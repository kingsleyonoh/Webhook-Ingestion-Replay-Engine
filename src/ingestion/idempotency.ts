/**
 * Idempotency key generation for incoming webhooks.
 * Section 5.1 steps 5-6 — source-provided header or SHA-256 body hash.
 *
 * If the source has an idempotency header configured (e.g., `Stripe-Webhook-Id`),
 * use that header's value. Otherwise, SHA-256 hash the raw body.
 */

import crypto from "node:crypto";

export interface GenerateIdempotencyKeyParams {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  idempotencyHeader?: string;
}

/**
 * Generate an idempotency key for a webhook event.
 *
 * @returns The idempotency key string (either from header or body hash)
 */
export function generateIdempotencyKey(
  params: GenerateIdempotencyKeyParams
): string {
  const { headers, rawBody, idempotencyHeader } = params;

  // If an idempotency header is configured, look it up (case-insensitive)
  if (idempotencyHeader) {
    const lowerHeader = idempotencyHeader.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowerHeader && value) {
        return value;
      }
    }
  }

  // Fallback: SHA-256 hash of the raw body
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}
