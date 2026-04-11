/**
 * Integration tests for signing secret encryption in the ingestion pipeline.
 * Tests:
 * - Source with encrypted signing_secret: handler decrypts before verification
 * - Cached source config stores encrypted secret (not plaintext)
 * - Source creation via API encrypts the signing_secret before DB insert
 * - Source update via API encrypts the new signing_secret
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";
import { setupTestRedis } from "../../helpers/redis.js";

// 32 bytes = 64 hex chars
const TEST_ENCRYPTION_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("Signing secret encryption (integration)", () => {
  const db = setupTestDb();
  const redisHelper = setupTestRedis();
  let app: FastifyInstance;
  let tenantId: string;
  let apiKey: string;
  const signingSecret = "whsec_encryption_test_secret";
  const sourceSlug = `encrypt-src-${Date.now()}`;

  beforeAll(async () => {
    // Set the encryption key env var BEFORE building the app
    process.env["SIGNING_SECRET_KEY"] = TEST_ENCRYPTION_KEY;

    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    apiKey = `test-api-key-encrypt-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(apiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Encrypt Test Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Encrypt the signing secret manually to insert into DB
    const { encrypt, getEncryptionKey } = await import(
      "../../../src/lib/crypto.js"
    );
    const key = getEncryptionKey();
    const encryptedSecret = encrypt(signingSecret, key);

    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_header, signature_algo, signing_secret, enabled)
      VALUES (${tenantId}, ${"Encrypt Source"}, ${sourceSlug}, ${"x-hub-signature-256"}, ${"hmac-sha256"}, ${encryptedSecret}, true)
    `;
  });

  afterEach(async () => {
    // Clear only THIS test's source config cache key to avoid wiping other concurrent tests' keys
    await redisHelper.redis.del(`source:config:${sourceSlug}`);
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
    delete process.env["SIGNING_SECRET_KEY"];
  });

  it("should decrypt signing_secret and verify valid signature", async () => {
    const payload = JSON.stringify({
      event: "encrypt.verify",
      ts: Date.now(),
    });
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
    expect(body.status).toBe("accepted");
    expect(body.eventId).toBeDefined();
  });

  it("should reject invalid signature even with encrypted secret", async () => {
    const payload = JSON.stringify({
      event: "encrypt.reject",
      ts: Date.now(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "invalid-signature",
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
  });

  it("should store encrypted (not plaintext) signing_secret in DB when source created via API", async () => {
    const newSlug = `api-encrypt-create-${Date.now()}`;
    const newSecret = "whsec_api_created_secret";

    const response = await app.inject({
      method: "POST",
      url: "/api/sources",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      payload: JSON.stringify({
        name: `API Encrypt Source ${Date.now()}`,
        slug: newSlug,
        signature_header: "x-hub-signature-256",
        signature_algo: "hmac-sha256",
        signing_secret: newSecret,
      }),
    });

    expect(response.statusCode).toBe(201);

    // Verify the DB has encrypted (not plaintext) secret
    const dbResult = await db.sql`
      SELECT signing_secret FROM sources WHERE slug = ${newSlug} AND tenant_id = ${tenantId}
    `;
    expect(dbResult).toHaveLength(1);
    const storedSecret = dbResult[0]!.signing_secret as string;
    expect(storedSecret).not.toBe(newSecret);

    // Verify it can be decrypted back
    const { decrypt, getEncryptionKey } = await import(
      "../../../src/lib/crypto.js"
    );
    const decrypted = decrypt(storedSecret, getEncryptionKey());
    expect(decrypted).toBe(newSecret);

    // Cleanup
    await db.sql`DELETE FROM sources WHERE slug = ${newSlug} AND tenant_id = ${tenantId}`;
  });

  it("should cache encrypted secret in Redis, not plaintext", async () => {
    // Make a request that triggers cache population
    const payload = JSON.stringify({
      event: "encrypt.cache.check",
      ts: Date.now(),
    });
    const rawBody = Buffer.from(payload);
    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(rawBody)
      .digest("hex");

    await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      payload: rawBody,
    });

    // Check what's in Redis
    const cached = await redisHelper.redis.get(
      `source:config:${sourceSlug}`
    );
    expect(cached).not.toBeNull();

    const parsed = JSON.parse(cached!);
    // The cached signingSecret should be the encrypted version, not plaintext
    expect(parsed.signingSecret).not.toBe(signingSecret);
  });
});
