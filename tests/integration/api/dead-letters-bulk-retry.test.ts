/**
 * Integration tests for POST /api/dead-letters/bulk-retry — bulk retry.
 * Batch 010, Item 4 (Section 5.5 step 4).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";
import { setupTestRedis } from "../../helpers/redis.js";

describe("POST /api/dead-letters/bulk-retry (integration)", () => {
  const db = setupTestDb();
  const testRedis = setupTestRedis();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let sourceId: string;
  let sourceId2: string;
  let destinationId: string;
  let destinationId2: string;
  let eventId1: string;
  let eventId2: string;
  let eventId3: string;
  let deadLetterId1: string;
  let deadLetterId2: string;
  let deadLetterId3: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create tenant
    tenantApiKey = `dl-bulk-${Date.now()}-${crypto.randomUUID()}`;
    const hash = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");
    const result = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DL Bulk Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = result[0]!.id as string;

    // Sources
    const src1 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Bulk Src 1', ${`bulk-src1-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = src1[0]!.id as string;

    const src2 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Bulk Src 2', ${`bulk-src2-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId2 = src2[0]!.id as string;

    // Destinations
    const dest1 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/bulk1', 'POST')
      RETURNING id
    `;
    destinationId = dest1[0]!.id as string;

    const dest2 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantId}, ${sourceId2}, 'https://example.com/bulk2', 'POST')
      RETURNING id
    `;
    destinationId2 = dest2[0]!.id as string;

    // Events
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`idem-bulk1-${Date.now()}`}, '{}', '{"bulk":1}', 'delivered')
      RETURNING id
    `;
    eventId1 = ev1[0]!.id as string;

    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`idem-bulk2-${Date.now()}`}, '{}', '{"bulk":2}', 'delivered')
      RETURNING id
    `;
    eventId2 = ev2[0]!.id as string;

    const ev3 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId2}, ${`idem-bulk3-${Date.now()}`}, '{}', '{"bulk":3}', 'delivered')
      RETURNING id
    `;
    eventId3 = ev3[0]!.id as string;

    // Dead-lettered deliveries
    const dl1 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, error_message, attempted_at)
      VALUES (${tenantId}, ${eventId1}, ${destinationId}, 5, 'dead_letter', 'Error 1', '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    deadLetterId1 = dl1[0]!.id as string;

    const dl2 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, error_message, attempted_at)
      VALUES (${tenantId}, ${eventId2}, ${destinationId}, 5, 'dead_letter', 'Error 2', '2026-04-02T10:00:00Z')
      RETURNING id
    `;
    deadLetterId2 = dl2[0]!.id as string;

    const dl3 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, error_message, attempted_at)
      VALUES (${tenantId}, ${eventId3}, ${destinationId2}, 5, 'dead_letter', 'Error 3', '2026-04-03T10:00:00Z')
      RETURNING id
    `;
    deadLetterId3 = dl3[0]!.id as string;

    // Clear BullMQ queue
    await testRedis.redis.flushdb();
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should retry all matching dead letters and return count", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/dead-letters/bulk-retry",
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("retried", 3);
    expect(body).toHaveProperty("total_matching", 3);

    // Verify all statuses were reset
    const dbResult = await db.sql`
      SELECT status, attempt FROM deliveries
      WHERE id IN (${deadLetterId1}, ${deadLetterId2}, ${deadLetterId3})
      ORDER BY id
    `;
    for (const row of dbResult) {
      expect(row.status).toBe("pending");
      expect(row.attempt).toBe(1);
    }
  });

  it("should apply source_id filter", async () => {
    // Reset state: put them back to dead_letter
    await db.sql`
      UPDATE deliveries SET status = 'dead_letter', attempt = 5
      WHERE id IN (${deadLetterId1}, ${deadLetterId2}, ${deadLetterId3})
    `;
    await testRedis.redis.flushdb();

    const response = await app.inject({
      method: "POST",
      url: "/api/dead-letters/bulk-retry",
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
      payload: { source_id: sourceId },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // sourceId has 2 dead letters
    expect(body.retried).toBe(2);
    expect(body.total_matching).toBe(2);

    // Verify only sourceId deliveries were retried
    const dlSrc1 = await db.sql`SELECT status FROM deliveries WHERE id = ${deadLetterId1}`;
    expect(dlSrc1[0]!.status).toBe("pending");
    const dlSrc2 = await db.sql`SELECT status FROM deliveries WHERE id = ${deadLetterId2}`;
    expect(dlSrc2[0]!.status).toBe("pending");
    // sourceId2 delivery should still be dead_letter
    const dlSrc3 = await db.sql`SELECT status FROM deliveries WHERE id = ${deadLetterId3}`;
    expect(dlSrc3[0]!.status).toBe("dead_letter");
  });

  it("should apply destination_id filter", async () => {
    // Reset all
    await db.sql`
      UPDATE deliveries SET status = 'dead_letter', attempt = 5
      WHERE id IN (${deadLetterId1}, ${deadLetterId2}, ${deadLetterId3})
    `;
    await testRedis.redis.flushdb();

    const response = await app.inject({
      method: "POST",
      url: "/api/dead-letters/bulk-retry",
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
      payload: { destination_id: destinationId2 },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.retried).toBe(1);
    expect(body.total_matching).toBe(1);
  });

  it("should apply date range filter", async () => {
    // Reset all
    await db.sql`
      UPDATE deliveries SET status = 'dead_letter', attempt = 5
      WHERE id IN (${deadLetterId1}, ${deadLetterId2}, ${deadLetterId3})
    `;
    await testRedis.redis.flushdb();

    const response = await app.inject({
      method: "POST",
      url: "/api/dead-letters/bulk-retry",
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
      payload: {
        from: "2026-04-02T00:00:00Z",
        to: "2026-04-02T23:59:59Z",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.retried).toBe(1);
    expect(body.total_matching).toBe(1);
  });

  it("should return zero counts when no dead letters match", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/dead-letters/bulk-retry",
      headers: {
        "x-api-key": tenantApiKey,
        "content-type": "application/json",
      },
      payload: { source_id: crypto.randomUUID() },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.retried).toBe(0);
    expect(body.total_matching).toBe(0);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/dead-letters/bulk-retry",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});
