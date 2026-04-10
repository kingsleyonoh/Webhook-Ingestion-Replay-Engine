import { describe, it, expect } from "vitest";

describe("Drizzle DB client", () => {
  it("should export a createDb function", async () => {
    const mod = await import("../../../src/db/client.js");
    expect(typeof mod.createDb).toBe("function");
  });

  it("should export a createSqlClient function", async () => {
    const mod = await import("../../../src/db/client.js");
    expect(typeof mod.createSqlClient).toBe("function");
  });

  it("should create a Drizzle instance from a connection string", async () => {
    const { createDb, createSqlClient } = await import(
      "../../../src/db/client.js"
    );
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      throw new Error("DATABASE_URL not set");
    }
    const sqlClient = createSqlClient(databaseUrl);
    const db = createDb(sqlClient);

    expect(db).toBeDefined();
    // Drizzle instance should have query capabilities
    expect(typeof db.select).toBe("function");

    // Clean up
    await sqlClient.end();
  });
});
