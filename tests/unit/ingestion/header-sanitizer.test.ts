/**
 * Unit tests for header sanitizer.
 * Tests:
 * - Strips Authorization header (case-insensitive)
 * - Strips Cookie header (case-insensitive)
 * - Strips Set-Cookie header (case-insensitive)
 * - Strips Proxy-Authorization header (case-insensitive)
 * - Preserves webhook-specific headers (stripe-signature, x-hub-signature)
 * - Preserves content-type and other standard headers
 * - Handles empty headers object
 * - Handles headers with mixed case sensitive keys
 */

import { describe, it, expect } from "vitest";

describe("header-sanitizer (unit)", () => {
  it("should strip Authorization header", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const headers = {
      authorization: "Bearer token123",
      "content-type": "application/json",
    };
    const result = sanitizeHeaders(headers);
    expect(result).not.toHaveProperty("authorization");
    expect(result["content-type"]).toBe("application/json");
  });

  it("should strip Authorization header case-insensitively", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const headers = {
      Authorization: "Bearer token123",
      AUTHORIZATION: "Bearer token456",
    };
    const result = sanitizeHeaders(headers);
    expect(Object.keys(result).filter((k) => k.toLowerCase() === "authorization")).toHaveLength(0);
  });

  it("should strip Cookie header", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const headers = {
      cookie: "session=abc123",
      "content-type": "application/json",
    };
    const result = sanitizeHeaders(headers);
    expect(result).not.toHaveProperty("cookie");
  });

  it("should strip Set-Cookie header", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const headers = {
      "set-cookie": "session=abc123; Path=/",
      "content-type": "application/json",
    };
    const result = sanitizeHeaders(headers);
    expect(result).not.toHaveProperty("set-cookie");
  });

  it("should strip Proxy-Authorization header", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const headers = {
      "proxy-authorization": "Basic dXNlcjpwYXNz",
      "content-type": "application/json",
    };
    const result = sanitizeHeaders(headers);
    expect(result).not.toHaveProperty("proxy-authorization");
  });

  it("should preserve webhook-specific headers", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const headers = {
      "stripe-signature": "t=123,v1=abc",
      "x-hub-signature-256": "sha256=def",
      "x-shopify-hmac-sha256": "ghi",
      "content-type": "application/json",
    };
    const result = sanitizeHeaders(headers);
    expect(result["stripe-signature"]).toBe("t=123,v1=abc");
    expect(result["x-hub-signature-256"]).toBe("sha256=def");
    expect(result["x-shopify-hmac-sha256"]).toBe("ghi");
    expect(result["content-type"]).toBe("application/json");
  });

  it("should handle empty headers object", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const result = sanitizeHeaders({});
    expect(result).toEqual({});
  });

  it("should strip all sensitive headers at once", async () => {
    const { sanitizeHeaders } = await import(
      "../../../src/ingestion/header-sanitizer.js"
    );
    const headers = {
      authorization: "Bearer abc",
      cookie: "session=xyz",
      "set-cookie": "session=xyz; Path=/",
      "proxy-authorization": "Basic abc",
      "content-type": "application/json",
      "x-request-id": "req-123",
    };
    const result = sanitizeHeaders(headers);
    expect(Object.keys(result)).toEqual(["content-type", "x-request-id"]);
  });
});
