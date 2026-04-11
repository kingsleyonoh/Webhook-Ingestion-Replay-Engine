/**
 * Header sanitizer — strips sensitive headers before DB persistence.
 * Prevents accidental storage of auth tokens, cookies, and proxy credentials.
 *
 * Stripped headers (case-insensitive):
 * - authorization
 * - cookie
 * - set-cookie
 * - proxy-authorization
 */

/** Headers that must never be persisted to the database */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

/**
 * Return a new headers object with sensitive headers removed.
 * Comparison is case-insensitive. Original object is not mutated.
 */
export function sanitizeHeaders(
  headers: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
