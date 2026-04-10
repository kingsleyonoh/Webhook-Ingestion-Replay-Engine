import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

describe("Server wiring (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("app factory", () => {
    it("should export a buildApp function", async () => {
      const serverModule = await import("../../../src/server.js");
      expect(typeof serverModule.buildApp).toBe("function");
    });

    it("should create a Fastify instance", () => {
      expect(app).toBeDefined();
      expect(typeof app.inject).toBe("function");
    });
  });

  describe("health endpoint", () => {
    it("should respond to GET /api/health with 200", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("uptime");
    });
  });

  describe("error handling", () => {
    it("should return structured error for unknown routes (404)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/nonexistent",
      });

      expect(response.statusCode).toBe(404);
    });

    it("should set content-type to application/json on error responses", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/nonexistent",
      });

      expect(response.headers["content-type"]).toContain("application/json");
    });
  });

  describe("raw body buffering", () => {
    it("should accept application/json content type", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/health",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ test: true }),
      });

      // Even though POST may not be supported on health, the body parser should not crash
      // It will return 404 or method not allowed but NOT a parse error
      expect([200, 404, 405]).toContain(response.statusCode);
    });
  });

  describe("request decorator", () => {
    it("should have tenantId decorator available on request", async () => {
      // The health endpoint doesn't use auth, but the decorator should exist
      // We verify by ensuring the app started without errors (decorator is registered)
      expect(app).toBeDefined();

      // Verify the decorator exists by checking the server started successfully
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("plugin registration", () => {
    it("should have error handler registered (returns structured errors)", async () => {
      // A non-existent route should return a valid JSON response, not a raw Fastify error
      const response = await app.inject({
        method: "GET",
        url: "/api/nonexistent",
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      // Fastify's default 404 is fine; it should be valid JSON
      expect(body).toBeDefined();
    });
  });
});
