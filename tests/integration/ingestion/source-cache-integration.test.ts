/**
 * Integration tests for source config caching in the ingestion pipeline.
 *
 * Tests:
 * - Cache miss on first webhook → DB query → cache populated
 * - Cache hit on second webhook → uses cached config (Redis key exists)
 * - Source update via PUT /api/sources/:id → cache invalidated
 * - Next webhook after invalidation → cache miss → re-populated from DB
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import Redis from "ioredis";
import { setupTestDb } from "../../helpers/db.js";
import { CACHE_PREFIX } from "../../../src/ingestion/source-cache.js";

describe("Source config cache integration (ingestion + source update)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let redis: Redis;
  let tenantId: string;
  let sourceId: string;
  let apiKey: string;
  const signingSecret = "whsec_cache_integration_test";
  const sourceSlug = `cache-test-source-${Date.now()}`;

  beforeAll(async () => {
    const redisUrl = process.env["REDIS_URL"];
    if (!redisUrl) throw new Error("REDIS_URL not set");
    redis = new Redis(redisUrl);

    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create a test tenant
    apiKey = `cache-test-api-key-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(apiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Cache Integration Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create an enabled test source with HMAC-SHA256
    const sourceResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_header, signature_algo, signing_secret, enabled)
      VALUES (${tenantId}, ${"Cache Test Source"}, ${sourceSlug}, ${"x-hub-signature-256"}, ${"hmac-sha256"}, ${signingSecret}, true)
      RETURNING id
    `;
    sourceId = sourceResult[0]!.id as string;
  });

  // Clear only THIS test's cache key before each test to avoid wiping other concurrent tests' keys
  beforeEach(async () => {
    await redis.del(`${CACHE_PREFIX}${sourceSlug}`);
  });

  afterAll(async () => {
    // Clean up only this test's cache key
    await redis.del(`${CACHE_PREFIX}${sourceSlug}`);
    // Clean up DB
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await redis.quit();
    await app.close();
  });

  function makeSignedPayload(body: Record<string, unknown>) {
    const payload = JSON.stringify(body);
    const rawBody = Buffer.from(payload);
    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBody)
      .digest("hex");
    return { payload: rawBody, signature };
  }

  it("should populate cache on first webhook (cache miss)", async () => {
    // Verify cache is empty
    const cacheBefore = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(cacheBefore).toBeNull();

    // Send webhook
    const { payload, signature } = makeSignedPayload({ event: "cache.miss.test" });
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);

    // Verify cache is now populated
    const cacheAfter = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(cacheAfter).not.toBeNull();

    const cached = JSON.parse(cacheAfter!);
    expect(cached.id).toBe(sourceId);
    expect(cached.slug).toBe(sourceSlug);
    expect(cached.tenantId).toBe(tenantId);
  });

  it("should use cached config on second webhook (cache hit)", async () => {
    // First webhook — populate cache
    const { payload: p1, signature: s1 } = makeSignedPayload({ event: "cache.hit.test1" });
    const r1 = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": s1,
      },
      payload: p1,
    });
    expect(r1.statusCode).toBe(200);

    // Verify cache is populated
    const cacheKey = `${CACHE_PREFIX}${sourceSlug}`;
    const cached = await redis.get(cacheKey);
    expect(cached).not.toBeNull();

    // Second webhook — should use cache (no way to directly assert no-DB-query,
    // but we can verify the cache key still exists and the request succeeds)
    const { payload: p2, signature: s2 } = makeSignedPayload({ event: "cache.hit.test2" });
    const r2 = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": s2,
      },
      payload: p2,
    });
    expect(r2.statusCode).toBe(200);

    // Cache should still exist (was hit, not evicted)
    const cacheStillExists = await redis.get(cacheKey);
    expect(cacheStillExists).not.toBeNull();
  });

  it("should invalidate cache when source is updated via PUT", async () => {
    // First, populate cache via webhook
    const { payload, signature } = makeSignedPayload({ event: "invalidation.test" });
    const webhookResponse = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload,
    });
    expect(webhookResponse.statusCode).toBe(200);

    // Verify cache is populated
    const cacheBefore = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(cacheBefore).not.toBeNull();

    // Update source via PUT /api/sources/:id
    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      payload: JSON.stringify({ name: "Updated Cache Test Source" }),
    });
    expect(updateResponse.statusCode).toBe(200);

    // Verify cache is invalidated
    const cacheAfter = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(cacheAfter).toBeNull();
  });

  it("should re-populate cache after invalidation on next webhook", async () => {
    // Populate cache
    const { payload: p1, signature: s1 } = makeSignedPayload({ event: "repopulate.test1" });
    await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": s1,
      },
      payload: p1,
    });

    // Invalidate via source update
    await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      payload: JSON.stringify({ name: "Re-populate Test Source" }),
    });

    // Verify cache is empty
    const cacheEmpty = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(cacheEmpty).toBeNull();

    // Send another webhook — should re-populate
    const { payload: p2, signature: s2 } = makeSignedPayload({ event: "repopulate.test2" });
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": s2,
      },
      payload: p2,
    });
    expect(response.statusCode).toBe(200);

    // Verify cache is re-populated
    const cacheRepopulated = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(cacheRepopulated).not.toBeNull();
  });

  it("should invalidate both old and new slug when slug is changed", async () => {
    const newSlug = `cache-renamed-${Date.now()}`;

    // Populate cache for original slug
    const { payload, signature } = makeSignedPayload({ event: "slug.change.test" });
    await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload,
    });

    // Verify cache populated
    const before = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(before).not.toBeNull();

    // Update slug
    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      payload: JSON.stringify({ slug: newSlug }),
    });
    expect(updateResponse.statusCode).toBe(200);

    // Old slug cache should be invalidated
    const oldSlugCache = await redis.get(`${CACHE_PREFIX}${sourceSlug}`);
    expect(oldSlugCache).toBeNull();

    // New slug cache should also be empty (not pre-populated)
    const newSlugCache = await redis.get(`${CACHE_PREFIX}${newSlug}`);
    expect(newSlugCache).toBeNull();

    // Restore original slug for other tests
    await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      payload: JSON.stringify({ slug: sourceSlug }),
    });
  });
});
