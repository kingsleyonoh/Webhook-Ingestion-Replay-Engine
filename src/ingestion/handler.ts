/**
 * Webhook ingestion handler — Fastify plugin.
 * POST /webhooks/:sourceSlug
 *
 * Section 5.1 — Ingestion pipeline:
 * 1. Look up source by slug (enabled only)
 * 2. Buffer raw body for signature verification
 * 3. Check payload size against MAX_PAYLOAD_BYTES
 * 4. Verify HMAC signature (if configured)
 * 5. Generate idempotency key
 * 6. Persist event to PostgreSQL (ON CONFLICT DO NOTHING for dedup)
 * 7. Enqueue delivery jobs for active destinations
 * 8. Return 200 immediately
 *
 * Edge cases:
 * - Unknown/disabled source -> 404
 * - Payload > MAX_PAYLOAD_BYTES -> 413
 * - Signature failure -> persist with 'rejected', return 401
 * - Duplicate idempotency key -> return 200 (already processed)
 * - No active destinations -> persist event, skip enqueue
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { eq, and } from "drizzle-orm";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { sources, events, destinations } from "../db/schema.js";
import { verifySignature } from "./signature.js";
import { generateIdempotencyKey } from "./idempotency.js";
import { createDeliveryQueue } from "../delivery/queue.js";
import type { DeliverJobData } from "../delivery/queue.js";
import {
  SourceNotFoundError,
  SignatureInvalidError,
  PayloadTooLargeError,
} from "../lib/errors.js";
import { loadConfig } from "../config.js";
import { logger } from "../lib/logger.js";
import type { Queue } from "bullmq";

interface WebhookParams {
  sourceSlug: string;
}

async function ingestionHandler(app: FastifyInstance): Promise<void> {
  const config = loadConfig();
  const databaseUrl = config.databaseUrl;

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 5 });
  const db: Database = createDb(sqlClient);

  // Create delivery queue for fan-out
  const deliverQueue: Queue<DeliverJobData> = createDeliveryQueue(
    config.redisUrl
  );

  // Clean up DB connection + queue on server close
  app.addHook("onClose", async () => {
    await deliverQueue.close();
    await sqlClient.end();
  });

  app.post<{ Params: WebhookParams }>(
    "/webhooks/:sourceSlug",
    async (
      request: FastifyRequest<{ Params: WebhookParams }>,
      reply: FastifyReply
    ) => {
      const { sourceSlug } = request.params;
      const reqLogger = logger.child({
        requestId: request.id as string,
        sourceSlug,
      });

      // Step 2: Get raw body buffer for signature verification
      const rawBody = Buffer.from(
        typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body)
      );

      // Step 3: Check payload size before any processing
      if (rawBody.length > config.maxPayloadBytes) {
        throw new PayloadTooLargeError(
          rawBody.length,
          config.maxPayloadBytes
        );
      }

      // Step 1: Look up source by slug (must be enabled)
      const sourceResult = await db
        .select({
          id: sources.id,
          tenantId: sources.tenantId,
          signatureHeader: sources.signatureHeader,
          signatureAlgo: sources.signatureAlgo,
          signingSecret: sources.signingSecret,
          enabled: sources.enabled,
        })
        .from(sources)
        .where(
          and(eq(sources.slug, sourceSlug), eq(sources.enabled, true))
        )
        .limit(1);

      const source = sourceResult[0];
      if (!source) {
        throw new SourceNotFoundError(sourceSlug);
      }

      // Step 4: Verify signature if configured
      const algo = (source.signatureAlgo ?? "none") as
        | "hmac-sha256"
        | "hmac-sha1"
        | "none";

      if (
        algo !== "none" &&
        source.signatureHeader &&
        source.signingSecret
      ) {
        const sigHeaderValue =
          (request.headers[
            source.signatureHeader.toLowerCase()
          ] as string) ?? "";

        const isValid = verifySignature({
          rawBody,
          signatureHeader: sigHeaderValue,
          signingSecret: source.signingSecret,
          algorithm: algo,
        });

        if (!isValid) {
          reqLogger.warn("Webhook signature verification failed");

          const idempotencyKey = generateIdempotencyKey({
            headers: request.headers as Record<string, string>,
            rawBody,
          });

          await db.insert(events).values({
            tenantId: source.tenantId,
            sourceId: source.id,
            idempotencyKey,
            headers: request.headers as Record<string, unknown>,
            payload: request.body as Record<string, unknown>,
            status: "rejected",
          });

          throw new SignatureInvalidError();
        }
      }

      // Step 5: Generate idempotency key
      const idempotencyKey = generateIdempotencyKey({
        headers: request.headers as Record<string, string>,
        rawBody,
      });

      // Step 6: Persist event with idempotency check
      const insertResult = await db
        .insert(events)
        .values({
          tenantId: source.tenantId,
          sourceId: source.id,
          idempotencyKey,
          headers: request.headers as Record<string, unknown>,
          payload: request.body as Record<string, unknown>,
          status: "pending",
        })
        .onConflictDoNothing({
          target: [
            events.tenantId,
            events.sourceId,
            events.idempotencyKey,
          ],
        })
        .returning({ id: events.id });

      // If no rows returned, the event already exists (duplicate)
      if (insertResult.length === 0) {
        reqLogger.info(
          { idempotencyKey },
          "Duplicate event — already processed"
        );
        return reply.send({
          eventId: null,
          status: "duplicate",
          message: "Event already processed",
        });
      }

      const eventId = insertResult[0]!.id;

      // Step 7: Look up active destinations for this source
      const activeDestinations = await db
        .select({ id: destinations.id })
        .from(destinations)
        .where(
          and(
            eq(destinations.sourceId, source.id),
            eq(destinations.tenantId, source.tenantId),
            eq(destinations.enabled, true)
          )
        );

      // Step 8: Enqueue delivery jobs for each active destination
      if (activeDestinations.length > 0) {
        const jobPromises = activeDestinations.map((dest) =>
          deliverQueue.add("deliver", {
            eventId,
            destinationId: dest.id,
            tenantId: source.tenantId,
          })
        );
        await Promise.all(jobPromises);

        reqLogger.info(
          {
            eventId,
            destinationCount: activeDestinations.length,
          },
          "Delivery jobs enqueued"
        );
      } else {
        reqLogger.info(
          { eventId },
          "No active destinations — event persisted for audit trail"
        );
      }

      // Step 9: Return 200 immediately
      return reply.send({
        eventId,
        status: "accepted",
      });
    }
  );
}

export const ingestionPlugin = fp(ingestionHandler, {
  name: "ingestion-handler",
});
