/**
 * Integration tests for GET /api/stats — tenant dashboard stats.
 * Section 8b: sources count, events today, delivery success rate, dead letters.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("GET /api/stats (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;

  // Tenant A — has data
  let tenantAKey: string;
  let tenantAId: string;

  // Tenant B — empty, zero-state
  let tenantBKey: string;
  let tenantBId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // ── Tenant A ──
    tenantAKey = `stats-a-${Date.now()}-${crypto.randomUUID()}`;
    const hashA = crypto.createHash("sha256").update(tenantAKey).digest("hex");
    const tA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Stats Tenant A ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantAId = tA[0]!.id as string;

    // ── Tenant B (zero-state) ──
    tenantBKey = `stats-b-${Date.now()}-${crypto.randomUUID()}`;
    const hashB = crypto.createHash("sha256").update(tenantBKey).digest("hex");
    const tB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Stats Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = tB[0]!.id as string;

    // ── Sources for Tenant A ──
    const s1 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantAId}, 'Stats Src 1', ${`stats-s1-${Date.now()}`}, true)
      RETURNING id
    `;
    const sourceId1 = s1[0]!.id as string;

    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantAId}, 'Stats Src 2', ${`stats-s2-${Date.now()}`}, true)
    `;

    // ── Destination for Tenant A ──
    const d1 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, max_retries)
      VALUES (${tenantAId}, ${sourceId1}, 'https://example.com/hook', 3)
      RETURNING id
    `;
    const destId1 = d1[0]!.id as string;

    // ── Events for Tenant A (2 today UTC, 1 old) ──
    const now = new Date();
    const todayStartUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );

    // Event 1: at UTC today start + 1 minute
    const todayEarly = new Date(todayStartUtc.getTime() + 60_000);
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantAId}, ${sourceId1}, ${`stat-ev1-${Date.now()}`}, '{}', '{"n":1}', 'delivered', ${todayEarly.toISOString()})
      RETURNING id
    `;
    const eventId1 = ev1[0]!.id as string;

    // Event 2: at UTC now
    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantAId}, ${sourceId1}, ${`stat-ev2-${Date.now()}`}, '{}', '{"n":2}', 'pending', ${now.toISOString()})
      RETURNING id
    `;
    const eventId2 = ev2[0]!.id as string;

    // Old event — yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantAId}, ${sourceId1}, ${`stat-ev3-${Date.now()}`}, '{}', '{"n":3}', 'delivered', ${yesterday.toISOString()})
    `;

    // ── Deliveries: 3 success, 1 failed, 1 dead_letter ──
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code)
      VALUES (${tenantAId}, ${eventId1}, ${destId1}, 1, 'success', 200)
    `;
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code)
      VALUES (${tenantAId}, ${eventId1}, ${destId1}, 1, 'success', 200)
    `;
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code)
      VALUES (${tenantAId}, ${eventId2}, ${destId1}, 1, 'success', 201)
    `;
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code)
      VALUES (${tenantAId}, ${eventId2}, ${destId1}, 2, 'failed', 500)
    `;
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status)
      VALUES (${tenantAId}, ${eventId1}, ${destId1}, 3, 'dead_letter')
    `;
  });

  afterAll(async () => {
    // Cleanup in FK order
    await db.sql`DELETE FROM deliveries WHERE tenant_id IN (${tenantAId}, ${tenantBId})`;
    await db.sql`DELETE FROM events WHERE tenant_id IN (${tenantAId}, ${tenantBId})`;
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantAId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantAId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantAId}, ${tenantBId})`;
    await app.close();
  });

  it("should return 200 with correct stats shape", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantAKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("sources_count");
    expect(body).toHaveProperty("events_today");
    expect(body).toHaveProperty("delivery_success_rate");
    expect(body).toHaveProperty("dead_letters");
  });

  it("should return correct sources count for tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantAKey },
    });

    const body = JSON.parse(response.body);
    expect(body.sources_count).toBe(2);
  });

  it("should return correct events today count", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantAKey },
    });

    const body = JSON.parse(response.body);
    expect(body.events_today).toBe(2);
  });

  it("should return correct delivery success rate", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantAKey },
    });

    const body = JSON.parse(response.body);
    // 3 success out of 5 total = 60%
    expect(body.delivery_success_rate).toBeCloseTo(60, 0);
  });

  it("should return correct dead letter count", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantAKey },
    });

    const body = JSON.parse(response.body);
    expect(body.dead_letters).toBe(1);
  });

  it("should return all zeros for tenant with no data (zero-state)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantBKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.sources_count).toBe(0);
    expect(body.events_today).toBe(0);
    expect(body.delivery_success_rate).toBe(0);
    expect(body.dead_letters).toBe(0);
  });

  it("should be tenant-scoped — tenant B cannot see tenant A stats", async () => {
    const responseA = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantAKey },
    });
    const responseB = await app.inject({
      method: "GET",
      url: "/api/stats",
      headers: { "x-api-key": tenantBKey },
    });

    const bodyA = JSON.parse(responseA.body);
    const bodyB = JSON.parse(responseB.body);

    expect(bodyA.sources_count).toBe(2);
    expect(bodyB.sources_count).toBe(0);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats",
    });
    expect(response.statusCode).toBe(401);
  });
});
