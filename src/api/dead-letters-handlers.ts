/**
 * Dead letter handler functions — list and detail views.
 * Extracted to keep dead-letters.routes.ts under 300 lines.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { eq, and, sql, gte, lte, asc } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { deliveries, events, destinations } from "../db/schema.js";
import { DeliveryNotFoundError, ValidationError } from "../lib/errors.js";
import { dateRangeSchema } from "./schemas/common.js";

/** Query schema for dead letter list */
const deadLetterListQuerySchema = z.object({
  source_id: z.string().uuid().optional(),
  destination_id: z.string().uuid().optional(),
  from: dateRangeSchema.shape.from,
  to: dateRangeSchema.shape.to,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25),
  cursor: z.string().optional(),
});

/** Delivery ID param schema */
const deliveryIdParamSchema = z.object({
  deliveryId: z.string().uuid("Must be a valid UUID"),
});

/**
 * GET /api/dead-letters — list dead-lettered deliveries with filters.
 */
export async function handleListDeadLetters(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const queryParse = deadLetterListQuerySchema.safeParse(request.query);
  if (!queryParse.success) {
    const details = queryParse.error.errors.map((e) => e.message);
    throw new ValidationError("Invalid query parameters", details);
  }

  const { source_id, destination_id, from, to, limit, cursor } = queryParse.data;
  const tenantId = request.tenantId;

  // Build WHERE conditions
  const conditions = [
    eq(deliveries.tenantId, tenantId),
    eq(deliveries.status, "dead_letter"),
  ];

  if (destination_id) {
    conditions.push(eq(deliveries.destinationId, destination_id));
  }

  if (from) {
    conditions.push(gte(deliveries.attemptedAt, new Date(from)));
  }

  if (to) {
    conditions.push(lte(deliveries.attemptedAt, new Date(to)));
  }

  // Decode cursor (offset-based for simplicity)
  const offset = cursor ? parseInt(Buffer.from(cursor, "base64").toString(), 10) : 0;
  if (cursor && isNaN(offset)) {
    throw new ValidationError("Invalid cursor", ["cursor is malformed"]);
  }

  // Count total matching
  let totalResult;
  let rows;

  if (source_id) {
    // Join with destinations to filter by source
    totalResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveries)
      .innerJoin(destinations, eq(deliveries.destinationId, destinations.id))
      .where(and(...conditions, eq(destinations.sourceId, source_id)));

    rows = await db
      .select({
        id: deliveries.id,
        eventId: deliveries.eventId,
        destinationId: deliveries.destinationId,
        attempt: deliveries.attempt,
        status: deliveries.status,
        statusCode: deliveries.statusCode,
        errorMessage: deliveries.errorMessage,
        attemptedAt: deliveries.attemptedAt,
        destinationUrl: destinations.url,
      })
      .from(deliveries)
      .innerJoin(destinations, eq(deliveries.destinationId, destinations.id))
      .where(and(...conditions, eq(destinations.sourceId, source_id)))
      .orderBy(sql`${deliveries.attemptedAt} DESC, ${deliveries.id} DESC`)
      .limit(limit)
      .offset(offset);
  } else {
    totalResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveries)
      .leftJoin(destinations, eq(deliveries.destinationId, destinations.id))
      .where(and(...conditions));

    rows = await db
      .select({
        id: deliveries.id,
        eventId: deliveries.eventId,
        destinationId: deliveries.destinationId,
        attempt: deliveries.attempt,
        status: deliveries.status,
        statusCode: deliveries.statusCode,
        errorMessage: deliveries.errorMessage,
        attemptedAt: deliveries.attemptedAt,
        destinationUrl: destinations.url,
      })
      .from(deliveries)
      .leftJoin(destinations, eq(deliveries.destinationId, destinations.id))
      .where(and(...conditions))
      .orderBy(sql`${deliveries.attemptedAt} DESC, ${deliveries.id} DESC`)
      .limit(limit)
      .offset(offset);
  }

  const total = totalResult[0]?.count ?? 0;
  const nextOffset = offset + rows.length;
  const nextCursor = nextOffset < total
    ? Buffer.from(String(nextOffset)).toString("base64")
    : undefined;

  const formattedDeliveries = rows.map((row) => ({
    id: row.id,
    event_id: row.eventId,
    destination_id: row.destinationId,
    attempt: row.attempt,
    status: row.status,
    status_code: row.statusCode,
    error_message: row.errorMessage,
    attempted_at: row.attemptedAt.toISOString(),
    destination_url: row.destinationUrl,
  }));

  const response: Record<string, unknown> = {
    deliveries: formattedDeliveries,
    total,
  };

  if (nextCursor) {
    response.cursor = nextCursor;
  }

  return reply.status(200).send(response);
}

