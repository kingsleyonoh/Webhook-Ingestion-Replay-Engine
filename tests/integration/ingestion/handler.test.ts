/**
 * Integration tests for webhook ingestion handler.
 * POST /webhooks/:sourceSlug
 *
 * Tests:
 * - valid source -> 200
 * - unknown slug -> 404
 * - disabled source -> 404
 * - signature failure -> 401, event persisted with 'rejected' status
 * - valid signature -> 200, event persisted with 'pending' status
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("POST /webhooks/:sourceSlug (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const signingSecret = "whsec_test_secret_for_handler_tests";
  const sourceSlug = `test-source-${Date.now()}`;
  const disabledSlug = `disabled-source-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create a test tenant with unique API key per run
    const uniqueApiKey = `test-api-key-handler-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueApiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Handler Test Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create an enabled test source with HMAC-SHA256
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_header, signature_algo, signing_secret, enabled)
      VALUES (${tenantId}, ${"Test Source"}, ${sourceSlug}, ${"x-hub-signature-256"}, ${"hmac-sha256"}, ${signingSecret}, true)
    `;

    // Create a disabled test source
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_header, signature_algo, signing_secret, enabled)
      VALUES (${tenantId}, ${"Disabled Source"}, ${disabledSlug}, ${"x-hub-signature-256"}, ${"hmac-sha256"}, ${signingSecret}, false)
    `;
  });

  afterAll(async () => {
    // Clean up in correct order (events first, then sources, then tenants)
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should return 200 for a valid source with valid signature", async () => {
    const payload = JSON.stringify({ event: "test.event", data: { id: 1 } });
    const rawBody = Buffer.from(payload);
    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBody)
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("eventId");
    expect(body.status).toBe("accepted");
  });

  it("should return 404 for unknown source slug", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/non-existent-source-slug",
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({ event: "test" }),
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SOURCE_NOT_FOUND");
  });

  it("should return 404 for disabled source", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${disabledSlug}`,
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({ event: "test" }),
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SOURCE_NOT_FOUND");
  });

  it("should return 401 and persist rejected event when signature is invalid", async () => {
    const payload = JSON.stringify({ event: "sig.fail.test", data: { id: 99 } });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "invalid-signature-value",
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SIGNATURE_INVALID");

    // Verify the rejected event was persisted in the database
    const events = await db.sql`
      SELECT id, status FROM events
      WHERE tenant_id = ${tenantId}
      AND status = 'rejected'
      ORDER BY received_at DESC
      LIMIT 1
    `;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.status).toBe("rejected");
  });

  it("should persist event with pending status on valid signature", async () => {
    const payload = JSON.stringify({ event: "persist.test", data: { id: 200 } });
    const rawBody = Buffer.from(payload);
    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBody)
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Verify event is persisted with pending status
    const events = await db.sql`
      SELECT id, status, idempotency_key FROM events
      WHERE id = ${body.eventId}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("pending");
  });
});

describe("POST /webhooks/:sourceSlug — no signature source (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const noSigSlug = `nosig-source-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create a test tenant
    const apiKeyHash = crypto
      .createHash("sha256")
      .update("test-api-key-nosig")
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`NoSig Test Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create a source with no signature verification (algo = none)
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"No Sig Source"}, ${noSigSlug}, ${"none"}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should accept webhook without signature when algo is none", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${noSigSlug}`,
      headers: {
        "content-type": "application/json",
      },
      payload: JSON.stringify({ event: "no-sig-test" }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("eventId");
    expect(body.status).toBe("accepted");
  });
});
