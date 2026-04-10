/**
 * Seed script — creates a default tenant for development.
 * Run via: npm run seed (tsx src/seed.ts)
 *
 * Idempotent: skips creation if "Default Tenant" already exists.
 * Prints the unhashed API key to console (shown once).
 */

import crypto from "node:crypto";
import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";

// Load .env
config({ path: resolve(import.meta.dirname, "../.env") });

interface SeedResult {
  created: boolean;
  apiKey?: string;
}

/**
 * Create the default tenant if it doesn't exist.
 * Exported for testing — accepts a postgres.js SQL client.
 */
export async function createDefaultTenant(
  sql: ReturnType<typeof postgres>
): Promise<SeedResult> {
  // Check if Default Tenant already exists
  const existing =
    await sql`SELECT id FROM tenants WHERE name = 'Default Tenant' LIMIT 1`;

  if (existing.length > 0) {
    return { created: false };
  }

  // Generate API key
  const rawApiKey = crypto.randomBytes(32).toString("hex");
  const apiKeyHash = crypto
    .createHash("sha256")
    .update(rawApiKey)
    .digest("hex");

  // Insert tenant
  await sql`
    INSERT INTO tenants (name, api_key, is_active)
    VALUES ('Default Tenant', ${apiKeyHash}, true)
  `;

  return { created: true, apiKey: rawApiKey };
}

/**
 * Main entry point — only runs when executed directly.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL not set. Check your .env file.");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const result = await createDefaultTenant(sql);

    if (result.created) {
      console.log("Default Tenant created successfully.");
      console.log(`API Key: ${result.apiKey}`);
      console.log(
        "Save this key — it will not be shown again."
      );
    } else {
      console.log(
        "Default Tenant already exists. Skipping creation."
      );
    }
  } finally {
    await sql.end();
  }
}

// Auto-run when executed directly
const isDirectRun =
  process.argv[1]?.includes("seed") &&
  !process.argv[1]?.includes("vitest") &&
  !process.argv[1]?.includes("node_modules");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
