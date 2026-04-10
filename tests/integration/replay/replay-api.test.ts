/**
 * Integration tests for POST /api/replays — create replay request.
 * Batch 011, Items 2, 3 (Section 5.3 step 1).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("POST /api/replays (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let sourceId2: string;
  let destId: string;
  let eventId1: string;
  let eventId2: string;
  let eventId3: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create Tenant A
    tenantApiKey = `replay-api-${Date.now()}-${crypto.randomUUID()}`;
    const hashA = crypto.createHash("sha256").update(tenantApiKey).digest("hex");
    const tA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Replay API Tenant ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantId = tA[0]!.id as string;

    // Create Tenant B
    tenantBApiKey = `replay-api-b-${Date.now()}-${crypto.randomUUID()}`;
    const hashB = crypto.createHash("sha256").update(tenantBApiKey).digest("hex");
    const tB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Replay API Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = tB[0]!.id as string;

    // Create sources
    const s1 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Replay Src 1', ${`replay-api-s1-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = s1[0]!.id as string;

    const s2 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Replay Src 2', ${`replay-api-s2-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId2 = s2[0]!.id as string;

    // Create destinations
    const d1 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method, enabled)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/replay-dest', 'POST', true)
      RETURNING id
    `;
    destId = d1[0]!.id as string;

    await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method, enabled)
      VALUES (${tenantId}, ${sourceId2}, 'https://example.com/replay-dest2', 'POST', true)
    `;

    // Create events
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`replay-api-ev1-${Date.now()}`}, '{}', '{"n":1}', 'pending', '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    eventId1 = ev1[0]!.id as string;

    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`replay-api-ev2-${Date.now()}`}, '{}', '{"n":2}', 'pending', '2026-04-02T10:00:00Z')
      RETURNING id
    `;
    eventId2 = ev2[0]!.id as string;

    const ev3 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId2}, ${`replay-api-ev3-${Date.now()}`}, '{}', '{"n":3}', 'pending', '2026-04-03T10:00:00Z')
      RETURNING id
    `;
    eventId3 = ev3[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM replay_requests WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM events WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should create a replay request with event_ids filter", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "x-api-key": tenantApiKey, "content-type": "application/json" },
      payload: {
        event_ids: [eventId1, eventId2],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("replay_request");
    expect(body.replay_request).toHaveProperty("id");
    expect(body.replay_request.tenant_id).toBe(tenantId);
    expect(body.replay_request.status).toBe("completed");
    expect(body.replay_request.total_events).toBe(2);
    expect(body.replay_request.processed).toBe(2);
    expect(body.replay_request.failed).toBe(0);
    expect(body.replay_request).toHaveProperty("created_at");
  });

  it("should create a replay request with source_id filter", async () => {
    // Reset events to pending
    await db.sql`
      UPDATE events SET status = 'pending'
      WHERE id IN (${eventId1}, ${eventId2}, ${eventId3})
    `;

    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "x-api-key": tenantApiKey, "content-type": "application/json" },
      payload: {
        source_id: sourceId,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.replay_request.source_id).toBe(sourceId);
    // Source 1 has eventId1 and eventId2
    expect(body.replay_request.total_events).toBeGreaterThanOrEqual(2);
  });

  it("should create a replay request with time range filter", async () => {
    // Reset events to pending
    await db.sql`
      UPDATE events SET status = 'pending'
      WHERE id IN (${eventId1}, ${eventId2}, ${eventId3})
    `;

    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "x-api-key": tenantApiKey, "content-type": "application/json" },
      payload: {
        from: "2026-04-01T00:00:00Z",
        to: "2026-04-01T23:59:59Z",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.replay_request.total_events).toBeGreaterThanOrEqual(1);
  });

  it("should return 400 for invalid source_id UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "x-api-key": tenantApiKey, "content-type": "application/json" },
      payload: {
        source_id: "not-a-uuid",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 for invalid event_ids", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "x-api-key": tenantApiKey, "content-type": "application/json" },
      payload: {
        event_ids: ["not-a-uuid"],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 for invalid datetime in from/to", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "x-api-key": tenantApiKey, "content-type": "application/json" },
      payload: {
        from: "not-a-date",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 when no filter is provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "x-api-key": tenantApiKey, "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/replays",
      headers: { "content-type": "application/json" },
      payload: { event_ids: [eventId1] },
    });

    expect(response.statusCode).toBe(401);
  });
});
