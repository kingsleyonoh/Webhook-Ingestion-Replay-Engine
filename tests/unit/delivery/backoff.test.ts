/**
 * Unit tests for exponential backoff retry logic.
 * Section 5.2 steps 5-6: backoff_base_ms * 2^(attempt-1), next_retry_at calculation.
 */

import { describe, it, expect } from "vitest";

import {
  calculateBackoffMs,
  calculateNextRetryAt,
} from "../../../src/delivery/backoff.js";

describe("calculateBackoffMs — exponential backoff", () => {
  it("should return base_ms for attempt 1 (2^0 = 1)", () => {
    const result = calculateBackoffMs(1000, 1);
    expect(result).toBe(1000);
  });

  it("should return base_ms * 2 for attempt 2 (2^1 = 2)", () => {
    const result = calculateBackoffMs(1000, 2);
    expect(result).toBe(2000);
  });

  it("should return base_ms * 4 for attempt 3 (2^2 = 4)", () => {
    const result = calculateBackoffMs(1000, 3);
    expect(result).toBe(4000);
  });

  it("should return base_ms * 8 for attempt 4 (2^3 = 8)", () => {
    const result = calculateBackoffMs(1000, 4);
    expect(result).toBe(8000);
  });

  it("should return base_ms * 16 for attempt 5 (2^4 = 16)", () => {
    const result = calculateBackoffMs(1000, 5);
    expect(result).toBe(16000);
  });

  it("should work with custom base_ms values", () => {
    expect(calculateBackoffMs(500, 1)).toBe(500);
    expect(calculateBackoffMs(500, 3)).toBe(2000);
    expect(calculateBackoffMs(2000, 2)).toBe(4000);
  });
});

describe("calculateNextRetryAt — timestamp calculation", () => {
  it("should return a Date in the future by backoff amount", () => {
    const now = new Date("2026-04-10T12:00:00.000Z");
    const result = calculateNextRetryAt(1000, 1, now);

    expect(result.getTime()).toBe(now.getTime() + 1000);
  });

  it("should use exponential backoff for the delay", () => {
    const now = new Date("2026-04-10T12:00:00.000Z");

    const retry2 = calculateNextRetryAt(1000, 2, now);
    expect(retry2.getTime()).toBe(now.getTime() + 2000);

    const retry3 = calculateNextRetryAt(1000, 3, now);
    expect(retry3.getTime()).toBe(now.getTime() + 4000);

    const retry5 = calculateNextRetryAt(1000, 5, now);
    expect(retry5.getTime()).toBe(now.getTime() + 16000);
  });

  it("should default to current time when no 'now' parameter provided", () => {
    const before = Date.now();
    const result = calculateNextRetryAt(1000, 1);
    const after = Date.now();

    // Result should be ~1000ms after 'now'
    expect(result.getTime()).toBeGreaterThanOrEqual(before + 1000);
    expect(result.getTime()).toBeLessThanOrEqual(after + 1000);
  });
});
