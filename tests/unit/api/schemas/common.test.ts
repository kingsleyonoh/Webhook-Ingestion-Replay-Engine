import { describe, it, expect } from "vitest";

describe("Common validation schemas", () => {
  let schemas: typeof import("../../../../src/api/schemas/common.js");

  it("should import the schemas module", async () => {
    schemas = await import("../../../../src/api/schemas/common.js");
    expect(schemas).toBeDefined();
  });

  describe("uuidParamSchema", () => {
    it("should accept a valid UUID", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.uuidParamSchema.safeParse({
        id: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
    });

    it("should reject an invalid UUID", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.uuidParamSchema.safeParse({ id: "not-a-uuid" });
      expect(result.success).toBe(false);
    });

    it("should reject a missing id", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.uuidParamSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("paginationSchema", () => {
    it("should accept valid pagination params", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.paginationSchema.safeParse({
        limit: "20",
        cursor: "some-cursor-value",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.cursor).toBe("some-cursor-value");
      }
    });

    it("should apply defaults when no params provided", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.paginationSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.cursor).toBeUndefined();
      }
    });

    it("should reject limit below 1", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.paginationSchema.safeParse({ limit: "0" });
      expect(result.success).toBe(false);
    });

    it("should reject limit above 200", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.paginationSchema.safeParse({ limit: "201" });
      expect(result.success).toBe(false);
    });
  });

  describe("errorResponseSchema", () => {
    it("should validate a standard error response shape", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.errorResponseSchema.safeParse({
        error: {
          code: "SOME_ERROR",
          message: "Something went wrong",
          details: [],
        },
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing error fields", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.errorResponseSchema.safeParse({
        error: { code: "X" },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("slugParamSchema", () => {
    it("should accept a valid slug", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.slugParamSchema.safeParse({
        sourceSlug: "my-webhook-source",
      });
      expect(result.success).toBe(true);
    });

    it("should reject an empty slug", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.slugParamSchema.safeParse({ sourceSlug: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("dateRangeSchema", () => {
    it("should accept valid ISO date strings", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.dateRangeSchema.safeParse({
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-31T23:59:59Z",
      });
      expect(result.success).toBe(true);
    });

    it("should allow omitting both dates", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.dateRangeSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("should reject invalid date strings", async () => {
      schemas = await import("../../../../src/api/schemas/common.js");
      const result = schemas.dateRangeSchema.safeParse({
        from: "not-a-date",
      });
      expect(result.success).toBe(false);
    });
  });
});
