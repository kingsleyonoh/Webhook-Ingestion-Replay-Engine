/**
 * Graceful shutdown handler.
 * Registers SIGTERM/SIGINT handlers that drain resources in order:
 *   1. Stop accepting new HTTP connections (Fastify close)
 *   2. Drain BullMQ worker (finish in-progress jobs)
 *   3. Close database connections
 *   4. Close Redis connections
 *   5. Exit cleanly
 */

import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "./lib/logger.js";

/** Postgres.js sql client — has an end() method */
interface SqlClient {
  end(): Promise<void>;
}

export interface GracefulShutdownParams {
  app: FastifyInstance;
  worker?: Worker;
  sqlClient?: SqlClient;
  redis?: Redis;
}

/**
 * Execute graceful shutdown: close resources in order.
 * Failures are logged but do not prevent remaining resources
 * from being cleaned up.
 *
 * Exported for direct testing without signal handling.
 */
export async function performShutdown(
  params: GracefulShutdownParams,
  signal: string
): Promise<void> {
  const { app, worker, sqlClient, redis } = params;

  logger.info({ signal }, "Received shutdown signal, draining...");

  // 1. Stop accepting new connections
  try {
    await app.close();
    logger.info("Fastify server closed");
  } catch (err) {
    logger.error({ err }, "Error closing Fastify server");
  }

  // 2. Drain BullMQ worker (finish in-progress jobs)
  if (worker) {
    try {
      await worker.close();
      logger.info("BullMQ worker drained");
    } catch (err) {
      logger.error({ err }, "Error draining BullMQ worker");
    }
  }

  // 3. Close database connections
  if (sqlClient) {
    try {
      await sqlClient.end();
      logger.info("Database connection closed");
    } catch (err) {
      logger.error({ err }, "Error closing database connection");
    }
  }

  // 4. Close Redis connections
  if (redis) {
    try {
      await redis.quit();
      logger.info("Redis connection closed");
    } catch (err) {
      logger.error({ err }, "Error closing Redis connection");
    }
  }

  logger.info("Graceful shutdown complete");
}

/**
 * Register SIGTERM and SIGINT handlers for graceful shutdown.
 * Each resource is closed in order; failures are logged but do not
 * prevent remaining resources from being cleaned up.
 */
export function setupGracefulShutdown(
  params: GracefulShutdownParams
): void {
  process.on("SIGTERM", () => {
    void performShutdown(params, "SIGTERM");
  });
  process.on("SIGINT", () => {
    void performShutdown(params, "SIGINT");
  });
}
