/**
 * Events API routes — list and detail views.
 * GET /api/events      — list with filters + cursor pagination (Section 8b)
 * GET /api/events/:id  — detail with all delivery attempts (Section 8b)
 *
 * Auth: API key required (X-API-Key header)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { eq, and, gte, lte, sql, asc } from "drizzle-orm";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { events, deliveries } from "../db/schema.js";
import { authPlugin } from "./middleware/auth.js";
import { RATE_LIMITS } from "./middleware/rate-limit.js";
import { ValidationError, EventNotFoundError } from "../lib/errors.js";
import { uuidParamSchema, dateRangeSchema } from "./schemas/common.js";

/** Query schema for event list */
const eventListQuerySchema = z.object({
  source_id: z.string().uuid().optional(),
  status: z.string().optional(),
  from: dateRangeSchema.shape.from,
  to: dateRangeSchema.shape.to,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50),
  cursor: z.string().optional(),
});

async function eventRoutes(app: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set — event routes require DB");
  }

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);

  app.addHook("onClose", async () => {
    await sqlClient.end();
  });

  await app.register(async (instance) => {
    await instance.register(authPlugin);

    // GET /api/events — list
    instance.get(
      "/api/events",
      { config: { rateLimit: RATE_LIMITS.eventsRead } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        return handleListEvents(db, request, reply);
      }
    );

    // GET /api/events/:id — detail
    instance.get(
      "/api/events/:id",
      { config: { rateLimit: RATE_LIMITS.eventsRead } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        return handleGetEvent(db, request, reply);
      }
    );
  });
}

export default fp(eventRoutes, { name: "event-routes" });

/* ────── Handlers ────── */

async function handleListEvents(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const queryParse = eventListQuerySchema.safeParse(request.query);
  if (!queryParse.success) {
    const details = queryParse.error.errors.map((e) => e.message);
    throw new ValidationError("Invalid query parameters", details);
  }

  const { source_id, status, from, to, limit, cursor } = queryParse.data;
  const tenantId = request.tenantId;

  // Build WHERE conditions
  const conditions = [eq(events.tenantId, tenantId)];

  if (source_id) {
    conditions.push(eq(events.sourceId, source_id));
  }

  if (status) {
    conditions.push(eq(events.status, status));
  }

  if (from) {
    conditions.push(gte(events.receivedAt, new Date(from)));
  }

  if (to) {
    conditions.push(lte(events.receivedAt, new Date(to)));
  }

  // Decode cursor (offset-based)
  const offset = cursor
    ? parseInt(Buffer.from(cursor, "base64").toString(), 10)
    : 0;
  if (cursor && isNaN(offset)) {
    throw new ValidationError("Invalid cursor", ["cursor is malformed"]);
  }

  // Count total matching
  const totalResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(and(...conditions));

  const total = totalResult[0]?.count ?? 0;

  // Fetch rows
  const rows = await db
    .select({
      id: events.id,
      sourceId: events.sourceId,
      idempotencyKey: events.idempotencyKey,
      headers: events.headers,
      payload: events.payload,
      status: events.status,
      receivedAt: events.receivedAt,
      metadata: events.metadata,
    })
    .from(events)
    .where(and(...conditions))
    .orderBy(sql`${events.receivedAt} DESC, ${events.id} DESC`)
    .limit(limit)
    .offset(offset);

  const nextOffset = offset + rows.length;
  const nextCursor =
    nextOffset < total
      ? Buffer.from(String(nextOffset)).toString("base64")
      : undefined;

  const formattedEvents = rows.map((row) => ({
    id: row.id,
    source_id: row.sourceId,
    idempotency_key: row.idempotencyKey,
    headers: row.headers,
    payload: row.payload,
    status: row.status,
    received_at: row.receivedAt.toISOString(),
    metadata: row.metadata,
  }));

  const response: Record<string, unknown> = {
    events: formattedEvents,
    total,
  };

  if (nextCursor) {
    response.cursor = nextCursor;
  }

  return reply.status(200).send(response);
}

async function handleGetEvent(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const paramParse = uuidParamSchema.safeParse(request.params);
  if (!paramParse.success) {
    throw new ValidationError("Invalid event ID", [
      "id must be a valid UUID",
    ]);
  }

  const { id } = paramParse.data;
  const tenantId = request.tenantId;

  // Fetch the event
  const eventResult = await db
    .select({
      id: events.id,
      sourceId: events.sourceId,
      idempotencyKey: events.idempotencyKey,
      headers: events.headers,
      payload: events.payload,
      status: events.status,
      receivedAt: events.receivedAt,
      metadata: events.metadata,
    })
    .from(events)
    .where(and(eq(events.id, id), eq(events.tenantId, tenantId)))
    .limit(1);

  const event = eventResult[0];
  if (!event) {
    throw new EventNotFoundError(id);
  }

  // Fetch all delivery attempts for this event
  const deliveryRows = await db
    .select({
      id: deliveries.id,
      destinationId: deliveries.destinationId,
      attempt: deliveries.attempt,
      status: deliveries.status,
      statusCode: deliveries.statusCode,
      responseBody: deliveries.responseBody,
      errorMessage: deliveries.errorMessage,
      durationMs: deliveries.durationMs,
      attemptedAt: deliveries.attemptedAt,
      nextRetryAt: deliveries.nextRetryAt,
    })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.eventId, id),
        eq(deliveries.tenantId, tenantId)
      )
    )
    .orderBy(asc(deliveries.attempt));

  return reply.status(200).send({
    event: {
      id: event.id,
      source_id: event.sourceId,
      idempotency_key: event.idempotencyKey,
      headers: event.headers,
      payload: event.payload,
      status: event.status,
      received_at: event.receivedAt.toISOString(),
      metadata: event.metadata,
    },
    deliveries: deliveryRows.map((d) => ({
      id: d.id,
      destination_id: d.destinationId,
      attempt: d.attempt,
      status: d.status,
      status_code: d.statusCode,
      response_body: d.responseBody,
      error_message: d.errorMessage,
      duration_ms: d.durationMs,
      attempted_at: d.attemptedAt.toISOString(),
      next_retry_at: d.nextRetryAt?.toISOString() ?? null,
    })),
  });
}
