/**
 * Integration tests for backpressure protection.
 * Section 10b — when queue depth exceeds threshold, return 429.
 *
 * Tests:
 * - queue under threshold -> webhook accepted (200)
 * - queue over threshold -> webhook rejected (429, QUEUE_OVERLOAD)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setupTestDb } from "../../helpers/db.js";

describe("Backpressure — POST /webhooks/:sourceSlug (integration)", () => {
  const db = setupTestDb();
  let app: FastifyInstance;
  let tenantId: string;
  const sourceSlug = `bp-source-${Date.now()}`;

  beforeAll(async () => {
    const { buildApp } = await import("../../../src/server.js");
    app = await buildApp();
    await app.ready();

    // Create a test tenant
    const uniqueApiKey = `test-api-key-bp-${Date.now()}-${crypto.randomUUID()}`;
    const apiKeyHash = crypto
      .createHash("sha256")
      .update(uniqueApiKey)
      .digest("hex");

    const tenantResult = await db.sql`
      INSERT INTO tenants (name, api_key, is_active)
      VALUES (${`Backpressure Test Tenant ${Date.now()}`}, ${apiKeyHash}, true)
      RETURNING id
    `;
    tenantId = tenantResult[0]!.id as string;

    // Create a source with no signature (algo = none) for simple testing
    await db.sql`
      INSERT INTO sources (tenant_id, name, slug, signature_algo, enabled)
      VALUES (${tenantId}, ${"BP Test Source"}, ${sourceSlug}, ${"none"}, true)
    `;
  });

  afterAll(async () => {
    await db.sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM sources WHERE tenant_id = ${tenantId}`;
    await db.sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await app.close();
  });

  it("should accept webhook when queue depth is under threshold", async () => {
    // Default queue will be near-empty in test env, well below 10000
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "bp.under.test", ts: Date.now() }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("accepted");
  });

  it("should return 429 when queue depth exceeds threshold", async () => {
    // We need to mock queue.getJobCounts to simulate an overloaded queue.
    // The ingestion handler creates the queue internally, so we mock the
    // BullMQ Queue prototype's getJobCounts method.
    const { Queue } = await import("bullmq");
    const originalGetJobCounts = Queue.prototype.getJobCounts;

    // Mock getJobCounts to return > 10000
    Queue.prototype.getJobCounts = vi.fn().mockResolvedValue({
      waiting: 8000,
      active: 3000,
      completed: 0,
      failed: 0,
      delayed: 0,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/webhooks/${sourceSlug}`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ event: "bp.over.test", ts: Date.now() }),
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("QUEUE_OVERLOAD");
      expect(body.error.message).toMatch(/exceeds maximum/);
    } finally {
      // Restore original method
      Queue.prototype.getJobCounts = originalGetJobCounts;
    }
  });

  it("should accept webhook after queue depth drops below threshold", async () => {
    // Verify recovery: after removing mock, queue is small again
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/${sourceSlug}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ event: "bp.recovery.test", ts: Date.now() }),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("accepted");
  });
});
