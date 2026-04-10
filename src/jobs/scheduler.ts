/**
 * Job scheduler — orchestrates periodic background jobs.
 * Section 7: dead letter sweep (1h), event archiver (24h), stats aggregator (5m).
 * Section 10b: alerting checks (5m).
 *
 * Uses setInterval for v1 simplicity. Each job is a standalone function
 * that takes DB URL as input, making them independently testable.
 */

import { runDeadLetterSweep } from "./dead-letter-sweep.js";
import { runEventArchiver } from "./event-archiver.js";
import { runStatsAggregator } from "./stats-aggregator.js";
import { checkAlertConditions } from "./alerting.js";
import { logger } from "../lib/logger.js";
import { Redis } from "ioredis";
import { createSqlClient } from "../db/client.js";

/** Interval constants in milliseconds */
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

interface SchedulerConfig {
  databaseUrl: string;
  redisUrl: string;
  archiveDays: number;
}

interface SchedulerHandle {
  stop: () => void;
}

/**
 * Gather alerting metrics from DB and Redis, then check thresholds.
 */
async function runAlertCheck(
  databaseUrl: string,
  redisUrl: string
): Promise<void> {
  const sqlClient = createSqlClient(databaseUrl, { max: 1 });
  const redis = new Redis(redisUrl);

  try {
    const oneHourAgo = new Date(Date.now() - ONE_HOUR);

    // Count dead letters in last hour
    const dlResult = await sqlClient`
      SELECT COUNT(*)::int AS cnt FROM deliveries
      WHERE status = 'dead_letter'
        AND attempted_at >= ${oneHourAgo}
    `;
    const recentDeadLetters = Number(dlResult[0]?.cnt ?? 0);

    // Queue depth from Redis
    let queueDepth = 0;
    try {
      const waiting = await redis.llen("bull:deliver:wait");
      const active = await redis.llen("bull:deliver:active");
      queueDepth = waiting + active;
    } catch {
      queueDepth = 0;
    }

    await checkAlertConditions({ recentDeadLetters, queueDepth });
  } finally {
    await redis.quit();
    await sqlClient.end();
  }
}

/**
 * Start all periodic background jobs. Returns a handle to stop them.
 */
export function startScheduler(config: SchedulerConfig): SchedulerHandle {
  const { databaseUrl, redisUrl, archiveDays } = config;

  logger.info({ module: "scheduler" }, "Starting background job scheduler");

  // Dead letter sweep — every 1 hour
  const sweepInterval = setInterval(() => {
    runDeadLetterSweep(databaseUrl).catch((err) => {
      logger.error({ err, module: "scheduler" }, "Dead letter sweep failed");
    });
  }, ONE_HOUR);

  // Event archiver ��� every 24 hours
  const archiverInterval = setInterval(() => {
    runEventArchiver(databaseUrl, archiveDays).catch((err) => {
      logger.error({ err, module: "scheduler" }, "Event archiver failed");
    });
  }, TWENTY_FOUR_HOURS);

  // Stats aggregator — every 5 minutes
  const statsInterval = setInterval(() => {
    runStatsAggregator(databaseUrl, redisUrl).catch((err) => {
      logger.error({ err, module: "scheduler" }, "Stats aggregator failed");
    });
  }, FIVE_MINUTES);

  // Alert checks — every 5 minutes
  const alertInterval = setInterval(() => {
    runAlertCheck(databaseUrl, redisUrl).catch((err) => {
      logger.error({ err, module: "scheduler" }, "Alert check failed");
    });
  }, FIVE_MINUTES);

  return {
    stop() {
      clearInterval(sweepInterval);
      clearInterval(archiverInterval);
      clearInterval(statsInterval);
      clearInterval(alertInterval);
      logger.info(
        { module: "scheduler" },
        "Background job scheduler stopped"
      );
    },
  };
}
