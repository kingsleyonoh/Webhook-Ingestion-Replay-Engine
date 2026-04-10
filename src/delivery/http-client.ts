/**
 * HTTP client for webhook delivery with timeout and redirect handling.
 * Section 5.2 edge cases: follow up to 3 redirects, timeout, body truncation.
 *
 * Uses Node.js native fetch with manual redirect following to enforce
 * a maximum redirect count (default 3).
 */

/** Maximum response body size to store (4KB) */
const MAX_RESPONSE_BODY_BYTES = 4096;

/** HTTP status codes that indicate a redirect */
const REDIRECT_CODES = new Set([301, 302, 307, 308]);

export interface DeliveryResult {
  /** HTTP status code (0 if no response received — timeout/network error) */
  statusCode: number;
  /** Response body, truncated to 4KB */
  responseBody: string;
  /** Round-trip duration in milliseconds */
  durationMs: number;
  /** Error message if delivery failed at the transport level */
  error?: string;
}

/**
 * Deliver a webhook payload to a destination URL.
 *
 * - Follows redirects manually up to `maxRedirects` (default 3).
 * - Aborts after `timeoutMs` milliseconds.
 * - Truncates response body to 4KB.
 *
 * Returns a DeliveryResult — never throws.
 */
export async function deliverWebhook(params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload: unknown;
  timeoutMs: number;
  maxRedirects?: number;
}): Promise<DeliveryResult> {
  const { method, headers, payload, timeoutMs } = params;
  const maxRedirects = params.maxRedirects ?? 3;
  const body = JSON.stringify(payload);

  const startMs = performance.now();

  let currentUrl = params.url;
  let redirectCount = 0;

  try {
    while (true) {
      const controller = new AbortController();
      const elapsed = performance.now() - startMs;
      const remainingMs = timeoutMs - elapsed;

      if (remainingMs <= 0) {
        return {
          statusCode: 0,
          responseBody: "",
          durationMs: Math.round(performance.now() - startMs),
          error: "Request timeout: time budget exhausted during redirects",
        };
      }

      const timer = setTimeout(() => controller.abort(), remainingMs);

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: "manual",
        });
      } finally {
        clearTimeout(timer);
      }

      // Handle redirect
      if (REDIRECT_CODES.has(response.status)) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          return {
            statusCode: 0,
            responseBody: "",
            durationMs: Math.round(performance.now() - startMs),
            error: `Too many redirects (max ${maxRedirects})`,
          };
        }

        const location = response.headers.get("location");
        if (!location) {
          return {
            statusCode: 0,
            responseBody: "",
            durationMs: Math.round(performance.now() - startMs),
            error: "Redirect response missing Location header",
          };
        }

        // Resolve relative URLs against current URL
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // Non-redirect response — read body and return
      const rawBody = await response.text();
      const responseBody = rawBody.slice(0, MAX_RESPONSE_BODY_BYTES);

      return {
        statusCode: response.status,
        responseBody,
        durationMs: Math.round(performance.now() - startMs),
      };
    }
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - startMs);
    const message =
      err instanceof Error ? err.message : "Unknown delivery error";

    // AbortController abort results in AbortError
    const isTimeout =
      (err instanceof DOMException && err.name === "AbortError") ||
      message.includes("abort");

    return {
      statusCode: 0,
      responseBody: "",
      durationMs,
      error: isTimeout
        ? `Request timeout after ${durationMs}ms`
        : message,
    };
  }
}
