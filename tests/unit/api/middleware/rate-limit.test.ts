import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

describe("Rate limit middleware", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { rateLimitPlugin, RATE_LIMITS } = await import(
      "../../../../src/api/middleware/rate-limit.js"
    );

    app = Fastify({ logger: false });

    await app.register(rateLimitPlugin);

    // Register a test route with a very low limit for testing
    app.get(
      "/test/limited",
      {
        config: {
          rateLimit: {
            max: 3,
            timeWindow: "1 minute",
          },
        },
      },
      async () => {
        return { ok: true };
      }
    );

    // Register a route without specific rate limit (uses global)
    app.get("/test/default", async () => {
      return { ok: true };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should allow requests within the rate limit", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/limited",
      remoteAddress: "10.0.0.1",
    });

    expect(response.statusCode).toBe(200);
  });

  it("should return 429 when rate limit is exceeded", async () => {
    // Use a unique IP for this test to avoid interference
    const testIp = "10.0.0.2";

    // Exhaust the limit (3 requests)
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "GET",
        url: "/test/limited",
        remoteAddress: testIp,
      });
    }

    // 4th request should be rejected
    const response = await app.inject({
      method: "GET",
      url: "/test/limited",
      remoteAddress: testIp,
    });

    expect(response.statusCode).toBe(429);
  });

  it("should include rate limit headers in response", async () => {
    const testIp = "10.0.0.3";
    const response = await app.inject({
      method: "GET",
      url: "/test/limited",
      remoteAddress: testIp,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
  });

  it("should export RATE_LIMITS configuration object", async () => {
    const { RATE_LIMITS } = await import(
      "../../../../src/api/middleware/rate-limit.js"
    );
    expect(RATE_LIMITS).toBeDefined();
    expect(RATE_LIMITS).toHaveProperty("webhookIngestion");
    expect(RATE_LIMITS).toHaveProperty("tenantRegister");
    expect(RATE_LIMITS).toHaveProperty("eventsRead");
    expect(RATE_LIMITS.webhookIngestion.max).toBe(1000);
    expect(RATE_LIMITS.tenantRegister.max).toBe(5);
  });

  it("should allow different limits per route config", async () => {
    const { RATE_LIMITS } = await import(
      "../../../../src/api/middleware/rate-limit.js"
    );
    // Verify per-endpoint configs exist per Section 8b
    expect(RATE_LIMITS.webhookIngestion.max).toBe(1000);
    expect(RATE_LIMITS.tenantRegister.max).toBe(5);
    expect(RATE_LIMITS.tenantMe.max).toBe(100);
    expect(RATE_LIMITS.sourcesCreate.max).toBe(50);
    expect(RATE_LIMITS.sourcesRead.max).toBe(100);
    expect(RATE_LIMITS.sourcesUpdate.max).toBe(50);
    expect(RATE_LIMITS.destinationsCreate.max).toBe(50);
    expect(RATE_LIMITS.eventsRead.max).toBe(200);
    expect(RATE_LIMITS.replaysCreate.max).toBe(10);
    expect(RATE_LIMITS.deadLettersRead.max).toBe(100);
    expect(RATE_LIMITS.deadLettersRetry.max).toBe(50);
    expect(RATE_LIMITS.statsRead.max).toBe(60);
  });
});
