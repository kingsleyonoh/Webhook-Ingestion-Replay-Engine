/**
 * Integration tests for security headers via @fastify/helmet.
 * Verifies that X-Content-Type-Options and X-Frame-Options headers
 * are present in responses.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

describe("Security headers (@fastify/helmet)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should include X-Content-Type-Options: nosniff header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("should include X-Frame-Options header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    // helmet defaults to SAMEORIGIN
    expect(response.headers["x-frame-options"]).toBeDefined();
  });

  it("should include X-DNS-Prefetch-Control header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.headers["x-dns-prefetch-control"]).toBeDefined();
  });

  it("should include X-Download-Options header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.headers["x-download-options"]).toBeDefined();
  });
});
