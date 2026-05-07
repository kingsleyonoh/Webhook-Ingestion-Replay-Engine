/**
 * Unit tests for HMAC signature verification module.
 * Tests: valid SHA-256 sig accepted, valid SHA-1 sig accepted,
 *        invalid sig rejected, `none` algo skips verification.
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

describe("Signature Verification (src/ingestion/signature.ts)", () => {
  const signingSecret = "whsec_test_secret_key_1234567890";
  const rawBody = Buffer.from(JSON.stringify({ event: "test", data: { id: 1 } }));

  describe("HMAC-SHA256", () => {
    it("should accept a valid SHA-256 signature", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const expectedSig = crypto
        .createHmac("sha256", signingSecret)
        .update(rawBody)
        .digest("hex");

      const result = verifySignature({
        rawBody,
        signatureHeader: expectedSig,
        signingSecret,
        algorithm: "hmac-sha256",
      });

      expect(result).toBe(true);
    });

    it("should reject an invalid SHA-256 signature", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
        signingSecret,
        algorithm: "hmac-sha256",
      });

      expect(result).toBe(false);
    });

    it("should reject a tampered body with valid format signature", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      // Sign original body
      const sig = crypto
        .createHmac("sha256", signingSecret)
        .update(rawBody)
        .digest("hex");

      // Verify with different body
      const tamperedBody = Buffer.from(JSON.stringify({ event: "tampered" }));
      const result = verifySignature({
        rawBody: tamperedBody,
        signatureHeader: sig,
        signingSecret,
        algorithm: "hmac-sha256",
      });

      expect(result).toBe(false);
    });
  });

  describe("HMAC-SHA1", () => {
    it("should accept a valid SHA-1 signature", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const expectedSig = crypto
        .createHmac("sha1", signingSecret)
        .update(rawBody)
        .digest("hex");

      const result = verifySignature({
        rawBody,
        signatureHeader: expectedSig,
        signingSecret,
        algorithm: "hmac-sha1",
      });

      expect(result).toBe(true);
    });

    it("should accept a SHA-1 signature with sha1= prefix (GitHub format)", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const expectedSig = crypto
        .createHmac("sha1", signingSecret)
        .update(rawBody)
        .digest("hex");

      const result = verifySignature({
        rawBody,
        signatureHeader: `sha1=${expectedSig}`,
        signingSecret,
        algorithm: "hmac-sha1",
      });

      expect(result).toBe(true);
    });

    it("should reject an invalid SHA-1 signature", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: "deadbeef1234567890abcdef12345678deadbeef",
        signingSecret,
        algorithm: "hmac-sha1",
      });

      expect(result).toBe(false);
    });
  });

  describe("none algorithm", () => {
    it("should skip verification and return true when algorithm is none", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: "",
        signingSecret: "",
        algorithm: "none",
      });

      expect(result).toBe(true);
    });

    it("should return true for none even with garbage signature value", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const result = verifySignature({
        rawBody,
        signatureHeader: "some-garbage-value",
        signingSecret: "unused",
        algorithm: "none",
      });

      expect(result).toBe(true);
    });
  });

  describe("RSA-SHA256", () => {
    it("should accept a valid base64 RSA-SHA256 signature", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const publicKeyPem = publicKey.export({
        type: "spki",
        format: "pem",
      }) as string;
      const signature = crypto
        .sign("RSA-SHA256", rawBody, {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        })
        .toString("base64");

      const result = verifySignature({
        rawBody,
        signatureHeader: signature,
        signingSecret: publicKeyPem,
        algorithm: "rsa-sha256",
      });

      expect(result).toBe(true);
    });

    it("should reject a tampered body with a valid RSA-SHA256 signature", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const publicKeyPem = publicKey.export({
        type: "spki",
        format: "pem",
      }) as string;
      const signature = crypto
        .sign("RSA-SHA256", rawBody, {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        })
        .toString("base64");

      const result = verifySignature({
        rawBody: Buffer.from(JSON.stringify({ event: "tampered" })),
        signatureHeader: signature,
        signingSecret: publicKeyPem,
        algorithm: "rsa-sha256",
      });

      expect(result).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle empty body for SHA-256", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const emptyBody = Buffer.from("");
      const sig = crypto
        .createHmac("sha256", signingSecret)
        .update(emptyBody)
        .digest("hex");

      const result = verifySignature({
        rawBody: emptyBody,
        signatureHeader: sig,
        signingSecret,
        algorithm: "hmac-sha256",
      });

      expect(result).toBe(true);
    });

    it("should accept SHA-256 signature with sha256= prefix", async () => {
      const { verifySignature } = await import(
        "../../../src/ingestion/signature.js"
      );

      const expectedSig = crypto
        .createHmac("sha256", signingSecret)
        .update(rawBody)
        .digest("hex");

      const result = verifySignature({
        rawBody,
        signatureHeader: `sha256=${expectedSig}`,
        signingSecret,
        algorithm: "hmac-sha256",
      });

      expect(result).toBe(true);
    });
  });
});
