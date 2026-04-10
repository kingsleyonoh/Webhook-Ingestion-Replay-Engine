/**
 * Fastify server entry point.
 * Section 9 — plugin registration, route mounting, middleware chain.
 *
 * Exports buildApp() factory for testing and start() for production.
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { errorHandlerPlugin } from "./api/middleware/error-handler.js";
import { rateLimitPlugin } from "./api/middleware/rate-limit.js";
import tenantRoutes from "./api/tenants.routes.js";
import healthRoutes from "./api/health.routes.js";

/**
 * Declare the tenantId request decorator type.
 * After auth middleware resolves, request.tenantId holds the UUID.
 */
declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
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
      _request,
      body: Buffer,
      done: (err: Error | null, result?: unknown) => void
    ) => {
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
      _request,
      body: Buffer,
      done: (err: Error | null, result?: unknown) => void
    ) => {
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

  const app = Fastify({
    logger: {
      level: logLevel,
    },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Decorate request with tenantId (default empty — set by auth middleware)
  app.decorateRequest("tenantId", "");

  // Register error handler (must be first — catches all downstream errors)
  await app.register(errorHandlerPlugin);

  // Register raw body parser for webhook signature verification
  registerRawBodyParser(app);

  // Register rate limiting
  await app.register(rateLimitPlugin);

  // Register health check routes (public, no auth)
  await app.register(healthRoutes);

  // Register tenant routes (register = public, me = authenticated)
  await app.register(tenantRoutes);

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
