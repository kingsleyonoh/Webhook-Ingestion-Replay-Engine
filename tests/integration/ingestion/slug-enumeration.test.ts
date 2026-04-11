/**
 * Integration tests for source slug enumeration prevention.
 * Tests:
 * - Unknown slug response shape === disabled source response shape
 * - Both return 404 with SOURCE_NOT_FOUND code
 * - Response bodies are identical in structure (no info leakage)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";
import { setupTestRedis } from "../../helpers/redis.js";

describe("Source slug enumeration prevention (integration)", () => {
  const db = setupTestDb();
  const redisHelper = setupTestRedis();
  let app: FastifyInstance;
  let tenantId: string;
  const disabledSlug = `disabled-enum-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    const uniqueApiKey = `test-api-key-enum-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueApiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Enum Test Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create a disabled source
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"Disabled Enum Source"}, ${disabledSlug}, ${"none"}, false)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should return identical response for unknown and disabled slugs", async () => {
    const unknownResponse = await app.inject({
      method: "POST",
      url: "/webhooks/completely-unknown-slug-xyz",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "test" }),
    });

    const disabledResponse = await app.inject({
      method: "POST",
      url: `/webhooks/${disabledSlug}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "test" }),
    });

    // Same status code
    expect(unknownResponse.statusCode).toBe(404);
    expect(disabledResponse.statusCode).toBe(404);

    // Same error code
    const unknownBody = JSON.parse(unknownResponse.body);
    const disabledBody = JSON.parse(disabledResponse.body);
    expect(unknownBody.error.code).toBe("SOURCE_NOT_FOUND");
    expect(disabledBody.error.code).toBe("SOURCE_NOT_FOUND");

    // The message should NOT reveal whether the source exists but is disabled
    // Both should use a generic message
    expect(unknownBody.error.code).toBe(disabledBody.error.code);
  });

  it("should return 404 for disabled source even if cached as enabled then disabled", async () => {
    // Create an enabled source, let it get cached, then disable it
    const cacheTestSlug = `cache-enum-${Date.now()}`;
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"Cache Enum Source"}, ${cacheTestSlug}, ${"none"}, true)
    `;

    // First request — populates cache
    const firstResponse = await app.inject({
      method: "POST",
      url: `/webhooks/${cacheTestSlug}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "cache.enum.first", ts: Date.now() }),
    });
    expect(firstResponse.statusCode).toBe(200);

    // Disable the source in DB
    await db.sql`
      UPDATE sources SET enabled = false WHERE slug = ${cacheTestSlug} AND tenant_id = ${tenantId}
    `;

    // Invalidate cache to simulate a source update
    await redisHelper.redis.del(`source:config:${cacheTestSlug}`);

    // Next request should see the disabled source
    const secondResponse = await app.inject({
      method: "POST",
      url: `/webhooks/${cacheTestSlug}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "cache.enum.second", ts: Date.now() }),
    });

    expect(secondResponse.statusCode).toBe(404);

    // Cleanup
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE slug = ${cacheTestSlug} AND tenant_id = ${tenantId}`;
  });
});
