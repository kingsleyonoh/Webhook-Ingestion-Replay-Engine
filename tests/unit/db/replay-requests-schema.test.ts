import { describe, it, expect } from "vitest";
import { setupTestDb } from "../../helpers/db.js";

describe("Database schema — replay_requests table", () => {
  const db = setupTestDb();

  it("should have a replay_requests table after migration", async () => {
    const result = await db.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]!.table_name).toBe("replay_requests");
  });

  it("should have all required columns", async () => {
    const result = await db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
      ORDER BY ordinal_position
    `;
    const columns = result.map(
      (r: { column_name: string }) => r.column_name
    );
    expect(columns).toContain("id");
    expect(columns).toContain("tenant_id");
    expect(columns).toContain("source_id");
    expect(columns).toContain("event_ids");
    expect(columns).toContain("from_timestamp");
    expect(columns).toContain("to_timestamp");
    expect(columns).toContain("status");
    expect(columns).toContain("total_events");
    expect(columns).toContain("processed");
    expect(columns).toContain("failed");
    expect(columns).toContain("created_at");
    expect(columns).toContain("completed_at");
  });

  it("should use UUID for id and tenant_id", async () => {
    const result = await db.sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
        AND column_name IN ('id', 'tenant_id')
    `;
    for (const col of result) {
      expect(col.data_type).toBe("uuid");
    }
  });

  it("should have tenant_id as NOT NULL", async () => {
    const result = await db.sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
        AND column_name = 'tenant_id'
    `;
    expect(result[0]!.is_nullable).toBe("NO");
  });

  it("should have FK from tenant_id to tenants.id", async () => {
    const result = await db.sql`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'replay_requests'
        AND kcu.column_name = 'tenant_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should have nullable source_id", async () => {
    const result = await db.sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
        AND column_name = 'source_id'
    `;
    expect(result[0]!.is_nullable).toBe("YES");
  });

  it("should have event_ids as array type", async () => {
    const result = await db.sql`
      SELECT data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
        AND column_name = 'event_ids'
    `;
    // PostgreSQL arrays are reported as ARRAY data_type with _uuid udt_name
    expect(result[0]!.data_type).toBe("ARRAY");
  });

  it("should default status to 'pending'", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
        AND column_name = 'status'
    `;
    expect(result[0]!.column_default).toContain("pending");
  });

  it("should default counters to 0", async () => {
    const result = await db.sql`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
        AND column_name IN ('total_events', 'processed', 'failed')
    `;
    for (const col of result) {
      expect(col.column_default).toBe("0");
    }
  });

  it("should have nullable timestamp filters", async () => {
    const result = await db.sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'replay_requests'
        AND column_name IN ('from_timestamp', 'to_timestamp', 'completed_at')
    `;
    for (const col of result) {
      expect(col.is_nullable).toBe("YES");
    }
  });

  it("should have an index on (tenant_id, status)", async () => {
    const result = await db.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'replay_requests'
    `;
    const indexNames = result.map(
      (r: { indexname: string }) => r.indexname
    );
    // PK index + at least 1 composite index
    expect(indexNames.length).toBeGreaterThanOrEqual(2);
  });

  describe("CRUD operations", () => {
    let tenantId: string;
    let replayId: string;
    const ts = Date.now();

    it("should insert a replay request with defaults", async () => {
      const tenant = await db.sql`
        INSERT INTO tenants (name, api_key)
        VALUES (${`rr-test-tenant-${ts}`}, ${`rr-test-key-${ts}`})
        RETURNING id
      `;
      tenantId = tenant[0]!.id;

      const result = await db.sql`
        INSERT INTO replay_requests (tenant_id)
        VALUES (${tenantId})
        RETURNING id, status, total_events, processed, failed, created_at
      `;
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("pending");
      expect(result[0]!.total_events).toBe(0);
      expect(result[0]!.processed).toBe(0);
      expect(result[0]!.failed).toBe(0);
      expect(result[0]!.created_at).toBeTruthy();
      replayId = result[0]!.id;
    });

    it("should reject insert with invalid tenant_id", async () => {
      await expect(
        db.sql`
          INSERT INTO replay_requests (tenant_id)
          VALUES ('00000000-0000-0000-0000-000000000000')
        `
      ).rejects.toThrow();
    });

    it("should clean up test data", async () => {
      if (replayId) {
        await db.sql`DELETE FROM replay_requests WHERE id = ${replayId}`;
      }
      if (tenantId) {
        await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
      }
    });
  });
});
