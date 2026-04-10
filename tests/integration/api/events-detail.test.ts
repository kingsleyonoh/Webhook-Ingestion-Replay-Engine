/**
 * Integration tests for GET /api/events/:id — event detail with deliveries.
 * Batch 011, Item 7 (Section 8b).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("GET /api/events/:id (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let destId: string;
  let eventId: string;
  let tenantBEventId: string;
  let deliveryId1: string;
  let deliveryId2: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Tenant A
    tenantApiKey = `ev-detail-${Date.now()}-${crypto.randomUUID()}`;
    const hashA = crypto.createHash("sha256").update(tenantApiKey).digest("hex");
    const tA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Events Detail Tenant ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantId = tA[0]!.id as string;

    // Tenant B
    tenantBApiKey = `ev-detail-b-${Date.now()}-${crypto.randomUUID()}`;
    const hashB = crypto.createHash("sha256").update(tenantBApiKey).digest("hex");
    const tB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Events Detail Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = tB[0]!.id as string;

    // Source + destination
    const s1 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Detail Src', ${`ev-detail-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = s1[0]!.id as string;

    const d1 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method, enabled)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/detail', 'POST', true)
      RETURNING id
    `;
    destId = d1[0]!.id as string;

    // Event for Tenant A
    const ev = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`ev-detail-${Date.now()}`}, '{"x-sig":"abc"}', '{"data":"test"}', 'delivered')
      RETURNING id
    `;
    eventId = ev[0]!.id as string;

    // Delivery attempts for the event
    const del1 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, duration_ms, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destId}, 1, 'failed', 500, 120, '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    deliveryId1 = del1[0]!.id as string;

    const del2 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, duration_ms, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destId}, 2, 'delivered', 200, 85, '2026-04-01T10:01:00Z')
      RETURNING id
    `;
    deliveryId2 = del2[0]!.id as string;

    // Tenant B event
    const sB = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'B Detail Src', ${`ev-detail-b-src-${Date.now()}`}, true)
      RETURNING id
    `;
    const sourceBId = sB[0]!.id as string;

    const evB = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantBId}, ${sourceBId}, ${`ev-detail-b-${Date.now()}`}, '{}', '{"b":1}', 'pending')
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

  it("should return event with all delivery attempts", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/events/${eventId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("event");
    expect(body).toHaveProperty("deliveries");

    // Event fields
    expect(body.event.id).toBe(eventId);
    expect(body.event.source_id).toBe(sourceId);
    expect(body.event.status).toBe("delivered");
    expect(body.event.payload).toEqual({ data: "test" });
    expect(body.event.headers).toEqual({ "x-sig": "abc" });
    expect(body.event).toHaveProperty("received_at");

    // Delivery attempts
    expect(body.deliveries).toHaveLength(2);
    const attempts = body.deliveries.map((d: { attempt: number }) => d.attempt);
    expect(attempts).toContain(1);
    expect(attempts).toContain(2);

    // Check delivery fields
    const firstAttempt = body.deliveries.find((d: { attempt: number }) => d.attempt === 1);
    expect(firstAttempt.status).toBe("failed");
    expect(firstAttempt.status_code).toBe(500);
    expect(firstAttempt.duration_ms).toBe(120);

    const secondAttempt = body.deliveries.find((d: { attempt: number }) => d.attempt === 2);
    expect(secondAttempt.status).toBe("delivered");
    expect(secondAttempt.status_code).toBe(200);
  });

  it("should return 404 for non-existent event", async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.inject({
      method: "GET",
      url: `/api/events/${fakeId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("EVENT_NOT_FOUND");
  });

  it("should return 404 when trying to access another tenant's event (cross-tenant)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/events/${tenantBEventId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(404);
  });

  it("should return 400 for invalid UUID param", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events/not-a-uuid",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return event with empty deliveries when no attempts exist", async () => {
    // Create event with no deliveries
    const ev = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`ev-no-del-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"empty":true}', 'pending')
      RETURNING id
    `;
    const noDelEventId = ev[0]!.id as string;

    const response = await app.inject({
      method: "GET",
      url: `/api/events/${noDelEventId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.event.id).toBe(noDelEventId);
    expect(body.deliveries).toHaveLength(0);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/events/${eventId}`,
    });
    expect(response.statusCode).toBe(401);
  });
});
