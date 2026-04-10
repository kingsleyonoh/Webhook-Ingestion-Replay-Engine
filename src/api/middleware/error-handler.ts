/**
 * Centralized error handler middleware — Fastify plugin.
 * Catches all errors and returns the standard Section 8b format:
 * { error: { code, message, details } }
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

async function errorHandler(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(
    (error: Error, request: FastifyRequest, reply: FastifyReply) => {
      const requestId =
        (request.id as string | undefined) ?? "unknown";
      const reqLogger = logger.child({ requestId });

      // Known application errors — return structured response
      if (error instanceof AppError) {
        reqLogger.warn(
          { code: error.code, statusCode: error.statusCode },
          error.message
        );

        return reply.status(error.statusCode).send(error.toJSON());
      }

      // Fastify errors with statusCode (e.g., body too large, validation)
      const fastifyErr = error as {
        statusCode?: number;
        code?: string;
      };
      if (fastifyErr.statusCode && fastifyErr.statusCode !== 500) {
        const statusCode = fastifyErr.statusCode;
        const errCode =
          statusCode === 413
            ? "PAYLOAD_TOO_LARGE"
            : fastifyErr.code ?? "REQUEST_ERROR";

        reqLogger.warn(
          { code: errCode, statusCode },
          error.message
        );

        return reply.status(statusCode).send({
          error: {
            code: errCode,
            message: error.message,
            details: [],
          },
        });
      }

      // Unknown errors — log full details, return safe message
      reqLogger.error(
        { err: error },
        "Unhandled error in request handler"
      );

      return reply.status(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          details: [],
        },
      });
    }
  );
}

export const errorHandlerPlugin = fp(errorHandler, {
  name: "error-handler",
});
