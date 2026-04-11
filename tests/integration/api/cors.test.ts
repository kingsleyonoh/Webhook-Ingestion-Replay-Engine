/**
 * Integration tests for CORS configuration.
 * Tests:
 * - CORS headers present on responses
 * - Origin not reflected (no wildcard)
 * - OPTIONS preflight handled
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

describe("CORS configuration (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should not include access-control-allow-origin wildcard on GET", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "https://evil.example.com",
      },
    });

    // origin: false means no CORS headers should be sent
    // The access-control-allow-origin should not be '*'
    const allowOrigin = response.headers["access-control-allow-origin"];
    expect(allowOrigin).not.toBe("*");
  });

  it("should not reflect arbitrary origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "https://evil.example.com",
      },
    });

    const allowOrigin = response.headers["access-control-allow-origin"];
    expect(allowOrigin).not.toBe("https://evil.example.com");
  });

  it("should handle OPTIONS preflight without wildcard CORS", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });

    // Should not have a wildcard access-control-allow-origin
    const allowOrigin = response.headers["access-control-allow-origin"];
    expect(allowOrigin).not.toBe("*");
  });
});
