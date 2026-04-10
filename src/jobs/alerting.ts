/**
 * Alerting log conditions — emit warn logs when thresholds are breached.
 * Section 10b:
 *   - Dead letter count > 100 in 1 hour → log.warn
 *   - Queue depth > 10,000 → log.warn
 */

import { logger } from "../lib/logger.js";

/** Thresholds for alerting conditions */
const DEAD_LETTER_THRESHOLD = 100;
const QUEUE_DEPTH_THRESHOLD = 10_000;

export interface AlertInput {
  recentDeadLetters: number;
  queueDepth: number;
}

/**
 * Check alert conditions and emit warn logs if thresholds are breached.
 * Standalone async function — called by scheduler or health monitor.
 */
export async function checkAlertConditions(
  input: AlertInput
): Promise<void> {
  const { recentDeadLetters, queueDepth } = input;

  if (recentDeadLetters > DEAD_LETTER_THRESHOLD) {
    logger.warn(
      {
        deadLetterCount: recentDeadLetters,
        threshold: DEAD_LETTER_THRESHOLD,
        module: "alerting",
      },
      `Dead letter threshold exceeded: ${recentDeadLetters} dead letters in the last hour`
    );
  }

  if (queueDepth > QUEUE_DEPTH_THRESHOLD) {
    logger.warn(
      {
        queueDepth,
        threshold: QUEUE_DEPTH_THRESHOLD,
        module: "alerting",
      },
      `Queue depth threshold exceeded: ${queueDepth} jobs in queue`
    );
  }
}
