/**
 * Drizzle ORM schema definitions for all database tables.
 * Sections 4.0–4.5 + Section 7 (events_archive).
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  index,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Tenants table — root entity for multi-tenant isolation.
 * API key auth: hash incoming key, lookup tenants.api_key, attach tenant_id.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Sources table — webhook source configuration per tenant.
 * Section 4.1: signature config, tenant-scoped unique name/slug.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    signatureHeader: text("signature_header"),
    signatureAlgo: text("signature_algo"),
    signingSecret: text("signing_secret"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("sources_tenant_id_name_unique").on(t.tenantId, t.name),
    unique("sources_tenant_id_slug_unique").on(t.tenantId, t.slug),
    index("sources_tenant_id_idx").on(t.tenantId),
  ]
);

/**
 * Events table — persisted webhook payloads.
 * Section 4.2: idempotency, status tracking, composite indexes.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sourceId: uuid("source_id").references(() => sources.id),
    idempotencyKey: text("idempotency_key").notNull(),
    headers: jsonb("headers").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: text("status").notNull().default("pending"),
    metadata: jsonb("metadata").default("{}"),
  },
  (t) => [
    unique("events_tenant_source_idempotency_unique").on(
      t.tenantId,
      t.sourceId,
      t.idempotencyKey
    ),
    index("events_tenant_id_source_id_idx").on(t.tenantId, t.sourceId),
    index("events_tenant_id_status_idx").on(t.tenantId, t.status),
    index("events_tenant_id_received_at_idx").on(
      t.tenantId,
      t.receivedAt
    ),
  ]
);

/**
 * Destinations table — delivery targets per source.
 * Section 4.3: fan-out config, delivery settings.
 */
export const destinations = pgTable(
  "destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sourceId: uuid("source_id").references(() => sources.id),
    url: text("url").notNull(),
    method: text("method").notNull().default("POST"),
    headers: jsonb("headers").default("{}"),
    timeoutMs: integer("timeout_ms").notNull().default(10000),
    maxRetries: integer("max_retries").notNull().default(5),
    backoffBaseMs: integer("backoff_base_ms").notNull().default(1000),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("destinations_tenant_id_source_id_idx").on(
      t.tenantId,
      t.sourceId
    ),
  ]
);

/**
 * Deliveries table — delivery attempt records.
 * Section 4.4: attempt tracking, retry scheduling.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    eventId: uuid("event_id").references(() => events.id),
    destinationId: uuid("destination_id").references(
      () => destinations.id
    ),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").notNull(),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  },
  (t) => [
    index("deliveries_tenant_id_event_id_idx").on(
      t.tenantId,
      t.eventId
    ),
    index("deliveries_tenant_id_destination_id_idx").on(
      t.tenantId,
      t.destinationId
    ),
    index("deliveries_tenant_id_status_idx").on(t.tenantId, t.status),
    index("deliveries_tenant_id_next_retry_at_idx").on(
      t.tenantId,
      t.nextRetryAt
    ),
  ]
);

/**
 * Replay requests table — batch replay tracking.
 * Section 4.5: filter fields, progress counters.
 */
export const replayRequests = pgTable(
  "replay_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sourceId: uuid("source_id"),
    eventIds: uuid("event_ids").array(),
    fromTimestamp: timestamp("from_timestamp", { withTimezone: true }),
    toTimestamp: timestamp("to_timestamp", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    totalEvents: integer("total_events").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("replay_requests_tenant_id_status_idx").on(
      t.tenantId,
      t.status
    ),
  ]
);

/**
 * Events archive table — same schema as events.
 * Section 7: used by event archiver job for old event storage.
 */
export const eventsArchive = pgTable(
  "events_archive",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sourceId: uuid("source_id").references(() => sources.id),
    idempotencyKey: text("idempotency_key").notNull(),
    headers: jsonb("headers").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: text("status").notNull().default("pending"),
    metadata: jsonb("metadata").default("{}"),
  },
  (t) => [
    index("events_archive_tenant_id_received_at_idx").on(
      t.tenantId,
      t.receivedAt
    ),
  ]
);
