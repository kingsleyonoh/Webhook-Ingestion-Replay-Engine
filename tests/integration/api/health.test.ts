/**
 * Integration tests for enhanced health check endpoint.
 * GET /api/health — public, no auth, no rate limit
 * Reports: DB, Redis, queue depth status.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

describe("Health endpoint (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/health — all services up", () => {
    it("should return 200 with status ok", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("ok");
    });

    it("should include uptime as a number", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      const body = JSON.parse(response.body);
      expect(typeof body.uptime).toBe("number");
      expect(body.uptime).toBeGreaterThan(0);
    });

    it("should include version string", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      const body = JSON.parse(response.body);
      expect(typeof body.version).toBe("string");
      expect(body.version.length).toBeGreaterThan(0);
    });

    it("should include checks object with database, redis, queue_depth", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      const body = JSON.parse(response.body);
      expect(body).toHaveProperty("checks");
      expect(body.checks).toHaveProperty("database");
      expect(body.checks).toHaveProperty("redis");
      expect(body.checks).toHaveProperty("queue_depth");
    });

    it("should report database as ok when PostgreSQL is reachable", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      const body = JSON.parse(response.body);
      expect(body.checks.database).toBe("ok");
    });

    it("should report redis as ok when Redis is reachable", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      const body = JSON.parse(response.body);
      expect(body.checks.redis).toBe("ok");
    });

    it("should report queue_depth as a number", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      const body = JSON.parse(response.body);
      expect(typeof body.checks.queue_depth).toBe("number");
      expect(body.checks.queue_depth).toBeGreaterThanOrEqual(0);
    });
  });

  describe("GET /api/health — degraded states", () => {
    it("should return degraded when database is unreachable", async () => {
      // Build a new app with invalid DB URL to simulate DB down
      const originalDbUrl = process.env["DATABASE_URL"];
      process.env["DATABASE_URL"] =
        "postgresql://postgres:devpass@localhost:59999/webhooks";

      const { buildApp: buildApp2 } = await import(
        "../../../src/server.js"
      );
      const app2 = await buildApp2();
      await app2.ready();

      try {
        const response = await app2.inject({
          method: "GET",
          url: "/api/health",
        });

        const body = JSON.parse(response.body);
        expect(body.status).toBe("degraded");
        expect(body.checks.database).toBe("error");
      } finally {
        process.env["DATABASE_URL"] = originalDbUrl;
        await app2.close();
      }
    });

    it("should return degraded when Redis is unreachable", async () => {
      // Build a new app with invalid Redis URL
      const originalRedisUrl = process.env["REDIS_URL"];
      process.env["REDIS_URL"] = "redis://localhost:59998";

      const { buildApp: buildApp3 } = await import(
        "../../../src/server.js"
      );
      const app3 = await buildApp3();
      await app3.ready();

      try {
        const response = await app3.inject({
          method: "GET",
          url: "/api/health",
        });

        const body = JSON.parse(response.body);
        expect(body.status).toBe("degraded");
        expect(body.checks.redis).toBe("error");
      } finally {
        process.env["REDIS_URL"] = originalRedisUrl;
        await app3.close();
      }
    });
  });

  describe("GET /api/health — no auth required", () => {
    it("should not require X-API-Key header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      // Should NOT be 401
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).toBe(200);
    });
  });
});
