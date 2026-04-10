/**
 * BullMQ delivery worker — picks jobs, delivers webhooks, records attempts.
 * Section 5.2 steps 1-8: load event + destination → HTTP request → record →
 * retry with backoff or dead-letter → aggregate event status.
 */

import { Worker } from "bullmq";
import type { Job } from "bullmq";
import postgres from "postgres";

import type { DeliverJobData } from "./queue.js";
import { createDeliveryQueue } from "./queue.js";
import { deliverWebhook } from "./http-client.js";
import { calculateBackoffMs, calculateNextRetryAt } from "./backoff.js";
import { logger } from "../lib/logger.js";

interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  concurrency?: number;
}

/**
 * Process a single delivery job.
 * Exported separately for direct testing without BullMQ worker lifecycle.
 *
 * Steps:
 * 1. Load event + destination from DB
 * 2. Make HTTP request via deliverWebhook()
 * 3. Record delivery attempt in deliveries table
 * 4. On 2xx: mark delivery as success
 * 5. On failure + under max_retries: schedule retry with backoff
 * 6. On failure + at max_retries: mark as dead_letter
 * 7. After success: check all destinations → update event status
 */
export async function processDeliveryJob(
  data: DeliverJobData,
  config: WorkerConfig
): Promise<void> {
  const { eventId, destinationId, tenantId } = data;
  const sql = postgres(config.databaseUrl, { max: 2 });

  try {
    // Step 1: Load event + destination from DB
    const [event, destination] = await Promise.all([
      loadEvent(sql, eventId, tenantId),
      loadDestination(sql, destinationId, tenantId),
    ]);

    if (!event || !destination) {
      logger.warn(
        { eventId, destinationId, tenantId },
        "Delivery job skipped: event or destination not found"
      );
      return;
    }

    // Determine current attempt number
    const attemptNumber = await getNextAttemptNumber(
      sql,
      eventId,
      destinationId
    );

    // Step 2-3: Make HTTP request
    const destHeaders =
      typeof destination.headers === "object" &&
      destination.headers !== null &&
      !Array.isArray(destination.headers)
        ? (destination.headers as Record<string, string>)
        : {};

    const result = await deliverWebhook({
      url: destination.url,
      method: destination.method,
      headers: {
        "content-type": "application/json",
        ...destHeaders,
      },
      payload: event.payload,
      timeoutMs: destination.timeout_ms,
    });

    // Step 4: Determine status and record
    const isSuccess = result.statusCode >= 200 && result.statusCode < 300;
    const isDeadLetter =
      !isSuccess && attemptNumber >= destination.max_retries;
    const isFailed = !isSuccess && !isDeadLetter;

    const status = isSuccess
      ? "success"
      : isDeadLetter
        ? "dead_letter"
        : "failed";

    // Calculate next_retry_at for failed (non-dead-letter) deliveries
    const nextRetryAt = isFailed
      ? calculateNextRetryAt(
          destination.backoff_base_ms,
          attemptNumber
        )
      : null;

    // Step 4: Record delivery attempt
    await sql`
      INSERT INTO deliveries (
        tenant_id, event_id, destination_id, attempt, status,
        status_code, response_body, error_message, duration_ms,
        next_retry_at
      )
      VALUES (
        ${tenantId}, ${eventId}, ${destinationId}, ${attemptNumber},
        ${status},
        ${result.statusCode > 0 ? result.statusCode : null},
        ${result.responseBody || null},
        ${result.error ?? null},
        ${result.durationMs},
        ${nextRetryAt}
      )
    `;

    // Step 5-6: Schedule retry if failed (not dead_letter)
    if (isFailed) {
      const delayMs = calculateBackoffMs(
        destination.backoff_base_ms,
        attemptNumber
      );
      const queue = createDeliveryQueue(config.redisUrl);
      await queue.add(
        "deliver",
        { eventId, destinationId, tenantId },
        { delay: delayMs }
      );
      await queue.close();
    }

    // Step 7-8: After success, check if all destinations are done
    if (isSuccess) {
      await updateEventStatusIfAllDelivered(
        sql,
        eventId,
        tenantId,
        event.source_id
      );
    }
  } finally {
    await sql.end();
  }
}

