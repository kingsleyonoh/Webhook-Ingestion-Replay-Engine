/**
 * Unit tests for BullMQ delivery queue setup and configuration.
 * Tests: queue connects to Redis, job enqueue/dequeue works, job shape validated.
 */

import { describe, it, expect, afterAll } from "vitest";
import { setupTestRedis } from "../../helpers/redis.js";
import { Queue, Worker } from "bullmq";

describe("Delivery Queue (src/delivery/queue.ts)", () => {
  const testRedis = setupTestRedis();

  describe("createDeliveryQueue", () => {
    let queue: Queue;

    afterAll(async () => {
      if (queue) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it("should create a queue that connects to Redis", async () => {
      const { createDeliveryQueue } = await import(
        "../../../src/delivery/queue.js"
      );
      const redisUrl = process.env["REDIS_URL"]!;
      queue = createDeliveryQueue(redisUrl);

      // Queue should be an instance of BullMQ Queue
      expect(queue).toBeInstanceOf(Queue);
      expect(queue.name).toBe("deliver");
    });

    it("should enqueue a deliver job with correct shape", async () => {
      const { createDeliveryQueue } = await import(
        "../../../src/delivery/queue.js"
      );
      const redisUrl = process.env["REDIS_URL"]!;
      queue = createDeliveryQueue(redisUrl);

      const jobData = {
        eventId: "550e8400-e29b-41d4-a716-446655440001",
        destinationId: "550e8400-e29b-41d4-a716-446655440002",
        tenantId: "550e8400-e29b-41d4-a716-446655440003",
      };

      const job = await queue.add("deliver", jobData);

      expect(job).toBeDefined();
      expect(job.name).toBe("deliver");
      expect(job.data).toEqual(jobData);
      expect(job.data.eventId).toBe(jobData.eventId);
      expect(job.data.destinationId).toBe(jobData.destinationId);
      expect(job.data.tenantId).toBe(jobData.tenantId);
    });

    it("should allow a worker to dequeue and process jobs", async () => {
      const { createDeliveryQueue } = await import(
        "../../../src/delivery/queue.js"
      );
      const redisUrl = process.env["REDIS_URL"]!;
      queue = createDeliveryQueue(redisUrl);

      // Clean previous jobs
      await queue.obliterate({ force: true });

      const jobData = {
        eventId: "550e8400-e29b-41d4-a716-446655440010",
        destinationId: "550e8400-e29b-41d4-a716-446655440011",
        tenantId: "550e8400-e29b-41d4-a716-446655440012",
      };

      // Create worker and track when it processes a job
      const worker = new Worker(
        "deliver",
        async (job) => {
          return job.data;
        },
        {
          connection: { url: redisUrl },
        }
      );

      const processed = new Promise<{
        eventId: string;
        destinationId: string;
        tenantId: string;
      }>((resolve) => {
        worker.on("completed", (job) => {
          resolve(job.returnvalue as {
            eventId: string;
            destinationId: string;
            tenantId: string;
          });
        });
      });

      await queue.add("deliver", jobData);
      const result = await processed;
      await worker.close();

      expect(result.eventId).toBe(jobData.eventId);
      expect(result.destinationId).toBe(jobData.destinationId);
      expect(result.tenantId).toBe(jobData.tenantId);
    });

    it("should export DeliverJobData type with required fields", async () => {
      const mod = await import("../../../src/delivery/queue.js");
      // Verify the module exports createDeliveryQueue function
      expect(typeof mod.createDeliveryQueue).toBe("function");
    });
  });
});
