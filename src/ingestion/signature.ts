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
  /** Extracted timestamp from header (milliseconds since epoch). */
  timestampMs?: number;
  /** Max signature age in ms (default 300000 = 5 min). Set to 0 to disable. */
  toleranceMs?: number;
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
  const {
    rawBody,
    signatureHeader,
    signingSecret,
    algorithm,
    timestampMs,
    toleranceMs,
  } = params;

  // No verification required
  if (algorithm === "none") {
    return true;
  }

  // Timestamp tolerance check: reject stale signatures
  if (
    timestampMs !== undefined &&
    toleranceMs !== undefined &&
    toleranceMs > 0
  ) {
    const age = Date.now() - timestampMs;
    if (age > toleranceMs) {
      return false;
    }
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

/**
 * Extract a timestamp from a signature header value.
 * Supports Stripe-style format: `t=1234567890,v1=abc...`
 *
 * @returns Timestamp in milliseconds, or undefined if not parseable.
 */
export function extractTimestampFromHeader(
  headerValue: string
): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  // Stripe format: t=<unix_seconds>,v1=<sig>
  const match = headerValue.match(/^t=(\d+),/);
  if (!match) {
    return undefined;
  }

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  return seconds * 1000; // Convert to milliseconds
}
