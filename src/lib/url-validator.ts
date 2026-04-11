/**
 * URL validation for SSRF protection.
 * Blocks private IPs, non-HTTP protocols, and cloud metadata endpoints.
 *
 * Applied at two layers:
 * 1. Destination creation (routes) — reject unsafe URLs at registration
 * 2. Delivery time (http-client pre-flight) — defense in depth against DNS rebinding
 */

import { AppError } from "./errors.js";
import dns from "node:dns/promises";
import net from "node:net";

/** Error thrown when a destination URL fails SSRF validation */
export class UnsafeUrlError extends AppError {
  constructor(message: string) {
    super("UNSAFE_URL", message, 400);
    this.name = "UnsafeUrlError";
  }
}

/** Allowed protocols for destination URLs */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames explicitly blocked */
const BLOCKED_HOSTNAMES = new Set(["localhost"]);

/**
 * Check if an IPv4 address falls in a private/reserved range.
 *
 * Blocked ranges:
 * - 127.0.0.0/8     (loopback)
 * - 10.0.0.0/8      (private)
 * - 172.16.0.0/12   (private)
 * - 192.168.0.0/16  (private)
 * - 169.254.0.0/16  (link-local / cloud metadata)
 * - 0.0.0.0         (unspecified)
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) {
    return false;
  }

  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0
  if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return true;

  // 127.0.0.0/8
  if (a === 127) return true;

  // 10.0.0.0/8
  if (a === 10) return true;

  // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 (link-local / AWS metadata)
  if (a === 169 && b === 254) return true;

  return false;
}

/**
 * Check if an IPv6 address is private/reserved.
 *
 * Blocked:
 * - ::1        (loopback)
 * - fc00::/7   (unique local: fc00:: and fd00::)
 */
function isPrivateIpv6(ip: string): boolean {
  // Normalize: remove brackets if present
  const cleaned = ip.replace(/^\[|\]$/g, "");

  // ::1 loopback
  if (cleaned === "::1") return true;

  // fc00::/7 — covers fc00:: through fdff::
  const lower = cleaned.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  return false;
}

/**
 * Check if an IP address (v4 or v6) is in a private/reserved range.
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return isPrivateIpv4(ip);
  }
  if (net.isIPv6(ip)) {
    return isPrivateIpv6(ip);
  }
  // Try without brackets for IPv6 in URLs
  const cleaned = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv6(cleaned)) {
    return isPrivateIpv6(cleaned);
  }
  return false;
}

/**
 * Validate a destination URL for SSRF safety.
 * Checks protocol, hostname, and IP address (if directly specified).
 *
 * Throws UnsafeUrlError if the URL is unsafe.
 * This is the synchronous check applied at destination creation time.
 */
export function validateDestinationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(
      `Invalid URL: unable to parse '${url}'`
    );
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new UnsafeUrlError(
      `Unsafe protocol '${parsed.protocol}' — only http: and https: are allowed`
    );
  }

  // Check blocked hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError(
      `Unsafe hostname '${hostname}' — localhost is not allowed`
    );
  }

  // Check if hostname is a direct IP address
  const cleanHostname = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(cleanHostname)) {
    if (isPrivateIp(cleanHostname)) {
      throw new UnsafeUrlError(
        `Unsafe IP address '${cleanHostname}' — private/reserved IPs are not allowed`
      );
    }
  }
}

/**
 * Resolve DNS for a URL and validate that the resolved IP is not private.
 * Defense in depth — catches DNS rebinding attacks where a public hostname
 * resolves to a private IP at delivery time.
 *
 * Returns the validated URL string, or throws UnsafeUrlError.
 */
export async function resolveAndValidateUrl(
  url: string
): Promise<string> {
  // First run static validation
  validateDestinationUrl(url);

  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  // If hostname is already an IP, we validated it above
  if (net.isIP(hostname)) {
    return url;
  }

  // Resolve DNS and check all resolved IPs
  try {
    const addresses = await dns.resolve4(hostname).catch(() => []);
    const addresses6 = await dns.resolve6(hostname).catch(() => []);
    const allAddresses = [...addresses, ...addresses6];

    // If DNS resolution returns nothing, allow it — the fetch will fail anyway
    if (allAddresses.length === 0) {
      return url;
    }

    for (const addr of allAddresses) {
      if (isPrivateIp(addr)) {
        throw new UnsafeUrlError(
          `DNS rebinding detected: '${hostname}' resolves to private IP '${addr}'`
        );
      }
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    // DNS resolution failed — allow the request, fetch will fail with network error
  }

  return url;
}
