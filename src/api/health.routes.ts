/**
 * Health check route — enhanced with DB, Redis, and queue depth checks.
 * GET /api/health — public, no auth, no rate limit.
 *
 * Section 8b, 10b — application health monitoring.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { createSqlClient } from "../db/client.js";
import type { SqlClient } from "../db/client.js";
import { Redis } from "ioredis";
import { logger } from "../lib/logger.js";

/** Read version from package.json at module load time */
const APP_VERSION = process.env["npm_package_version"] ?? "0.1.0";

async function healthRoutes(app: FastifyInstance): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  const redisUrl = process.env["REDIS_URL"];

  let sqlClient: SqlClient | null = null;
  let redis: Redis | null = null;

  // Initialize DB connection for health checks
  if (databaseUrl) {
    sqlClient = createSqlClient(databaseUrl, { max: 1 });
  }

  // Initialize Redis connection for health checks
  if (redisUrl) {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    // Suppress unhandled error events on the Redis client
    redis.on("error", () => {
      // Errors handled per-request in the health check
    });
  }

  // Clean up connections on server close
  app.addHook("onClose", async () => {
    if (sqlClient) {
      await sqlClient.end().catch(() => {
        // Ignore close errors
      });
    }
    if (redis) {
      await redis.quit().catch(() => {
        // Ignore close errors
      });
    }
  });

  app.get("/api/health", async (_request, reply) => {
    let dbStatus: "ok" | "error" = "error";
    let redisStatus: "ok" | "error" = "error";
    let queueDepth = 0;

    // Check PostgreSQL connectivity
    if (sqlClient) {
      try {
        await sqlClient`SELECT 1`;
        dbStatus = "ok";
      } catch (err) {
        logger.warn({ err }, "Health check: database unreachable");
      }
    }

    // Check Redis connectivity and queue depth
    if (redis) {
      try {
        // Connect if not already connected
        if (redis.status === "wait") {
          await redis.connect();
        }
        await redis.ping();
        redisStatus = "ok";

        // Get BullMQ queue depth (waiting + active jobs)
        try {
          const waiting = await redis.llen("bull:deliver:wait");
          const active = await redis.llen("bull:deliver:active");
          queueDepth = waiting + active;
        } catch {
          // Queue may not exist yet — depth is 0
          queueDepth = 0;
        }
      } catch (err) {
        logger.warn({ err }, "Health check: Redis unreachable");
      }
    }

    const overallStatus =
      dbStatus === "ok" && redisStatus === "ok" ? "ok" : "degraded";

    return reply.send({
      status: overallStatus,
      uptime: process.uptime(),
      version: APP_VERSION,
      checks: {
        database: dbStatus,
        redis: redisStatus,
        queue_depth: queueDepth,
      },
    });
  });
}

export default fp(healthRoutes, { name: "health-routes" });
