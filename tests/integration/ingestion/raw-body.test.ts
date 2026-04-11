/**
 * Integration tests for raw body preservation — HMAC verification with non-canonical JSON.
 * Verifies that the raw bytes are preserved through the content type parser and used
 * for signature verification, rather than re-serialized JSON.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Raw body preservation for HMAC verification (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const signingSecret = "whsec_raw_body_test_secret_123";
  const sourceSlug = `rawbody-src-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create a test tenant with unique API key
    const uniqueApiKey = `test-api-key-rawbody-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueApiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`RawBody Test Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create a source with HMAC-SHA256 verification
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_header, signature_algo, signing_secret, enabled)
      VALUES (${tenantId}, ${"RawBody Test Source"}, ${sourceSlug}, ${"x-hub-signature-256"}, ${"hmac-sha256"}, ${signingSecret}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should verify HMAC on non-canonical JSON with extra whitespace", async () => {
    // Non-canonical JSON: extra whitespace that JSON.parse then JSON.stringify would lose
    const rawPayload = '{"event":  "test.whitespace",  "data": {"id":  1}}';
    const rawBuffer = Buffer.from(rawPayload);

    // Sign the actual raw bytes (with extra whitespace)
    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBuffer)
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: rawBuffer,
    });

    // Should be accepted — raw body is preserved for HMAC
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("accepted");
  });

  it("should verify HMAC on JSON with different key ordering", async () => {
    // Different key order than canonical: JSON.stringify would reorder
    const rawPayload = '{"data":{"id":42},"event":"test.key_order"}';
    const rawBuffer = Buffer.from(rawPayload);

    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBuffer)
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: rawBuffer,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("accepted");
  });

  it("should verify HMAC on JSON with trailing newline", async () => {
    const rawPayload = '{"event":"test.newline","data":{}}\n';
    const rawBuffer = Buffer.from(rawPayload);

    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBuffer)
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: rawBuffer,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("accepted");
  });

  it("should reject HMAC when signature does not match raw body", async () => {
    const rawPayload = '{"event":"test.mismatch"}';
    const rawBuffer = Buffer.from(rawPayload);

    // Sign a DIFFERENT payload
    const wrongSignature = crypto
      .createHmac("sha256", signingSecret)
      .update(Buffer.from('{"event":"different.payload"}'))
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": wrongSignature,
      },
      payload: rawBuffer,
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("SIGNATURE_INVALID");
  });
});
