import { describe, it, expect } from "vitest";

// Static import — module doesn't exist yet, so this will fail in RED phase
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type * as ErrorsModule from "../../../src/lib/errors.js";

// Use top-level await-safe import
let errors: typeof ErrorsModule;

describe("Custom error classes", () => {
  it("should import the errors module", async () => {
    errors = await import("../../../src/lib/errors.js");
    expect(errors).toBeDefined();
  });

  describe("AppError base class", () => {
    it("should create an error with code, message, and statusCode", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.AppError("TEST_ERROR", "Something went wrong", 500);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("TEST_ERROR");
      expect(err.message).toBe("Something went wrong");
      expect(err.statusCode).toBe(500);
    });

    it("should default details to empty array", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.AppError("TEST_ERROR", "msg", 400);
      expect(err.details).toEqual([]);
    });

    it("should accept custom details", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.AppError("TEST_ERROR", "msg", 400, [
        "field x is invalid",
      ]);
      expect(err.details).toEqual(["field x is invalid"]);
    });

    it("should serialize to the standard error format", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.AppError("TEST_ERROR", "Something failed", 422, [
        "detail1",
      ]);
      const serialized = err.toJSON();
      expect(serialized).toEqual({
        error: {
          code: "TEST_ERROR",
          message: "Something failed",
          details: ["detail1"],
        },
      });
    });
  });

  describe("SourceNotFoundError", () => {
    it("should produce SOURCE_NOT_FOUND code with 404 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.SourceNotFoundError("unknown-slug");
      expect(err.code).toBe("SOURCE_NOT_FOUND");
      expect(err.statusCode).toBe(404);
      expect(err.message).toContain("unknown-slug");
    });
  });

  describe("SignatureInvalidError", () => {
    it("should produce SIGNATURE_INVALID code with 401 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.SignatureInvalidError();
      expect(err.code).toBe("SIGNATURE_INVALID");
      expect(err.statusCode).toBe(401);
      expect(err.message).toBeTruthy();
    });
  });

  describe("PayloadTooLargeError", () => {
    it("should produce PAYLOAD_TOO_LARGE code with 413 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.PayloadTooLargeError(2097152, 1048576);
      expect(err.code).toBe("PAYLOAD_TOO_LARGE");
      expect(err.statusCode).toBe(413);
      expect(err.message).toContain("2097152");
      expect(err.message).toContain("1048576");
    });
  });

  describe("RateLimitExceededError", () => {
    it("should produce RATE_LIMIT_EXCEEDED code with 429 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.RateLimitExceededError();
      expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(err.statusCode).toBe(429);
    });
  });

  describe("DuplicateEventError", () => {
    it("should produce DUPLICATE_EVENT code with 200 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.DuplicateEventError("idem-key-123");
      expect(err.code).toBe("DUPLICATE_EVENT");
      expect(err.statusCode).toBe(200);
      expect(err.message).toContain("idem-key-123");
    });
  });

  describe("TenantNotFoundError", () => {
    it("should produce TENANT_NOT_FOUND code with 401 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.TenantNotFoundError();
      expect(err.code).toBe("TENANT_NOT_FOUND");
      expect(err.statusCode).toBe(401);
    });
  });

  describe("TenantInactiveError", () => {
    it("should produce TENANT_INACTIVE code with 403 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.TenantInactiveError();
      expect(err.code).toBe("TENANT_INACTIVE");
      expect(err.statusCode).toBe(403);
    });
  });

  describe("ValidationError", () => {
    it("should produce VALIDATION_ERROR code with 400 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.ValidationError("Invalid input", [
        "name is required",
        "slug must be lowercase",
      ]);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.statusCode).toBe(400);
      expect(err.details).toHaveLength(2);
    });
  });

  describe("QueueOverloadError", () => {
    it("should produce QUEUE_OVERLOAD code with 429 status", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.QueueOverloadError(15000, 10000);
      expect(err.code).toBe("QUEUE_OVERLOAD");
      expect(err.statusCode).toBe(429);
      expect(err.message).toContain("15000");
    });
  });

  describe("error serialization format", () => {
    it("should match Section 8b error format for all error types", async () => {
      errors = await import("../../../src/lib/errors.js");
      const err = new errors.SourceNotFoundError("my-slug");
      const json = err.toJSON();

      // Must match: { error: { code, message, details } }
      expect(json).toHaveProperty("error");
      expect(json.error).toHaveProperty("code");
      expect(json.error).toHaveProperty("message");
      expect(json.error).toHaveProperty("details");
      expect(Array.isArray(json.error.details)).toBe(true);
    });
  });
});
