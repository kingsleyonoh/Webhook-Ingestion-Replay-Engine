/**
 * Integration tests for DELETE /api/sources/:id/destinations/:destId.
 * Batch 007, Item 4 (Section 5.4).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("DELETE /api/sources/:id/destinations/:destId (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;
  let sourceId: string;
  let sourceBId: string;
  let destToDeleteId: string;
  let destBId: string;

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
      VALUES (${`Del Dest Tenant A ${Date.now()}`}, ${hashA}, true)
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
      VALUES (${`Del Dest Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;

    // Create source for Tenant A
    const srcResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Del Dest Source', ${`del-dest-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = srcResult[0]!.id as string;

    // Create source for Tenant B
    const srcBResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'Del Dest B Source', ${`del-dest-b-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceBId = srcBResult[0]!.id as string;

    // Create a destination to delete
    const destResult = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/to-delete', 'POST')
      RETURNING id
    `;
    destToDeleteId = destResult[0]!.id as string;

    // Create a destination for Tenant B
    const destBResult = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method)
      VALUES (${tenantBId}, ${sourceBId}, 'https://example.com/b-dest', 'POST')
      RETURNING id
    `;
    destBId = destBResult[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should delete a destination and return 204", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/sources/${sourceId}/destinations/${destToDeleteId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    // Verify deletion in DB
    const dbResult = await db.sql`
      SELECT id FROM destinations WHERE id = ${destToDeleteId}
    `;
    expect(dbResult).toHaveLength(0);
  });

  it("should return 404 for non-existent destination ID", async () => {
    const fakeDestId = crypto.randomUUID();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/sources/${sourceId}/destinations/${fakeDestId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("DESTINATION_NOT_FOUND");
  });

  it("should return 404 when Tenant A tries to delete Tenant B's destination (cross-tenant)", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/sources/${sourceBId}/destinations/${destBId}`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(404);

    // Verify Tenant B's destination is untouched
    const dbResult = await db.sql`
      SELECT id FROM destinations WHERE id = ${destBId}
    `;
    expect(dbResult).toHaveLength(1);
  });

  it("should return 400 for invalid destination ID format", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/sources/${sourceId}/destinations/not-a-uuid`,
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/sources/${sourceId}/destinations/${destBId}`,
    });

    expect(response.statusCode).toBe(401);
  });
});
