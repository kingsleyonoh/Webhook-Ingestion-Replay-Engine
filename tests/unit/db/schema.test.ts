import { describe, it, expect } from "vitest";
import { setupTestDb } from "../../helpers/db.js";

describe("Database schema — tenants table", () => {
  const db = setupTestDb();

  it("should have a tenants table after migration", async () => {
    const result = await db.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tenants'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]!.table_name).toBe("tenants");
  });

  it("should have all required columns", async () => {
    const result = await db.sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
      ORDER BY ordinal_position
    `;

    const columns = result.map(
      (r: { column_name: string }) => r.column_name
    );
    expect(columns).toContain("id");
    expect(columns).toContain("name");
    expect(columns).toContain("api_key");
    expect(columns).toContain("is_active");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");
  });

  it("should use UUID for the id column", async () => {
    const result = await db.sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'id'
    `;
    expect(result[0]!.data_type).toBe("uuid");
  });

  it("should have api_key as unique", async () => {
    const result = await db.sql`
      SELECT tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'tenants'
        AND ccu.column_name = 'api_key'
        AND tc.constraint_type = 'UNIQUE'
    `;
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should default is_active to true", async () => {
    const result = await db.sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'is_active'
    `;
    expect(result[0]!.column_default).toBe("true");
  });

  it("should have NOT NULL constraints on name and api_key", async () => {
    const result = await db.sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('name', 'api_key')
    `;
    for (const col of result) {
      expect(col.is_nullable).toBe("NO");
    }
  });

  it("should have timestamp defaults on created_at and updated_at", async () => {
    const result = await db.sql`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants'
        AND column_name IN ('created_at', 'updated_at')
    `;
    for (const col of result) {
      expect(col.column_default).toBeTruthy();
    }
  });

  describe("CRUD operations", () => {
    const testApiKey = `test-key-${Date.now()}`;
    const testName = `test-tenant-${Date.now()}`;
    let testId: string;

    it("should insert a tenant", async () => {
      const result = await db.sql`
        INSERT INTO tenants (name, api_key)
        VALUES (${testName}, ${testApiKey})
        RETURNING id, name, api_key, is_active, created_at, updated_at
      `;
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe(testName);
      expect(result[0]!.api_key).toBe(testApiKey);
      expect(result[0]!.is_active).toBe(true);
      expect(result[0]!.id).toBeTruthy();
      testId = result[0]!.id;
    });

    it("should reject duplicate api_key", async () => {
      await expect(
        db.sql`INSERT INTO tenants (name, api_key) VALUES ('other', ${testApiKey})`
      ).rejects.toThrow();
    });

    it("should reject null name", async () => {
      await expect(
        db.sql`INSERT INTO tenants (name, api_key) VALUES (${null}, 'some-key')`
      ).rejects.toThrow();
    });

    it("should clean up test data", async () => {
      if (testId) {
        await db.sql`DELETE FROM tenants WHERE id = ${testId}`;
      }
    });
  });
});
