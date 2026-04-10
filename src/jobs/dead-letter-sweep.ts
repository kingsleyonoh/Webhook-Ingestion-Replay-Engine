/**
 * Dead letter sweep job — promotes failed deliveries past max retries.
 * Section 7: runs every 1 hour. Idempotent.
 *
 * Scans deliveries WHERE status='failed' AND attempt >= destination.max_retries.
 * Updates status to 'dead_letter'. Skips already dead-lettered deliveries.
 */

import { createSqlClient } from "../db/client.js";
import { logger } from "../lib/logger.js";

export interface SweepResult {
  promoted: number;
}

/**
 * Run the dead letter sweep. Standalone async function for testability.
 * Uses raw SQL for UPDATE with subquery join and row count access.
 */
export async function runDeadLetterSweep(
  databaseUrl: string
): Promise<SweepResult> {
  const sqlClient = createSqlClient(databaseUrl, { max: 2 });

  try {
    const result = await sqlClient`
      UPDATE deliveries
      SET status = 'dead_letter'
      WHERE status = 'failed'
        AND destination_id IS NOT NULL
        AND attempt >= (
          SELECT max_retries FROM destinations
          WHERE destinations.id = deliveries.destination_id
        )
    `;

    const promoted = result.count;

    logger.info(
      { promoted, module: "dead-letter-sweep" },
      "Dead letter sweep completed"
    );

    return { promoted };
  } finally {
    await sqlClient.end();
  }
}
