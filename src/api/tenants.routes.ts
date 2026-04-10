/**
 * Tenant management routes — registration and profile.
 * POST /api/tenants/register — public, rate-limited (5/min)
 * GET /api/tenants/me — authenticated, rate-limited (100/min)
 *
 * Section 8b — Tenant endpoints.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { tenants } from "../db/schema.js";
import { hashApiKey } from "./middleware/auth.js";
import { authPlugin } from "./middleware/auth.js";
import { RATE_LIMITS } from "./middleware/rate-limit.js";
import { loadConfig } from "../config.js";
import {
  ValidationError,
  RegistrationDisabledError,
  DuplicateTenantError,
} from "../lib/errors.js";

/** Request body schema for tenant registration */
const registerBodySchema = z.object({
  name: z
    .string({ required_error: "name is required" })
    .trim()
    .min(1, "name must not be empty"),
});

async function tenantRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set — tenant routes require DB");
  }

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);

  // Clean up DB connection on server close
  app.addHook("onClose", async () => {
    await sqlClient.end();
  });

  /**
   * POST /api/tenants/register
   * Public endpoint — creates a new tenant, returns API key (shown once).
   */
  app.post(
    "/api/tenants/register",
    {
      config: { rateLimit: RATE_LIMITS.tenantRegister },
    },
    async (request, reply) => {
      // Check if self-registration is enabled
      if (!config.selfRegistrationEnabled) {
        throw new RegistrationDisabledError();
      }

      // Validate request body
      const parseResult = registerBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        const details = parseResult.error.errors.map(
          (e) => e.message
        );
        throw new ValidationError(
          "Invalid registration request",
          details
        );
      }

      const { name } = parseResult.data;

      // Check for duplicate tenant name
      const existing = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.name, name))
        .limit(1);

      if (existing.length > 0) {
        throw new DuplicateTenantError(name);
      }

      // Generate API key
      const rawApiKey = crypto.randomBytes(32).toString("hex");
      const apiKeyHash = hashApiKey(rawApiKey);

      // Insert tenant
      const result = await db
        .insert(tenants)
        .values({
          name,
          apiKey: apiKeyHash,
          isActive: true,
        })
        .returning({
          id: tenants.id,
          name: tenants.name,
          isActive: tenants.isActive,
          createdAt: tenants.createdAt,
        });

      const tenant = result[0]!;

      return reply.status(201).send({
        tenant: {
          id: tenant.id,
          name: tenant.name,
          is_active: tenant.isActive,
          created_at: tenant.createdAt.toISOString(),
        },
        apiKey: rawApiKey,
      });
    }
  );

  /**
   * GET /api/tenants/me
   * Authenticated endpoint — returns the tenant profile for the API key owner.
   */
  await app.register(async (instance) => {
    await instance.register(authPlugin);

    instance.get(
      "/api/tenants/me",
      {
        config: { rateLimit: RATE_LIMITS.tenantMe },
      },
      async (request, reply) => {
        const tenantId = request.tenantId;

        const result = await db
          .select({
            id: tenants.id,
            name: tenants.name,
            isActive: tenants.isActive,
            createdAt: tenants.createdAt,
          })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);

        const tenant = result[0]!;

        return reply.send({
          tenant: {
            id: tenant.id,
            name: tenant.name,
            is_active: tenant.isActive,
            created_at: tenant.createdAt.toISOString(),
          },
        });
      }
    );
  });
}

export default fp(tenantRoutes, { name: "tenant-routes" });
