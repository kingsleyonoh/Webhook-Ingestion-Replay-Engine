/**
 * Common Zod validation schemas for Fastify request/response validation.
 * Section 8b — shared patterns used across all API routes.
 */

import { z } from "zod";

/** UUID path parameter — validates a single :id param */
export const uuidParamSchema = z.object({
  id: z.string().uuid("Must be a valid UUID"),
});

/** Cursor-based pagination query parameters */
export const paginationSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1, "Limit must be at least 1")
    .max(200, "Limit must not exceed 200")
    .default(50),
  cursor: z.string().optional(),
});

/** Standard error response shape — Section 8b format */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.string()),
  }),
});

/** Slug path parameter for webhook source routes */
export const slugParamSchema = z.object({
  sourceSlug: z.string().min(1, "Source slug is required"),
});

/** Optional date range filter for event queries */
export const dateRangeSchema = z.object({
  from: z
    .string()
    .datetime({ message: "Must be a valid ISO 8601 datetime" })
    .optional(),
  to: z
    .string()
    .datetime({ message: "Must be a valid ISO 8601 datetime" })
    .optional(),
});

/** Type exports for use in route handlers */
export type UuidParam = z.infer<typeof uuidParamSchema>;
export type PaginationQuery = z.infer<typeof paginationSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type SlugParam = z.infer<typeof slugParamSchema>;
export type DateRange = z.infer<typeof dateRangeSchema>;
