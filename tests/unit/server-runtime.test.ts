import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/delivery/worker.js", () => ({
  createDeliveryWorker: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("../../src/shutdown.js", () => ({
  setupGracefulShutdown: vi.fn(),
}));

describe("production runtime wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a BullMQ delivery worker and registers it for shutdown", async () => {
    const { startRuntime } = await import("../../src/server.js");
    const { createDeliveryWorker } = await import("../../src/delivery/worker.js");
    const { setupGracefulShutdown } = await import("../../src/shutdown.js");

    const app = {
      listen: vi.fn().mockResolvedValue(undefined),
      log: { error: vi.fn() },
    };
    const config = {
      databaseUrl: "postgres://test",
      redisUrl: "redis://test",
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      selfRegistrationEnabled: true,
      deliveryConcurrency: 7,
      deliveryDefaultTimeoutMs: 10000,
      deliveryMaxRetries: 5,
      deliveryBackoffBaseMs: 1000,
      replayBatchSize: 100,
      eventArchiveDays: 90,
      maxPayloadBytes: 1048576,
      signatureToleranceMs: 300000,
      signingSecretKey: undefined,
      notificationHubUrl: undefined,
      notificationHubApiKey: undefined,
      workflowEngineUrl: undefined,
      workflowEngineSecret: undefined,
    };

    await startRuntime(app as never, config);

    expect(createDeliveryWorker).toHaveBeenCalledWith({
      databaseUrl: "postgres://test",
      redisUrl: "redis://test",
      concurrency: 7,
    });
    expect(setupGracefulShutdown).toHaveBeenCalledWith({
      app,
      worker: expect.any(Object),
    });
    expect(app.listen).toHaveBeenCalledWith({ port: 3000, host: "0.0.0.0" });
  });
});
