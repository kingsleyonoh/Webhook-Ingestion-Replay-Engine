/**
 * Unit tests for idempotency key generation.
 * Tests: source header used when present, body hash used as fallback,
 *        same body produces same key.
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

describe("Idempotency Key Generation (src/ingestion/idempotency.ts)", () => {
  describe("generateIdempotencyKey", () => {
    const rawBody = Buffer.from(
      JSON.stringify({ event: "test.event", data: { id: 42 } })
    );

    it("should use source-provided header value when present", async () => {
      const { generateIdempotencyKey } = await import(
        "../../../src/ingestion/idempotency.js"
      );

      const result = generateIdempotencyKey({
        headers: {
          "stripe-webhook-id": "evt_1234567890",
          "content-type": "application/json",
        },
        rawBody,
        idempotencyHeader: "stripe-webhook-id",
      });

      expect(result).toBe("evt_1234567890");
    });

    it("should use SHA-256 body hash as fallback when no header configured", async () => {
      const { generateIdempotencyKey } = await import(
        "../../../src/ingestion/idempotency.js"
      );

      const result = generateIdempotencyKey({
        headers: {
          "content-type": "application/json",
        },
        rawBody,
      });

      const expectedHash = crypto
        .createHash("sha256")
        .update(rawBody)
        .digest("hex");

      expect(result).toBe(expectedHash);
    });

    it("should use SHA-256 body hash when header is configured but not present in request", async () => {
      const { generateIdempotencyKey } = await import(
        "../../../src/ingestion/idempotency.js"
      );

      const result = generateIdempotencyKey({
        headers: {
          "content-type": "application/json",
        },
        rawBody,
        idempotencyHeader: "x-webhook-id",
      });

      const expectedHash = crypto
        .createHash("sha256")
        .update(rawBody)
        .digest("hex");

      expect(result).toBe(expectedHash);
    });

    it("should produce the same key for the same body", async () => {
      const { generateIdempotencyKey } = await import(
        "../../../src/ingestion/idempotency.js"
      );

      const body = Buffer.from(JSON.stringify({ event: "deterministic" }));

      const key1 = generateIdempotencyKey({
        headers: {},
        rawBody: body,
      });

      const key2 = generateIdempotencyKey({
        headers: {},
        rawBody: body,
      });

      expect(key1).toBe(key2);
    });

    it("should produce different keys for different bodies", async () => {
      const { generateIdempotencyKey } = await import(
        "../../../src/ingestion/idempotency.js"
      );

      const body1 = Buffer.from(JSON.stringify({ event: "event-a" }));
      const body2 = Buffer.from(JSON.stringify({ event: "event-b" }));

      const key1 = generateIdempotencyKey({
        headers: {},
        rawBody: body1,
      });

      const key2 = generateIdempotencyKey({
        headers: {},
        rawBody: body2,
      });

      expect(key1).not.toBe(key2);
    });

    it("should handle case-insensitive header lookup", async () => {
      const { generateIdempotencyKey } = await import(
        "../../../src/ingestion/idempotency.js"
      );

      const result = generateIdempotencyKey({
        headers: {
          "X-Webhook-Id": "webhook-id-123",
        },
        rawBody,
        idempotencyHeader: "x-webhook-id",
      });

      expect(result).toBe("webhook-id-123");
    });
  });
});
