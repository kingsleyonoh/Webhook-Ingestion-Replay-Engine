/**
 * Integration tests for webhook ingestion — delivery fan-out + no-destinations.
 * Items 3-4 of Batch 006:
 * - No-destinations edge case (Section 5.1)
 * - Enqueue deliver job for each active destination (Section 5.1 steps 7-8)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { setupTestDb } from "../../helpers/db.js";

describe("No-destinations edge case (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  let redis: Redis;
  const sourceSlug = `no-dest-src-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
    redis = new Redis(redisUrl);

    // Create test tenant with unique API key
    const uniqueKey = `no-dest-api-key-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`No Dest Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create source with NO destinations
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"No Dest Source"}, ${sourceSlug}, ${"none"}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await redis.quit();
    await app.close();
  });

  it("should persist event, return 200, and enqueue no jobs when source has no destinations", async () => {
    const deliverQueue = new Queue("deliver", {
      connection: { url: process.env["REDIS_URL"] ?? "redis://localhost:6379" },
    });

    const payload = JSON.stringify({ event: "no-dest.test", ts: Date.now() });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: Buffer.from(payload),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eventId).toBeTruthy();

    // Verify event was persisted
    const events = await db.sql`
      SELECT id, status FROM events WHERE id = ${body.eventId}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("pending");

    // Verify no jobs were enqueued for THIS event
    const jobs = await deliverQueue.getWaiting();
    const ourJobs = jobs.filter((j) => j.data.eventId === body.eventId);
    expect(ourJobs).toHaveLength(0);

    await deliverQueue.close();
  });
});

describe("Delivery fan-out — N active destinations (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  let sourceId: string;
  let redis: Redis;
  const sourceSlug = `fanout-src-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
    redis = new Redis(redisUrl);

    // Create test tenant with unique API key
    const uniqueKey = `fanout-api-key-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Fanout Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create source
    const sourceResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"Fanout Source"}, ${sourceSlug}, ${"none"}, true)
      RETURNING id
    `;
    sourceId = sourceResult[0]!.id as string;

    // Create 3 enabled destinations + 1 disabled
    await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, enabled)
      VALUES
        (${tenantId}, ${sourceId}, ${"https://dest1.example.com/hook"}, true),
        (${tenantId}, ${sourceId}, ${"https://dest2.example.com/hook"}, true),
        (${tenantId}, ${sourceId}, ${"https://dest3.example.com/hook"}, true),
        (${tenantId}, ${sourceId}, ${"https://disabled.example.com/hook"}, false)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await redis.quit();
    await app.close();
  });

  it("should enqueue N deliver jobs for N active destinations", async () => {
    const deliverQueue = new Queue("deliver", {
      connection: { url: process.env["REDIS_URL"] ?? "redis://localhost:6379" },
    });

    const payload = JSON.stringify({ event: "fanout.test", ts: Date.now() });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: Buffer.from(payload),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eventId).toBeTruthy();
    expect(body.status).toBe("accepted");

    // Verify exactly 3 jobs for THIS event (not 4 — disabled destination skipped)
    const jobs = await deliverQueue.getWaiting();
    const ourJobs = jobs.filter((j) => j.data.eventId === body.eventId);
    expect(ourJobs).toHaveLength(3);
    for (const job of ourJobs) {
      expect(job.data).toHaveProperty("tenantId", tenantId);
      expect(job.data).toHaveProperty("destinationId");
    }

    await deliverQueue.close();
  });

  it("should not enqueue duplicate jobs on idempotent replay", async () => {
    const deliverQueue = new Queue("deliver", {
      connection: { url: process.env["REDIS_URL"] ?? "redis://localhost:6379" },
    });

    const payload = JSON.stringify({ event: "fanout.dedup", ts: Date.now() });

    // First submission
    const res1 = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: Buffer.from(payload),
    });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.status).toBe("accepted");

    // Verify 3 jobs for THIS event (filter by eventId, not total count)
    const jobsAfterFirst = await deliverQueue.getWaiting();
    const firstJobs = jobsAfterFirst.filter((j) => j.data.eventId === body1.eventId);
    expect(firstJobs).toHaveLength(3);

    // Second submission — duplicate, should NOT enqueue
    const res2 = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: Buffer.from(payload),
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.status).toBe("duplicate");

    // Still only 3 jobs for the original event — no new ones from duplicate
    const jobsAfterSecond = await deliverQueue.getWaiting();
    const secondJobs = jobsAfterSecond.filter((j) => j.data.eventId === body1.eventId);
    expect(secondJobs).toHaveLength(3);

    await deliverQueue.close();
  });
});
