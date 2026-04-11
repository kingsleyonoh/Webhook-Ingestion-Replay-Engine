/**
 * Unit tests for signature timestamp tolerance.
 * Tests: fresh timestamp -> accepted, stale timestamp -> rejected,
 *        no timestamp -> accepted (backward compat), toleranceMs=0 disables check.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";

describe("Signature Timestamp Tolerance (src/ingestion/signature.ts)", () => {
  const signingSecret = "whsec_test_secret_timestamp_tolerance";
  const rawBody = Buffer.from(
    JSON.stringify({ event: "test", data: { id: 1 } })
  );

  // Compute a valid HMAC-SHA256 signature for the raw body
  function computeSignature(): string {
    return crypto
      .createHmac("sha256", signingSecret)
      .update(rawBody)
      .digest("hex");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fresh timestamp", () => {
    it("should accept a signature with a fresh timestamp within tolerance", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const now = Date.now();
      const result = verifySignature({
        rawBody,
        signatureHeader: computeSignature(),
        signingSecret,
        algorithm: "hmac-sha256",
        timestampMs: now - 1000, // 1 second ago — well within 5 min
        toleranceMs: 300_000,
      });

      expect(result).toBe(true);
    });

    it("should accept a signature with timestamp exactly at tolerance boundary", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const now = Date.now();
      // Mock Date.now to get deterministic behavior
      vi.spyOn(Date, "now").mockReturnValue(now);

      const result = verifySignature({
        rawBody,
        signatureHeader: computeSignature(),
        signingSecret,
        algorithm: "hmac-sha256",
        timestampMs: now - 300_000, // exactly 5 minutes ago
        toleranceMs: 300_000,
      });

      expect(result).toBe(true);
    });
  });

  describe("stale timestamp", () => {
    it("should reject a signature with a stale timestamp beyond tolerance", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);

      const result = verifySignature({
        rawBody,
        signatureHeader: computeSignature(),
        signingSecret,
        algorithm: "hmac-sha256",
        timestampMs: now - 400_000, // 6m 40s ago — beyond 5 min tolerance
        toleranceMs: 300_000,
      });

      expect(result).toBe(false);
    });

    it("should reject a signature with a very old timestamp", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: computeSignature(),
        signingSecret,
        algorithm: "hmac-sha256",
        timestampMs: 1000000000000, // 2001 — very old
        toleranceMs: 300_000,
      });

      expect(result).toBe(false);
    });
  });

  describe("no timestamp (backward compatibility)", () => {
    it("should accept a valid signature when no timestampMs is provided", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: computeSignature(),
        signingSecret,
        algorithm: "hmac-sha256",
        // No timestampMs — backward compat
      });

      expect(result).toBe(true);
    });

    it("should accept a valid signature when timestampMs is undefined", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: computeSignature(),
        signingSecret,
        algorithm: "hmac-sha256",
        timestampMs: undefined,
        toleranceMs: 300_000,
      });

      expect(result).toBe(true);
    });
  });

  describe("toleranceMs=0 disables check", () => {
    it("should accept a valid signature with old timestamp when toleranceMs is 0", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: computeSignature(),
        signingSecret,
        algorithm: "hmac-sha256",
        timestampMs: 1000000000000, // 2001 — very old
        toleranceMs: 0, // disabled
      });

      expect(result).toBe(true);
    });
  });

  describe("extractTimestampFromHeader", () => {
    it("should extract Stripe-style t= timestamp from signature header", async () => {
      const { extractTimestampFromHeader } = await import(
        "../../../src/ingestion/signature.js"
      );

      const sig = computeSignature();
      const timestampSeconds = 1700000000;
      const header = `t=${timestampSeconds},v1=${sig}`;

      const result = extractTimestampFromHeader(header);
      expect(result).toBe(timestampSeconds * 1000); // converted to milliseconds
    });

    it("should return undefined for headers without t= prefix", async () => {
      const { extractTimestampFromHeader } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = extractTimestampFromHeader("sha256=abcdef123456");
      expect(result).toBeUndefined();
    });

    it("should return undefined for empty header", async () => {
      const { extractTimestampFromHeader } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = extractTimestampFromHeader("");
      expect(result).toBeUndefined();
    });

    it("should handle t= with invalid number gracefully", async () => {
      const { extractTimestampFromHeader } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = extractTimestampFromHeader("t=notanumber,v1=abc");
      expect(result).toBeUndefined();
    });
  });
});
