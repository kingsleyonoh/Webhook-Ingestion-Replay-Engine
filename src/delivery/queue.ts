/**
 * BullMQ delivery queue setup and configuration.
 * Section 5.2 — `deliver` job type for async webhook delivery.
 *
 * Usage:
 *   import { createDeliveryQueue } from './queue.js';
 *   const queue = createDeliveryQueue(config.redisUrl);
 *   await queue.add('deliver', { eventId, destinationId, tenantId });
 */

import { Queue } from "bullmq";

/**
 * Job data shape for the `deliver` job type.
 * Contains the IDs needed to load event + destination and attempt delivery.
 */
export interface DeliverJobData {
  eventId: string;
  destinationId: string;
  tenantId: string;
}

/**
 * Create a BullMQ queue for webhook delivery jobs.
 * The queue name is "deliver" — workers will pick up jobs from this queue.
 */
export function createDeliveryQueue(redisUrl: string): Queue<DeliverJobData> {
  return new Queue<DeliverJobData>("deliver", {
    connection: { url: redisUrl },
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}
