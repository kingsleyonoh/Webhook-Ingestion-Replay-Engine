/**
 * Integration tests for GET /api/dead-letters/:deliveryId — full detail view.
 * Batch 010, Item 2 (Section 5.5 step 2).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("GET /api/dead-letters/:deliveryId (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let destinationId: string;
  let eventId: string;
  let deadLetterId: string;
  let tenantBDeliveryId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Tenant A
    tenantApiKey = `dl-detail-${Date.now()}-${crypto.randomUUID()}`;
    const hashA = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");
    const resultA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DL Detail A ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantId = resultA[0]!.id as string;

    // Tenant B
    tenantBApiKey = `dl-detail-b-${Date.now()}-${crypto.randomUUID()}`;
    const hashB = crypto
      .createHash("sha256")
      .update(tenantBApiKey)
      .digest("hex");
    const resultB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DL Detail B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;

    // Source + destination for Tenant A
    const src = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Detail Source', ${`detail-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = src[0]!.id as string;

    const dest = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/detail', 'POST')
      RETURNING id
    `;
    destinationId = dest[0]!.id as string;

    // Event with payload
    const ev = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`idem-detail-${Date.now()}`}, '{"content-type":"application/json"}', '{"order_id":"12345"}', 'delivered')
      RETURNING id
    `;
    eventId = ev[0]!.id as string;

    // Create multiple delivery attempts (retry history)
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, duration_ms, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destinationId}, 1, 'failed', 500, 'Internal server error', 150, '2026-04-01T10:00:00Z')
    `;
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, duration_ms, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destinationId}, 2, 'failed', 502, 'Bad gateway', 200, '2026-04-01T10:01:00Z')
    `;
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, duration_ms, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destinationId}, 3, 'failed', 503, 'Service unavailable', 250, '2026-04-01T10:02:00Z')
    `;

    // The final dead-lettered delivery
    const dl = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, duration_ms, attempted_at)
      VALUES (${tenantId}, ${eventId}, ${destinationId}, 4, 'dead_letter', 500, 'Max retries exceeded', 300, '2026-04-01T10:03:00Z')
      RETURNING id
    `;
    deadLetterId = dl[0]!.id as string;

    // Tenant B dead letter (for cross-tenant test)
    const srcB = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'B Detail Src', ${`b-detail-${Date.now()}`}, true)
      RETURNING id
    `;
    const destB = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantBId}, ${srcB[0]!.id}, 'https://example.com/b', 'POST')
      RETURNING id
    `;
    const evB = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantBId}, ${srcB[0]!.id}, ${`idem-b-detail-${Date.now()}`}, '{}', '{"b":1}', 'delivered')
      RETURNING id
    `;
    const dlB = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, error_message, attempted_at)
      VALUES (${tenantBId}, ${evB[0]!.id}, ${destB[0]!.id}, 5, 'dead_letter', 'Tenant B error', '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    tenantBDeliveryId = dlB[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM events WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should return full delivery details with event, destination, and all attempts", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/dead-letters/${deadLetterId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("delivery");

    const delivery = body.delivery;
    expect(delivery.id).toBe(deadLetterId);
    expect(delivery.status).toBe("dead_letter");
    expect(delivery.attempt).toBe(4);
    expect(delivery.error_message).toBe("Max retries exceeded");

    // Event details with payload
    expect(delivery).toHaveProperty("event");
    expect(delivery.event.id).toBe(eventId);
    expect(delivery.event.payload).toEqual({ order_id: "12345" });
    expect(delivery.event.headers).toEqual({ "content-type": "application/json" });

    // Destination details
    expect(delivery).toHaveProperty("destination");
    expect(delivery.destination.id).toBe(destinationId);
    expect(delivery.destination.url).toBe("https://example.com/detail");
    expect(delivery.destination.method).toBe("POST");

    // All delivery attempts
    expect(delivery).toHaveProperty("attempts");
    expect(delivery.attempts).toHaveLength(4);
    expect(delivery.attempts[0].attempt).toBe(1);
    expect(delivery.attempts[3].attempt).toBe(4);
  });

  it("should return 404 for non-existent delivery ID", async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.inject({
      method: "GET",
      url: `/api/dead-letters/${fakeId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("DELIVERY_NOT_FOUND");
  });

  it("should return 404 when delivery belongs to another tenant (cross-tenant)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/dead-letters/${tenantBDeliveryId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("DELIVERY_NOT_FOUND");
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/dead-letters/${deadLetterId}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("should return 400 for invalid UUID format", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dead-letters/not-a-uuid",
      headers: { "x-api-key": tenantApiKey },
    });
    expect(response.statusCode).toBe(400);
  });
});
