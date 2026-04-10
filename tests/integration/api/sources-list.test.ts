/**
 * Integration tests for GET /api/sources — list sources with delivery stats.
 * Batch 007, Item 1 (Section 5.4).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("GET /api/sources (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let tenantBApiKey: string;
  let tenantBId: string;

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
      VALUES (${`List Sources Tenant A ${Date.now()}`}, ${hashA}, true)
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
      VALUES (${`List Sources Tenant B ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;

    // Create sources for Tenant A with staggered created_at for cursor pagination
    const now = new Date();
    const t1 = new Date(now.getTime() - 3000).toISOString();
    const t2 = new Date(now.getTime() - 2000).toISOString();
    const t3 = new Date(now.getTime() - 1000).toISOString();
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled, created_at)
      VALUES
        (${tenantId}, 'Source Alpha', ${`alpha-${Date.now()}`}, true, ${t1}::timestamptz),
        (${tenantId}, 'Source Beta', ${`beta-${Date.now()}`}, true, ${t2}::timestamptz),
        (${tenantId}, 'Source Gamma', ${`gamma-${Date.now()}`}, true, ${t3}::timestamptz)
    `;

    // Create source for Tenant B (should NOT appear in Tenant A's list)
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantBId}, 'Source B Only', ${`b-only-${Date.now()}`}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM events WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM destinations WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantId}, ${tenantBId})`;
    await app.close();
  });

  it("should return only the authenticated tenant's sources", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sources",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("sources");
    expect(body).toHaveProperty("total");
    expect(body.total).toBe(3);
    expect(body.sources).toHaveLength(3);

    // Verify all returned sources belong to Tenant A
    for (const source of body.sources) {
      expect(source.tenant_id).toBe(tenantId);
    }
  });

  it("should not return sources belonging to another tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sources",
      headers: { "x-api-key": tenantBApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(1);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].name).toBe("Source B Only");
  });

  it("should include delivery stats for each source", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sources",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    for (const source of body.sources) {
      expect(source).toHaveProperty("stats");
      expect(source.stats).toHaveProperty("total_events");
      expect(source.stats).toHaveProperty("successful_deliveries");
      expect(source.stats).toHaveProperty("failed_deliveries");
      expect(typeof source.stats.total_events).toBe("number");
      expect(typeof source.stats.successful_deliveries).toBe("number");
      expect(typeof source.stats.failed_deliveries).toBe("number");
    }
  });

  it("should support pagination with limit parameter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sources?limit=2",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.sources).toHaveLength(2);
    // Total should still reflect all sources
    expect(body.total).toBe(3);
  });

  it("should support cursor-based pagination", async () => {
    // Get first page
    const page1 = await app.inject({
      method: "GET",
      url: "/api/sources?limit=2",
      headers: { "x-api-key": tenantApiKey },
    });

    const body1 = JSON.parse(page1.body);
    expect(body1.sources).toHaveLength(2);
    expect(body1).toHaveProperty("cursor");

    // Get second page using cursor
    const page2 = await app.inject({
      method: "GET",
      url: `/api/sources?limit=2&cursor=${body1.cursor}`,
      headers: { "x-api-key": tenantApiKey },
    });

    const body2 = JSON.parse(page2.body);
    expect(body2.sources).toHaveLength(1);

    // Pages should not overlap
    const page1Ids = body1.sources.map((s: { id: string }) => s.id);
    const page2Ids = body2.sources.map((s: { id: string }) => s.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sources",
    });

    expect(response.statusCode).toBe(401);
  });

  it("should return empty list when tenant has no sources", async () => {
    // Create a tenant with no sources
    const emptyKey = crypto.randomBytes(32).toString("hex");
    const emptyHash = crypto
      .createHash("sha256")
      .update(emptyKey)
      .digest("hex");
    const emptyResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Empty Tenant ${Date.now()}`}, ${emptyHash}, true)
      RETURNING id
    `;
    const emptyTenantId = emptyResult[0]!.id as string;

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/sources",
        headers: { "x-api-key": emptyKey },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sources).toHaveLength(0);
      expect(body.total).toBe(0);
    } finally {
      await db.sql`DELETE FROM tenants WHERE id = ${emptyTenantId}`;
    }
  });
});
