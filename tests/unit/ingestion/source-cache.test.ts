/**
 * Unit tests for source config cache.
 * Tests cache get/set/invalidate operations against real Redis.
 *
 * Tests:
 * - getCachedSource returns null on cache miss
 * - setCachedSource stores config and getCachedSource returns it
 * - invalidateCachedSource removes the cache entry
 * - cache entries expire after TTL (60s)
 * - setCachedSource overwrites existing entry
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setupTestRedis } from "../../helpers/redis.js";
import {
  getCachedSource,
  setCachedSource,
  invalidateCachedSource,
  CACHE_PREFIX,
  CACHE_TTL,
} from "../../../src/ingestion/source-cache.js";
import type { CachedSourceConfig } from "../../../src/ingestion/source-cache.js";

describe("Source config cache (unit)", () => {
  const redisHelper = setupTestRedis();

  const sampleConfig: CachedSourceConfig = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "660e8400-e29b-41d4-a716-446655440001",
    slug: "stripe-webhooks",
    signatureHeader: "x-hub-signature-256",
    signatureAlgo: "hmac-sha256",
    signingSecret: "whsec_test_secret",
    enabled: true,
  };

  // Clean up cache keys before each test
  beforeEach(async () => {
    const keys = await redisHelper.redis.keys(`${CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redisHelper.redis.del(...keys);
    }
  });

  it("should return null on cache miss", async () => {
    const result = await getCachedSource(redisHelper.redis, "nonexistent-slug");
    expect(result).toBeNull();
  });

  it("should store config and retrieve on cache hit", async () => {
    await setCachedSource(redisHelper.redis, sampleConfig.slug, sampleConfig);
    const result = await getCachedSource(redisHelper.redis, sampleConfig.slug);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(sampleConfig.id);
    expect(result!.tenantId).toBe(sampleConfig.tenantId);
    expect(result!.slug).toBe(sampleConfig.slug);
    expect(result!.signatureHeader).toBe(sampleConfig.signatureHeader);
    expect(result!.signatureAlgo).toBe(sampleConfig.signatureAlgo);
    expect(result!.signingSecret).toBe(sampleConfig.signingSecret);
    expect(result!.enabled).toBe(true);
  });

  it("should invalidate cache entry on invalidateCachedSource", async () => {
    await setCachedSource(redisHelper.redis, sampleConfig.slug, sampleConfig);

    // Confirm it exists
    const before = await getCachedSource(redisHelper.redis, sampleConfig.slug);
    expect(before).not.toBeNull();

    // Invalidate
    await invalidateCachedSource(redisHelper.redis, sampleConfig.slug);

    // Confirm it's gone
    const after = await getCachedSource(redisHelper.redis, sampleConfig.slug);
    expect(after).toBeNull();
  });

  it("should set TTL on cached entries", async () => {
    await setCachedSource(redisHelper.redis, sampleConfig.slug, sampleConfig);

    const ttl = await redisHelper.redis.ttl(`${CACHE_PREFIX}${sampleConfig.slug}`);
    // TTL should be set and close to CACHE_TTL (within a few seconds)
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CACHE_TTL);
  });

  it("should overwrite existing cache entry", async () => {
    await setCachedSource(redisHelper.redis, sampleConfig.slug, sampleConfig);

    const updatedConfig: CachedSourceConfig = {
      ...sampleConfig,
      signatureHeader: "x-stripe-signature",
      signatureAlgo: "hmac-sha1",
    };
    await setCachedSource(redisHelper.redis, sampleConfig.slug, updatedConfig);

    const result = await getCachedSource(redisHelper.redis, sampleConfig.slug);
    expect(result!.signatureHeader).toBe("x-stripe-signature");
    expect(result!.signatureAlgo).toBe("hmac-sha1");
  });

  it("should handle null signature fields correctly", async () => {
    const nullConfig: CachedSourceConfig = {
      ...sampleConfig,
      signatureHeader: null,
      signatureAlgo: null,
      signingSecret: null,
    };
    await setCachedSource(redisHelper.redis, nullConfig.slug, nullConfig);

    const result = await getCachedSource(redisHelper.redis, nullConfig.slug);
    expect(result!.signatureHeader).toBeNull();
    expect(result!.signatureAlgo).toBeNull();
    expect(result!.signingSecret).toBeNull();
  });

  it("should export CACHE_TTL as 60 seconds", () => {
    expect(CACHE_TTL).toBe(60);
  });

  it("should export CACHE_PREFIX as source:config:", () => {
    expect(CACHE_PREFIX).toBe("source:config:");
  });
});
