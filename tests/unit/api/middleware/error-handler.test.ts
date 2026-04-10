import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

describe("Error handler middleware", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { errorHandlerPlugin } = await import(
      "../../../../src/api/middleware/error-handler.js"
    );
    const {
      AppError,
      SourceNotFoundError,
      TenantNotFoundError,
      TenantInactiveError,
      ValidationError,
      RateLimitExceededError,
    } = await import("../../../../src/lib/errors.js");

    app = Fastify({ logger: false });

    await app.register(errorHandlerPlugin);

    // Route that throws a known AppError
    app.get("/test/source-not-found", async () => {
      throw new SourceNotFoundError("unknown-slug");
    });

    // Route that throws TenantNotFoundError (401)
    app.get("/test/tenant-not-found", async () => {
      throw new TenantNotFoundError();
    });

    // Route that throws TenantInactiveError (403)
    app.get("/test/tenant-inactive", async () => {
      throw new TenantInactiveError();
    });

    // Route that throws ValidationError (400)
    app.get("/test/validation-error", async () => {
      throw new ValidationError("Invalid input", [
        "name is required",
        "slug must be lowercase",
      ]);
    });

    // Route that throws RateLimitExceededError (429)
    app.get("/test/rate-limit", async () => {
      throw new RateLimitExceededError();
    });

    // Route that throws a generic AppError
    app.get("/test/app-error", async () => {
      throw new AppError("CUSTOM_ERROR", "Custom error occurred", 422, [
        "detail1",
      ]);
    });

    // Route that throws an unknown error
    app.get("/test/unknown-error", async () => {
      throw new Error("Something unexpected happened");
    });

    // Route that throws a non-Error object
    app.get("/test/string-throw", async () => {
      throw "string error";
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should return structured response for SourceNotFoundError", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/source-not-found",
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      error: {
        code: "SOURCE_NOT_FOUND",
        message: "No webhook source found with slug 'unknown-slug'",
        details: [],
      },
    });
  });

  it("should return 401 for TenantNotFoundError", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/tenant-not-found",
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_NOT_FOUND");
  });

  it("should return 403 for TenantInactiveError", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/tenant-inactive",
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("TENANT_INACTIVE");
  });

  it("should return 400 with details for ValidationError", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/validation-error",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([
      "name is required",
      "slug must be lowercase",
    ]);
  });

  it("should return 429 for RateLimitExceededError", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/rate-limit",
    });

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("should return custom status code for generic AppError", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/app-error",
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("CUSTOM_ERROR");
    expect(body.error.message).toBe("Custom error occurred");
    expect(body.error.details).toEqual(["detail1"]);
  });

  it("should return 500 with safe message for unknown errors", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/unknown-error",
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred");
    expect(body.error.details).toEqual([]);
    // Must NOT leak internal error message
    expect(body.error.message).not.toContain("Something unexpected happened");
  });

  it("should handle non-Error throws safely", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/string-throw",
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred");
  });

  it("should always return the standard error response shape", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/test/unknown-error",
    });

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("details");
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    expect(Array.isArray(body.error.details)).toBe(true);
  });
});
