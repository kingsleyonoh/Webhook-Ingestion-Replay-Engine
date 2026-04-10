/**
 * Drizzle ORM PostgreSQL client using postgres.js driver.
 *
 * Usage:
 *   import { createDb, createSqlClient } from './client.js';
 *   const sql = createSqlClient(config.databaseUrl);
 *   const db = createDb(sql);
 */

import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type SqlClient = ReturnType<typeof postgres>;
export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Create a postgres.js SQL client for the given connection string.
 */
export function createSqlClient(
  connectionString: string,
  options: { max?: number } = {}
): SqlClient {
  return postgres(connectionString, {
    max: options.max ?? 10,
  });
}

/**
 * Create a Drizzle ORM instance from a postgres.js client.
 */
export function createDb(sqlClient: SqlClient): Database {
  return drizzle(sqlClient, { schema });
}
