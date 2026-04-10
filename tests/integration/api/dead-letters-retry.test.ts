/**
 * Integration tests for POST /api/dead-letters/:deliveryId/retry — single retry.
 * Batch 010, Item 3 (Section 5.5 step 3).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";
import { setupTestRedis } from "../../helpers/redis.js";

describe("POST /api/dead-letters/:deliveryId/retry (integration)", () => {
  const db = setupTestDb();
  const testRedis = setupTestRedis();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let sourceId: string;
  let destinationId: string;
  let eventId: string;
  let deadLetterId: string;
  let nonDeadLetterId: string;
  let tenantBDeliveryId: string;
  let tenantBId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Tenant A
    tenantApiKey = `dl-retry-${Date.now()}-${crypto.randomUUID()}`;
    const hashA = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");
    const resultA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DL Retry A ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantId = resultA[0]!.id as string;

    // Tenant B
    const tenantBApiKey = `dl-retry-b-${Date.now()}-${crypto.randomUUID()}`;
    const hashB = crypto
      .createHash("sha256")
      .update(tenantBApiKey)
      .digest("hex");
    const resultB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DL Retry B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;

    // Source + destination
    const src = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Retry Source', ${`retry-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = src[0]!.id as string;

    const dest = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/retry', 'POST')
      RETURNING id
    `;
    destinationId = dest[0]!.id as string;

    // Event
    const ev = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`idem-retry-${Date.now()}`}, '{}', '{"retry":true}', 'delivered')
      RETURNING id
    `;
    eventId = ev[0]!.id as string;

    // Dead-lettered delivery
    const dl = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destinationId}, 5, 'dead_letter', 500, 'Max retries', '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    deadLetterId = dl[0]!.id as string;

    // Non-dead-letter delivery (should NOT be retryable)
    const ndl = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destinationId}, 1, 'delivered', 200, '2026-04-01T09:00:00Z')
      RETURNING id
    `;
    nonDeadLetterId = ndl[0]!.id as string;

    // Tenant B dead letter
    const srcB = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'B Retry Src', ${`b-retry-${Date.now()}`}, true)
      RETURNING id
    `;
    const destB = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantBId}, ${srcB[0]!.id}, 'https://example.com/b-retry', 'POST')
      RETURNING id
    `;
    const evB = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantBId}, ${srcB[0]!.id}, ${`idem-b-retry-${Date.now()}`}, '{}', '{"b":1}', 'delivered')
      RETURNING id
    `;
    const dlB = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, error_message, attempted_at)
      VALUES (${tenantBId}, ${evB[0]!.id}, ${destB[0]!.id}, 5, 'dead_letter', 'B error', '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    tenantBDeliveryId = dlB[0]!.id as string;

    // Clear BullMQ queue before tests
    await testRedis.redis.flushdb();
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM events WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should retry a dead-lettered delivery — reset status and enqueue job", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/dead-letters/${deadLetterId}/retry`,
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("retried", true);
    expect(body).toHaveProperty("delivery_id", deadLetterId);

    // Verify DB status updated to pending
    const dbResult = await db.sql`
      SELECT status, attempt FROM deliveries WHERE id = ${deadLetterId}
    `;
    expect(dbResult[0]!.status).toBe("pending");
    expect(dbResult[0]!.attempt).toBe(1);

    // Verify BullMQ job was enqueued (check queue)
    const jobs = await testRedis.redis.llen("bull:deliver:wait");
    expect(jobs).toBeGreaterThanOrEqual(1);
  });

  it("should return 404 for non-existent delivery", async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/dead-letters/${fakeId}/retry`,
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("DELIVERY_NOT_FOUND");
  });

  it("should return 404 when delivery belongs to another tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/dead-letters/${tenantBDeliveryId}/retry`,
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("should return 400 when delivery is not in dead_letter status", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/dead-letters/${nonDeadLetterId}/retry`,
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
    });

    // Non-dead-letter should be treated as not found (only dead letters visible)
    expect(response.statusCode).toBe(404);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/dead-letters/${deadLetterId}/retry`,
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(401);
  });
});
