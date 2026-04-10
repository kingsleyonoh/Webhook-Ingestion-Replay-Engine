/**
 * Unit tests for graceful shutdown.
 * Tests:
 * - setupGracefulShutdown registers SIGTERM/SIGINT handlers
 * - performShutdown drains resources in correct order:
 *     1. Fastify app close (stop accepting connections)
 *     2. BullMQ worker drain (finish in-progress jobs)
 *     3. Database connection close
 *     4. Redis connection close
 * - Handles missing optional resources gracefully
 * - Continues cleanup even when one resource fails to close
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("setupGracefulShutdown", () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  const registeredHandlers = new Map<string, (...args: unknown[]) => void>();

  beforeEach(() => {
    registeredHandlers.clear();
    processOnSpy = vi.spyOn(process, "on").mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        registeredHandlers.set(event, handler);
        return process;
      }
    );
  });

  afterEach(() => {
    processOnSpy.mockRestore();
  });

  it("should register SIGTERM and SIGINT handlers", async () => {
    const { setupGracefulShutdown } = await import(
      "../../src/shutdown.js"
    );

    const mockApp = { close: vi.fn().mockResolvedValue(undefined) };

    setupGracefulShutdown({ app: mockApp as never });

    expect(registeredHandlers.has("SIGTERM")).toBe(true);
    expect(registeredHandlers.has("SIGINT")).toBe(true);
  });
});

describe("performShutdown", () => {
  it("should close Fastify app", async () => {
    const { performShutdown } = await import("../../src/shutdown.js");

    const mockApp = { close: vi.fn().mockResolvedValue(undefined) };

    await performShutdown({ app: mockApp as never }, "SIGTERM");

    expect(mockApp.close).toHaveBeenCalledTimes(1);
  });

  it("should drain BullMQ worker after closing app", async () => {
    const { performShutdown } = await import("../../src/shutdown.js");

    const callOrder: string[] = [];
    const mockApp = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("app.close");
      }),
    };
    const mockWorker = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("worker.close");
      }),
    };

    await performShutdown(
      { app: mockApp as never, worker: mockWorker as never },
      "SIGTERM"
    );

    expect(mockWorker.close).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["app.close", "worker.close"]);
  });

  it("should close DB connection after worker drain", async () => {
    const { performShutdown } = await import("../../src/shutdown.js");

    const callOrder: string[] = [];
    const mockApp = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("app.close");
      }),
    };
    const mockWorker = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("worker.close");
      }),
    };
    const mockSqlClient = {
      end: vi.fn().mockImplementation(async () => {
        callOrder.push("sql.end");
      }),
    };

    await performShutdown(
      {
        app: mockApp as never,
        worker: mockWorker as never,
        sqlClient: mockSqlClient as never,
      },
      "SIGTERM"
    );

    expect(mockSqlClient.end).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["app.close", "worker.close", "sql.end"]);
  });

  it("should close Redis after DB", async () => {
    const { performShutdown } = await import("../../src/shutdown.js");

    const callOrder: string[] = [];
    const mockApp = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("app.close");
      }),
    };
    const mockWorker = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("worker.close");
      }),
    };
    const mockSqlClient = {
      end: vi.fn().mockImplementation(async () => {
        callOrder.push("sql.end");
      }),
    };
    const mockRedis = {
      quit: vi.fn().mockImplementation(async () => {
        callOrder.push("redis.quit");
      }),
    };

    await performShutdown(
      {
        app: mockApp as never,
        worker: mockWorker as never,
        sqlClient: mockSqlClient as never,
        redis: mockRedis as never,
      },
      "SIGTERM"
    );

    expect(mockRedis.quit).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "app.close",
      "worker.close",
      "sql.end",
      "redis.quit",
    ]);
  });

  it("should handle absent optional resources gracefully", async () => {
    const { performShutdown } = await import("../../src/shutdown.js");

    const mockApp = { close: vi.fn().mockResolvedValue(undefined) };

    // Should not throw — no worker, sqlClient, or redis
    await performShutdown({ app: mockApp as never }, "SIGTERM");

    expect(mockApp.close).toHaveBeenCalledTimes(1);
  });

  it("should continue cleanup when worker close fails", async () => {
    const { performShutdown } = await import("../../src/shutdown.js");

    const mockApp = { close: vi.fn().mockResolvedValue(undefined) };
    const mockWorker = {
      close: vi
        .fn()
        .mockRejectedValue(new Error("Worker close failed")),
    };
    const mockSqlClient = { end: vi.fn().mockResolvedValue(undefined) };
    const mockRedis = { quit: vi.fn().mockResolvedValue(undefined) };

    // Should not throw
    await performShutdown(
      {
        app: mockApp as never,
        worker: mockWorker as never,
        sqlClient: mockSqlClient as never,
        redis: mockRedis as never,
      },
      "SIGTERM"
    );

    expect(mockApp.close).toHaveBeenCalledTimes(1);
    expect(mockWorker.close).toHaveBeenCalledTimes(1);
    // Should still close DB and Redis even though worker failed
    expect(mockSqlClient.end).toHaveBeenCalledTimes(1);
    expect(mockRedis.quit).toHaveBeenCalledTimes(1);
  });

  it("should handle SIGINT signal string correctly", async () => {
    const { performShutdown } = await import("../../src/shutdown.js");

    const mockApp = { close: vi.fn().mockResolvedValue(undefined) };
    const mockWorker = { close: vi.fn().mockResolvedValue(undefined) };

    await performShutdown(
      { app: mockApp as never, worker: mockWorker as never },
      "SIGINT"
    );

    expect(mockApp.close).toHaveBeenCalledTimes(1);
    expect(mockWorker.close).toHaveBeenCalledTimes(1);
  });
});
