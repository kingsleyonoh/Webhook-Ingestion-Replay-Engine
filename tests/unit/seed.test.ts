/**
 * Unit tests for the seed script logic.
 * Tests the createDefaultTenant function in isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { setupTestDb } from "../helpers/db.js";

describe("Seed script (integration)", () => {
  const db = setupTestDb();

  afterAll(async () => {
    // Clean up any seed-created tenants
    await db.sql`DELETE FROM tenants WHERE name = 'Default Tenant'`;
  });

  it("should create a Default Tenant when none exists", async () => {
    // Ensure no Default Tenant exists
    await db.sql`DELETE FROM tenants WHERE name = 'Default Tenant'`;

    const { createDefaultTenant } = await import(
      "../../src/seed.js"
    );

    const result = await createDefaultTenant(db.sql);

    expect(result).toHaveProperty("created", true);
    expect(result).toHaveProperty("apiKey");
    expect(typeof result.apiKey).toBe("string");
    expect(result.apiKey!.length).toBeGreaterThan(0);

    // Verify tenant was persisted
    const tenants =
      await db.sql`SELECT id, name, api_key, is_active FROM tenants WHERE name = 'Default Tenant'`;
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.is_active).toBe(true);

    // Verify the API key hash matches
    const expectedHash = crypto
      .createHash("sha256")
      .update(result.apiKey!)
      .digest("hex");
    expect(tenants[0]!.api_key).toBe(expectedHash);
  });

  it("should be idempotent — skip if Default Tenant already exists", async () => {
    // Ensure a Default Tenant exists from previous test or create one
    const existing =
      await db.sql`SELECT id FROM tenants WHERE name = 'Default Tenant'`;
    if (existing.length === 0) {
      const hash = crypto
        .createHash("sha256")
        .update("pre-existing-key")
        .digest("hex");
      await db.sql`INSERT INTO tenants (name, api_key, is_active) VALUES ('Default Tenant', ${hash}, true)`;
    }

    const { createDefaultTenant } = await import(
      "../../src/seed.js"
    );

    const result = await createDefaultTenant(db.sql);

    expect(result).toHaveProperty("created", false);
    expect(result.apiKey).toBeUndefined();
  });

  it("should create tenant with is_active = true", async () => {
    await db.sql`DELETE FROM tenants WHERE name = 'Default Tenant'`;

    const { createDefaultTenant } = await import(
      "../../src/seed.js"
    );

    await createDefaultTenant(db.sql);

    const tenants =
      await db.sql`SELECT is_active FROM tenants WHERE name = 'Default Tenant'`;
    expect(tenants).toHaveLength(1);
    expect(tenants[0]!.is_active).toBe(true);
  });

  it("should generate a cryptographically random API key", async () => {
    await db.sql`DELETE FROM tenants WHERE name = 'Default Tenant'`;

    const { createDefaultTenant } = await import(
      "../../src/seed.js"
    );

    const result1 = await createDefaultTenant(db.sql);
    await db.sql`DELETE FROM tenants WHERE name = 'Default Tenant'`;

    const result2 = await createDefaultTenant(db.sql);

    // Two calls should generate different API keys
    expect(result1.apiKey).not.toBe(result2.apiKey);
  });
});
