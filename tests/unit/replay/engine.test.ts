/**
 * Unit tests for replay engine — batch event re-processing.
 * Batch 011, Items 1, 3, 4, 5 (Section 5.3).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";
import { createSqlClient, createDb } from "../../../src/db/client.js";
import { createDeliveryQueue } from "../../../src/delivery/queue.js";
import { executeReplay } from "../../../src/replay/engine.js";
import type { Database, SqlClient } from "../../../src/db/client.js";
import type { Queue } from "bullmq";
import type { DeliverJobData } from "../../../src/delivery/queue.js";

describe("Replay Engine (unit)", () => {
  const testDb = setupTestDb();
  let sqlClient: SqlClient;
  let db: Database;
  let queue: Queue<DeliverJobData>;
  let tenantId: string;
  let sourceId: string;
  let destId1: string;
  let destId2: string;
  let disabledDestId: string;

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"]!;
    const redisUrl = process.env["REDIS_URL"]!;

    sqlClient = createSqlClient(databaseUrl, { max: 3 });
    db = createDb(sqlClient);
    queue = createDeliveryQueue(redisUrl);

    // Drain queue
    await queue.drain();

    // Create tenant
    const apiKey = `replay-eng-${Date.now()}-${crypto.randomUUID()}`;
    const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const t = await testDb.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Replay Engine Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = t[0]!.id as string;

    // Create source
    const s = await testDb.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Replay Source', ${`replay-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = s[0]!.id as string;

    // Create enabled destinations
    const d1 = await testDb.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method, enabled)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/dest1', 'POST', true)
      RETURNING id
    `;
    destId1 = d1[0]!.id as string;

    const d2 = await testDb.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method, enabled)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/dest2', 'POST', true)
      RETURNING id
    `;
    destId2 = d2[0]!.id as string;

    // Create disabled destination
    const d3 = await testDb.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method, enabled)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/disabled', 'POST', false)
      RETURNING id
    `;
    disabledDestId = d3[0]!.id as string;
  });

  afterAll(async () => {
    await testDb.sql`DELETE FROM deliveries WHERE tenant_id = ${tenantId}`;
    await testDb.sql`DELETE FROM replay_requests WHERE tenant_id = ${tenantId}`;
    await testDb.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await testDb.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await testDb.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await testDb.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await queue.close();
    await sqlClient.end();
  });

  it("should replay events and enqueue deliver jobs for active destinations", async () => {
    // Create events
    const ev1 = await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`replay-ev1-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"n":1}', 'pending')
      RETURNING id
    `;
    const ev2 = await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`replay-ev2-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"n":2}', 'pending')
      RETURNING id
    `;

    await queue.drain();

    const result = await executeReplay({
      db,
      queue,
      options: {
        tenantId,
        eventIds: [ev1[0]!.id as string, ev2[0]!.id as string],
      },
      batchSize: 100,
    });

    // 2 events x 2 active destinations = 4 jobs
    expect(result.totalEvents).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.replayRequestId).toBeDefined();

    // Verify jobs in queue
    const waiting = await queue.getWaitingCount();
    expect(waiting).toBeGreaterThanOrEqual(4);

    // Verify events marked as replayed
    const eventsAfter = await testDb.sql`
      SELECT status FROM events WHERE id IN (${ev1[0]!.id as string}, ${ev2[0]!.id as string})
    `;
    expect(eventsAfter.every((e: { status: string }) => e.status === "replayed")).toBe(true);

    // Verify replay request completed
    const rr = await testDb.sql`
      SELECT status, total_events, processed, failed, completed_at
      FROM replay_requests WHERE id = ${result.replayRequestId}
    `;
    expect(rr[0]!.status).toBe("completed");
    expect(rr[0]!.total_events).toBe(2);
    expect(rr[0]!.processed).toBe(2);
    expect(rr[0]!.failed).toBe(0);
    expect(rr[0]!.completed_at).not.toBeNull();

    await queue.drain();
  });

  it("should update progress counters accurately", async () => {
    const ev = await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`replay-counter-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"c":1}', 'pending')
      RETURNING id
    `;

    await queue.drain();

    const result = await executeReplay({
      db,
      queue,
      options: {
        tenantId,
        eventIds: [ev[0]!.id as string],
      },
      batchSize: 100,
    });

    expect(result.totalEvents).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // Check DB counters
    const rr = await testDb.sql`
      SELECT total_events, processed, failed, completed_at
      FROM replay_requests WHERE id = ${result.replayRequestId}
    `;
    expect(rr[0]!.total_events).toBe(1);
    expect(rr[0]!.processed).toBe(1);
    expect(rr[0]!.failed).toBe(0);
    expect(rr[0]!.completed_at).not.toBeNull();

    await queue.drain();
  });

  it("should set completed_at when all events processed", async () => {
    const ev = await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`replay-done-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"d":1}', 'pending')
      RETURNING id
    `;

    await queue.drain();

    const result = await executeReplay({
      db,
      queue,
      options: { tenantId, eventIds: [ev[0]!.id as string] },
      batchSize: 100,
    });

    const rr = await testDb.sql`
      SELECT completed_at, status FROM replay_requests WHERE id = ${result.replayRequestId}
    `;
    expect(rr[0]!.completed_at).not.toBeNull();
    expect(rr[0]!.status).toBe("completed");

    await queue.drain();
  });

  it("should batch enqueue in groups of batchSize to avoid Redis spikes", async () => {
    // Create 5 events, use batchSize=2 to force multiple batches
    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ev = await testDb.sql`
        INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
        VALUES (${tenantId}, ${sourceId}, ${`replay-batch-${i}-${Date.now()}-${crypto.randomUUID()}`}, '{}', ${JSON.stringify({ batch: i })}, 'pending')
        RETURNING id
      `;
      eventIds.push(ev[0]!.id as string);
    }

    await queue.drain();

    const result = await executeReplay({
      db,
      queue,
      options: { tenantId, eventIds },
      batchSize: 2, // Force 3 batches: [2, 2, 1]
    });

    expect(result.totalEvents).toBe(5);
    expect(result.processed).toBe(5);
    expect(result.failed).toBe(0);

    // 5 events x 2 active destinations = 10 jobs total
    const waiting = await queue.getWaitingCount();
    expect(waiting).toBeGreaterThanOrEqual(10);

    // Verify all events marked replayed
    const eventsAfter = await testDb.sql`
      SELECT status FROM events WHERE id IN (${eventIds[0]!}, ${eventIds[1]!}, ${eventIds[2]!}, ${eventIds[3]!}, ${eventIds[4]!})
    `;
    expect(eventsAfter.every((e: { status: string }) => e.status === "replayed")).toBe(true);

    await queue.drain();
  });

  it("should skip disabled destinations", async () => {
    const ev = await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`replay-skip-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"skip":1}', 'pending')
      RETURNING id
    `;

    await queue.drain();

    const result = await executeReplay({
      db,
      queue,
      options: { tenantId, eventIds: [ev[0]!.id as string] },
      batchSize: 100,
    });

    // 1 event x 2 active destinations (disabled one skipped) = 2 jobs
    const waiting = await queue.getWaitingCount();
    expect(waiting).toBe(2);

    // Disabled destination should not be in the jobs
    const jobs = await queue.getWaiting();
    const destIds = jobs.map((j) => j.data.destinationId);
    expect(destIds).not.toContain(disabledDestId);
    expect(destIds).toContain(destId1);
    expect(destIds).toContain(destId2);

    await queue.drain();
  });

  it("should filter events by source_id", async () => {
    // Create second source with a destination
    const s2 = await testDb.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Other Source', ${`other-src-${Date.now()}`}, true)
      RETURNING id
    `;
    const otherSourceId = s2[0]!.id as string;

    await testDb.sql`
      INSERT INTO destinations (tenant_id, source_id, url, method, enabled)
      VALUES (${tenantId}, ${otherSourceId}, 'https://example.com/other', 'POST', true)
    `;

    // Events on source 1
    const ev1 = await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`filter-src-ev1-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"f":1}', 'pending')
      RETURNING id
    `;

    // Events on other source
    await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${otherSourceId}, ${`filter-src-ev2-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"f":2}', 'pending')
    `;

    await queue.drain();

    // Replay only sourceId events
    const result = await executeReplay({
      db,
      queue,
      options: { tenantId, sourceId },
      batchSize: 100,
    });

    // Should have found at least ev1 (the one on sourceId with status pending)
    expect(result.totalEvents).toBeGreaterThanOrEqual(1);

    // The event on the other source should NOT be included
    const rr = await testDb.sql`
      SELECT source_id FROM replay_requests WHERE id = ${result.replayRequestId}
    `;
    expect(rr[0]!.source_id).toBe(sourceId);

    await queue.drain();
  });

  it("should filter events by time range", async () => {
    const ev = await testDb.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`time-range-${Date.now()}-${crypto.randomUUID()}`}, '{}', '{"t":1}', 'pending', '2025-06-15T12:00:00Z')
      RETURNING id
    `;

    await queue.drain();

    const result = await executeReplay({
      db,
      queue,
      options: {
        tenantId,
        fromTimestamp: new Date("2025-06-15T00:00:00Z"),
        toTimestamp: new Date("2025-06-15T23:59:59Z"),
      },
      batchSize: 100,
    });

    expect(result.totalEvents).toBeGreaterThanOrEqual(1);

    await queue.drain();
  });

  it("should handle empty event set gracefully", async () => {
    await queue.drain();

    const result = await executeReplay({
      db,
      queue,
      options: {
        tenantId,
        eventIds: [crypto.randomUUID()], // Non-existent event
      },
      batchSize: 100,
    });

    expect(result.totalEvents).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    // Still creates a replay request marked completed
    const rr = await testDb.sql`
      SELECT status, completed_at FROM replay_requests WHERE id = ${result.replayRequestId}
    `;
    expect(rr[0]!.status).toBe("completed");
    expect(rr[0]!.completed_at).not.toBeNull();

    await queue.drain();
  });
});
