/**
 * Integration tests for event archiver job.
 * Section 7: archive events older than EVENT_ARCHIVE_DAYS to events_archive table.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Event archiver job (integration)", () => {
  const db = setupTestDb();
  let tenantId: string;
  let sourceId: string;
  let oldEventId: string;
  let recentEventId: string;

  beforeAll(async () => {
    // Create tenant
    const apiKey = `archiver-${Date.now()}-${crypto.randomUUID()}`;
    const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const t = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Archiver Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = t[0]!.id as string;

    // Source
    const s = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'Archiver Src', ${`archiver-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = s[0]!.id as string;

    // Old event — 100 days ago (exceeds default 90 days)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const ev1 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`archiver-old-${Date.now()}`}, '{"h":"old"}', '{"old":true}', 'delivered', ${oldDate.toISOString()})
      RETURNING id
    `;
    oldEventId = ev1[0]!.id as string;

    // Recent event — 10 days ago (within 90 days)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 10);
    const ev2 = await db.sql`
      INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload, status, received_at)
      VALUES (${tenantId}, ${sourceId}, ${`archiver-recent-${Date.now()}`}, '{"h":"recent"}', '{"recent":true}', 'pending', ${recentDate.toISOString()})
      RETURNING id
    `;
    recentEventId = ev2[0]!.id as string;
  });

  afterAll(async () => {
    // Clean up archive + events
    await db.sql`DELETE FROM events_archive WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM deliveries WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
  });

  it("should archive events older than archiveDays", async () => {
    const { runEventArchiver } = await import("../../../src/jobs/event-archiver.js");

    const result = await runEventArchiver(process.env["DATABASE_URL"]!, 90);

    expect(result.archived).toBeGreaterThanOrEqual(1);

    // Old event should be in the archive table
    const archived = await db.sql`
      SELECT id, tenant_id, payload, status FROM events_archive WHERE id = ${oldEventId}
    `;
    expect(archived).toHaveLength(1);
    expect(archived[0]!.tenant_id).toBe(tenantId);
  });

  it("should delete archived events from the events table", async () => {
    // After the previous test ran archiver, old event should be gone
    const rows = await db.sql`
      SELECT id FROM events WHERE id = ${oldEventId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("should not archive recent events", async () => {
    const { runEventArchiver } = await import("../../../src/jobs/event-archiver.js");

    await runEventArchiver(process.env["DATABASE_URL"]!, 90);

    // Recent event still in events
    const rows = await db.sql`
      SELECT id FROM events WHERE id = ${recentEventId}
    `;
    expect(rows).toHaveLength(1);

    // Recent event NOT in archive
    const archived = await db.sql`
      SELECT id FROM events_archive WHERE id = ${recentEventId}
    `;
    expect(archived).toHaveLength(0);
  });

  it("should preserve all event fields in the archive", async () => {
    const archived = await db.sql`
      SELECT id, tenant_id, source_id, idempotency_key, headers, payload, status
      FROM events_archive WHERE id = ${oldEventId}
    `;
    expect(archived).toHaveLength(1);
    const row = archived[0]!;
    expect(row.tenant_id).toBe(tenantId);
    expect(row.source_id).toBe(sourceId);
    expect(row.idempotency_key).toContain("archiver-old-");
    expect(row.status).toBe("delivered");
  });

  it("should be idempotent — running twice does not duplicate archives", async () => {
    const { runEventArchiver } = await import("../../../src/jobs/event-archiver.js");

    // Run again — old event already archived, recent event untouched
    const result = await runEventArchiver(process.env["DATABASE_URL"]!, 90);
    expect(result.archived).toBe(0);

    // Verify no duplicates in archive
    const archived = await db.sql`
      SELECT id FROM events_archive WHERE tenant_id = ${tenantId}
    `;
    // Should be exactly 1 (the old event, archived once)
    expect(archived).toHaveLength(1);
  });
});
