/**
 * Replay engine — batch event re-processing.
 * Section 5.3: query matching events, enqueue deliver jobs
 * for active destinations, update progress counters.
 */

import { eq, and, gte, lte, inArray } from "drizzle-orm";
import type { Queue } from "bullmq";
import type { Database } from "../db/client.js";
import type { DeliverJobData } from "../delivery/queue.js";
import {
  events,
  destinations,
  replayRequests,
} from "../db/schema.js";
import { logger } from "../lib/logger.js";

export interface ReplayOptions {
  tenantId: string;
  sourceId?: string;
  eventIds?: string[];
  fromTimestamp?: Date;
  toTimestamp?: Date;
}

export interface ReplayResult {
  replayRequestId: string;
  totalEvents: number;
  processed: number;
  failed: number;
}

/**
 * Execute a replay: query matching events, enqueue delivery jobs
 * for each active destination, update progress counters.
 *
 * Batches enqueue operations in groups of `batchSize` to avoid
 * Redis memory spikes (Section 5.3 edge case).
 */
export async function executeReplay(params: {
  db: Database;
  queue: Queue<DeliverJobData>;
  options: ReplayOptions;
  batchSize: number;
}): Promise<ReplayResult> {
  const { db, queue, options, batchSize } = params;
  const { tenantId, sourceId, eventIds, fromTimestamp, toTimestamp } = options;

  const replayLog = logger.child({ module: "replay-engine", tenantId });

  // Step 1: Insert replay_requests row with status 'pending'
  const [replayRequest] = await db
    .insert(replayRequests)
    .values({
      tenantId,
      sourceId: sourceId ?? null,
      eventIds: eventIds ?? null,
      fromTimestamp: fromTimestamp ?? null,
      toTimestamp: toTimestamp ?? null,
      status: "pending",
      totalEvents: 0,
      processed: 0,
      failed: 0,
    })
    .returning({ id: replayRequests.id });

  const replayRequestId = replayRequest!.id;

  // Step 2: Query matching events (tenant-scoped, apply filters)
  const conditions = [eq(events.tenantId, tenantId)];

  if (sourceId) {
    conditions.push(eq(events.sourceId, sourceId));
  }

  if (eventIds && eventIds.length > 0) {
    conditions.push(inArray(events.id, eventIds));
  }

  if (fromTimestamp) {
    conditions.push(gte(events.receivedAt, fromTimestamp));
  }

  if (toTimestamp) {
    conditions.push(lte(events.receivedAt, toTimestamp));
  }

  const matchingEvents = await db
    .select({ id: events.id, sourceId: events.sourceId })
    .from(events)
    .where(and(...conditions));

  const totalEvents = matchingEvents.length;

  // Update total_events count and status to processing
  await db
    .update(replayRequests)
    .set({ totalEvents, status: "processing" })
    .where(eq(replayRequests.id, replayRequestId));

  if (totalEvents === 0) {
    // No events to replay — mark completed immediately
    await db
      .update(replayRequests)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(replayRequests.id, replayRequestId));

    replayLog.info({ replayRequestId }, "Replay completed with 0 events");

    return { replayRequestId, totalEvents: 0, processed: 0, failed: 0 };
  }

  // Step 4: Process in batches of batchSize
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < matchingEvents.length; i += batchSize) {
    const batch = matchingEvents.slice(i, i + batchSize);

    for (const event of batch) {
      try {
        // Get active destinations for this event's source
        const activeDestinations = await db
          .select({ id: destinations.id })
          .from(destinations)
          .where(
            and(
              eq(destinations.tenantId, tenantId),
              eq(destinations.sourceId, event.sourceId!),
              eq(destinations.enabled, true)
            )
          );

        if (activeDestinations.length > 0) {
          // Enqueue deliver jobs for each active destination
          const jobs = activeDestinations.map((dest) => ({
            name: "deliver" as const,
            data: {
              eventId: event.id,
              destinationId: dest.id,
              tenantId,
            },
          }));

          await queue.addBulk(jobs);
        }

        // Mark event status as 'replayed'
        await db
          .update(events)
          .set({ status: "replayed" })
          .where(eq(events.id, event.id));

        processed++;
      } catch (err) {
        replayLog.error(
          { err, eventId: event.id, replayRequestId },
          "Failed to replay event"
        );
        failed++;
      }
    }

    // Update progress counters after each batch
    await db
      .update(replayRequests)
      .set({ processed, failed })
      .where(eq(replayRequests.id, replayRequestId));
  }

  // Step 5: Mark completed
  await db
    .update(replayRequests)
    .set({
      processed,
      failed,
      status: "completed",
      completedAt: new Date(),
    })
    .where(eq(replayRequests.id, replayRequestId));

  replayLog.info(
    { replayRequestId, totalEvents, processed, failed },
    "Replay completed"
  );

  return { replayRequestId, totalEvents, processed, failed };
}
