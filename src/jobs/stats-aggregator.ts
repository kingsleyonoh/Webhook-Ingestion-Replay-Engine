/**
 * Stats aggregator job — updates per-source delivery success/failure counts.
 * Section 7: runs every 5 minutes. Writes to Redis hash per source.
 *
 * Key format: stats:source:{sourceId} → { success: N, failed: N }
 * Concurrent-safe: uses atomic HSET overwrite (last writer wins, same data).
 */

import { Redis } from "ioredis";
import { createSqlClient } from "../db/client.js";
import { logger } from "../lib/logger.js";

export interface AggregatorResult {
  sourcesUpdated: number;
}

/**
 * Run the stats aggregator. Standalone async function for testability.
 * Queries delivery counts per source (via destination's source_id), writes to Redis.
 */
export async function runStatsAggregator(
  databaseUrl: string,
  redisUrl: string
): Promise<AggregatorResult> {
  const sqlClient = createSqlClient(databaseUrl, { max: 2 });
  const redis = new Redis(redisUrl);

  try {
    // Aggregate delivery counts per source via join with destinations
    const rows = await sqlClient`
      SELECT
        d.source_id,
        COUNT(*) FILTER (WHERE del.status = 'success') AS success_count,
        COUNT(*) FILTER (WHERE del.status = 'failed' OR del.status = 'dead_letter') AS failed_count
      FROM deliveries del
      INNER JOIN destinations d ON del.destination_id = d.id
      WHERE d.source_id IS NOT NULL
      GROUP BY d.source_id
    `;

    let sourcesUpdated = 0;

    for (const row of rows) {
      const sourceId = row.source_id as string;
      const success = Number(row.success_count ?? 0);
      const failed = Number(row.failed_count ?? 0);

      await redis.hset(`stats:source:${sourceId}`, {
        success: success.toString(),
        failed: failed.toString(),
      });
      sourcesUpdated++;
    }

    logger.info(
      { sourcesUpdated, module: "stats-aggregator" },
      "Stats aggregator completed"
    );

    return { sourcesUpdated };
  } finally {
    await redis.quit();
    await sqlClient.end();
  }
}
