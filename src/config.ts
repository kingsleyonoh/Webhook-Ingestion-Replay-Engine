/**
 * Environment configuration loader with Zod validation.
 * All environment variables from Section 14 of the PRD.
 *
 * Usage:
 *   import { loadConfig } from './config.js';
 *   const config = loadConfig();
 */

import { z } from "zod";

/** Transform empty strings to undefined for optional fields */
const optionalString = z
  .string()
  .optional()
  .transform((val) => (val === "" ? undefined : val));

const configSchema = z.object({
  // Required
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Logging
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  // Tenant management
  SELF_REGISTRATION_ENABLED: z
    .string()
    .default("true")
    .transform((val) => val === "true"),

  // Delivery
  DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  DELIVERY_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DELIVERY_MAX_RETRIES: z.coerce.number().int().min(0).default(5),
  DELIVERY_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),

  // Replay
  REPLAY_BATCH_SIZE: z.coerce.number().int().positive().default(100),

  // Archival
  EVENT_ARCHIVE_DAYS: z.coerce.number().int().positive().default(90),

  // Payload limits
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(1048576),

  // Signature timestamp tolerance (ms). Default 300000 (5 min). Set 0 to disable.
  SIGNATURE_TOLERANCE_MS: z.coerce.number().int().min(0).default(300000),

  // Encryption (required if any source uses signing secrets)
  SIGNING_SECRET_KEY: optionalString,

  // Ecosystem (optional)
  NOTIFICATION_HUB_URL: optionalString,
  NOTIFICATION_HUB_API_KEY: optionalString,
  WORKFLOW_ENGINE_URL: optionalString,
  WORKFLOW_ENGINE_SECRET: optionalString,
});

export type AppConfig = {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  host: string;
  logLevel: string;
  selfRegistrationEnabled: boolean;
  deliveryConcurrency: number;
  deliveryDefaultTimeoutMs: number;
  deliveryMaxRetries: number;
  deliveryBackoffBaseMs: number;
  replayBatchSize: number;
  eventArchiveDays: number;
  maxPayloadBytes: number;
  signatureToleranceMs: number;
  signingSecretKey: string | undefined;
  notificationHubUrl: string | undefined;
  notificationHubApiKey: string | undefined;
  workflowEngineUrl: string | undefined;
  workflowEngineSecret: string | undefined;
};

/**
 * Load and validate configuration from process.env.
 * Throws ZodError if required variables are missing or invalid.
 */
export function loadConfig(): AppConfig {
  const parsed = configSchema.parse(process.env);

  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    selfRegistrationEnabled: parsed.SELF_REGISTRATION_ENABLED,
    deliveryConcurrency: parsed.DELIVERY_CONCURRENCY,
    deliveryDefaultTimeoutMs: parsed.DELIVERY_DEFAULT_TIMEOUT_MS,
    deliveryMaxRetries: parsed.DELIVERY_MAX_RETRIES,
    deliveryBackoffBaseMs: parsed.DELIVERY_BACKOFF_BASE_MS,
    replayBatchSize: parsed.REPLAY_BATCH_SIZE,
    eventArchiveDays: parsed.EVENT_ARCHIVE_DAYS,
    maxPayloadBytes: parsed.MAX_PAYLOAD_BYTES,
    signatureToleranceMs: parsed.SIGNATURE_TOLERANCE_MS,
    signingSecretKey: parsed.SIGNING_SECRET_KEY,
    notificationHubUrl: parsed.NOTIFICATION_HUB_URL,
    notificationHubApiKey: parsed.NOTIFICATION_HUB_API_KEY,
    workflowEngineUrl: parsed.WORKFLOW_ENGINE_URL,
    workflowEngineSecret: parsed.WORKFLOW_ENGINE_SECRET,
  };
}
