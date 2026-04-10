/**
 * Integration tests for POST /api/sources — register new webhook source.
 * Item 5 of Batch 006 (Section 5.4).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("POST /api/sources (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  const createdSourceIds: string[] = [];

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create test tenant directly via DB
    tenantApiKey = crypto.randomBytes(32).toString("hex");
    const hash = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");

    const result = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Sources Test Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = result[0]!.id as string;
  });

  afterAll(async () => {
    for (const id of createdSourceIds) {
      await db.sql`DELETE FROM sources WHERE id = ${id}`;
    }
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should create a source with full signature config and return 201", async () => {
    const slug = `full-config-${Date.now()}`;

    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: {
        name: "Stripe Webhooks",
        slug,
        signature_header: "stripe-signature",
        signature_algo: "hmac-sha256",
        signing_secret: "whsec_test123",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty("source");
    expect(body.source).toHaveProperty("id");
    expect(body.source).toHaveProperty("tenant_id", tenantId);
    expect(body.source).toHaveProperty("name", "Stripe Webhooks");
    expect(body.source).toHaveProperty("slug", slug);
    expect(body.source).toHaveProperty("signature_header", "stripe-signature");
    expect(body.source).toHaveProperty("signature_algo", "hmac-sha256");
    expect(body.source).toHaveProperty("enabled", true);
    expect(body.source).toHaveProperty("created_at");

    // Signing secret should NOT be returned in the response
    expect(body.source).not.toHaveProperty("signing_secret");
    expect(body.source).not.toHaveProperty("signingSecret");

    createdSourceIds.push(body.source.id);

    // Verify DB persistence
    const dbResult = await db.sql`
      SELECT id, tenant_id, name, slug, signature_header, signature_algo, signing_secret
      FROM sources WHERE id = ${body.source.id}
    `;
    expect(dbResult).toHaveLength(1);
    expect(dbResult[0]!.tenant_id).toBe(tenantId);
    expect(dbResult[0]!.signing_secret).toBe("whsec_test123");
  });

  it("should create a source with minimal config (name + slug only)", async () => {
    const slug = `minimal-${Date.now()}`;

    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: {
        name: "Generic Webhook",
        slug,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.source.name).toBe("Generic Webhook");
    expect(body.source.slug).toBe(slug);
    expect(body.source.enabled).toBe(true);

    createdSourceIds.push(body.source.id);
  });

  it("should return 409 for duplicate slug within the same tenant", async () => {
    const slug = `dup-slug-${Date.now()}`;

    // First creation
    const res1 = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Source A", slug },
    });
    expect(res1.statusCode).toBe(201);
    createdSourceIds.push(JSON.parse(res1.body).source.id);

    // Second creation with same slug
    const res2 = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Source B", slug },
    });

    expect(res2.statusCode).toBe(409);
    const body = JSON.parse(res2.body);
    expect(body.error.code).toBe("DUPLICATE_SOURCE");
  });

  it("should return 400 when name is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { slug: "missing-name" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 when slug is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Missing Slug Source" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 when slug contains invalid characters", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { name: "Bad Slug Source", slug: "invalid slug with spaces!" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 for invalid signature_algo value", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: {
        name: "Bad Algo Source",
        slug: `bad-algo-${Date.now()}`,
        signature_algo: "md5",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: { "content-type": "application/json" },
      payload: { name: "No Auth", slug: "no-auth" },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/sources — tenant scoping (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantAApiKey: string;
  let tenantAId: string;
  let tenantBApiKey: string;
  let tenantBId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();
    // Create Tenant A
    tenantAApiKey = crypto.randomBytes(32).toString("hex");
    const hashA = crypto.createHash("sha256").update(tenantAApiKey).digest("hex");
    const resultA = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Tenant A Sources ${Date.now()}`}, ${hashA}, true)
      RETURNING id
    `;
    tenantAId = resultA[0]!.id as string;
    // Create Tenant B
    tenantBApiKey = crypto.randomBytes(32).toString("hex");
    const hashB = crypto.createHash("sha256").update(tenantBApiKey).digest("hex");
    const resultB = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Tenant B Sources ${Date.now()}`}, ${hashB}, true)
      RETURNING id
    `;
    tenantBId = resultB[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM sources WHERE tenant_id IN (${tenantAId}, ${tenantBId})`;
    await db.sql`DELETE FROM tenants WHERE id IN (${tenantAId}, ${tenantBId})`;
    await app.close();
  });

  it("should allow same slug across different tenants", async () => {
    const slug = `shared-slug-${Date.now()}`;

    const resA = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantAApiKey,
      },
      payload: { name: "Shared Source A", slug },
    });
    expect(resA.statusCode).toBe(201);
    const bodyA = JSON.parse(resA.body);
    expect(bodyA.source.tenant_id).toBe(tenantAId);

    const resB = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantBApiKey,
      },
      payload: { name: "Shared Source B", slug },
    });
    expect(resB.statusCode).toBe(201);
    const bodyB = JSON.parse(resB.body);
    expect(bodyB.source.tenant_id).toBe(tenantBId);
  });
});
