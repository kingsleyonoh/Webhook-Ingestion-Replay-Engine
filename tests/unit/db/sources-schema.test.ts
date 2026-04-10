import { describe, it, expect } from "vitest";
import { setupTestDb } from "../../helpers/db.js";

describe("Database schema — sources table", () => {
  const db = setupTestDb();

  it("should have a sources table after migration", async () => {
    const result = await db.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'sources'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]!.table_name).toBe("sources");
  });

  it("should have all required columns", async () => {
    const result = await db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sources'
      ORDER BY ordinal_position
    `;
    const columns = result.map(
      (r: { column_name: string }) => r.column_name
    );
    expect(columns).toContain("id");
    expect(columns).toContain("tenant_id");
    expect(columns).toContain("name");
    expect(columns).toContain("slug");
    expect(columns).toContain("signature_header");
    expect(columns).toContain("signature_algo");
    expect(columns).toContain("signing_secret");
    expect(columns).toContain("enabled");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("should use UUID for id and tenant_id columns", async () => {
    const result = await db.sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sources'
        AND column_name IN ('id', 'tenant_id')
    `;
    for (const col of result) {
      expect(col.data_type).toBe("uuid");
    }
  });

  it("should have tenant_id as NOT NULL", async () => {
    const result = await db.sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sources'
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
      WHERE tc.table_name = 'sources'
        AND kcu.column_name = 'tenant_id'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should have UNIQUE(tenant_id, name)", async () => {
    const result = await db.sql`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      WHERE tc.table_name = 'sources'
        AND tc.constraint_type = 'UNIQUE'
    `;
    // Get columns for each unique constraint
    const constraintNames = result.map(
      (r: { constraint_name: string }) => r.constraint_name
    );
    let foundNameUnique = false;
    for (const name of constraintNames) {
      const cols = await db.sql`
        SELECT column_name FROM information_schema.constraint_column_usage
        WHERE constraint_name = ${name}
        ORDER BY column_name
      `;
      const colNames = cols.map(
        (c: { column_name: string }) => c.column_name
      );
      if (colNames.includes("tenant_id") && colNames.includes("name")) {
        foundNameUnique = true;
      }
    }
    expect(foundNameUnique).toBe(true);
  });

  it("should have UNIQUE(tenant_id, slug)", async () => {
    const result = await db.sql`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      WHERE tc.table_name = 'sources'
        AND tc.constraint_type = 'UNIQUE'
    `;
    const constraintNames = result.map(
      (r: { constraint_name: string }) => r.constraint_name
    );
    let foundSlugUnique = false;
    for (const name of constraintNames) {
      const cols = await db.sql`
        SELECT column_name FROM information_schema.constraint_column_usage
        WHERE constraint_name = ${name}
        ORDER BY column_name
      `;
      const colNames = cols.map(
        (c: { column_name: string }) => c.column_name
      );
      if (colNames.includes("tenant_id") && colNames.includes("slug")) {
        foundSlugUnique = true;
      }
    }
    expect(foundSlugUnique).toBe(true);
  });

  it("should default enabled to true", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sources'
        AND column_name = 'enabled'
    `;
    expect(result[0]!.column_default).toBe("true");
  });

  it("should allow nullable signature fields", async () => {
    const result = await db.sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sources'
        AND column_name IN ('signature_header', 'signature_algo', 'signing_secret')
    `;
    for (const col of result) {
      expect(col.is_nullable).toBe("YES");
    }
  });

  describe("CRUD operations", () => {
    let tenantId: string;
    let sourceId: string;
    const ts = Date.now();

    it("should insert a source with valid tenant", async () => {
      // Create tenant first
      const tenant = await db.sql`
        INSERT INTO tenants (name, api_key)
        VALUES (${`src-test-tenant-${ts}`}, ${`src-test-key-${ts}`})
        RETURNING id
      `;
      tenantId = tenant[0]!.id;

      const result = await db.sql`
        INSERT INTO sources (tenant_id, name, slug, signature_algo)
        VALUES (${tenantId}, 'My Source', 'my-source', 'hmac-sha256')
        RETURNING id, tenant_id, name, slug, enabled, created_at
      `;
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("My Source");
      expect(result[0]!.slug).toBe("my-source");
      expect(result[0]!.enabled).toBe(true);
      sourceId = result[0]!.id;
    });

    it("should reject duplicate (tenant_id, slug)", async () => {
      await expect(
        db.sql`
          INSERT INTO sources (tenant_id, name, slug)
          VALUES (${tenantId}, 'Other Source', 'my-source')
        `
      ).rejects.toThrow();
    });

    it("should reject duplicate (tenant_id, name)", async () => {
      await expect(
        db.sql`
          INSERT INTO sources (tenant_id, name, slug)
          VALUES (${tenantId}, 'My Source', 'other-slug')
        `
      ).rejects.toThrow();
    });

    it("should reject insert with invalid tenant_id", async () => {
      await expect(
        db.sql`
          INSERT INTO sources (tenant_id, name, slug)
          VALUES ('00000000-0000-0000-0000-000000000000', 'Bad Source', 'bad-src')
        `
      ).rejects.toThrow();
    });

    it("should clean up test data", async () => {
      if (sourceId) {
        await db.sql`DELETE FROM sources WHERE id = ${sourceId}`;
      }
      if (tenantId) {
        await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
      }
    });
  });
});
