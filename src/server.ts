/**
 * Fastify server entry point.
 * Section 9 — plugin registration, route mounting, middleware chain.
 *
 * Exports buildApp() factory for testing and start() for production.
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import { errorHandlerPlugin } from "./api/middleware/error-handler.js";
import { rateLimitPlugin } from "./api/middleware/rate-limit.js";
import tenantRoutes from "./api/tenants.routes.js";
import healthRoutes from "./api/health.routes.js";
import sourceRoutes from "./api/sources.routes.js";
import destinationRoutes from "./api/destinations.routes.js";
import deadLetterRoutes from "./api/dead-letters.routes.js";
import eventRoutes from "./api/events.routes.js";
import replayRoutes from "./replay/routes.js";
import statsRoutes from "./api/stats.routes.js";
import { ingestionPlugin } from "./ingestion/handler.js";
import { setupGracefulShutdown } from "./shutdown.js";

/**
 * Declare request decorator types.
 * - tenantId: set by auth middleware after API key resolution
 * - rawBody: preserved by content type parser for HMAC signature verification
 */
declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
    rawBody: Buffer;
  }
}

/**
 * Raw body content type parser for webhook signature verification.
 * Buffers the raw body while still parsing JSON for handler access.
 */
function registerRawBodyParser(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (
      request,
      body: Buffer,
      done: (err: Error | null, result?: unknown) => void
    ) => {
      // Preserve raw bytes for HMAC signature verification
      request.rawBody = body;
      try {
        const parsed: unknown =
          body.length > 0 ? JSON.parse(body.toString()) : {};
        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    }
  );

  // Accept any content type for webhook payloads
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (
      request,
      body: Buffer,
      done: (err: Error | null, result?: unknown) => void
    ) => {
      // Preserve raw bytes for HMAC signature verification
      request.rawBody = body;
      done(null, body);
    }
  );
}

/**
 * Build and configure the Fastify application.
 * Does NOT start listening — call app.listen() separately for production.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const logLevel = process.env["LOG_LEVEL"] ?? "info";
  const maxPayloadBytes = parseInt(
    process.env["MAX_PAYLOAD_BYTES"] ?? "1048576",
    10
  );

  const app = Fastify({
    logger: {
      level: logLevel,
    },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
    bodyLimit: maxPayloadBytes,
  });

  // Decorate request with tenantId (default empty — set by auth middleware)
  app.decorateRequest("tenantId", "");

  // Decorate request with rawBody (for HMAC signature verification)
  // Fastify 5.x requires getter/setter for reference types (Buffer, Object, Array)
  app.decorateRequest("rawBody", {
    getter() {
      return (this as unknown as Record<string, Buffer>)._rawBody ?? Buffer.alloc(0);
    },
    setter(value: Buffer) {
      (this as unknown as Record<string, Buffer>)._rawBody = value;
    },
  });

  // Register security headers (must be first — applies to all responses)
  await app.register(helmet, {
    // Disable CSP for API-only server (no HTML content)
    contentSecurityPolicy: false,
  });

  // Register error handler (catches all downstream errors)
  await app.register(errorHandlerPlugin);

  // Register raw body parser for webhook signature verification
  registerRawBodyParser(app);

  // Register rate limiting
  await app.register(rateLimitPlugin);

  // Register health check routes (public, no auth)
  await app.register(healthRoutes);

  // Register tenant routes (register = public, me = authenticated)
  await app.register(tenantRoutes);

  // Register source management routes (authenticated)
  await app.register(sourceRoutes);

  // Register destination management routes (authenticated)
  await app.register(destinationRoutes);

  // Register dead letter inspector routes (authenticated)
  await app.register(deadLetterRoutes);

  // Register event inspector routes (authenticated)
  await app.register(eventRoutes);

  // Register replay routes (authenticated)
  await app.register(replayRoutes);

  // Register stats dashboard route (authenticated)
  await app.register(statsRoutes);

  // Register webhook ingestion route (public, HMAC signature auth)
  await app.register(ingestionPlugin);

  return app;
}

/**
 * Production entry point — builds the app and starts listening.
 * Only runs when this file is executed directly (not imported in tests).
 */
async function start(): Promise<void> {
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const host = process.env["HOST"] ?? "0.0.0.0";

  const app = await buildApp();

  // Register graceful shutdown handlers
  setupGracefulShutdown({ app });

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Auto-start only when run directly (not when imported by tests)
const isDirectRun =
  process.argv[1]?.includes("server") &&
  !process.argv[1]?.includes("vitest") &&
  !process.argv[1]?.includes("node_modules");

if (isDirectRun) {
  start();
}

export { start };