/**
 * Create and return a BullMQ Worker that processes delivery jobs.
 * Wire this into server startup for production use.
 */
export function createDeliveryWorker(config: WorkerConfig): Worker<DeliverJobData> {
  const worker = new Worker<DeliverJobData>(
    "deliver",
    async (job: Job<DeliverJobData>) => {
      await processDeliveryJob(job.data, config);
    },
    {
      connection: { url: config.redisUrl },
      concurrency: config.concurrency ?? 10,
    }
  );

  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, data: job?.data, error: error.message },
      "Delivery job failed with unhandled error"
    );
  });

  return worker;
}

// ─── Internal helpers ────────────────────────────────────────────────

interface EventRow {
  id: string;
  source_id: string;
  headers: unknown;
  payload: unknown;
  status: string;
}

interface DestinationRow {
  id: string;
  url: string;
  method: string;
  headers: unknown;
  timeout_ms: number;
  max_retries: number;
  backoff_base_ms: number;
}

async function loadEvent(
  sql: postgres.Sql,
  eventId: string,
  tenantId: string
): Promise<EventRow | null> {
  const rows = await sql<EventRow[]>`
    SELECT id, source_id, headers, payload, status
    FROM events
    WHERE id = ${eventId} AND tenant_id = ${tenantId}
  `;
  return rows[0] ?? null;
}

async function loadDestination(
  sql: postgres.Sql,
  destinationId: string,
  tenantId: string
): Promise<DestinationRow | null> {
  const rows = await sql<DestinationRow[]>`
    SELECT id, url, method, headers, timeout_ms, max_retries, backoff_base_ms
    FROM destinations
    WHERE id = ${destinationId} AND tenant_id = ${tenantId}
  `;
  return rows[0] ?? null;
}

async function getNextAttemptNumber(
  sql: postgres.Sql,
  eventId: string,
  destinationId: string
): Promise<number> {
  const rows = await sql<{ max_attempt: number | null }[]>`
    SELECT MAX(attempt) as max_attempt
    FROM deliveries
    WHERE event_id = ${eventId} AND destination_id = ${destinationId}
  `;
  const maxAttempt = rows[0]?.max_attempt;
  return (maxAttempt ?? 0) + 1;
}

/**
 * Check if all enabled destinations for an event's source have successful
 * deliveries. If so, mark the event as 'delivered'.
 */
async function updateEventStatusIfAllDelivered(
  sql: postgres.Sql,
  eventId: string,
  tenantId: string,
  sourceId: string
): Promise<void> {
  // Get all enabled destinations for this source
  const enabledDests = await sql<{ id: string }[]>`
    SELECT id FROM destinations
    WHERE source_id = ${sourceId} AND tenant_id = ${tenantId} AND enabled = true
  `;

  if (enabledDests.length === 0) return;

  // For each destination, check if there's a 'success' delivery for this event
  const successDests = await sql<{ destination_id: string }[]>`
    SELECT DISTINCT destination_id
    FROM deliveries
    WHERE event_id = ${eventId}
      AND tenant_id = ${tenantId}
      AND status = 'success'
  `;

  const enabledIds = new Set(enabledDests.map((d) => d.id));
  const successIds = new Set(successDests.map((d) => d.destination_id));

  // Check if every enabled destination has a success delivery
  const allDelivered = [...enabledIds].every((id) => successIds.has(id));

  if (allDelivered) {
    await sql`
      UPDATE events SET status = 'delivered'
      WHERE id = ${eventId} AND tenant_id = ${tenantId}
    `;
  }
}
