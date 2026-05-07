/**
 * Integration tests for the delivery worker.
 * Section 5.2: pick job → load event + destination → HTTP request → record attempt.
 *
 * Tests delivery recording, retry/backoff, dead-letter promotion, event aggregation.
 * Uses real DB + Redis, nock for external destination URLs.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import nock from "nock";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { setupTestDb } from "../../helpers/db.js";

import { processDeliveryJob } from "../../../src/delivery/worker.js";
import { createDeliveryQueue } from "../../../src/delivery/queue.js";
import type { DeliverJobData } from "../../../src/delivery/queue.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://postgres:devpass@localhost:5450/webhooks";

describe("Delivery worker — processDeliveryJob (integration)", () => {
  const db = setupTestDb();
  let redis: Redis;
  let queue: Queue<DeliverJobData>;

  let tenantId: string;
  let sourceId: string;
  let eventId: string;
  let destId: string;
  const ts = Date.now();

  const destUrl = "https://dest-worker-test.example.com";

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    queue = createDeliveryQueue(REDIS_URL);

    // Create tenant
    const tenant = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`worker-tenant-${ts}`}, ${`worker-key-${ts}`}, true)
      RETURNING id
    `;
    tenantId = tenant[0]!.id as string;

    // Create source
    const source = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, ${`worker-source-${ts}`}, ${`worker-src-${ts}`}, true)
      RETURNING id
    `;
    sourceId = source[0]!.id as string;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await queue.close();
    await redis.quit();
  });

  /**
   * Helper: create event + destination for a test case.
   */
  async function createEventAndDest(opts?: {
    maxRetries?: number;
    timeoutMs?: number;
    backoffBaseMs?: number;
    destUrlPath?: string;
  }) {
    const idemKey = `worker-idem-${ts}-${Math.random()}`;
    const event = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (
        ${tenantId}, ${sourceId}, ${idemKey},
        '{"content-type":"application/json"}'::jsonb,
        '{"data":"test-payload"}'::jsonb,
        'pending'
      )
      RETURNING id
    `;
    const eid = event[0]!.id as string;

    const urlPath = opts?.destUrlPath ?? `/hook-${Math.random()}`;
    const dest = await db.sql`
      INSERT INTO destinations (
        tenant_id, source_id, url, method, timeout_ms, max_retries, backoff_base_ms, enabled
      )
      VALUES (
        ${tenantId}, ${sourceId},
        ${`${destUrl}${urlPath}`},
        'POST',
        ${opts?.timeoutMs ?? 5000},
        ${opts?.maxRetries ?? 5},
        ${opts?.backoffBaseMs ?? 1000},
        true
      )
      RETURNING id
    `;
    const did = dest[0]!.id as string;

    return { eventId: eid, destId: did, urlPath };
  }

  describe("successful delivery recorded", () => {
    it("should record delivery with status=success, status_code, response_body, duration_ms", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest();

      nock(destUrl).post(urlPath).reply(200, "ok-response");

      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT status, status_code, response_body, duration_ms, attempt, error_message
        FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
        ORDER BY attempt DESC LIMIT 1
      `;

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe("success");
      expect(deliveries[0]!.status_code).toBe(200);
      expect(deliveries[0]!.response_body).toBe("ok-response");
      expect(deliveries[0]!.duration_ms).toBeGreaterThanOrEqual(0);
      expect(deliveries[0]!.attempt).toBe(1);
      expect(deliveries[0]!.error_message).toBeNull();
    });
  });

  describe("failed delivery recorded", () => {
    it("should record delivery with status=failed on 500 response", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest();

      nock(destUrl).post(urlPath).reply(500, "server error");

      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT status, status_code, response_body, next_retry_at
        FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
        ORDER BY attempt DESC LIMIT 1
      `;

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe("failed");
      expect(deliveries[0]!.status_code).toBe(500);
      expect(deliveries[0]!.response_body).toBe("server error");
      expect(deliveries[0]!.next_retry_at).toBeTruthy();
    });
  });

  describe("malformed job handled", () => {
    it("should not throw when event does not exist", async () => {
      const { destId: did } = await createEventAndDest();
      const fakeEventId = "00000000-0000-0000-0000-000000000001";

      // Should not throw — just log and return
      await expect(
        processDeliveryJob(
          { eventId: fakeEventId, destinationId: did, tenantId },
          { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
        )
      ).resolves.not.toThrow();
    });

    it("should not throw when destination does not exist", async () => {
      const { eventId: eid } = await createEventAndDest();
      const fakeDestId = "00000000-0000-0000-0000-000000000002";

      await expect(
        processDeliveryJob(
          { eventId: eid, destinationId: fakeDestId, tenantId },
          { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
        )
      ).resolves.not.toThrow();
    });
  });

  describe("delivery attempt recording — all fields", () => {
    it("should record all required fields in deliveries table", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest();

      nock(destUrl).post(urlPath).reply(201, '{"id":"abc"}');

      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT id, tenant_id, event_id, destination_id, attempt, status,
               status_code, response_body, error_message, duration_ms,
               attempted_at, next_retry_at
        FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
      `;

      const d = deliveries[0]!;
      expect(d.id).toBeTruthy();
      expect(d.tenant_id).toBe(tenantId);
      expect(d.event_id).toBe(eid);
      expect(d.destination_id).toBe(did);
      expect(d.attempt).toBe(1);
      expect(d.status).toBe("success");
      expect(d.status_code).toBe(201);
      expect(d.response_body).toBe('{"id":"abc"}');
      expect(d.error_message).toBeNull();
      expect(d.duration_ms).toBeGreaterThanOrEqual(0);
      expect(d.attempted_at).toBeTruthy();
      expect(d.next_retry_at).toBeNull();
    });

    it("should truncate response body at 4KB", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest();

      const largeBody = "z".repeat(8192);
      nock(destUrl).post(urlPath).reply(200, largeBody);

      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT response_body FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
      `;

      expect(deliveries[0]!.response_body.length).toBe(4096);
    });

    it("should track duration in milliseconds", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest();

      nock(destUrl).post(urlPath).delayConnection(50).reply(200, "delayed");

      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT duration_ms FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
      `;

      expect(deliveries[0]!.duration_ms).toBeGreaterThanOrEqual(40);
    });
  });

  describe("exponential backoff — next_retry_at", () => {
    it("should set next_retry_at with correct backoff for attempt 1", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest({
        backoffBaseMs: 1000,
      });

      nock(destUrl).post(urlPath).reply(500, "fail");

      const beforeMs = Date.now();
      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT next_retry_at, attempted_at FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
      `;

      const nextRetry = new Date(deliveries[0]!.next_retry_at).getTime();
      // backoff for attempt 1 = 1000 * 2^0 = 1000ms
      expect(nextRetry).toBeGreaterThanOrEqual(beforeMs + 900);
      expect(nextRetry).toBeLessThanOrEqual(beforeMs + 3000);
    });

    it("should increase backoff exponentially for subsequent attempts", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest({
        backoffBaseMs: 1000,
        maxRetries: 5,
      });

      // First failure — attempt 1
      nock(destUrl).post(urlPath).reply(500, "fail1");
      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      // Second failure — attempt 2
      nock(destUrl).post(urlPath).reply(500, "fail2");
      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT attempt, next_retry_at, attempted_at FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
        ORDER BY attempt ASC
      `;

      expect(deliveries).toHaveLength(2);

      const attempt1At = new Date(deliveries[0]!.attempted_at).getTime();
      const retry1At = new Date(deliveries[0]!.next_retry_at).getTime();
      const attempt2At = new Date(deliveries[1]!.attempted_at).getTime();
      const retry2At = new Date(deliveries[1]!.next_retry_at).getTime();

      // Attempt 1 backoff: 1000 * 2^0 = 1000ms
      const backoff1 = retry1At - attempt1At;
      expect(backoff1).toBeGreaterThanOrEqual(900);
      expect(backoff1).toBeLessThanOrEqual(1500);

      // Attempt 2 backoff: 1000 * 2^1 = 2000ms
      const backoff2 = retry2At - attempt2At;
      expect(backoff2).toBeGreaterThanOrEqual(1800);
      expect(backoff2).toBeLessThanOrEqual(2500);
    });
  });

  describe("dead letter promotion", () => {
    it("should mark as dead_letter when attempt >= max_retries", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest({
        maxRetries: 2,
        backoffBaseMs: 100,
      });

      // Attempt 1 — failure
      nock(destUrl).post(urlPath).reply(500, "fail1");
      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      // Attempt 2 (= max_retries) — failure → dead_letter
      nock(destUrl).post(urlPath).reply(500, "fail2");
      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT attempt, status, next_retry_at FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
        ORDER BY attempt ASC
      `;

      expect(deliveries).toHaveLength(2);

      // First attempt should be 'failed' with retry
      expect(deliveries[0]!.status).toBe("failed");
      expect(deliveries[0]!.next_retry_at).toBeTruthy();

      // Second attempt should be 'dead_letter' with NO retry
      expect(deliveries[1]!.status).toBe("dead_letter");
      expect(deliveries[1]!.next_retry_at).toBeNull();
    });

    it("should not schedule further retries after dead_letter", async () => {
      const { eventId: eid, destId: did, urlPath } = await createEventAndDest({
        maxRetries: 1,
        backoffBaseMs: 100,
      });

      // Single attempt = max_retries → dead_letter immediately
      nock(destUrl).post(urlPath).reply(500, "fail");
      await processDeliveryJob(
        { eventId: eid, destinationId: did, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const deliveries = await db.sql`
        SELECT status, next_retry_at FROM deliveries
        WHERE event_id = ${eid} AND destination_id = ${did}
      `;

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe("dead_letter");
      expect(deliveries[0]!.next_retry_at).toBeNull();
    });
  });

  describe("event status aggregation", () => {
    it("should mark event as delivered when all destinations succeed", async () => {
      // Use isolated source so other test destinations don't interfere
      const aggSource = await db.sql`
        INSERT INTO sources (tenant_id, name, slug, enabled)
        VALUES (${tenantId}, ${`agg-ok-source-${Math.random()}`}, ${`agg-ok-slug-${Math.random()}`}, true)
        RETURNING id
      `;
      const aggSourceId = aggSource[0]!.id as string;

      const idemKey = `agg-ok-${ts}-${Math.random()}`;
      const event = await db.sql`
        INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
        VALUES (
          ${tenantId}, ${aggSourceId}, ${idemKey},
          '{"content-type":"application/json"}'::jsonb,
          '{"data":"agg-test"}'::jsonb,
          'pending'
        )
        RETURNING id
      `;
      const eid = event[0]!.id as string;

      const path1 = `/agg-ok-1-${Math.random()}`;
      const path2 = `/agg-ok-2-${Math.random()}`;

      const d1 = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url, method, timeout_ms, max_retries, backoff_base_ms, enabled)
        VALUES (${tenantId}, ${aggSourceId}, ${`${destUrl}${path1}`}, 'POST', 5000, 5, 1000, true)
        RETURNING id
      `;
      const d2 = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url, method, timeout_ms, max_retries, backoff_base_ms, enabled)
        VALUES (${tenantId}, ${aggSourceId}, ${`${destUrl}${path2}`}, 'POST', 5000, 5, 1000, true)
        RETURNING id
      `;

      const did1 = d1[0]!.id as string;
      const did2 = d2[0]!.id as string;

      // Deliver to dest 1 — success
      nock(destUrl).post(path1).reply(200, "ok1");
      await processDeliveryJob(
        { eventId: eid, destinationId: did1, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      // Check event still pending (dest2 not delivered yet)
      const midEvent = await db.sql`
        SELECT status FROM events WHERE id = ${eid}
      `;
      expect(midEvent[0]!.status).toBe("pending");

      // Deliver to dest 2 — success
      nock(destUrl).post(path2).reply(200, "ok2");
      await processDeliveryJob(
        { eventId: eid, destinationId: did2, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      // Now event should be 'delivered'
      const finalEvent = await db.sql`
        SELECT status FROM events WHERE id = ${eid}
      `;
      expect(finalEvent[0]!.status).toBe("delivered");
    });

    it("should mark scoped events delivered when matched destinations succeed", async () => {
      const scopedSource = await db.sql`
        INSERT INTO sources (tenant_id, name, slug, enabled)
        VALUES (${tenantId}, ${`scoped-source-${Math.random()}`}, ${`scoped-slug-${Math.random()}`}, true)
        RETURNING id
      `;
      const scopedSourceId = scopedSource[0]!.id as string;
      const path1 = `/scoped-1-${Math.random()}`;
      const path2 = `/scoped-2-${Math.random()}`;

      const d1 = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url, method, timeout_ms, max_retries, backoff_base_ms, enabled)
        VALUES (${tenantId}, ${scopedSourceId}, ${`${destUrl}${path1}`}, 'POST', 5000, 5, 1000, true)
        RETURNING id
      `;
      const d2 = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url, method, timeout_ms, max_retries, backoff_base_ms, enabled)
        VALUES (${tenantId}, ${scopedSourceId}, ${`${destUrl}${path2}`}, 'POST', 5000, 5, 1000, true)
        RETURNING id
      `;

      const did1 = d1[0]!.id as string;
      const did2 = d2[0]!.id as string;
      const idemKey = `agg-scoped-${ts}-${Math.random()}`;
      const event = await db.sql`
        INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
        VALUES (
          ${tenantId}, ${scopedSourceId}, ${idemKey},
          '{"content-type":"application/json"}'::jsonb,
          ${JSON.stringify({
            data: "scoped-test",
            _matched_destination_ids: [did1],
          })}::jsonb,
          'pending'
        )
        RETURNING id
      `;
      const eid = event[0]!.id as string;

      nock(destUrl).post(path1).reply(200, "ok");
      await processDeliveryJob(
        { eventId: eid, destinationId: did1, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      const finalEvent = await db.sql`
        SELECT status FROM events WHERE id = ${eid}
      `;
      expect(finalEvent[0]!.status).toBe("delivered");
      expect(did2).toBeTruthy();
    });

    it("should keep event as pending when partial success (one destination fails)", async () => {
      // Use isolated source so other test destinations don't interfere
      const partialSource = await db.sql`
        INSERT INTO sources (tenant_id, name, slug, enabled)
        VALUES (${tenantId}, ${`partial-source-${Math.random()}`}, ${`partial-slug-${Math.random()}`}, true)
        RETURNING id
      `;
      const partialSourceId = partialSource[0]!.id as string;

      const idemKey = `agg-partial-${ts}-${Math.random()}`;
      const event = await db.sql`
        INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
        VALUES (
          ${tenantId}, ${partialSourceId}, ${idemKey},
          '{"content-type":"application/json"}'::jsonb,
          '{"data":"partial-test"}'::jsonb,
          'pending'
        )
        RETURNING id
      `;
      const eid = event[0]!.id as string;

      const path1 = `/partial-1-${Math.random()}`;
      const path2 = `/partial-2-${Math.random()}`;

      const d1 = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url, method, timeout_ms, max_retries, backoff_base_ms, enabled)
        VALUES (${tenantId}, ${partialSourceId}, ${`${destUrl}${path1}`}, 'POST', 5000, 5, 1000, true)
        RETURNING id
      `;
      const d2 = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url, method, timeout_ms, max_retries, backoff_base_ms, enabled)
        VALUES (${tenantId}, ${partialSourceId}, ${`${destUrl}${path2}`}, 'POST', 5000, 5, 1000, true)
        RETURNING id
      `;

      const did1 = d1[0]!.id as string;
      const did2 = d2[0]!.id as string;

      // Dest 1 — success
      nock(destUrl).post(path1).reply(200, "ok");
      await processDeliveryJob(
        { eventId: eid, destinationId: did1, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      // Dest 2 — failure
      nock(destUrl).post(path2).reply(500, "fail");
      await processDeliveryJob(
        { eventId: eid, destinationId: did2, tenantId },
        { databaseUrl: DATABASE_URL, redisUrl: REDIS_URL }
      );

      // Event should remain 'pending' since dest2 failed
      const finalEvent = await db.sql`
        SELECT status FROM events WHERE id = ${eid}
      `;
      expect(finalEvent[0]!.status).toBe("pending");
    });
  });
});
