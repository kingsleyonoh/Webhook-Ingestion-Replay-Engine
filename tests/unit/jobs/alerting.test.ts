/**
 * Unit tests for alerting log conditions.
 * Section 10b: dead letter count > 100 in 1h → warn, queue depth > 10000 → warn.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the logger module before importing alerting
vi.mock("../../../src/lib/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      warn: vi.fn(),
      info: vi.fn(),
    })),
  },
}));

describe("Alerting conditions (unit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("dead letter threshold", () => {
    it("should emit warn log when dead letter count > 100 in 1 hour", async () => {
      const { checkAlertConditions } = await import("../../../src/jobs/alerting.js");
      const { logger } = await import("../../../src/lib/logger.js");

      await checkAlertConditions({
        recentDeadLetters: 101,
        queueDepth: 0,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ deadLetterCount: 101 }),
        expect.stringContaining("Dead letter threshold")
      );
    });

    it("should not emit warn when dead letter count <= 100", async () => {
      const { checkAlertConditions } = await import("../../../src/jobs/alerting.js");
      const { logger } = await import("../../../src/lib/logger.js");

      await checkAlertConditions({
        recentDeadLetters: 100,
        queueDepth: 0,
      });

      // logger.warn should not be called for dead letters
      const warnCalls = vi.mocked(logger.warn).mock.calls;
      const deadLetterWarn = warnCalls.filter(
        (call) => typeof call[1] === "string" && call[1].includes("Dead letter")
      );
      expect(deadLetterWarn).toHaveLength(0);
    });

    it("should not emit warn when dead letter count is exactly 0", async () => {
      const { checkAlertConditions } = await import("../../../src/jobs/alerting.js");
      const { logger } = await import("../../../src/lib/logger.js");

      await checkAlertConditions({
        recentDeadLetters: 0,
        queueDepth: 0,
      });

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("queue depth threshold", () => {
    it("should emit warn log when queue depth > 10000", async () => {
      const { checkAlertConditions } = await import("../../../src/jobs/alerting.js");
      const { logger } = await import("../../../src/lib/logger.js");

      await checkAlertConditions({
        recentDeadLetters: 0,
        queueDepth: 10001,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ queueDepth: 10001 }),
        expect.stringContaining("Queue depth threshold")
      );
    });

    it("should not emit warn when queue depth <= 10000", async () => {
      const { checkAlertConditions } = await import("../../../src/jobs/alerting.js");
      const { logger } = await import("../../../src/lib/logger.js");

      await checkAlertConditions({
        recentDeadLetters: 0,
        queueDepth: 10000,
      });

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("should not emit warn when queue depth is 0", async () => {
      const { checkAlertConditions } = await import("../../../src/jobs/alerting.js");
      const { logger } = await import("../../../src/lib/logger.js");

      await checkAlertConditions({
        recentDeadLetters: 0,
        queueDepth: 0,
      });

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("both thresholds", () => {
    it("should emit two warn logs when both thresholds breached", async () => {
      const { checkAlertConditions } = await import("../../../src/jobs/alerting.js");
      const { logger } = await import("../../../src/lib/logger.js");

      await checkAlertConditions({
        recentDeadLetters: 200,
        queueDepth: 15000,
      });

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });
});
