import { describe, it, expect } from "vitest";
import { setupTestDb } from "../helpers/db.js";
import { setupTestRedis } from "../helpers/redis.js";

describe("PostgreSQL connectivity", () => {
  const db = setupTestDb();

  it("should connect and execute a query", async () => {
    const result = await db.sql`SELECT 1 AS value`;
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe(1);
  });

  it("should confirm the webhooks database exists", async () => {
    const result = await db.sql`SELECT current_database() AS db`;
    expect(result[0]!.db).toBe("webhooks");
  });
});

describe("Redis connectivity", () => {
  const r = setupTestRedis();

  it("should connect and respond to PING", async () => {
    const result = await r.redis.ping();
    expect(result).toBe("PONG");
  });

  it("should set and get a key", async () => {
    const testKey = `smoke-test:${Date.now()}`;
    await r.redis.set(testKey, "hello");
    const value = await r.redis.get(testKey);
    expect(value).toBe("hello");
    await r.redis.del(testKey);
  });
});
