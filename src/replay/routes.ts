/**
 * Replay API routes — create and track replay requests.
 * POST /api/replays — create replay request with filters (Section 5.3)
 *
 * Auth: API key required (X-API-Key header)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { authPlugin } from "../api/middleware/auth.js";
import { RATE_LIMITS } from "../api/middleware/rate-limit.js";
import { ValidationError } from "../lib/errors.js";
import { createDeliveryQueue } from "../delivery/queue.js";
import { executeReplay } from "./engine.js";
import { loadConfig } from "../config.js";

/** Request body schema for replay creation */
const createReplayBodySchema = z
  .object({
    source_id: z.string().uuid("source_id must be a valid UUID").optional(),
    event_ids: z
      .array(z.string().uuid("Each event_id must be a valid UUID"))
      .min(1, "event_ids must contain at least one ID")
      .optional(),
    from: z
      .string()
      .datetime({ message: "from must be a valid ISO 8601 datetime" })
      .optional(),
    to: z
      .string()
      .datetime({ message: "to must be a valid ISO 8601 datetime" })
      .optional(),
  })
  .refine(
    (data) => data.source_id || data.event_ids || data.from || data.to,
    {
      message:
        "At least one filter is required (source_id, event_ids, from, or to)",
    }
  );

async function replayRoutes(app: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set — replay routes require DB");
  }

  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) {
    throw new Error("REDIS_URL not set — replay routes require Redis");
  }

  const config = loadConfig();
  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);
  const queue = createDeliveryQueue(redisUrl);

  app.addHook("onClose", async () => {
    await queue.close();
    await sqlClient.end();
  });

  await app.register(async (instance) => {
    await instance.register(authPlugin);

    // POST /api/replays — create replay request
    instance.post(
      "/api/replays",
      { config: { rateLimit: RATE_LIMITS.replaysCreate } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        return handleCreateReplay(
          db,
          queue,
          config.replayBatchSize,
          request,
          reply
        );
      }
    );
  });
}

export default fp(replayRoutes, { name: "replay-routes" });

/* ────── Handler ────── */

async function handleCreateReplay(
  db: Database,
  queue: ReturnType<typeof createDeliveryQueue>,
  batchSize: number,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const bodyParse = createReplayBodySchema.safeParse(request.body ?? {});
  if (!bodyParse.success) {
    const details = bodyParse.error.errors.map((e) => e.message);
    throw new ValidationError("Invalid replay request", details);
  }

  const { source_id, event_ids, from, to } = bodyParse.data;
  const tenantId = request.tenantId;

  const result = await executeReplay({
    db,
    queue,
    options: {
      tenantId,
      sourceId: source_id,
      eventIds: event_ids,
      fromTimestamp: from ? new Date(from) : undefined,
      toTimestamp: to ? new Date(to) : undefined,
    },
    batchSize,
  });

  return reply.status(201).send({
    replay_request: {
      id: result.replayRequestId,
      tenant_id: tenantId,
      source_id: source_id ?? null,
      status: "completed",
      total_events: result.totalEvents,
      processed: result.processed,
      failed: result.failed,
      created_at: new Date().toISOString(),
    },
  });
}
