/**
 * Dead letter inspector routes — list, detail, retry, bulk-retry.
 * GET  /api/dead-letters            — list dead-lettered deliveries (Section 5.5 step 1)
 * GET  /api/dead-letters/:deliveryId — full delivery details (Section 5.5 step 2)
 * POST /api/dead-letters/:deliveryId/retry — re-enqueue single (Section 5.5 step 3)
 * POST /api/dead-letters/bulk-retry — re-enqueue all matching (Section 5.5 step 4)
 *
 * Auth: API key required (X-API-Key header)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { deliveries, destinations } from "../db/schema.js";
import { authPlugin } from "./middleware/auth.js";
import { RATE_LIMITS } from "./middleware/rate-limit.js";
import { DeliveryNotFoundError, ValidationError } from "../lib/errors.js";
import { createDeliveryQueue } from "../delivery/queue.js";
import {
  handleListDeadLetters,
  handleGetDeadLetter,
} from "./dead-letters-handlers.js";

/** Delivery ID param schema */
const deliveryIdParamSchema = z.object({
  deliveryId: z.string().uuid("Must be a valid UUID"),
});

/** Bulk retry request body schema */
const bulkRetryBodySchema = z.object({
  source_id: z.string().uuid("source_id must be a valid UUID").optional(),
  destination_id: z.string().uuid("destination_id must be a valid UUID").optional(),
  from: z.string().datetime({ message: "from must be valid ISO 8601" }).optional(),
  to: z.string().datetime({ message: "to must be valid ISO 8601" }).optional(),
});

async function deadLetterRoutes(app: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set — dead-letter routes require DB");
  }

  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) {
    throw new Error("REDIS_URL not set — dead-letter retry requires Redis");
  }

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);
  const queue = createDeliveryQueue(redisUrl);

  app.addHook("onClose", async () => {
    await queue.close();
    await sqlClient.end();
  });

  await app.register(async (instance) => {
    await instance.register(authPlugin);

    // GET /api/dead-letters — list
    instance.get(
      "/api/dead-letters",
      { config: { rateLimit: RATE_LIMITS.deadLettersRead } },
      async (request, reply) => {
        return handleListDeadLetters(db, request, reply);
      }
    );

    // GET /api/dead-letters/:deliveryId — detail
    instance.get(
      "/api/dead-letters/:deliveryId",
      { config: { rateLimit: RATE_LIMITS.eventsRead } },
      async (request, reply) => {
        return handleGetDeadLetter(db, request, reply);
      }
    );

    // POST /api/dead-letters/:deliveryId/retry — single retry
    instance.post(
      "/api/dead-letters/:deliveryId/retry",
      { config: { rateLimit: RATE_LIMITS.deadLettersRetry } },
      async (request, reply) => {
        return handleRetryDeadLetter(db, queue, request, reply);
      }
    );

    // POST /api/dead-letters/bulk-retry — bulk retry
    instance.post(
      "/api/dead-letters/bulk-retry",
      { config: { rateLimit: RATE_LIMITS.replaysCreate } },
      async (request, reply) => {
        return handleBulkRetry(db, queue, request, reply);
      }
    );
  });
}

export default fp(deadLetterRoutes, { name: "dead-letter-routes" });

/* ────── Handlers (retry + bulk-retry) ────── */

async function handleRetryDeadLetter(
  db: Database,
  queue: ReturnType<typeof createDeliveryQueue>,
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

  // Find the dead-lettered delivery scoped to tenant
  const result = await db
    .select({
      id: deliveries.id,
      eventId: deliveries.eventId,
      destinationId: deliveries.destinationId,
      status: deliveries.status,
    })
    .from(deliveries)
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

  // Reset status to pending and attempt to 1
  await db
    .update(deliveries)
    .set({ status: "pending", attempt: 1 })
    .where(eq(deliveries.id, deliveryId));

  // Enqueue delivery job
  await queue.add("deliver", {
    eventId: delivery.eventId!,
    destinationId: delivery.destinationId!,
    tenantId,
  });

  return reply.status(200).send({
    retried: true,
    delivery_id: deliveryId,
  });
}

async function handleBulkRetry(
  db: Database,
  queue: ReturnType<typeof createDeliveryQueue>,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const bodyParse = bulkRetryBodySchema.safeParse(request.body ?? {});
  if (!bodyParse.success) {
    const details = bodyParse.error.errors.map((e) => e.message);
    throw new ValidationError("Invalid bulk retry request", details);
  }

  const { source_id, destination_id, from, to } = bodyParse.data;
  const tenantId = request.tenantId;

  // Build conditions
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

  // If source_id filter, join with destinations to filter by source
  let matchingDeliveries;
  if (source_id) {
    matchingDeliveries = await db
      .select({
        id: deliveries.id,
        eventId: deliveries.eventId,
        destinationId: deliveries.destinationId,
      })
      .from(deliveries)
      .innerJoin(
        destinations,
        eq(deliveries.destinationId, destinations.id)
      )
      .where(
        and(...conditions, eq(destinations.sourceId, source_id))
      );
  } else {
    matchingDeliveries = await db
      .select({
        id: deliveries.id,
        eventId: deliveries.eventId,
        destinationId: deliveries.destinationId,
      })
      .from(deliveries)
      .where(and(...conditions));
  }

  const totalMatching = matchingDeliveries.length;

  if (totalMatching === 0) {
    return reply.status(200).send({
      retried: 0,
      total_matching: 0,
    });
  }

  // Update all matching to pending and enqueue jobs
  const ids = matchingDeliveries.map((d) => d.id);

  await db
    .update(deliveries)
    .set({ status: "pending", attempt: 1 })
    .where(
      sql`${deliveries.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    );

  // Enqueue jobs for each delivery
  const jobs = matchingDeliveries.map((d) => ({
    name: "deliver" as const,
    data: {
      eventId: d.eventId!,
      destinationId: d.destinationId!,
      tenantId,
    },
  }));

  await queue.addBulk(jobs);

  return reply.status(200).send({
    retried: totalMatching,
    total_matching: totalMatching,
  });
}
