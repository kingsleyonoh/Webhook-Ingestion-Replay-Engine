/**
 * Integration tests for GET /api/dead-letters — list dead-lettered deliveries.
 * Batch 010, Item 1 (Section 5.5 step 1).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("GET /api/dead-letters (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let sourceId2: string;
  let destinationId: string;
  let destinationId2: string;
  let eventId1: string;
  let eventId2: string;
  let eventId3: string;
  let deliveryId1: string;
  let deliveryId2: string;
  let deliveryId3: string;
  let tenantBDeliveryId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create Tenant A
    tenantApiKey = `dl-list-${Date.now()}-${crypto.randomUUID()}`;
    const hashA = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");
    const resultA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DL List Tenant A ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantId = resultA[0]!.id as string;

    // Create Tenant B
    tenantBApiKey = `dl-list-b-${Date.now()}-${crypto.randomUUID()}`;
    const hashB = crypto
      .createHash("sha256")
      .update(tenantBApiKey)
      .digest("hex");
    const resultB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DL List Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;

    // Create sources for Tenant A
    const src1 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'DL Source 1', ${`dl-src1-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = src1[0]!.id as string;

    const src2 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'DL Source 2', ${`dl-src2-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId2 = src2[0]!.id as string;

    // Create destinations
    const dest1 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/dl1', 'POST')
      RETURNING id
    `;
    destinationId = dest1[0]!.id as string;

    const dest2 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantId}, ${sourceId2}, 'https://example.com/dl2', 'POST')
      RETURNING id
    `;
    destinationId2 = dest2[0]!.id as string;

    // Create events
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`idem-dl1-${Date.now()}`}, '{}', '{"test":1}', 'delivered')
      RETURNING id
    `;
    eventId1 = ev1[0]!.id as string;

    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`idem-dl2-${Date.now()}`}, '{}', '{"test":2}', 'delivered')
      RETURNING id
    `;
    eventId2 = ev2[0]!.id as string;

    const ev3 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId2}, ${`idem-dl3-${Date.now()}`}, '{}', '{"test":3}', 'delivered')
      RETURNING id
    `;
    eventId3 = ev3[0]!.id as string;

    // Create dead-lettered deliveries
    const dl1 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, attempted_at)
      VALUES (${tenantId}, ${eventId1}, ${destinationId}, 5, 'dead_letter', 500, 'Server error', '2026-04-01T10:00:00Z')
      RETURNING id
    `;
    deliveryId1 = dl1[0]!.id as string;

    const dl2 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, attempted_at)
      VALUES (${tenantId}, ${eventId2}, ${destinationId}, 5, 'dead_letter', 502, 'Bad gateway', '2026-04-02T10:00:00Z')
      RETURNING id
    `;
    deliveryId2 = dl2[0]!.id as string;

    const dl3 = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, error_message, attempted_at)
      VALUES (${tenantId}, ${eventId3}, ${destinationId2}, 5, 'dead_letter', 503, 'Service unavailable', '2026-04-03T10:00:00Z')
      RETURNING id
    `;
    deliveryId3 = dl3[0]!.id as string;

    // Create a non-dead-letter delivery (should NOT appear)
    await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code, attempted_at)
      VALUES (${tenantId}, ${eventId1}, ${destinationId}, 1, 'delivered', 200, '2026-04-01T09:00:00Z')
    `;

    // Create Tenant B source, event, delivery (for tenant isolation)
    const srcB = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'Tenant B Source', ${`dl-b-src-${Date.now()}`}, true)
      RETURNING id
    `;
    const sourceBId = srcB[0]!.id as string;

    const destB = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantBId}, ${sourceBId}, 'https://example.com/b', 'POST')
      RETURNING id
    `;
    const destBId = destB[0]!.id as string;

    const evB = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantBId}, ${sourceBId}, ${`idem-b-${Date.now()}`}, '{}', '{"b":1}', 'delivered')
      RETURNING id
    `;
    const eventBId = evB[0]!.id as string;

    const dlB = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, error_message, attempted_at)
      VALUES (${tenantBId}, ${eventBId}, ${destBId}, 5, 'dead_letter', 'Tenant B error', '2026-04-01T10:00:00Z')
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

  it("should list dead-lettered deliveries for the authenticated tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dead-letters",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("deliveries");
    expect(body).toHaveProperty("total");
    expect(body.total).toBe(3);
    expect(body.deliveries).toHaveLength(3);

    // Should be ordered by attempted_at DESC
    const ids = body.deliveries.map((d: { id: string }) => d.id);
    expect(ids).toContain(deliveryId1);
    expect(ids).toContain(deliveryId2);
    expect(ids).toContain(deliveryId3);

    // Each delivery should have required fields
    const first = body.deliveries[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("event_id");
    expect(first).toHaveProperty("destination_id");
    expect(first).toHaveProperty("attempt");
    expect(first).toHaveProperty("status", "dead_letter");
    expect(first).toHaveProperty("error_message");
    expect(first).toHaveProperty("attempted_at");
    expect(first).toHaveProperty("destination_url");
  });

  it("should not include non-dead-letter deliveries", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dead-letters",
      headers: { "x-api-key": tenantApiKey },
    });

    const body = JSON.parse(response.body);
    const statuses = body.deliveries.map((d: { status: string }) => d.status);
    expect(statuses.every((s: string) => s === "dead_letter")).toBe(true);
  });

  it("should filter by source_id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/dead-letters?source_id=${sourceId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // sourceId has 2 dead letters (deliveryId1, deliveryId2)
    expect(body.total).toBe(2);
    expect(body.deliveries).toHaveLength(2);
  });

  it("should filter by destination_id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/dead-letters?destination_id=${destinationId2}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(1);
    expect(body.deliveries[0].id).toBe(deliveryId3);
  });

  it("should filter by date range (from/to)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dead-letters?from=2026-04-02T00:00:00Z&to=2026-04-02T23:59:59Z",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(1);
    expect(body.deliveries[0].id).toBe(deliveryId2);
  });

  it("should support cursor pagination with limit", async () => {
    // Get first page with limit=2
    const page1 = await app.inject({
      method: "GET",
      url: "/api/dead-letters?limit=2",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(page1.statusCode).toBe(200);
    const body1 = JSON.parse(page1.body);
    expect(body1.deliveries).toHaveLength(2);
    expect(body1.total).toBe(3);
    expect(body1).toHaveProperty("cursor");

    // Get second page using cursor
    const page2 = await app.inject({
      method: "GET",
      url: `/api/dead-letters?limit=2&cursor=${body1.cursor}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(page2.statusCode).toBe(200);
    const body2 = JSON.parse(page2.body);
    expect(body2.deliveries).toHaveLength(1);
    // No more pages
    expect(body2.cursor).toBeUndefined();
  });

  it("should enforce tenant scoping — tenant A cannot see tenant B dead letters", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dead-letters",
      headers: { "x-api-key": tenantApiKey },
    });

    const body = JSON.parse(response.body);
    const ids = body.deliveries.map((d: { id: string }) => d.id);
    expect(ids).not.toContain(tenantBDeliveryId);
  });

  it("should return empty result set when no dead letters match", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/dead-letters?source_id=${crypto.randomUUID()}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.deliveries).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/dead-letters",
    });
    expect(response.statusCode).toBe(401);
  });
});
