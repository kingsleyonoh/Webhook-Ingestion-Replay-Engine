/**
 * Pino structured JSON logger with request ID tracking.
 * All application logging should use this module.
 */

import pino from "pino";
import type { Logger } from "pino";

const LOG_LEVEL = process.env["LOG_LEVEL"] ?? "info";

/**
 * Root application logger — JSON output, structured fields.
 */
export const logger: Logger = pino({
  level: LOG_LEVEL,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a child logger bound to a specific request ID.
 * Use in request handlers for correlated logging.
 */
export function createRequestLogger(requestId: string): Logger {
  return logger.child({ requestId });
}
