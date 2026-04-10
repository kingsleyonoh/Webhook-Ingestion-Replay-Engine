CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid,
	"destination_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"status_code" integer,
	"response_body" text,
	"error_message" text,
	"duration_ms" integer,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_retry_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"url" text NOT NULL,
	"method" text DEFAULT 'POST' NOT NULL,
	"headers" jsonb DEFAULT '{}',
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"backoff_base_ms" integer DEFAULT 1000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"idempotency_key" text NOT NULL,
	"headers" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}',
	CONSTRAINT "events_tenant_source_idempotency_unique" UNIQUE("tenant_id","source_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "events_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"idempotency_key" text NOT NULL,
	"headers" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE "replay_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"event_ids" uuid[],
	"from_timestamp" timestamp with time zone,
	"to_timestamp" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_events" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"signature_header" text,
	"signature_algo" text,
	"signing_secret" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_tenant_id_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "sources_tenant_id_slug_unique" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_archive" ADD CONSTRAINT "events_archive_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_archive" ADD CONSTRAINT "events_archive_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_requests" ADD CONSTRAINT "replay_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_tenant_id_event_id_idx" ON "deliveries" USING btree ("tenant_id","event_id");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_id_destination_id_idx" ON "deliveries" USING btree ("tenant_id","destination_id");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_id_status_idx" ON "deliveries" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_id_next_retry_at_idx" ON "deliveries" USING btree ("tenant_id","next_retry_at");--> statement-breakpoint
CREATE INDEX "destinations_tenant_id_source_id_idx" ON "destinations" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE INDEX "events_tenant_id_source_id_idx" ON "events" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE INDEX "events_tenant_id_status_idx" ON "events" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "events_tenant_id_received_at_idx" ON "events" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "events_archive_tenant_id_received_at_idx" ON "events_archive" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "replay_requests_tenant_id_status_idx" ON "replay_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "sources_tenant_id_idx" ON "sources" USING btree ("tenant_id");