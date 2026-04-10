/**
 * Stats dashboard route — tenant-scoped aggregated statistics.
 * GET /api/stats — sources count, events today, delivery success rate, dead letters.
 *
 * Section 8b: Auth required, rate limit 60/min.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { eq, and, gte, count, sql } from "drizzle-orm";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { sources, events, deliveries } from "../db/schema.js";
import { authPlugin } from "./middleware/auth.js";
import { RATE_LIMITS } from "./middleware/rate-limit.js";

async function statsRoutes(app: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not set — stats routes require DB");
  }

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 3 });
  const db: Database = createDb(sqlClient);

  app.addHook("onClose", async () => {
    await sqlClient.end();
  });

  await app.register(async (instance) => {
    await instance.register(authPlugin);

    instance.get(
      "/api/stats",
      { config: { rateLimit: RATE_LIMITS.statsRead } },
      async (request, reply) => {
        return handleGetStats(db, request, reply);
      }
    );
  });
}

export default fp(statsRoutes, { name: "stats-routes" });

/* ────── Handler ────── */

async function handleGetStats(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const tenantId = request.tenantId;

  // Start of today (UTC)
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  // Run all 4 independent queries in parallel
  const [sourcesResult, eventsTodayResult, deliveryStatsResult, deadLetterResult] =
    await Promise.all([
      // 1. Sources count
      db
        .select({ count: count() })
        .from(sources)
        .where(eq(sources.tenantId, tenantId)),

      // 2. Events today
      db
        .select({ count: count() })
        .from(events)
        .where(
          and(
            eq(events.tenantId, tenantId),
            gte(events.receivedAt, todayStart)
          )
        ),

      // 3. Delivery success rate: count success / count all
      db
        .select({
          total: count(),
          success: count(
            sql`CASE WHEN ${deliveries.status} = 'success' THEN 1 END`
          ),
        })
        .from(deliveries)
        .where(eq(deliveries.tenantId, tenantId)),

      // 4. Dead letter count
      db
        .select({ count: count() })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.tenantId, tenantId),
            eq(deliveries.status, "dead_letter")
          )
        ),
    ]);

  const sourcesCount = sourcesResult[0]?.count ?? 0;
  const eventsToday = eventsTodayResult[0]?.count ?? 0;

  const totalDeliveries = deliveryStatsResult[0]?.total ?? 0;
  const successDeliveries = deliveryStatsResult[0]?.success ?? 0;
  const deliverySuccessRate =
    totalDeliveries > 0
      ? Math.round((successDeliveries / totalDeliveries) * 100 * 100) / 100
      : 0;

  const deadLetters = deadLetterResult[0]?.count ?? 0;

  return reply.status(200).send({
    sources_count: sourcesCount,
    events_today: eventsToday,
    delivery_success_rate: deliverySuccessRate,
    dead_letters: deadLetters,
  });
}
