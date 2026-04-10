/**
 * Integration tests for GET /api/events — list events with filters.
 * Batch 011, Item 6 (Section 8b).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("GET /api/events (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let sourceId2: string;
  let eventId1: string;
  let eventId2: string;
  let eventId3: string;
  let eventId4: string;
  let tenantBEventId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Tenant A
    tenantApiKey = `ev-list-${Date.now()}-${crypto.randomUUID()}`;
    const hashA = crypto.createHash("sha256").update(tenantApiKey).digest("hex");
    const tA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Events List Tenant ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantId = tA[0]!.id as string;

    // Tenant B
    tenantBApiKey = `ev-list-b-${Date.now()}-${crypto.randomUUID()}`;
    const hashB = crypto.createHash("sha256").update(tenantBApiKey).digest("hex");
    const tB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Events List Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = tB[0]!.id as string;

    // Sources
    const s1 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Events Src 1', ${`ev-list-s1-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = s1[0]!.id as string;

    const s2 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Events Src 2', ${`ev-list-s2-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId2 = s2[0]!.id as string;

    // Events for Tenant A
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`ev-list-1-${Date.now()}`}, '{"h":"v"}', '{"n":1}', 'pending', '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    eventId1 = ev1[0]!.id as string;

    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`ev-list-2-${Date.now()}`}, '{}', '{"n":2}', 'delivered', '2026-04-02T10:00:00Z')
      RETURNING id
    `;
    eventId2 = ev2[0]!.id as string;

    const ev3 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId2}, ${`ev-list-3-${Date.now()}`}, '{}', '{"n":3}', 'failed', '2026-04-03T10:00:00Z')
      RETURNING id
    `;
    eventId3 = ev3[0]!.id as string;

    const ev4 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`ev-list-4-${Date.now()}`}, '{}', '{"n":4}', 'pending', '2026-04-04T10:00:00Z')
      RETURNING id
    `;
    eventId4 = ev4[0]!.id as string;

    // Tenant B event
    const sB = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'B Source', ${`ev-b-src-${Date.now()}`}, true)
      RETURNING id
    `;
    const sourceBId = sB[0]!.id as string;

    const evB = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantBId}, ${sourceBId}, ${`ev-b-${Date.now()}`}, '{}', '{"b":1}', 'pending')
      RETURNING id
    `;
    tenantBEventId = evB[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM events WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should list events for the authenticated tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("events");
    expect(body).toHaveProperty("total");
    expect(body.total).toBe(4);
    expect(body.events).toHaveLength(4);

    // Each event should have required fields
    const ev = body.events[0];
    expect(ev).toHaveProperty("id");
    expect(ev).toHaveProperty("source_id");
    expect(ev).toHaveProperty("idempotency_key");
    expect(ev).toHaveProperty("headers");
    expect(ev).toHaveProperty("payload");
    expect(ev).toHaveProperty("status");
    expect(ev).toHaveProperty("received_at");
  });

  it("should filter by source_id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/events?source_id=${sourceId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(3); // eventId1, eventId2, eventId4
    body.events.forEach((ev: { source_id: string }) => {
      expect(ev.source_id).toBe(sourceId);
    });
  });

  it("should filter by status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events?status=pending",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(2); // eventId1, eventId4
    body.events.forEach((ev: { status: string }) => {
      expect(ev.status).toBe("pending");
    });
  });

  it("should filter by date range (from/to)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events?from=2026-04-02T00:00:00Z&to=2026-04-03T23:59:59Z",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(2); // eventId2, eventId3
    const ids = body.events.map((e: { id: string }) => e.id);
    expect(ids).toContain(eventId2);
    expect(ids).toContain(eventId3);
  });

  it("should support cursor pagination with limit", async () => {
    // Page 1
    const page1 = await app.inject({
      method: "GET",
      url: "/api/events?limit=2",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(page1.statusCode).toBe(200);
    const body1 = JSON.parse(page1.body);
    expect(body1.events).toHaveLength(2);
    expect(body1.total).toBe(4);
    expect(body1).toHaveProperty("cursor");

    // Page 2
    const page2 = await app.inject({
      method: "GET",
      url: `/api/events?limit=2&cursor=${body1.cursor}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(page2.statusCode).toBe(200);
    const body2 = JSON.parse(page2.body);
    expect(body2.events).toHaveLength(2);

    // No overlap
    const page1Ids = body1.events.map((e: { id: string }) => e.id);
    const page2Ids = body2.events.map((e: { id: string }) => e.id);
    const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it("should enforce tenant scoping — tenant A cannot see tenant B events", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events",
      headers: { "x-api-key": tenantApiKey },
    });

    const body = JSON.parse(response.body);
    const ids = body.events.map((e: { id: string }) => e.id);
    expect(ids).not.toContain(tenantBEventId);
  });

  it("should return empty when no events match filter", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/events?source_id=${crypto.randomUUID()}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events",
    });
    expect(response.statusCode).toBe(401);
  });
});
