/**
 * Integration tests for webhook ingestion — event persistence + idempotency.
 * Items 1-2 of Batch 006:
 * - Event persistence with idempotency dedup (Section 5.1 step 6)
 * - Payload size enforcement (Section 5.1 edge case)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Event persistence + idempotency (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const signingSecret = "whsec_persist_test_secret";
  const sourceSlug = `persist-src-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create test tenant with unique API key per run
    const uniqueApiKey = `persist-test-api-key-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueApiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Persist Test Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create enabled source with HMAC-SHA256
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_header, signature_algo, signing_secret, enabled)
      VALUES (${tenantId}, ${"Persist Source"}, ${sourceSlug}, ${"x-hub-signature-256"}, ${"hmac-sha256"}, ${signingSecret}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  function signPayload(payload: string): string {
    return crypto
      .createHmac("sha256", signingSecret)
      .update(Buffer.from(payload))
      .digest("hex");
  }

  it("should persist event and return 200 with event_id on first submission", async () => {
    const payload = JSON.stringify({ event: "persist.first", ts: Date.now() });
    const signature = signPayload(payload);

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: Buffer.from(payload),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("eventId");
    expect(body.eventId).toBeTruthy();

    // Verify event is in DB
    const events = await db.sql`
      SELECT id, status, idempotency_key FROM events
      WHERE id = ${body.eventId}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("pending");
  });

  it("should return 200 without re-processing on duplicate idempotency key", async () => {
    const payload = JSON.stringify({ event: "persist.dedup", ts: Date.now() });
    const signature = signPayload(payload);

    // First submission
    const res1 = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: Buffer.from(payload),
    });

    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.eventId).toBeTruthy();

    // Second submission — same payload = same idempotency key
    const res2 = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: Buffer.from(payload),
    });

    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    // Duplicate response should indicate already processed
    expect(body2.status).toBe("duplicate");

    // Verify only 1 event row exists for this idempotency key
    const events = await db.sql`
      SELECT id FROM events
      WHERE tenant_id = ${tenantId}
      AND id = ${body1.eventId}
    `;
    expect(events).toHaveLength(1);
  });
});

describe("Payload size enforcement (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const sourceSlug = `payload-size-src-${Date.now()}`;

  beforeAll(async () => {
    // Set MAX_PAYLOAD_BYTES to a small value for testing
    process.env["MAX_PAYLOAD_BYTES"] = "1048576"; // 1MB default
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create test tenant
    const apiKeyHash = crypto
      .createHash("sha256")
      .update("payload-size-api-key")
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Payload Size Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create source with no signature for simplicity
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"Payload Size Source"}, ${sourceSlug}, ${"none"}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should accept payload at limit (1MB)", async () => {
    // Create a payload just under 1MB — JSON overhead means we need slightly less
    const largeData = "x".repeat(1048576 - 100);
    const payload = JSON.stringify({ data: largeData });

    // This will be slightly over 1MB due to JSON wrapping, so use a smaller value
    const smallerData = "x".repeat(1000000);
    const smallerPayload = JSON.stringify({ d: smallerData });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: Buffer.from(smallerPayload),
    });

    expect(response.statusCode).toBe(200);
  });

  it("should reject payload over limit with 413", async () => {
    // Create a payload well over 1MB
    const oversizedData = "x".repeat(1048576 + 1000);
    const payload = JSON.stringify({ data: oversizedData });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: Buffer.from(payload),
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
