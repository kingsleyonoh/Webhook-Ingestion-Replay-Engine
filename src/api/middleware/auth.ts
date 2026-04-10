/**
 * API key auth middleware — Fastify plugin.
 * Extracts X-API-Key header, hashes with SHA-256, resolves tenant.
 * Attaches tenant_id to request.tenantId decorator.
 *
 * Section 8b Authentication:
 * - Valid key + active tenant → request.tenantId set, proceed
 * - Missing/invalid key → 401 TenantNotFoundError
 * - Inactive tenant → 403 TenantInactiveError
 */

import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { createSqlClient, createDb } from "../../db/client.js";
import { tenants } from "../../db/schema.js";
import {
  TenantNotFoundError,
  TenantInactiveError,
} from "../../lib/errors.js";

/** Hash an API key with SHA-256 for comparison against stored hashes */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

async function authMiddleware(fastify: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set — auth middleware requires DB");
  }

  const sqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db = createDb(sqlClient);

  // Clean up DB connection on server close
  fastify.addHook("onClose", async () => {
    await sqlClient.end();
  });

  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest) => {
      const apiKey = request.headers["x-api-key"];

      if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new TenantNotFoundError();
      }

      const apiKeyHash = hashApiKey(apiKey);

      const result = await db
        .select({
          id: tenants.id,
          isActive: tenants.isActive,
        })
        .from(tenants)
        .where(eq(tenants.apiKey, apiKeyHash))
        .limit(1);

      const tenant = result[0];

      if (!tenant) {
        throw new TenantNotFoundError();
      }

      if (!tenant.isActive) {
        throw new TenantInactiveError();
      }

      // Attach tenant ID to request context
      (request as unknown as { tenantId: string }).tenantId = tenant.id;
    }
  );
}

export const authPlugin = fp(authMiddleware, {
  name: "auth-middleware",
});
