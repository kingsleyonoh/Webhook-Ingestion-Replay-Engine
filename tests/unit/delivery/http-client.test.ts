/**
 * Unit tests for HTTP client — webhook delivery with timeout and redirect handling.
 * Section 5.2 edge cases: follow up to 3 redirects, timeout → failure, body truncation.
 *
 * Uses nock to intercept outgoing HTTP requests.
 */

import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";

import { deliverWebhook } from "../../../src/delivery/http-client.js";

afterEach(() => {
  nock.cleanAll();
});

describe("deliverWebhook — HTTP client", () => {
  const baseUrl = "https://dest.example.com";
  const defaultParams = {
    url: `${baseUrl}/hook`,
    method: "POST",
    headers: { "content-type": "application/json" },
    payload: { event: "test.event", data: { id: 1 } },
    timeoutMs: 5000,
  };

  describe("successful delivery", () => {
    it("should return status 200 with response body and duration", async () => {
      nock(baseUrl)
        .post("/hook")
        .reply(200, { ok: true });

      const result = await deliverWebhook(defaultParams);

      expect(result.statusCode).toBe(200);
      expect(result.responseBody).toContain("ok");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it("should send payload as JSON body", async () => {
      nock(baseUrl)
        .post("/hook", { event: "test.event", data: { id: 1 } })
        .reply(200, "accepted");

      const result = await deliverWebhook(defaultParams);

      expect(result.statusCode).toBe(200);
    });

    it("should include custom headers in the request", async () => {
      nock(baseUrl)
        .post("/hook")
        .matchHeader("x-custom", "value123")
        .reply(200, "ok");

      const result = await deliverWebhook({
        ...defaultParams,
        headers: { ...defaultParams.headers, "x-custom": "value123" },
      });

      expect(result.statusCode).toBe(200);
    });

    it("should handle non-2xx as delivery result (not error)", async () => {
      nock(baseUrl)
        .post("/hook")
        .reply(500, "Internal Server Error");

      const result = await deliverWebhook(defaultParams);

      expect(result.statusCode).toBe(500);
      expect(result.responseBody).toBe("Internal Server Error");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe("timeout handling", () => {
    it("should return error when request exceeds timeoutMs", async () => {
      nock(baseUrl)
        .post("/hook")
        .delayConnection(3000)
        .reply(200, "too late");

      const result = await deliverWebhook({
        ...defaultParams,
        timeoutMs: 500,
      });

      expect(result.statusCode).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/timeout|abort/i);
      expect(result.durationMs).toBeGreaterThanOrEqual(400);
    });
  });

  describe("redirect following", () => {
    it("should follow up to 3 redirects and return final response", async () => {
      nock(baseUrl)
        .post("/hook")
        .reply(302, "", { location: `${baseUrl}/redirect1` });

      nock(baseUrl)
        .post("/redirect1")
        .reply(302, "", { location: `${baseUrl}/redirect2` });

      nock(baseUrl)
        .post("/redirect2")
        .reply(302, "", { location: `${baseUrl}/final` });

      nock(baseUrl)
        .post("/final")
        .reply(200, "final destination");

      const result = await deliverWebhook({
        ...defaultParams,
        maxRedirects: 3,
      });

      expect(result.statusCode).toBe(200);
      expect(result.responseBody).toBe("final destination");
    });

    it("should follow 301 redirects", async () => {
      nock(baseUrl)
        .post("/hook")
        .reply(301, "", { location: `${baseUrl}/moved` });

      nock(baseUrl)
        .post("/moved")
        .reply(200, "new location");

      const result = await deliverWebhook(defaultParams);

      expect(result.statusCode).toBe(200);
      expect(result.responseBody).toBe("new location");
    });

    it("should fail when exceeding max redirects (4th redirect)", async () => {
      nock(baseUrl)
        .post("/hook")
        .reply(302, "", { location: `${baseUrl}/r1` });

      nock(baseUrl)
        .post("/r1")
        .reply(302, "", { location: `${baseUrl}/r2` });

      nock(baseUrl)
        .post("/r2")
        .reply(302, "", { location: `${baseUrl}/r3` });

      nock(baseUrl)
        .post("/r3")
        .reply(302, "", { location: `${baseUrl}/r4` });

      const result = await deliverWebhook({
        ...defaultParams,
        maxRedirects: 3,
      });

      expect(result.statusCode).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/redirect/i);
    });

    it("should default maxRedirects to 3 if not specified", async () => {
      // 3 redirects should work (default)
      nock(baseUrl)
        .post("/hook")
        .reply(302, "", { location: `${baseUrl}/r1` });
      nock(baseUrl)
        .post("/r1")
        .reply(302, "", { location: `${baseUrl}/r2` });
      nock(baseUrl)
        .post("/r2")
        .reply(302, "", { location: `${baseUrl}/r3` });
      nock(baseUrl)
        .post("/r3")
        .reply(200, "reached");

      const result = await deliverWebhook(defaultParams);
      expect(result.statusCode).toBe(200);
    });
  });

  describe("response body truncation", () => {
    it("should truncate response body at 4KB", async () => {
      const largeBody = "x".repeat(8192); // 8KB
      nock(baseUrl)
        .post("/hook")
        .reply(200, largeBody);

      const result = await deliverWebhook(defaultParams);

      expect(result.statusCode).toBe(200);
      expect(result.responseBody.length).toBe(4096);
    });

    it("should not truncate response body under 4KB", async () => {
      const smallBody = "y".repeat(2000);
      nock(baseUrl)
        .post("/hook")
        .reply(200, smallBody);

      const result = await deliverWebhook(defaultParams);

      expect(result.responseBody.length).toBe(2000);
    });
  });

  describe("HTTP method support", () => {
    it("should use the specified HTTP method", async () => {
      nock(baseUrl)
        .put("/hook")
        .reply(200, "put ok");

      const result = await deliverWebhook({
        ...defaultParams,
        method: "PUT",
      });

      expect(result.statusCode).toBe(200);
      expect(result.responseBody).toBe("put ok");
    });
  });

  describe("network errors", () => {
    it("should return error on connection failure", async () => {
      nock(baseUrl)
        .post("/hook")
        .replyWithError("ECONNREFUSED");

      const result = await deliverWebhook(defaultParams);

      expect(result.statusCode).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
