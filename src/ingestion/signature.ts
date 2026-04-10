/**
 * HMAC signature verification for incoming webhooks.
 * Section 5.1 step 4, Section 6 — SHA-256, SHA-1, and `none` algorithms.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */

import crypto from "node:crypto";

export interface VerifySignatureParams {
  rawBody: Buffer;
  signatureHeader: string;
  signingSecret: string;
  algorithm: "hmac-sha256" | "hmac-sha1" | "none";
}

/**
 * Strip common algorithm prefixes from signature headers.
 * GitHub sends `sha1=abc123`, Stripe may send `sha256=abc123`.
 */
function stripPrefix(signature: string): string {
  if (signature.startsWith("sha256=")) {
    return signature.slice(7);
  }
  if (signature.startsWith("sha1=")) {
    return signature.slice(5);
  }
  return signature;
}

/**
 * Verify a webhook signature against the raw body using the configured algorithm.
 *
 * @returns true if signature is valid (or algorithm is `none`), false otherwise
 */
export function verifySignature(params: VerifySignatureParams): boolean {
  const { rawBody, signatureHeader, signingSecret, algorithm } = params;

  // No verification required
  if (algorithm === "none") {
    return true;
  }

  // Map algorithm name to Node.js crypto algorithm
  const cryptoAlgo = algorithm === "hmac-sha256" ? "sha256" : "sha1";

  const expectedHex = crypto
    .createHmac(cryptoAlgo, signingSecret)
    .update(rawBody)
    .digest("hex");

  const providedHex = stripPrefix(signatureHeader);

  // Lengths must match for timingSafeEqual
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const providedBuf = Buffer.from(providedHex, "utf8");

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
