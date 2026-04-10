import { describe, it, expect } from "vitest";
import { setupTestDb } from "../../helpers/db.js";

describe("Database schema — deliveries table", () => {
  const db = setupTestDb();

  it("should have a deliveries table after migration", async () => {
    const result = await db.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'deliveries'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]!.table_name).toBe("deliveries");
  });

  it("should have all required columns", async () => {
    const result = await db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'deliveries'
      ORDER BY ordinal_position
    `;
    const columns = result.map(
      (r: { column_name: string }) => r.column_name
    );
    expect(columns).toContain("id");
    expect(columns).toContain("tenant_id");
    expect(columns).toContain("event_id");
    expect(columns).toContain("destination_id");
    expect(columns).toContain("attempt");
    expect(columns).toContain("status");
    expect(columns).toContain("status_code");
    expect(columns).toContain("response_body");
    expect(columns).toContain("error_message");
    expect(columns).toContain("duration_ms");
    expect(columns).toContain("attempted_at");
    expect(columns).toContain("next_retry_at");
  });

  it("should use UUID for id, tenant_id, event_id, destination_id", async () => {
    const result = await db.sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'deliveries'
        AND column_name IN ('id', 'tenant_id', 'event_id', 'destination_id')
    `;
    for (const col of result) {
      expect(col.data_type).toBe("uuid");
    }
  });

  it("should have tenant_id as NOT NULL", async () => {
    const result = await db.sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'deliveries'
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
      WHERE tc.table_name = 'deliveries'
        AND kcu.column_name = 'tenant_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should have FK from event_id to events.id", async () => {
    const result = await db.sql`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'deliveries'
        AND kcu.column_name = 'event_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should have FK from destination_id to destinations.id", async () => {
    const result = await db.sql`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'deliveries'
        AND kcu.column_name = 'destination_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should default attempt to 1", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'deliveries'
        AND column_name = 'attempt'
    `;
    expect(result[0]!.column_default).toBe("1");
  });

  it("should have nullable fields for status_code, response_body, error_message, duration_ms", async () => {
    const result = await db.sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'deliveries'
        AND column_name IN ('status_code', 'response_body', 'error_message', 'duration_ms', 'next_retry_at')
    `;
    for (const col of result) {
      expect(col.is_nullable).toBe("YES");
    }
  });

  it("should have composite indexes for tenant-scoped queries", async () => {
    const result = await db.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'deliveries'
    `;
    const indexNames = result.map(
      (r: { indexname: string }) => r.indexname
    );
    // PK index + at least 4 composite indexes
    expect(indexNames.length).toBeGreaterThanOrEqual(4);
  });

  describe("CRUD operations", () => {
    let tenantId: string;
    let sourceId: string;
    let eventId: string;
    let destId: string;
    let deliveryId: string;
    const ts = Date.now();

    it("should insert a delivery with valid references", async () => {
      const tenant = await db.sql`
        INSERT INTO tenants (name, api_key)
        VALUES (${`del-test-tenant-${ts}`}, ${`del-test-key-${ts}`})
        RETURNING id
      `;
      tenantId = tenant[0]!.id;

      const source = await db.sql`
        INSERT INTO sources (tenant_id, name, slug)
        VALUES (${tenantId}, ${`del-source-${ts}`}, ${`del-src-${ts}`})
        RETURNING id
      `;
      sourceId = source[0]!.id;

      const event = await db.sql`
        INSERT INTO events (tenant_id, source_id, idempotency_key, headers, payload)
        VALUES (${tenantId}, ${sourceId}, ${`del-idem-${ts}`}, '{"x":"y"}'::jsonb, '{"d":"1"}'::jsonb)
        RETURNING id
      `;
      eventId = event[0]!.id;

      const dest = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url)
        VALUES (${tenantId}, ${sourceId}, 'https://example.com/hook')
        RETURNING id
      `;
      destId = dest[0]!.id;

      const result = await db.sql`
        INSERT INTO deliveries (tenant_id, event_id, destination_id, status)
        VALUES (${tenantId}, ${eventId}, ${destId}, 'pending')
        RETURNING id, attempt, status, attempted_at
      `;
      expect(result).toHaveLength(1);
      expect(result[0]!.attempt).toBe(1);
      expect(result[0]!.status).toBe("pending");
      expect(result[0]!.attempted_at).toBeTruthy();
      deliveryId = result[0]!.id;
    });

    it("should reject insert with invalid tenant_id", async () => {
      await expect(
        db.sql`
          INSERT INTO deliveries (tenant_id, event_id, destination_id, status)
          VALUES ('00000000-0000-0000-0000-000000000000', ${eventId}, ${destId}, 'pending')
        `
      ).rejects.toThrow();
    });

    it("should clean up test data", async () => {
      if (deliveryId) {
        await db.sql`DELETE FROM deliveries WHERE id = ${deliveryId}`;
      }
      if (destId) {
        await db.sql`DELETE FROM destinations WHERE id = ${destId}`;
      }
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
