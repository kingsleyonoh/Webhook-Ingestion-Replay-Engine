import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

describe("Pino structured logger", () => {
  describe("logger instance", () => {
    it("should export a logger object", async () => {
      const { logger } = await import("../../../src/lib/logger.js");
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.debug).toBe("function");
    });

    it("should have a valid log level", async () => {
      const { logger } = await import("../../../src/lib/logger.js");
      expect(["trace", "debug", "info", "warn", "error", "fatal"]).toContain(
        logger.level
      );
    });
  });

  describe("createRequestLogger", () => {
    it("should create a child logger with requestId", async () => {
      const { createRequestLogger } = await import(
        "../../../src/lib/logger.js"
      );
      const requestId = "req-abc-123";
      const reqLogger = createRequestLogger(requestId);

      expect(reqLogger).toBeDefined();
      expect(typeof reqLogger.info).toBe("function");
      // The child logger bindings should include requestId
      expect(reqLogger.bindings()).toHaveProperty("requestId", requestId);
    });

    it("should propagate requestId in log bindings", async () => {
      const { createRequestLogger } = await import(
        "../../../src/lib/logger.js"
      );
      const requestId = "req-xyz-789";
      const reqLogger = createRequestLogger(requestId);
      const bindings = reqLogger.bindings();
      expect(bindings.requestId).toBe(requestId);
    });
  });

  describe("JSON output format", () => {
    it("should output JSON-parseable log entries", () => {
      let logLine = "";
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          logLine = chunk.toString();
          callback();
        },
      });

      const testLogger = pino({ level: "info" }, stream);
      testLogger.info({ foo: "bar" }, "test message");

      const parsed = JSON.parse(logLine);
      expect(parsed).toHaveProperty("level");
      expect(parsed).toHaveProperty("msg", "test message");
      expect(parsed).toHaveProperty("foo", "bar");
    });
  });

  describe("log levels", () => {
    it("should support all standard Pino levels", async () => {
      const { logger } = await import("../../../src/lib/logger.js");
      const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
      for (const level of levels) {
        expect(typeof (logger as Record<string, unknown>)[level]).toBe(
          "function"
        );
      }
    });
  });
});
