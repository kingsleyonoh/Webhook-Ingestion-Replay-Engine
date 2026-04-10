/**
 * Integration tests for tenant registration and profile endpoints.
 * POST /api/tenants/register — public, rate-limited (5/min)
 * GET /api/tenants/me — authenticated (100/min)
 *
 * Rate limit is 5/min on register, so each describe group uses its
 * own Fastify instance to avoid cross-test rate limit interference.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("POST /api/tenants/register (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  const createdApiKeyHashes: string[] = [];

  beforeAll(async () => {
    process.env["SELF_REGISTRATION_ENABLED"] = "true";
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    for (const hash of createdApiKeyHashes) {
      await db.sql`DELETE FROM tenants WHERE api_key = ${hash}`;
    }
    await db.sql`DELETE FROM tenants WHERE name LIKE 'Test Tenant%'`;
    await app.close();
  });

  it("should create a tenant and return API key on success", async () => {
    const name = `Test Tenant ${Date.now()}`;

    const response = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: { name },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);

    // Response shape
    expect(body).toHaveProperty("tenant");
    expect(body).toHaveProperty("apiKey");
    expect(body.tenant).toHaveProperty("id");
    expect(body.tenant).toHaveProperty("name", name);
    expect(body.tenant).toHaveProperty("is_active", true);
    expect(body.tenant).toHaveProperty("created_at");

    // API key should be a non-empty string
    expect(typeof body.apiKey).toBe("string");
    expect(body.apiKey.length).toBeGreaterThan(0);

    // API key should NOT be in the tenant object
    expect(body.tenant).not.toHaveProperty("api_key");
    expect(body.tenant).not.toHaveProperty("apiKey");

    // Track for cleanup
    const hash = crypto
      .createHash("sha256")
      .update(body.apiKey)
      .digest("hex");
    createdApiKeyHashes.push(hash);

    // Verify tenant was actually persisted
    const dbResult =
      await db.sql`SELECT id, name, is_active FROM tenants WHERE api_key = ${hash}`;
    expect(dbResult).toHaveLength(1);
    expect(dbResult[0]!.name).toBe(name);
  });

  it("should return 403 when self-registration is disabled", async () => {
    process.env["SELF_REGISTRATION_ENABLED"] = "false";

    const { buildApp: buildApp2 } = await import(
      "../../../src/server.js"
    );
    const app2 = await buildApp2();
    await app2.ready();

    try {
      const response = await app2.inject({
        method: "POST",
        url: "/api/tenants/register",
        payload: { name: "Should Not Register" },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("REGISTRATION_DISABLED");
    } finally {
      process.env["SELF_REGISTRATION_ENABLED"] = "true";
      await app2.close();
    }
  });

  it("should return 400 when name is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 when name is empty string", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: { name: "" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("should return 400 when name is only whitespace", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: { name: "   " },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/tenants/register — duplicate handling (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  const createdApiKeyHashes: string[] = [];

  beforeAll(async () => {
    process.env["SELF_REGISTRATION_ENABLED"] = "true";
    // Fresh app instance to reset rate limit counters
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();
    // Clean up any leftover from prior runs
    await db.sql`DELETE FROM tenants WHERE name = 'Duplicate Tenant'`;
  });

  afterAll(async () => {
    for (const hash of createdApiKeyHashes) {
      await db.sql`DELETE FROM tenants WHERE api_key = ${hash}`;
    }
    await db.sql`DELETE FROM tenants WHERE name = 'Duplicate Tenant'`;
    await app.close();
  });

  it("should handle duplicate name gracefully with 409", async () => {
    const name = "Duplicate Tenant";

    // First registration
    const res1 = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: { name },
    });
    expect(res1.statusCode).toBe(201);
    const body1 = JSON.parse(res1.body);
    const hash1 = crypto
      .createHash("sha256")
      .update(body1.apiKey)
      .digest("hex");
    createdApiKeyHashes.push(hash1);

    // Second registration with same name
    const res2 = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: { name },
    });

    expect(res2.statusCode).toBe(409);
    const body2 = JSON.parse(res2.body);
    expect(body2.error.code).toBe("DUPLICATE_TENANT");
  });

  it("should generate unique API keys for different tenants", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: { name: `Test Tenant A ${Date.now()}` },
    });
    const res2 = await app.inject({
      method: "POST",
      url: "/api/tenants/register",
      payload: { name: `Test Tenant B ${Date.now()}` },
    });

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);

    expect(body1.apiKey).not.toBe(body2.apiKey);

    // Track for cleanup
    createdApiKeyHashes.push(
      crypto.createHash("sha256").update(body1.apiKey).digest("hex")
    );
    createdApiKeyHashes.push(
      crypto.createHash("sha256").update(body2.apiKey).digest("hex")
    );
  });
});

describe("GET /api/tenants/me (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;

  beforeAll(async () => {
    process.env["SELF_REGISTRATION_ENABLED"] = "true";
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create tenant directly via DB to avoid using registration endpoint
    tenantApiKey = crypto.randomBytes(32).toString("hex");
    const hash = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");

    const result = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Test Profile Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = result[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should return tenant profile with valid API key", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants/me",
      headers: { "x-api-key": tenantApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty("tenant");
    expect(body.tenant).toHaveProperty("id", tenantId);
    expect(body.tenant).toHaveProperty("name");
    expect(body.tenant).toHaveProperty("is_active", true);
    expect(body.tenant).toHaveProperty("created_at");

    // API key must NOT be in the response
    expect(body.tenant).not.toHaveProperty("api_key");
    expect(body.tenant).not.toHaveProperty("apiKey");
  });

  it("should return 401 when no API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants/me",
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_NOT_FOUND");
  });

  it("should return 401 when invalid API key provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants/me",
      headers: { "x-api-key": "invalid-key-does-not-exist" },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_NOT_FOUND");
  });

  it("should return correct tenant fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/tenants/me",
      headers: { "x-api-key": tenantApiKey },
    });

    const body = JSON.parse(response.body);
    const tenant = body.tenant;

    // Validate UUID format
    expect(tenant.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // Validate ISO date format
    expect(() => new Date(tenant.created_at)).not.toThrow();
    expect(new Date(tenant.created_at).toISOString()).toBeTruthy();

    // Validate is_active is boolean
    expect(typeof tenant.is_active).toBe("boolean");
  });
});
