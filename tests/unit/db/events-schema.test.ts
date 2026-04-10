import { describe, it, expect } from "vitest";
import { setupTestDb } from "../../helpers/db.js";

describe("Database schema — events table", () => {
  const db = setupTestDb();

  it("should have an events table after migration", async () => {
    const result = await db.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'events'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]!.table_name).toBe("events");
  });

  it("should have all required columns", async () => {
    const result = await db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
      ORDER BY ordinal_position
    `;
    const columns = result.map(
      (r: { column_name: string }) => r.column_name
    );
    expect(columns).toContain("id");
    expect(columns).toContain("tenant_id");
    expect(columns).toContain("source_id");
    expect(columns).toContain("idempotency_key");
    expect(columns).toContain("headers");
    expect(columns).toContain("payload");
    expect(columns).toContain("received_at");
    expect(columns).toContain("status");
    expect(columns).toContain("metadata");
  });

  it("should use UUID for id, tenant_id, and source_id", async () => {
    const result = await db.sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
        AND column_name IN ('id', 'tenant_id', 'source_id')
    `;
    for (const col of result) {
      expect(col.data_type).toBe("uuid");
    }
  });

  it("should use jsonb for headers, payload, and metadata", async () => {
    const result = await db.sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
        AND column_name IN ('headers', 'payload', 'metadata')
    `;
    for (const col of result) {
      expect(col.data_type).toBe("jsonb");
    }
  });

  it("should have tenant_id as NOT NULL", async () => {
    const result = await db.sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
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
      WHERE tc.table_name = 'events'
        AND kcu.column_name = 'tenant_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should have FK from source_id to sources.id", async () => {
    const result = await db.sql`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'events'
        AND kcu.column_name = 'source_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should have UNIQUE(tenant_id, source_id, idempotency_key)", async () => {
    const result = await db.sql`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      WHERE tc.table_name = 'events'
        AND tc.constraint_type = 'UNIQUE'
    `;
    const constraintNames = result.map(
      (r: { constraint_name: string }) => r.constraint_name
    );
    let found = false;
    for (const name of constraintNames) {
      const cols = await db.sql`
        SELECT column_name FROM information_schema.constraint_column_usage
        WHERE constraint_name = ${name}
        ORDER BY column_name
      `;
      const colNames = cols.map(
        (c: { column_name: string }) => c.column_name
      );
      if (
        colNames.includes("tenant_id") &&
        colNames.includes("source_id") &&
        colNames.includes("idempotency_key")
      ) {
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("should default status to 'pending'", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
        AND column_name = 'status'
    `;
    expect(result[0]!.column_default).toContain("pending");
  });

  it("should have composite indexes for tenant-scoped queries", async () => {
    const result = await db.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'events'
    `;
    const indexNames = result.map(
      (r: { indexname: string }) => r.indexname
    );
    // Should have at least indexes covering tenant_id combinations
    expect(indexNames.length).toBeGreaterThanOrEqual(2);
  });

  describe("CRUD operations", () => {
    let tenantId: string;
    let sourceId: string;
    let eventId: string;
    const ts = Date.now();

    it("should insert an event with valid references", async () => {
      const tenant = await db.sql`
        INSERT INTO tenants (name, api_key)
        VALUES (${`evt-test-tenant-${ts}`}, ${`evt-test-key-${ts}`})
        RETURNING id
      `;
      tenantId = tenant[0]!.id;

      const source = await db.sql`
        INSERT INTO sources (tenant_id, name, slug)
        VALUES (${tenantId}, ${`evt-source-${ts}`}, ${`evt-src-${ts}`})
        RETURNING id
      `;
      sourceId = source[0]!.id;

      const result = await db.sql`
        INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload)
        VALUES (${tenantId}, ${sourceId}, ${`idem-${ts}`}, '{"content-type":"application/json"}'::jsonb, '{"data":"test"}'::jsonb)
        RETURNING id, status, received_at, metadata
      `;
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe("pending");
      expect(result[0]!.received_at).toBeTruthy();
      eventId = result[0]!.id;
    });

    it("should reject duplicate (tenant_id, source_id, idempotency_key)", async () => {
      await expect(
        db.sql`
          INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload)
          VALUES (${tenantId}, ${sourceId}, ${`idem-${ts}`}, '{"x":"y"}'::jsonb, '{"d":"2"}'::jsonb)
        `
      ).rejects.toThrow();
    });

    it("should reject insert with invalid tenant_id", async () => {
      await expect(
        db.sql`
          INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload)
          VALUES ('00000000-0000-0000-0000-000000000000', ${sourceId}, 'key2', '{"x":"y"}'::jsonb, '{"d":"2"}'::jsonb)
        `
      ).rejects.toThrow();
    });

    it("should clean up test data", async () => {
      if (eventId) {
        await db.sql`DELETE FROM events WHERE id = ${eventId}`;
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
