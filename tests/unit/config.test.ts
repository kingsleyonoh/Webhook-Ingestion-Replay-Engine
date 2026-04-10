import { describe, it, expect, vi, beforeEach } from "vitest";

// We'll test the loadConfig function which reads from process.env at call time
// Config module will be imported statically; loadConfig() re-reads env on each call

describe("Config loader", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Set required vars
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:devpass@localhost:5450/webhooks");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  async function getLoadConfig() {
    const mod = await import("../../src/config.js");
    return mod.loadConfig;
  }

  describe("valid configuration", () => {
    it("should load config with all defaults when only required vars set", async () => {
      const loadConfig = await getLoadConfig();
      const config = loadConfig();
      expect(config.databaseUrl).toBe(
        "postgresql://postgres:devpass@localhost:5450/webhooks"
      );
      expect(config.redisUrl).toBe("redis://localhost:6379");
      expect(config.port).toBe(3000);
      expect(config.host).toBe("0.0.0.0");
      expect(config.logLevel).toBe("info");
      expect(config.selfRegistrationEnabled).toBe(true);
    });

    it("should apply custom values when env vars are set", async () => {
      vi.stubEnv("PORT", "8080");
      vi.stubEnv("HOST", "127.0.0.1");
      vi.stubEnv("LOG_LEVEL", "debug");
      vi.stubEnv("SELF_REGISTRATION_ENABLED", "false");
      vi.stubEnv("DELIVERY_CONCURRENCY", "20");
      vi.stubEnv("DELIVERY_DEFAULT_TIMEOUT_MS", "5000");
      vi.stubEnv("DELIVERY_MAX_RETRIES", "3");
      vi.stubEnv("DELIVERY_BACKOFF_BASE_MS", "500");
      vi.stubEnv("REPLAY_BATCH_SIZE", "50");
      vi.stubEnv("EVENT_ARCHIVE_DAYS", "30");
      vi.stubEnv("MAX_PAYLOAD_BYTES", "2097152");

      const loadConfig = await getLoadConfig();
      const config = loadConfig();
      expect(config.port).toBe(8080);
      expect(config.host).toBe("127.0.0.1");
      expect(config.logLevel).toBe("debug");
      expect(config.selfRegistrationEnabled).toBe(false);
      expect(config.deliveryConcurrency).toBe(20);
      expect(config.deliveryDefaultTimeoutMs).toBe(5000);
      expect(config.deliveryMaxRetries).toBe(3);
      expect(config.deliveryBackoffBaseMs).toBe(500);
      expect(config.replayBatchSize).toBe(50);
      expect(config.eventArchiveDays).toBe(30);
      expect(config.maxPayloadBytes).toBe(2097152);
    });

    it("should load optional ecosystem variables", async () => {
      vi.stubEnv("NOTIFICATION_HUB_URL", "https://notifications.example.com");
      vi.stubEnv("NOTIFICATION_HUB_API_KEY", "notif-key-123");
      vi.stubEnv("WORKFLOW_ENGINE_URL", "https://workflows.example.com");
      vi.stubEnv("WORKFLOW_ENGINE_SECRET", "wf-secret-456");

      const loadConfig = await getLoadConfig();
      const config = loadConfig();
      expect(config.notificationHubUrl).toBe(
        "https://notifications.example.com"
      );
      expect(config.notificationHubApiKey).toBe("notif-key-123");
      expect(config.workflowEngineUrl).toBe("https://workflows.example.com");
      expect(config.workflowEngineSecret).toBe("wf-secret-456");
    });

    it("should treat empty optional strings as undefined", async () => {
      vi.stubEnv("NOTIFICATION_HUB_URL", "");
      vi.stubEnv("NOTIFICATION_HUB_API_KEY", "");

      const loadConfig = await getLoadConfig();
      const config = loadConfig();
      expect(config.notificationHubUrl).toBeUndefined();
      expect(config.notificationHubApiKey).toBeUndefined();
    });
  });

  describe("defaults applied correctly", () => {
    it("should use default delivery settings", async () => {
      const loadConfig = await getLoadConfig();
      const config = loadConfig();
      expect(config.deliveryConcurrency).toBe(10);
      expect(config.deliveryDefaultTimeoutMs).toBe(10000);
      expect(config.deliveryMaxRetries).toBe(5);
      expect(config.deliveryBackoffBaseMs).toBe(1000);
    });

    it("should use default replay and archival settings", async () => {
      const loadConfig = await getLoadConfig();
      const config = loadConfig();
      expect(config.replayBatchSize).toBe(100);
      expect(config.eventArchiveDays).toBe(90);
      expect(config.maxPayloadBytes).toBe(1048576);
    });
  });

  describe("missing required variables", () => {
    it("should throw when DATABASE_URL is missing", async () => {
      vi.stubEnv("DATABASE_URL", "");
      delete process.env["DATABASE_URL"];

      const loadConfig = await getLoadConfig();
      expect(() => loadConfig()).toThrow();
    });

    it("should throw when REDIS_URL is missing", async () => {
      vi.stubEnv("REDIS_URL", "");
      delete process.env["REDIS_URL"];

      const loadConfig = await getLoadConfig();
      expect(() => loadConfig()).toThrow();
    });
  });

  describe("invalid formats", () => {
    it("should throw when PORT is not a number", async () => {
      vi.stubEnv("PORT", "not-a-number");
      const loadConfig = await getLoadConfig();
      expect(() => loadConfig()).toThrow();
    });

    it("should throw when DELIVERY_CONCURRENCY is negative", async () => {
      vi.stubEnv("DELIVERY_CONCURRENCY", "-1");
      const loadConfig = await getLoadConfig();
      expect(() => loadConfig()).toThrow();
    });

    it("should throw when LOG_LEVEL is invalid", async () => {
      vi.stubEnv("LOG_LEVEL", "banana");
      const loadConfig = await getLoadConfig();
      expect(() => loadConfig()).toThrow();
    });

    it("should throw when MAX_PAYLOAD_BYTES is zero", async () => {
      vi.stubEnv("MAX_PAYLOAD_BYTES", "0");
      const loadConfig = await getLoadConfig();
      expect(() => loadConfig()).toThrow();
    });
  });
});
