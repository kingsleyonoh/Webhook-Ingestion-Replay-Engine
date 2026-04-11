/**
 * Integration tests for JSON nesting depth limit.
 * Tests:
 * - Normal JSON payload accepted via webhook endpoint
 * - Deeply nested JSON (100 levels) rejected with 400
 * - Boundary: 20 levels deep accepted (at default limit)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("JSON nesting depth limit (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const sourceSlug = `json-depth-src-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    const uniqueApiKey = `test-api-key-json-depth-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueApiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`JSON Depth Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"JSON Depth Source"}, ${sourceSlug}, ${"none"}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should accept normal webhook JSON payload", async () => {
    const payload = JSON.stringify({
      event: "json.depth.normal",
      data: { nested: { value: 42 } },
      ts: Date.now(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(200);
  });

  it("should reject deeply nested JSON (100 levels) with 400", async () => {
    // Build 100-level deep JSON
    let json = "1";
    for (let i = 0; i < 100; i++) {
      json = `{"a":${json}}`;
    }

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: json,
    });

    expect(response.statusCode).toBe(400);
  });

  it("should accept JSON at exactly 20 levels deep (default limit)", async () => {
    // Build exactly 20-level deep JSON
    let json = "1";
    for (let i = 0; i < 20; i++) {
      json = `{"a":${json}}`;
    }

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: json,
    });

    expect(response.statusCode).toBe(200);
  });

  it("should reject JSON at 21 levels deep", async () => {
    // Build 21-level deep JSON
    let json = "1";
    for (let i = 0; i < 21; i++) {
      json = `{"a":${json}}`;
    }

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: json,
    });

    expect(response.statusCode).toBe(400);
  });
});
