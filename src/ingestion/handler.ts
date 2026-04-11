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
import { Redis } from "ioredis";
import { createSqlClient, createDb } from "../db/client.js";
import type { Database, SqlClient } from "../db/client.js";
import { sources, events, destinations } from "../db/schema.js";
import { verifySignature, extractTimestampFromHeader } from "./signature.js";
import { generateIdempotencyKey } from "./idempotency.js";
import { getCachedSource, setCachedSource } from "./source-cache.js";
import type { CachedSourceConfig } from "./source-cache.js";
import { createDeliveryQueue } from "../delivery/queue.js";
import type { DeliverJobData } from "../delivery/queue.js";
import {
  SourceNotFoundError,
  SignatureInvalidError,
  PayloadTooLargeError,
  QueueOverloadError,
} from "../lib/errors.js";
import { loadConfig } from "../config.js";
import { logger } from "../lib/logger.js";
import { decrypt, getEncryptionKey } from "../lib/crypto.js";
import { sanitizeHeaders } from "./header-sanitizer.js";
import type { Queue } from "bullmq";

/** Maximum queue depth before rejecting incoming webhooks (Section 10b) */
const BACKPRESSURE_MAX_QUEUE_DEPTH = 10_000;

interface WebhookParams {
  sourceSlug: string;
}

async function ingestionHandler(app: FastifyInstance): Promise<void> {
  const config = loadConfig();
  const databaseUrl = config.databaseUrl;

  const sqlClient: SqlClient = createSqlClient(databaseUrl, { max: 5 });
  const db: Database = createDb(sqlClient);

  // Create Redis client for source config cache
  const redis = new Redis(config.redisUrl);

  // Create delivery queue for fan-out
  const deliverQueue: Queue<DeliverJobData> = createDeliveryQueue(
    config.redisUrl
  );

  // Clean up DB connection + queue + Redis on server close
  app.addHook("onClose", async () => {
    await deliverQueue.close();
    await redis.quit();
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
      // Uses preserved raw bytes from content type parser (avoids re-serialization
      // which would break HMAC on non-canonical JSON)
      const rawBody =
        request.rawBody && request.rawBody.length > 0
          ? request.rawBody
          : Buffer.from(
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

      // Step 3b: Backpressure check — reject if queue is overloaded (Section 10b)
      const jobCounts = await deliverQueue.getJobCounts(
        "waiting",
        "active"
      );
      const queueDepth =
        (jobCounts.waiting ?? 0) + (jobCounts.active ?? 0);
      if (queueDepth > BACKPRESSURE_MAX_QUEUE_DEPTH) {
        reqLogger.warn(
          { queueDepth, maxDepth: BACKPRESSURE_MAX_QUEUE_DEPTH },
          "Queue backpressure — rejecting webhook"
        );
        throw new QueueOverloadError(
          queueDepth,
          BACKPRESSURE_MAX_QUEUE_DEPTH
        );
      }

      // Step 1: Look up source by slug — cache first, then DB
      let source: CachedSourceConfig | null =
        await getCachedSource(redis, sourceSlug);

      if (!source) {
        // Cache miss — query DB (fetch ALL matching slugs, including disabled)
        const sourceResult = await db
          .select({
            id: sources.id,
            tenantId: sources.tenantId,
            slug: sources.slug,
            signatureHeader: sources.signatureHeader,
            signatureAlgo: sources.signatureAlgo,
            signingSecret: sources.signingSecret,
            enabled: sources.enabled,
          })
          .from(sources)
          .where(eq(sources.slug, sourceSlug))
          .limit(1);

        const dbSource = sourceResult[0];
        if (!dbSource) {
          throw new SourceNotFoundError(sourceSlug);
        }

        // Uniform 404 for disabled sources — same as unknown slug
        if (!dbSource.enabled) {
          throw new SourceNotFoundError(sourceSlug);
        }

        // Populate cache for future requests (stores encrypted secret)
        source = {
          id: dbSource.id,
          tenantId: dbSource.tenantId,
          slug: dbSource.slug,
          signatureHeader: dbSource.signatureHeader,
          signatureAlgo: dbSource.signatureAlgo,
          signingSecret: dbSource.signingSecret,
          enabled: dbSource.enabled,
        };
        await setCachedSource(redis, sourceSlug, source);
      }

      // Cached entries should only be enabled, but guard against stale cache
      if (!source.enabled) {
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
        // Decrypt the signing secret (stored encrypted at rest)
        let plainSecret: string;
        try {
          const encKey = getEncryptionKey();
          plainSecret = decrypt(source.signingSecret, encKey);
        } catch {
          // If decryption fails, treat as plaintext (migration compatibility)
          plainSecret = source.signingSecret;
        }

        const sigHeaderValue =
          (request.headers[
            source.signatureHeader.toLowerCase()
          ] as string) ?? "";

        // Extract timestamp from signature header (Stripe t=NNN format)
        const timestampMs = extractTimestampFromHeader(sigHeaderValue);

        const isValid = verifySignature({
          rawBody,
          signatureHeader: sigHeaderValue,
          signingSecret: plainSecret,
          algorithm: algo,
          timestampMs,
          toleranceMs: config.signatureToleranceMs,
        });

        if (!isValid) {
          reqLogger.warn("Webhook signature verification failed");

          const idempotencyKey = generateIdempotencyKey({
            headers: request.headers as Record<string, string>,
            rawBody,
          });

          const sanitizedRejectedHeaders = sanitizeHeaders(
            request.headers as Record<string, unknown>
          );
          await db.insert(events).values({
            tenantId: source.tenantId,
            sourceId: source.id,
            idempotencyKey,
            headers: sanitizedRejectedHeaders,
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

      // Step 5b: Sanitize headers before persistence
      const sanitizedHeaders = sanitizeHeaders(
        request.headers as Record<string, unknown>
      );

      // Step 6: Persist event with idempotency check
      const insertResult = await db
        .insert(events)
        .values({
          tenantId: source.tenantId,
          sourceId: source.id,
          idempotencyKey,
          headers: sanitizedHeaders,
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
