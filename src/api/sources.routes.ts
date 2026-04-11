/**
 * Source management routes — register and manage webhook sources.
 * POST /api/sources — create a new webhook source (Section 5.4)
 * GET  /api/sources — list sources with delivery stats (Section 5.4)
 * PUT  /api/sources/:id — update source config (Section 5.4)
 *
 * Auth: API key required (X-API-Key header)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { Redis } from "ioredis";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { sources } from "../db/schema.js";
import { authPlugin } from "./middleware/auth.js";
import { RATE_LIMITS } from "./middleware/rate-limit.js";
import {
  ValidationError,
  DuplicateSourceError,
  SourceNotFoundError,
} from "../lib/errors.js";
import { uuidParamSchema } from "./schemas/common.js";
import { handleListSources } from "./sources-list.handler.js";
import { invalidateCachedSource } from "../ingestion/source-cache.js";

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

/** Request body schema for source update (all fields optional) */
const updateSourceBodySchema = z.object({
  name: z.string().trim().min(1, "name must not be empty").optional(),
  slug: z
    .string()
    .trim()
    .min(1, "slug must not be empty")
    .regex(
      SLUG_PATTERN,
      "slug must be URL-safe (lowercase letters, digits, hyphens)"
    )
    .optional(),
  signature_header: z.string().optional(),
  signature_algo: z
    .enum(["hmac-sha256", "hmac-sha1", "none"])
    .optional(),
  signing_secret: z.string().optional(),
  enabled: z.boolean().optional(),
});

async function sourceRoutes(app: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL not set — source routes require DB"
    );
  }
  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL not set — source routes require Redis for cache"
    );
  }

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);
  const redis = new Redis(redisUrl);

  app.addHook("onClose", async () => {
    await redis.quit();
    await sqlClient.end();
  });

  await app.register(async (instance) => {
    await instance.register(authPlugin);

    instance.post(
      "/api/sources",
      { config: { rateLimit: RATE_LIMITS.sourcesCreate } },
      async (request, reply) => {
        return handleCreateSource(db, request, reply);
      }
    );

    instance.get(
      "/api/sources",
      { config: { rateLimit: RATE_LIMITS.sourcesRead } },
      async (request, reply) => {
        return handleListSources(db, request, reply);
      }
    );

    instance.put(
      "/api/sources/:id",
      { config: { rateLimit: RATE_LIMITS.sourcesUpdate } },
      async (request, reply) => {
        return handleUpdateSource(db, redis, request, reply);
      }
    );
  });
}

export default fp(sourceRoutes, { name: "source-routes" });

/* ────── Handlers ────── */

async function handleCreateSource(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const parseResult = createSourceBodySchema.safeParse(request.body);
  if (!parseResult.success) {
    const details = parseResult.error.errors.map((e) => e.message);
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
    // Drizzle-orm v0.45+ wraps DB errors in DrizzleQueryError with .cause
    const pgError = extractPgError(err);
    if (pgError?.code === "23505") {
      const constraintName =
        pgError.constraint_name ?? pgError.constraint ?? "";
      if (constraintName.includes("slug")) {
        throw new DuplicateSourceError(slug);
      }
    }
    throw err;
  }
}

/** Extract PostgreSQL error from drizzle-orm's DrizzleQueryError wrapper */
interface PgError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

function extractPgError(err: unknown): PgError | null {
  const direct = err as PgError;
  if (direct?.code) return direct;

  // Drizzle-orm v0.45+ wraps in DrizzleQueryError with .cause
  const wrapped = err as { cause?: PgError };
  if (wrapped?.cause?.code) return wrapped.cause;

  return null;
}

async function handleUpdateSource(
  db: Database,
  redis: Redis,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const paramParse = uuidParamSchema.safeParse(request.params);
  if (!paramParse.success) {
    throw new ValidationError("Invalid source ID", [
      "id must be a valid UUID",
    ]);
  }

  const { id } = paramParse.data;
  const tenantId = request.tenantId;

  const bodyParse = updateSourceBodySchema.safeParse(request.body);
  if (!bodyParse.success) {
    const details = bodyParse.error.errors.map((e) => e.message);
    throw new ValidationError(
      "Invalid source update request",
      details
    );
  }

  const updateData = bodyParse.data;

  // Fetch current slug before update so we can invalidate the old cache entry
  const currentSource = await db
    .select({ slug: sources.slug })
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.tenantId, tenantId)))
    .limit(1);
  const oldSlug = currentSource[0]?.slug;

  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (updateData.name !== undefined) setClause.name = updateData.name;
  if (updateData.slug !== undefined) setClause.slug = updateData.slug;
  if (updateData.signature_header !== undefined)
    setClause.signatureHeader = updateData.signature_header;
  if (updateData.signature_algo !== undefined)
    setClause.signatureAlgo = updateData.signature_algo;
  if (updateData.signing_secret !== undefined)
    setClause.signingSecret = updateData.signing_secret;
  if (updateData.enabled !== undefined)
    setClause.enabled = updateData.enabled;

  const result = await db
    .update(sources)
    .set(setClause)
    .where(and(eq(sources.id, id), eq(sources.tenantId, tenantId)))
    .returning({
      id: sources.id,
      tenantId: sources.tenantId,
      name: sources.name,
      slug: sources.slug,
      signatureHeader: sources.signatureHeader,
      signatureAlgo: sources.signatureAlgo,
      enabled: sources.enabled,
      createdAt: sources.createdAt,
      updatedAt: sources.updatedAt,
    });

  const updated = result[0];
  if (!updated) {
    throw new SourceNotFoundError(id);
  }

  // Invalidate cache for old slug (always) and new slug (if changed)
  if (oldSlug) {
    await invalidateCachedSource(redis, oldSlug);
  }
  if (updateData.slug && updateData.slug !== oldSlug) {
    await invalidateCachedSource(redis, updateData.slug);
  }

  return reply.status(200).send({
    source: {
      id: updated.id,
      tenant_id: updated.tenantId,
      name: updated.name,
      slug: updated.slug,
      signature_header: updated.signatureHeader,
      signature_algo: updated.signatureAlgo,
      enabled: updated.enabled,
      created_at: updated.createdAt.toISOString(),
      updated_at: updated.updatedAt.toISOString(),
    },
  });
}
