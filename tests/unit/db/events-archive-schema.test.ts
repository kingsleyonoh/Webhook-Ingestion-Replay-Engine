import { describe, it, expect } from "vitest";
import { setupTestDb } from "../../helpers/db.js";

describe("Database schema — events_archive table", () => {
  const db = setupTestDb();

  it("should have an events_archive table after migration", async () => {
    const result = await db.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'events_archive'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]!.table_name).toBe("events_archive");
  });

  it("should have the same columns as the events table", async () => {
    const eventsResult = await db.sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
      ORDER BY column_name
    `;
    const archiveResult = await db.sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events_archive'
      ORDER BY column_name
    `;

    const eventsColumns = eventsResult.map(
      (r: { column_name: string }) => r.column_name
    );
    const archiveColumns = archiveResult.map(
      (r: { column_name: string }) => r.column_name
    );

    expect(archiveColumns).toEqual(eventsColumns);
  });

  it("should have matching data types with the events table", async () => {
    const eventsResult = await db.sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
      ORDER BY column_name
    `;
    const archiveResult = await db.sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events_archive'
      ORDER BY column_name
    `;

    for (let i = 0; i < eventsResult.length; i++) {
      expect(archiveResult[i]!.column_name).toBe(
        eventsResult[i]!.column_name
      );
      expect(archiveResult[i]!.data_type).toBe(
        eventsResult[i]!.data_type
      );
    }
  });

  it("should use jsonb for headers, payload, and metadata", async () => {
    const result = await db.sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events_archive'
        AND column_name IN ('headers', 'payload', 'metadata')
    `;
    for (const col of result) {
      expect(col.data_type).toBe("jsonb");
    }
  });

  it("should have tenant_id as NOT NULL", async () => {
    const result = await db.sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events_archive'
        AND column_name = 'tenant_id'
    `;
    expect(result[0]!.is_nullable).toBe("NO");
  });

  describe("CRUD operations", () => {
    let tenantId: string;
    let sourceId: string;
    let archiveId: string;
    const ts = Date.now();

    it("should insert an archived event", async () => {
      const tenant = await db.sql`
        INSERT INTO tenants (name, api_key)
        VALUES (${`arch-test-tenant-${ts}`}, ${`arch-test-key-${ts}`})
        RETURNING id
      `;
      tenantId = tenant[0]!.id;

      const source = await db.sql`
        INSERT INTO sources (tenant_id, name, slug)
        VALUES (${tenantId}, ${`arch-source-${ts}`}, ${`arch-src-${ts}`})
        RETURNING id
      `;
      sourceId = source[0]!.id;

      const result = await db.sql`
        INSERT INTO events_archive (tenant_id, source_id, idempotency_key, headers, payload, status)
        VALUES (${tenantId}, ${sourceId}, ${`arch-idem-${ts}`}, '{"x":"y"}'::jsonb, '{"d":"1"}'::jsonb, 'delivered')
        RETURNING id, status, received_at
      `;
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("delivered");
      expect(result[0]!.received_at).toBeTruthy();
      archiveId = result[0]!.id;
    });

    it("should clean up test data", async () => {
      if (archiveId) {
        await db.sql`DELETE FROM events_archive WHERE id = ${archiveId}`;
      }
      if (sourceId) {
        await db.sql`DELETE FROM sources WHERE id = ${sourceId}`;
      }
      if (tenantId) {
        await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
      }
    });
  });
});
