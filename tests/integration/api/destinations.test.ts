/**
 * Integration tests for POST /api/sources/:id/destinations — add destination.
 * Batch 007, Item 3 (Section 5.4).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("POST /api/sources/:id/destinations (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let sourceBId: string;
  const createdDestIds: string[] = [];

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create Tenant A
    tenantApiKey = crypto.randomBytes(32).toString("hex");
    const hashA = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");
    const resultA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Dest Tenant A ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantId = resultA[0]!.id as string;

    // Create Tenant B
    tenantBApiKey = crypto.randomBytes(32).toString("hex");
    const hashB = crypto
      .createHash("sha256")
      .update(tenantBApiKey)
      .digest("hex");
    const resultB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Dest Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;

    // Create source for Tenant A
    const srcResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Dest Test Source', ${`dest-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = srcResult[0]!.id as string;

    // Create source for Tenant B
    const srcBResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'Dest B Source', ${`dest-b-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceBId = srcBResult[0]!.id as string;
  });

  afterAll(async () => {
    for (const id of createdDestIds) {
      await db.sql`DELETE FROM destinations WHERE id = ${id}`;
    }
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should create a destination with full config and return 201", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: {
        url: "https://example.com/webhook",
        method: "PUT",
        headers: { "Authorization": "Bearer token123" },
        timeout_ms: 5000,
        max_retries: 3,
        backoff_base_ms: 500,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("destination");
    expect(body.destination).toHaveProperty("id");
    expect(body.destination.url).toBe("https://example.com/webhook");
    expect(body.destination.method).toBe("PUT");
    expect(body.destination.timeout_ms).toBe(5000);
    expect(body.destination.max_retries).toBe(3);
    expect(body.destination.backoff_base_ms).toBe(500);

    createdDestIds.push(body.destination.id);
  });

  it("should create a destination with only url (defaults applied)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "https://example.com/minimal" },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.destination.url).toBe("https://example.com/minimal");
    expect(body.destination.method).toBe("POST");
    expect(body.destination.timeout_ms).toBe(10000);
    expect(body.destination.max_retries).toBe(5);

    createdDestIds.push(body.destination.id);
  });

  it("should return 404 when source does not exist", async () => {
    const fakeSourceId = crypto.randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${fakeSourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "https://example.com/nope" },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SOURCE_NOT_FOUND");
  });

  it("should return 404 when source belongs to another tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceBId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "https://example.com/cross-tenant" },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SOURCE_NOT_FOUND");
  });

  it("should return 400 when url is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { method: "POST" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 for invalid source ID format", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sources/not-a-uuid/destinations",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "https://example.com" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: { "content-type": "application/json" },
      payload: { url: "https://example.com" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should persist destination in the database", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "https://example.com/persist-check" },
    });

    const body = JSON.parse(response.body);
    const destId = body.destination.id;
    createdDestIds.push(destId);

    const dbResult = await db.sql`
      SELECT id, tenant_id, source_id, url FROM destinations WHERE id = ${destId}
    `;
    expect(dbResult).toHaveLength(1);
    expect(dbResult[0]!.tenant_id).toBe(tenantId);
    expect(dbResult[0]!.source_id).toBe(sourceId);
    expect(dbResult[0]!.url).toBe("https://example.com/persist-check");
  });
});
