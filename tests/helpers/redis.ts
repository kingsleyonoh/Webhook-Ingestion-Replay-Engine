import Redis from "ioredis";
import { beforeAll, afterAll } from "vitest";

let redis: Redis;

/**
 * Returns a shared Redis connection for integration tests.
 * Call `setupTestRedis()` at the top of test files that need Redis access.
 */
export function setupTestRedis() {
  beforeAll(() => {
    const redisUrl = process.env["REDIS_URL"];
    if (!redisUrl) {
      throw new Error("REDIS_URL not set — is .env loaded?");
    }
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    await redis.quit();
  });

  return {
    get redis() {
      return redis;
    },
  };
}
