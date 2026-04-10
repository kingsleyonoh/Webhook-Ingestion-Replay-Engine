/**
 * Source management routes — register and manage webhook sources.
 * POST /api/sources — create a new webhook source (Section 5.4)
 *
 * Auth: API key required (X-API-Key header)
 * Rate limit: 50/min (sourcesCreate)
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { sources } from "../db/schema.js";
import { authPlugin } from "./middleware/auth.js";
import { RATE_LIMITS } from "./middleware/rate-limit.js";
import {
  ValidationError,
  DuplicateSourceError,
} from "../lib/errors.js";

/** URL-safe slug pattern: lowercase letters, digits, hyphens */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Request body schema for source creation */
const createSourceBodySchema = z.object({
  name: z
    .string({ required_error: "name is required" })
    .trim()
    .min(1, "name must not be empty"),
  slug: z
    .string({ required_error: "slug is required" })
    .trim()
    .min(1, "slug must not be empty")
    .regex(
      SLUG_PATTERN,
      "slug must be URL-safe (lowercase letters, digits, hyphens)"
    ),
  signature_header: z.string().optional(),
  signature_algo: z
    .enum(["hmac-sha256", "hmac-sha1", "none"])
    .optional(),
  signing_secret: z.string().optional(),
});

async function sourceRoutes(app: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL not set — source routes require DB"
    );
  }

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);

  // Clean up DB connection on server close
  app.addHook("onClose", async () => {
    await sqlClient.end();
  });

  // Use encapsulated sub-instance for authenticated routes
  await app.register(async (instance) => {
    await instance.register(authPlugin);

    /**
     * POST /api/sources
     * Create a new webhook source for the authenticated tenant.
     */
    instance.post(
      "/api/sources",
      {
        config: { rateLimit: RATE_LIMITS.sourcesCreate },
      },
      async (request, reply) => {
        // Validate request body
        const parseResult = createSourceBodySchema.safeParse(
          request.body
        );
        if (!parseResult.success) {
          const details = parseResult.error.errors.map(
            (e) => e.message
          );
          throw new ValidationError(
            "Invalid source creation request",
            details
          );
        }

        const {
          name,
          slug,
          signature_header,
          signature_algo,
          signing_secret,
        } = parseResult.data;
        const tenantId = request.tenantId;

        // Insert source — unique constraint on (tenant_id, slug)
        try {
          const result = await db
            .insert(sources)
            .values({
              tenantId,
              name,
              slug,
              signatureHeader: signature_header ?? null,
              signatureAlgo: signature_algo ?? null,
              signingSecret: signing_secret ?? null,
              enabled: true,
            })
            .returning({
              id: sources.id,
              tenantId: sources.tenantId,
              name: sources.name,
              slug: sources.slug,
              signatureHeader: sources.signatureHeader,
              signatureAlgo: sources.signatureAlgo,
              enabled: sources.enabled,
              createdAt: sources.createdAt,
            });

          const source = result[0]!;

          return reply.status(201).send({
            source: {
              id: source.id,
              tenant_id: source.tenantId,
              name: source.name,
              slug: source.slug,
              signature_header: source.signatureHeader,
              signature_algo: source.signatureAlgo,
              enabled: source.enabled,
              created_at: source.createdAt.toISOString(),
            },
          });
        } catch (err: unknown) {
          // Check for unique constraint violation on slug
          // postgres.js uses `constraint_name`, Drizzle may use `constraint`
          const pgError = err as {
            code?: string;
            constraint_name?: string;
            constraint?: string;
          };
          if (pgError.code === "23505") {
            const constraintName =
              pgError.constraint_name ?? pgError.constraint ?? "";
            if (constraintName.includes("slug")) {
              throw new DuplicateSourceError(slug);
            }
          }
          throw err;
        }
      }
    );
  });
}

export default fp(sourceRoutes, { name: "source-routes" });
