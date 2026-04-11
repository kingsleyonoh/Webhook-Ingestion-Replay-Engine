/**
 * Destination management routes — add/remove delivery destinations.
 * POST   /api/sources/:id/destinations          — add destination
 * DELETE /api/sources/:id/destinations/:destId   — remove destination
 *
 * Auth: API key required (X-API-Key header)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { sources, destinations } from "../db/schema.js";
import { authPlugin } from "./middleware/auth.js";
import { RATE_LIMITS } from "./middleware/rate-limit.js";
import {
  ValidationError,
  SourceNotFoundError,
  DestinationNotFoundError,
} from "../lib/errors.js";
import { validateDestinationUrl } from "../lib/url-validator.js";
import { uuidParamSchema } from "./schemas/common.js";

/** Source + destination path params */
const sourceDestParamSchema = z.object({
  id: z.string().uuid("Source ID must be a valid UUID"),
  destId: z.string().uuid("Destination ID must be a valid UUID"),
});

/** Request body schema for destination creation */
const createDestinationBodySchema = z.object({
  url: z
    .string({ required_error: "url is required" })
    .trim()
    .min(1, "url must not be empty"),
  method: z.string().trim().toUpperCase().default("POST").optional(),
  headers: z.record(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional(),
  backoff_base_ms: z.number().int().positive().optional(),
});

async function destinationRoutes(
  app: FastifyInstance
): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL not set — destination routes require DB"
    );
  }

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);

  app.addHook("onClose", async () => {
    await sqlClient.end();
  });

  await app.register(async (instance) => {
    await instance.register(authPlugin);

    instance.post(
      "/api/sources/:id/destinations",
      { config: { rateLimit: RATE_LIMITS.destinationsCreate } },
      async (request, reply) => {
        return handleCreateDestination(db, request, reply);
      }
    );

    instance.delete(
      "/api/sources/:id/destinations/:destId",
      { config: { rateLimit: RATE_LIMITS.sourcesUpdate } },
      async (request, reply) => {
        return handleDeleteDestination(db, request, reply);
      }
    );
  });
}

export default fp(destinationRoutes, {
  name: "destination-routes",
});

/* ────── Handlers ────── */

async function handleCreateDestination(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  // Validate source ID param
  const paramParse = uuidParamSchema.safeParse(request.params);
  if (!paramParse.success) {
    throw new ValidationError("Invalid source ID", [
      "id must be a valid UUID",
    ]);
  }

  const { id: sourceId } = paramParse.data;
  const tenantId = request.tenantId;

  // Validate body
  const bodyParse = createDestinationBodySchema.safeParse(request.body);
  if (!bodyParse.success) {
    const details = bodyParse.error.errors.map((e) => e.message);
    throw new ValidationError(
      "Invalid destination creation request",
      details
    );
  }

  // SSRF protection: validate destination URL before persisting
  validateDestinationUrl(bodyParse.data.url);

  // Verify source exists and belongs to tenant
  const sourceCheck = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(eq(sources.id, sourceId), eq(sources.tenantId, tenantId))
    )
    .limit(1);

  if (sourceCheck.length === 0) {
    throw new SourceNotFoundError(sourceId);
  }

  const {
    url,
    method,
    headers,
    timeout_ms,
    max_retries,
    backoff_base_ms,
  } = bodyParse.data;

  const result = await db
    .insert(destinations)
    .values({
      tenantId,
      sourceId,
      url,
      method: method ?? "POST",
      headers: headers ?? {},
      timeoutMs: timeout_ms ?? 10000,
      maxRetries: max_retries ?? 5,
      backoffBaseMs: backoff_base_ms ?? 1000,
      enabled: true,
    })
    .returning({
      id: destinations.id,
      tenantId: destinations.tenantId,
      sourceId: destinations.sourceId,
      url: destinations.url,
      method: destinations.method,
      headers: destinations.headers,
      timeoutMs: destinations.timeoutMs,
      maxRetries: destinations.maxRetries,
      backoffBaseMs: destinations.backoffBaseMs,
      enabled: destinations.enabled,
      createdAt: destinations.createdAt,
    });

  const dest = result[0]!;

  return reply.status(201).send({
    destination: {
      id: dest.id,
      tenant_id: dest.tenantId,
      source_id: dest.sourceId,
      url: dest.url,
      method: dest.method,
      headers: dest.headers,
      timeout_ms: dest.timeoutMs,
      max_retries: dest.maxRetries,
      backoff_base_ms: dest.backoffBaseMs,
      enabled: dest.enabled,
      created_at: dest.createdAt.toISOString(),
    },
  });
}

async function handleDeleteDestination(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  // Validate path params
  const paramParse = sourceDestParamSchema.safeParse(request.params);
  if (!paramParse.success) {
    const details = paramParse.error.errors.map((e) => e.message);
    throw new ValidationError("Invalid path parameters", details);
  }

  const { id: sourceId, destId } = paramParse.data;
  const tenantId = request.tenantId;

  // Delete destination only if it belongs to this tenant + source
  const result = await db
    .delete(destinations)
    .where(
      and(
        eq(destinations.id, destId),
        eq(destinations.sourceId, sourceId),
        eq(destinations.tenantId, tenantId)
      )
    )
    .returning({ id: destinations.id });

  if (result.length === 0) {
    throw new DestinationNotFoundError(destId);
  }

  return reply.status(204).send();
}
