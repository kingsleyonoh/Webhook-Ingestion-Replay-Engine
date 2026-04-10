import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Auth middleware (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let testTenantId: string;
  const testApiKey = "test-api-key-" + Date.now();
  const testApiKeyHash = crypto
    .createHash("sha256")
    .update(testApiKey)
    .digest("hex");

  const inactiveApiKey = "inactive-api-key-" + Date.now();
  const inactiveApiKeyHash = crypto
    .createHash("sha256")
    .update(inactiveApiKey)
    .digest("hex");

  beforeAll(async () => {
    // Insert test tenant with hashed API key
    const result = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES ('Test Auth Tenant', ${testApiKeyHash}, true)
      RETURNING id
    `;
    testTenantId = result[0]!.id as string;

    // Insert inactive tenant
    await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES ('Inactive Tenant', ${inactiveApiKeyHash}, false)
    `;

    // Build a test Fastify app with auth middleware
    const { authPlugin } = await import(
      "../../../src/api/middleware/auth.js"
    );
    const { errorHandlerPlugin } = await import(
      "../../../src/api/middleware/error-handler.js"
    );

    app = Fastify({ logger: false });

    // Decorate request with tenantId
    app.decorateRequest("tenantId", "");

    // Register error handler first
    await app.register(errorHandlerPlugin);

    // Register a protected route behind auth
    await app.register(async (instance) => {
      await instance.register(authPlugin);

      instance.get("/test/protected", async (request) => {
        return {
          tenantId: (request as unknown as { tenantId: string }).tenantId,
        };
      });
    });

    await app.ready();
  });

  afterAll(async () => {
    // Clean up test data
    await db.sql`DELETE FROM tenants WHERE api_key = ${testApiKeyHash}`;
    await db.sql`DELETE FROM tenants WHERE api_key = ${inactiveApiKeyHash}`;
    await app.close();
  });

  it("should resolve tenant from valid API key", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { "x-api-key": testApiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.tenantId).toBe(testTenantId);
  });

  it("should return 401 when X-API-Key header is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/protected",
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_NOT_FOUND");
  });

  it("should return 401 when API key is invalid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { "x-api-key": "completely-bogus-key" },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_NOT_FOUND");
  });

  it("should return 403 when tenant is inactive", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { "x-api-key": inactiveApiKey },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_INACTIVE");
  });

  it("should return 401 when API key is empty string", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/protected",
      headers: { "x-api-key": "" },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_NOT_FOUND");
  });
});
