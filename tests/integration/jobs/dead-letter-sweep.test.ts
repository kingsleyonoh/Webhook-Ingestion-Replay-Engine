/**
 * Integration tests for dead letter sweep job.
 * Section 7: scan failed deliveries past max retries, promote to dead_letter.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Dead letter sweep job (integration)", () => {
  const db = setupTestDb();
  let tenantId: string;
  let sourceId: string;
  let destId: string;
  let eventId1: string;
  let eventId2: string;
  let eventId3: string;

  // Delivery IDs we track
  let deliveryFailedPastMax: string;   // attempt=5, maxRetries=5 → promote
  let deliveryFailedNotMax: string;    // attempt=2, maxRetries=5 → skip
  let deliveryAlreadyDead: string;     // already dead_letter → skip
  let deliverySuccess: string;         // success → skip

  beforeAll(async () => {
    // Create tenant
    const apiKey = `dlsweep-${Date.now()}-${crypto.randomUUID()}`;
    const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const t = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`DLSweep Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = t[0]!.id as string;

    // Source
    const s = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'DL Sweep Src', ${`dlsweep-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = s[0]!.id as string;

    // Destination with max_retries = 5
    const d = await db.sql`
      INSERT INTO destinations (tenant_id, source_id, url, max_retries)
      VALUES (${tenantId}, ${sourceId}, 'https://example.com/hook', 5)
      RETURNING id
    `;
    destId = d[0]!.id as string;

    // Events
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`dlsweep-ev1-${Date.now()}`}, '{}', '{}', 'pending')
      RETURNING id
    `;
    eventId1 = ev1[0]!.id as string;

    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`dlsweep-ev2-${Date.now()}`}, '{}', '{}', 'pending')
      RETURNING id
    `;
    eventId2 = ev2[0]!.id as string;

    const ev3 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status)
      VALUES (${tenantId}, ${sourceId}, ${`dlsweep-ev3-${Date.now()}`}, '{}', '{}', 'pending')
      RETURNING id
    `;
    eventId3 = ev3[0]!.id as string;

    // Delivery: failed, attempt >= max_retries (5 >= 5) → should be promoted
    const dFailed = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code)
      VALUES (${tenantId}, ${eventId1}, ${destId}, 5, 'failed', 500)
      RETURNING id
    `;
    deliveryFailedPastMax = dFailed[0]!.id as string;

    // Delivery: failed, attempt < max_retries (2 < 5) → skip
    const dNotMax = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code)
      VALUES (${tenantId}, ${eventId2}, ${destId}, 2, 'failed', 503)
      RETURNING id
    `;
    deliveryFailedNotMax = dNotMax[0]!.id as string;

    // Delivery: already dead_letter → skip
    const dDead = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status)
      VALUES (${tenantId}, ${eventId3}, ${destId}, 5, 'dead_letter')
      RETURNING id
    `;
    deliveryAlreadyDead = dDead[0]!.id as string;

    // Delivery: success → skip
    const dSuccess = await db.sql`
      INSERT INTO deliveries (tenant_id, event_id, destination_id, attempt, status, status_code)
      VALUES (${tenantId}, ${eventId1}, ${destId}, 1, 'success', 200)
      RETURNING id
    `;
    deliverySuccess = dSuccess[0]!.id as string;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM deliveries WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
  });

  it("should promote failed deliveries past max retries to dead_letter", async () => {
    const { runDeadLetterSweep } = await import("../../../src/jobs/dead-letter-sweep.js");

    const databaseUrl = process.env["DATABASE_URL"]!;
    const result = await runDeadLetterSweep(databaseUrl);

    expect(result.promoted).toBeGreaterThanOrEqual(1);

    // Verify the delivery was promoted
    const rows = await db.sql`
      SELECT status FROM deliveries WHERE id = ${deliveryFailedPastMax}
    `;
    expect(rows[0]!.status).toBe("dead_letter");
  });

  it("should skip failed deliveries that have not reached max retries", async () => {
    const { runDeadLetterSweep } = await import("../../../src/jobs/dead-letter-sweep.js");

    await runDeadLetterSweep(process.env["DATABASE_URL"]!);

    const rows = await db.sql`
      SELECT status FROM deliveries WHERE id = ${deliveryFailedNotMax}
    `;
    expect(rows[0]!.status).toBe("failed");
  });

  it("should skip deliveries already in dead_letter status", async () => {
    const { runDeadLetterSweep } = await import("../../../src/jobs/dead-letter-sweep.js");

    await runDeadLetterSweep(process.env["DATABASE_URL"]!);

    const rows = await db.sql`
      SELECT status FROM deliveries WHERE id = ${deliveryAlreadyDead}
    `;
    expect(rows[0]!.status).toBe("dead_letter");
  });

  it("should not affect successful deliveries", async () => {
    const { runDeadLetterSweep } = await import("../../../src/jobs/dead-letter-sweep.js");

    await runDeadLetterSweep(process.env["DATABASE_URL"]!);

    const rows = await db.sql`
      SELECT status FROM deliveries WHERE id = ${deliverySuccess}
    `;
    expect(rows[0]!.status).toBe("success");
  });

  it("should be idempotent — running twice yields same result", async () => {
    const { runDeadLetterSweep } = await import("../../../src/jobs/dead-letter-sweep.js");

    const result1 = await runDeadLetterSweep(process.env["DATABASE_URL"]!);
    const result2 = await runDeadLetterSweep(process.env["DATABASE_URL"]!);

    // After first run, the failed-past-max is dead_letter. Second run should find 0 new.
    // (First run might find some from other tests, but second should find 0 new ones)
    expect(result2.promoted).toBe(0);

    // All statuses remain unchanged
    const rows = await db.sql`
      SELECT id, status FROM deliveries WHERE tenant_id = ${tenantId} ORDER BY id
    `;
    const byId = new Map(rows.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(byId.get(deliveryFailedPastMax)).toBe("dead_letter");
    expect(byId.get(deliveryFailedNotMax)).toBe("failed");
    expect(byId.get(deliveryAlreadyDead)).toBe("dead_letter");
    expect(byId.get(deliverySuccess)).toBe("success");
  });
});
