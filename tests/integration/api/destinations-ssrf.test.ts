/**
 * Integration tests for SSRF protection on destination creation.
 * POST /api/sources/:id/destinations must reject private/unsafe URLs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Destination SSRF protection (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantApiKey: string;
  let tenantId: string;
  let sourceId: string;
  const createdDestIds: string[] = [];

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create tenant
    tenantApiKey = crypto.randomBytes(32).toString("hex");
    const hash = crypto
      .createHash("sha256")
      .update(tenantApiKey)
      .digest("hex");
    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`SSRF Tenant ${Date.now()}`}, ${hash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create source
    const srcResult = await db.sql`
      INSERT INTO sources (tenant_id, name, slug, enabled)
      VALUES (${tenantId}, 'SSRF Test Source', ${`ssrf-src-${Date.now()}`}, true)
      RETURNING id
    `;
    sourceId = srcResult[0]!.id as string;
  });

  afterAll(async () => {
    for (const id of createdDestIds) {
      await db.sql`DELETE FROM destinations WHERE id = ${id}`;
    }
    await db.sql`DELETE FROM destinations WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should accept valid https:// destination URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "https://example.com/webhook" },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    createdDestIds.push(body.destination.id);
  });

  it("should reject localhost destination URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "http://localhost:8080/hook" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("UNSAFE_URL");
  });

  it("should reject 127.0.0.1 destination URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "http://127.0.0.1/hook" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("UNSAFE_URL");
  });

  it("should reject 10.x.x.x private range", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "http://10.0.0.1/hook" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("UNSAFE_URL");
  });

  it("should reject 169.254.169.254 metadata endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "http://169.254.169.254/latest/meta-data" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("UNSAFE_URL");
  });

  it("should reject ftp:// protocol", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "ftp://example.com/file" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("UNSAFE_URL");
  });

  it("should reject file:// protocol", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "file:///etc/passwd" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("UNSAFE_URL");
  });

  it("should reject 192.168.x.x private range", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/sources/${sourceId}/destinations`,
      headers: {
        "content-type": "application/json",
        "x-api-key": tenantApiKey,
      },
      payload: { url: "http://192.168.1.1/hook" },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("UNSAFE_URL");
  });
});
