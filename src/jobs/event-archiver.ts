/**
 * Event archiver job — moves old events to events_archive table.
 * Section 7: runs every 24 hours.
 *
 * Copies events WHERE received_at < now() - archiveDays to events_archive,
 * then deletes from events only those that were successfully archived.
 * ON CONFLICT ensures idempotency (no duplicate archives).
 */

import postgres from "postgres";
import { logger } from "../lib/logger.js";

export interface ArchiveResult {
  archived: number;
}

/**
 * Run the event archiver. Standalone async function for testability.
 * @param databaseUrl — PostgreSQL connection string
 * @param archiveDays — events older than this many days are archived
 */
export async function runEventArchiver(
  databaseUrl: string,
  archiveDays: number
): Promise<ArchiveResult> {
  const sql = postgres(databaseUrl, { max: 2 });

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - archiveDays);

    // Step 1: Copy old events to archive (ON CONFLICT skip duplicates)
    const inserted = await sql`
      INSERT INTO events_archive
        (id, tenant_id, source_id, idempotency_key, headers, payload, received_at, status, metadata)
      SELECT id, tenant_id, source_id, idempotency_key, headers, payload, received_at, status, metadata
      FROM events
      WHERE received_at < ${cutoff}
      ON CONFLICT (id) DO NOTHING
    `;
    const archivedCount = inserted.count;

    // Step 2: Delete from events only rows that exist in archive
    if (archivedCount > 0) {
      await sql`
        DELETE FROM events
        WHERE received_at < ${cutoff}
          AND id IN (SELECT id FROM events_archive)
      `;
    }

    logger.info(
      { archived: archivedCount, archiveDays, module: "event-archiver" },
      "Event archiver completed"
    );

    return { archived: archivedCount };
  } finally {
    await sql.end();
  }
}
