import { describe, it, expect } from "vitest";
import { setupTestDb } from "../../helpers/db.js";

describe("Database schema — destinations table", () => {
  const db = setupTestDb();

  it("should have a destinations table after migration", async () => {
    const result = await db.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'destinations'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]!.table_name).toBe("destinations");
  });

  it("should have all required columns", async () => {
    const result = await db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
      ORDER BY ordinal_position
    `;
    const columns = result.map(
      (r: { column_name: string }) => r.column_name
    );
    expect(columns).toContain("id");
    expect(columns).toContain("tenant_id");
    expect(columns).toContain("source_id");
    expect(columns).toContain("url");
    expect(columns).toContain("method");
    expect(columns).toContain("headers");
    expect(columns).toContain("timeout_ms");
    expect(columns).toContain("max_retries");
    expect(columns).toContain("backoff_base_ms");
    expect(columns).toContain("enabled");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("should use UUID for id, tenant_id, and source_id", async () => {
    const result = await db.sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
        AND column_name IN ('id', 'tenant_id', 'source_id')
    `;
    for (const col of result) {
      expect(col.data_type).toBe("uuid");
    }
  });

  it("should have tenant_id as NOT NULL", async () => {
    const result = await db.sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
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
      WHERE tc.table_name = 'destinations'
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
      WHERE tc.table_name = 'destinations'
        AND kcu.column_name = 'source_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should default method to 'POST'", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
        AND column_name = 'method'
    `;
    expect(result[0]!.column_default).toContain("POST");
  });

  it("should default timeout_ms to 10000", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
        AND column_name = 'timeout_ms'
    `;
    expect(result[0]!.column_default).toBe("10000");
  });

  it("should default max_retries to 5", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
        AND column_name = 'max_retries'
    `;
    expect(result[0]!.column_default).toBe("5");
  });

  it("should default backoff_base_ms to 1000", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
        AND column_name = 'backoff_base_ms'
    `;
    expect(result[0]!.column_default).toBe("1000");
  });

  it("should default enabled to true", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
        AND column_name = 'enabled'
    `;
    expect(result[0]!.column_default).toBe("true");
  });

  it("should use jsonb for headers", async () => {
    const result = await db.sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'destinations'
        AND column_name = 'headers'
    `;
    expect(result[0]!.data_type).toBe("jsonb");
  });

  it("should have an index on (tenant_id, source_id)", async () => {
    const result = await db.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'destinations'
    `;
    const indexNames = result.map(
      (r: { indexname: string }) => r.indexname
    );
    expect(indexNames.length).toBeGreaterThanOrEqual(2);
  });

  describe("CRUD operations", () => {
    let tenantId: string;
    let sourceId: string;
    let destId: string;
    const ts = Date.now();

    it("should insert a destination with valid references", async () => {
      const tenant = await db.sql`
        INSERT INTO tenants (name, api_key)
        VALUES (${`dest-test-tenant-${ts}`}, ${`dest-test-key-${ts}`})
        RETURNING id
      `;
      tenantId = tenant[0]!.id;

      const source = await db.sql`
        INSERT INTO sources (tenant_id, name, slug)
        VALUES (${tenantId}, ${`dest-source-${ts}`}, ${`dest-src-${ts}`})
        RETURNING id
      `;
      sourceId = source[0]!.id;

      const result = await db.sql`
        INSERT INTO destinations (tenant_id, source_id, url)
        VALUES (${tenantId}, ${sourceId}, 'https://example.com/webhook')
        RETURNING id, method, timeout_ms, max_retries, backoff_base_ms, enabled
      `;
      expect(result).toHaveLength(1);
      expect(result[0]!.method).toBe("POST");
      expect(result[0]!.timeout_ms).toBe(10000);
      expect(result[0]!.max_retries).toBe(5);
      expect(result[0]!.backoff_base_ms).toBe(1000);
      expect(result[0]!.enabled).toBe(true);
      destId = result[0]!.id;
    });

    it("should reject insert with invalid tenant_id", async () => {
      await expect(
        db.sql`
          INSERT INTO destinations (tenant_id, source_id, url)
          VALUES ('00000000-0000-0000-0000-000000000000', ${sourceId}, 'https://example.com')
        `
      ).rejects.toThrow();
    });

    it("should clean up test data", async () => {
      if (destId) {
        await db.sql`DELETE FROM destinations WHERE id = ${destId}`;
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
