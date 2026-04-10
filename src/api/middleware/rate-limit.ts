/**
 * Rate limiting middleware — Fastify plugin using @fastify/rate-limit.
 * Per-endpoint limits defined in Section 8b endpoint inventory.
 *
 * Usage: import RATE_LIMITS and apply per-route via config.rateLimit:
 *   app.get('/api/events', { config: { rateLimit: RATE_LIMITS.eventsRead } }, handler)
 */

import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";

/**
 * Per-endpoint rate limit configurations from Section 8b.
 * Each entry has `max` (requests) and `timeWindow` (window size).
 */
export const RATE_LIMITS = {
  /** POST /webhooks/:sourceSlug — 1000/min */
  webhookIngestion: { max: 1000, timeWindow: "1 minute" },

  /** POST /api/tenants/register — 5/min */
  tenantRegister: { max: 5, timeWindow: "1 minute" },

  /** GET /api/tenants/me — 100/min */
  tenantMe: { max: 100, timeWindow: "1 minute" },

  /** POST /api/sources — 50/min */
  sourcesCreate: { max: 50, timeWindow: "1 minute" },

  /** GET /api/sources — 100/min */
  sourcesRead: { max: 100, timeWindow: "1 minute" },

  /** PUT /api/sources/:id — 50/min */
  sourcesUpdate: { max: 50, timeWindow: "1 minute" },

  /** POST /api/sources/:id/destinations — 50/min */
  destinationsCreate: { max: 50, timeWindow: "1 minute" },

  /** GET /api/events — 200/min */
  eventsRead: { max: 200, timeWindow: "1 minute" },

  /** POST /api/replays — 10/min */
  replaysCreate: { max: 10, timeWindow: "1 minute" },

  /** GET /api/dead-letters — 100/min */
  deadLettersRead: { max: 100, timeWindow: "1 minute" },

  /** POST /api/dead-letters/:id/retry — 50/min */
  deadLettersRetry: { max: 50, timeWindow: "1 minute" },

  /** GET /api/stats — 60/min */
  statsRead: { max: 60, timeWindow: "1 minute" },
} as const;

async function rateLimitMiddleware(
  fastify: FastifyInstance
): Promise<void> {
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    addHeadersOnExceeding: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  });
}

export const rateLimitPlugin = fp(rateLimitMiddleware, {
  name: "rate-limit",
});
