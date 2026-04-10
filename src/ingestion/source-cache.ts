/**
 * Redis-backed source config cache for the ingestion pipeline.
 * Section 10b — reduces DB load on high-throughput webhook endpoints.
 *
 * Cache key: source:config:{slug}
 * TTL: 60 seconds
 * Invalidated on source update (PUT /api/sources/:id)
 */

import type { Redis } from "ioredis";
import { logger } from "../lib/logger.js";

export interface CachedSourceConfig {
  id: string;
  tenantId: string;
  slug: string;
  signatureHeader: string | null;
  signatureAlgo: string | null;
  signingSecret: string | null;
  enabled: boolean;
}

/** Cache TTL in seconds */
export const CACHE_TTL = 60;

/** Redis key prefix for source config */
export const CACHE_PREFIX = "source:config:";

const cacheLogger = logger.child({ module: "source-cache" });

/**
 * Retrieve a cached source config by slug.
 * Returns null on cache miss.
 */
export async function getCachedSource(
  redis: Redis,
  slug: string
): Promise<CachedSourceConfig | null> {
  const key = `${CACHE_PREFIX}${slug}`;
  const raw = await redis.get(key);

  if (raw === null) {
    cacheLogger.debug({ slug }, "Source config cache miss");
    return null;
  }

  cacheLogger.debug({ slug }, "Source config cache hit");
  return JSON.parse(raw) as CachedSourceConfig;
}

/**
 * Store a source config in Redis with TTL.
 */
export async function setCachedSource(
  redis: Redis,
  slug: string,
  config: CachedSourceConfig
): Promise<void> {
  const key = `${CACHE_PREFIX}${slug}`;
  await redis.set(key, JSON.stringify(config), "EX", CACHE_TTL);
  cacheLogger.debug({ slug }, "Source config cached");
}

/**
 * Remove a cached source config by slug.
 * Called on source update to ensure stale config is not served.
 */
export async function invalidateCachedSource(
  redis: Redis,
  slug: string
): Promise<void> {
  const key = `${CACHE_PREFIX}${slug}`;
  await redis.del(key);
  cacheLogger.debug({ slug }, "Source config cache invalidated");
}
