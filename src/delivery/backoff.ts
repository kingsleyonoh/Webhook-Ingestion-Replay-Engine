/**
 * Exponential backoff retry logic for webhook delivery.
 * Section 5.2 steps 5-6: backoff_base_ms * 2^(attempt-1), next_retry_at.
 */

/**
 * Calculate backoff delay in milliseconds using exponential formula.
 * Formula: baseMs * 2^(attempt - 1)
 *
 * @param baseMs  - Base backoff in milliseconds (from destination config)
 * @param attempt - Current attempt number (1-based)
 * @returns Delay in milliseconds before next retry
 */
export function calculateBackoffMs(baseMs: number, attempt: number): number {
  return baseMs * Math.pow(2, attempt - 1);
}

/**
 * Calculate the absolute timestamp for the next retry.
 *
 * @param baseMs  - Base backoff in milliseconds
 * @param attempt - Current attempt number (1-based)
 * @param now     - Reference time (defaults to current time)
 * @returns Date when the next retry should be attempted
 */
export function calculateNextRetryAt(
  baseMs: number,
  attempt: number,
  now?: Date
): Date {
  const reference = now ?? new Date();
  const delayMs = calculateBackoffMs(baseMs, attempt);
  return new Date(reference.getTime() + delayMs);
}