/**
 * GET /api/dead-letters/:deliveryId — full delivery detail with attempts.
 */
export async function handleGetDeadLetter(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const paramParse = deliveryIdParamSchema.safeParse(request.params);
  if (!paramParse.success) {
    throw new ValidationError("Invalid delivery ID", [
      "deliveryId must be a valid UUID",
    ]);
  }

  const { deliveryId } = paramParse.data;
  const tenantId = request.tenantId;

  // Fetch the delivery with event + destination
  const result = await db
    .select({
      id: deliveries.id,
      eventId: deliveries.eventId,
      destinationId: deliveries.destinationId,
      attempt: deliveries.attempt,
      status: deliveries.status,
      statusCode: deliveries.statusCode,
      responseBody: deliveries.responseBody,
      errorMessage: deliveries.errorMessage,
      durationMs: deliveries.durationMs,
      attemptedAt: deliveries.attemptedAt,
      nextRetryAt: deliveries.nextRetryAt,
      // Event fields
      evId: events.id,
      evPayload: events.payload,
      evHeaders: events.headers,
      // Destination fields
      destId: destinations.id,
      destUrl: destinations.url,
      destMethod: destinations.method,
    })
    .from(deliveries)
    .leftJoin(events, eq(deliveries.eventId, events.id))
    .leftJoin(destinations, eq(deliveries.destinationId, destinations.id))
    .where(
      and(
        eq(deliveries.id, deliveryId),
        eq(deliveries.tenantId, tenantId),
        eq(deliveries.status, "dead_letter")
      )
    )
    .limit(1);

  const delivery = result[0];
  if (!delivery) {
    throw new DeliveryNotFoundError(deliveryId);
  }

  // Fetch all attempts for same event+destination
  const attempts = await db
    .select({
      id: deliveries.id,
      attempt: deliveries.attempt,
      status: deliveries.status,
      statusCode: deliveries.statusCode,
      errorMessage: deliveries.errorMessage,
      durationMs: deliveries.durationMs,
      attemptedAt: deliveries.attemptedAt,
    })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.tenantId, tenantId),
        eq(deliveries.eventId, delivery.eventId!),
        eq(deliveries.destinationId, delivery.destinationId!)
      )
    )
    .orderBy(asc(deliveries.attempt));

  return reply.status(200).send({
    delivery: {
      id: delivery.id,
      event_id: delivery.eventId,
      destination_id: delivery.destinationId,
      attempt: delivery.attempt,
      status: delivery.status,
      status_code: delivery.statusCode,
      response_body: delivery.responseBody,
      error_message: delivery.errorMessage,
      duration_ms: delivery.durationMs,
      attempted_at: delivery.attemptedAt.toISOString(),
      next_retry_at: delivery.nextRetryAt?.toISOString() ?? null,
      event: {
        id: delivery.evId,
        payload: delivery.evPayload,
        headers: delivery.evHeaders,
      },
      destination: {
        id: delivery.destId,
        url: delivery.destUrl,
        method: delivery.destMethod,
      },
      attempts: attempts.map((a) => ({
        id: a.id,
        attempt: a.attempt,
        status: a.status,
        status_code: a.statusCode,
        error_message: a.errorMessage,
        duration_ms: a.durationMs,
        attempted_at: a.attemptedAt.toISOString(),
      })),
    },
  });
}
