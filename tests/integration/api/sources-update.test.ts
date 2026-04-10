/**
 * Integration tests for PUT /api/sources/:id — update source config.
 * Batch 007, Item 2 (Section 5.4).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("PUT /api/sources/:id (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let sourceBId: string;

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
      VALUES (${`Update Source Tenant A ${Date.now()}`}, ${hashA}, true)
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
      VALUES (${`Update Source Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;

    // Create source for Tenant A
    const srcResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_header, signature_algo, signing_secret, enabled)
      VALUES (${tenantId}, 'Original Name', ${`update-src-${Date.now()}`}, 'x-sig', 'hmac-sha256', 'secret123', true)
      RETURNING id
    `;
    sourceId = srcResult[0]!.id as string;

    // Create source for Tenant B
    const srcBResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'Tenant B Source', ${`b-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceBId = srcBResult[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should update source name and return updated source", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Updated Name" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("source");
    expect(body.source.id).toBe(sourceId);
    expect(body.source.name).toBe("Updated Name");
    expect(body.source).toHaveProperty("updated_at");
  });

  it("should update multiple fields at once", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: {
        name: "Multi Update",
        signature_header: "x-new-sig",
        signature_algo: "hmac-sha1",
        enabled: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.source.name).toBe("Multi Update");
    expect(body.source.signature_header).toBe("x-new-sig");
    expect(body.source.signature_algo).toBe("hmac-sha1");
    expect(body.source.enabled).toBe(false);
  });

  it("should persist updates in the database", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Persisted Name" },
    });

    const dbResult = await db.sql`
      SELECT name FROM sources WHERE id = ${sourceId}
    `;
    expect(dbResult[0]!.name).toBe("Persisted Name");
  });

  it("should return 404 for non-existent source ID", async () => {
    const fakeId = crypto.randomUUID();
    const response = await app.inject({
      method: "PUT",
      url: `/api/sources/${fakeId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Ghost Source" },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SOURCE_NOT_FOUND");
  });

  it("should return 404 when Tenant A tries to update Tenant B's source (cross-tenant)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceBId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Hijacked" },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SOURCE_NOT_FOUND");

    // Verify Tenant B's source is unchanged
    const dbResult = await db.sql`
      SELECT name FROM sources WHERE id = ${sourceBId}
    `;
    expect(dbResult[0]!.name).toBe("Tenant B Source");
  });

  it("should return 400 for invalid source ID format", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/sources/not-a-uuid",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Bad ID" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 400 for invalid signature_algo value", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { signature_algo: "md5" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/sources/${sourceId}`,
      headers: { "content-type": "application/json" },
      payload: { name: "No Auth" },
    });

    expect(response.statusCode).toBe(401);
  });
});
