/**
 * Integration tests for stats aggregator job.
 * Section 7: update per-source delivery success/failure counts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";
import { setupTestRedis } from "../../helpers/redis.js";

describe("Stats aggregator job (integration)", () => {
  const db = setupTestDb();
  const redisHelper = setupTestRedis();
  let tenantId: string;
  let sourceId1: string;
  let sourceId2: string;
  let destId1: string;
  let destId2: string;

  beforeAll(async () => {
    // Create tenant
    const apiKey = `stagg-${Date.now()}-${crypto.randomUUID()}`;
    const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const t = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`StatsAgg Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = t[0]!.id as string;

    // Sources
    const s1 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Agg Src 1', ${`agg-s1-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId1 = s1[0]!.id as string;

    const s2 = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Agg Src 2', ${`agg-s2-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId2 = s2[0]!.id as string;

    // Destinations
    const d1 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, max_retries)
      VALUES (${tenantId}, ${sourceId1}, 'https://example.com/hook1', 5)
      RETURNING id
    `;
    destId1 = d1[0]!.id as string;

    const d2 = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, max_retries)
      VALUES (${tenantId}, ${sourceId2}, 'https://example.com/hook2', 5)
      RETURNING id
    `;
    destId2 = d2[0]!.id as string;

    // Events
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId1}, ${`agg-ev1-${Date.now()}`}, '{}', '{}', 'pending')
      RETURNING id
    `;
    const eventId1 = ev1[0]!.id as string;

    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId2}, ${`agg-ev2-${Date.now()}`}, '{}', '{}', 'pending')
      RETURNING id
    `;
    const eventId2 = ev2[0]!.id as string;

    // Source 1: 3 success, 1 failed
    await db.sql`INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code) VALUES (${tenantId}, ${eventId1}, ${destId1}, 1, 'success', 200)`;
    await db.sql`INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code) VALUES (${tenantId}, ${eventId1}, ${destId1}, 1, 'success', 200)`;
    await db.sql`INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code) VALUES (${tenantId}, ${eventId1}, ${destId1}, 1, 'success', 201)`;
    await db.sql`INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code) VALUES (${tenantId}, ${eventId1}, ${destId1}, 2, 'failed', 500)`;

    // Source 2: 0 success, 2 failed
    await db.sql`INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code) VALUES (${tenantId}, ${eventId2}, ${destId2}, 1, 'failed', 500)`;
    await db.sql`INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code) VALUES (${tenantId}, ${eventId2}, ${destId2}, 2, 'failed', 503)`;
  });

  afterAll(async () => {
    // Clean up only THIS test's Redis keys to avoid wiping other concurrent tests' keys
    await redisHelper.redis.del(`stats:source:${sourceId1}`, `stats:source:${sourceId2}`);

    // DB cleanup
    await db.sql`DELETE FROM deliveries WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
  });

  it("should compute accurate per-source delivery counts", async () => {
    const { runStatsAggregator } = await import("../../../src/jobs/stats-aggregator.js");

    const result = await runStatsAggregator(
      process.env["DATABASE_URL"]!,
      process.env["REDIS_URL"]!
    );

    expect(result.sourcesUpdated).toBeGreaterThanOrEqual(2);

    // Check Redis for source1 stats
    const s1Stats = await redisHelper.redis.hgetall(`stats:source:${sourceId1}`);
    expect(parseInt(s1Stats["success"] ?? "0", 10)).toBe(3);
    expect(parseInt(s1Stats["failed"] ?? "0", 10)).toBe(1);
  });

  it("should handle source with zero success deliveries", async () => {
    const { runStatsAggregator } = await import("../../../src/jobs/stats-aggregator.js");

    await runStatsAggregator(
      process.env["DATABASE_URL"]!,
      process.env["REDIS_URL"]!
    );

    const s2Stats = await redisHelper.redis.hgetall(`stats:source:${sourceId2}`);
    expect(parseInt(s2Stats["success"] ?? "0", 10)).toBe(0);
    expect(parseInt(s2Stats["failed"] ?? "0", 10)).toBe(2);
  });

  it("should be idempotent — running twice gives same counts", async () => {
    const { runStatsAggregator } = await import("../../../src/jobs/stats-aggregator.js");

    await runStatsAggregator(process.env["DATABASE_URL"]!, process.env["REDIS_URL"]!);
    await runStatsAggregator(process.env["DATABASE_URL"]!, process.env["REDIS_URL"]!);

    const s1Stats = await redisHelper.redis.hgetall(`stats:source:${sourceId1}`);
    expect(parseInt(s1Stats["success"] ?? "0", 10)).toBe(3);
    expect(parseInt(s1Stats["failed"] ?? "0", 10)).toBe(1);
  });
});
