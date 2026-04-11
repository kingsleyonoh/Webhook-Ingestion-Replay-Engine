/**
 * Integration tests for header sanitization in webhook ingestion.
 * Verifies that sensitive headers are stripped before DB persistence.
 * Tests:
 * - Authorization header not persisted in event headers
 * - Cookie header not persisted in event headers
 * - Webhook-specific headers (stripe-signature, x-hub-signature) ARE persisted
 * - Content-type header IS persisted
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Header sanitization in ingestion (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const sourceSlug = `header-sanitize-src-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    const uniqueApiKey = `test-api-key-header-sanitize-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueApiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Header Sanitize Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Source with no signature verification (algo = none) to simplify test
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"Header Sanitize Source"}, ${sourceSlug}, ${"none"}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should strip Authorization header from persisted event", async () => {
    const payload = JSON.stringify({
      event: "header.sanitize.auth",
      ts: Date.now(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sensitive-token-123",
        "x-request-id": "req-sanitize-test",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const eventId = body.eventId;

    // Check persisted headers
    const events = await db.sql`
      SELECT headers FROM events WHERE id = ${eventId}
    `;
    expect(events).toHaveLength(1);
    const headers = events[0]!.headers as Record<string, unknown>;
    expect(headers).not.toHaveProperty("authorization");
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("should strip Cookie header from persisted event", async () => {
    const payload = JSON.stringify({
      event: "header.sanitize.cookie",
      ts: Date.now(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        cookie: "session=abc123; token=xyz789",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const eventId = body.eventId;

    const events = await db.sql`
      SELECT headers FROM events WHERE id = ${eventId}
    `;
    const headers = events[0]!.headers as Record<string, unknown>;
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("Cookie");
  });

  it("should preserve webhook-specific headers", async () => {
    const payload = JSON.stringify({
      event: "header.sanitize.preserve",
      ts: Date.now(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=abc",
        "x-hub-signature-256": "sha256=def",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const eventId = body.eventId;

    const events = await db.sql`
      SELECT headers FROM events WHERE id = ${eventId}
    `;
    const headers = events[0]!.headers as Record<string, unknown>;
    expect(headers).toHaveProperty("stripe-signature");
    expect(headers).toHaveProperty("x-hub-signature-256");
    expect(headers).toHaveProperty("content-type");
  });
});
