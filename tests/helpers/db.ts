import postgres from "postgres";
import { beforeAll, afterAll } from "vitest";

let sql: ReturnType<typeof postgres>;

/**
 * Returns a shared PostgreSQL connection for integration tests.
 * Call `setupTestDb()` at the top of test files that need DB access.
 */
export function setupTestDb() {
  beforeAll(() => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error("DATABASE_URL not set — is .env loaded?");
    }
    sql = postgres(databaseUrl, { max: 3 });
  });

  afterAll(async () => {
    await sql.end();
  });

  return {
    get sql() {
      return sql;
    },
  };
}
