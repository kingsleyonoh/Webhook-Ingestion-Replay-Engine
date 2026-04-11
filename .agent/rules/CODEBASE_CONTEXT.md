# Webhook Ingestion Engine — Codebase Context

> Last updated: 2026-04-11
> Template synced: 2026-04-11

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.x (strict mode) |
| Runtime | Node.js 22 LTS |
| Framework | Fastify 5.x |
| Database | PostgreSQL 16 |
| ORM | Drizzle ORM |
| Job Queue | BullMQ 5.x (Redis-backed) |
| Cache | Redis 7 |
| Package Manager | npm |
| Test Runner | Vitest + Supertest |
| Build Tool | TypeScript compiler (tsc) |
| Containerization | Docker + Docker Compose |
| Hosting | Docker on Hetzner VPS behind Traefik |

## Project Structure

```
src/
├── server.ts              # Fastify app entry point
├── config.ts              # Env config loader
├── ingestion/             # Webhook receiving (handler, signature, idempotency)
├── delivery/              # Outbound delivery (worker, queue, http-client)
├── replay/                # Replay engine (engine, routes)
├── api/                   # REST API routes + middleware/
├── db/                    # Drizzle client, schema, migrations/
└── lib/                   # Shared utilities (errors, logger)
tests/
├── unit/                  # Unit tests mirroring src/
├── integration/           # API + delivery integration tests
└── fixtures/              # Sample webhook payloads (stripe/, github/, shopify/)
```

## Key Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| Ingestion | Receive webhooks, verify signatures, persist events | `src/ingestion/handler.ts`, `signature.ts`, `idempotency.ts` |
| Delivery | Async HTTP delivery with retries and dead-lettering | `src/delivery/worker.ts`, `queue.ts`, `http-client.ts` |
| Replay | Re-process historical events through delivery pipeline | `src/replay/engine.ts`, `routes.ts` |
| API | Tenant/source/event/dead-letter management REST API | `src/api/*.routes.ts` |
| Middleware | Auth (API key), rate limiting, error handling | `src/api/middleware/auth.ts`, `rate-limit.ts`, `error-handler.ts` |
| Database | Drizzle schema, client, migrations | `src/db/client.ts`, `schema.ts`, `migrations/` |
| Lib | Logger, error classes | `src/lib/logger.ts`, `errors.ts` |
| Config | Env variable loading and validation | `src/config.ts` |

## Database Schema

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| tenants | Root entity — API key auth | `id`, `name`, `api_key` (hashed), `is_active` |
| sources | Webhook source config | `tenant_id`, `slug`, `signature_header`, `signature_algo`, `signing_secret` |
| events | Persisted webhook payloads | `tenant_id`, `source_id`, `idempotency_key`, `headers`, `payload`, `status` |
| destinations | Delivery targets per source | `tenant_id`, `source_id`, `url`, `method`, `timeout_ms`, `max_retries` |
| deliveries | Delivery attempt records | `tenant_id`, `event_id`, `destination_id`, `attempt`, `status`, `status_code`, `duration_ms` |
| replay_requests | Batch replay tracking | `tenant_id`, `source_id`, `event_ids`, `status`, `total_events`, `processed`, `failed` |

## External Integrations

| Service | Purpose | Auth Method |
|---------|---------|------------|
| Event-Driven Notification Hub | Forward events for notifications (optional ecosystem destination) | API key (`NOTIFICATION_HUB_API_KEY`) |
| Workflow Automation Engine | Forward events for workflow triggers (optional ecosystem destination) | Shared secret (`WORKFLOW_ENGINE_SECRET`) |
| BetterStack | Uptime monitoring on `/api/health` | External polling |

## Ecosystem Connections

| Direction | Connected System | Method | Env Var |
|-----------|-----------------|--------|---------|
| this → | Event-Driven Notification Hub | REST `POST /api/notifications/send` | `NOTIFICATION_HUB_URL`, `NOTIFICATION_HUB_API_KEY` |
| this → | Workflow Automation Engine | REST `POST /webhooks/:path` | `WORKFLOW_ENGINE_URL`, `WORKFLOW_ENGINE_SECRET` |
| ← this | Any external service | Webhook `POST /webhooks/:sourceSlug` | Per-source `signing_secret` in DB |

## Environment Variables

| Variable | Purpose | Source |
|----------|---------|--------|
| `DATABASE_URL` | PostgreSQL connection string | `.env` |
| `REDIS_URL` | Redis connection string | `.env` |
| `PORT` | Server port (default: 3000) | `.env` |
| `HOST` | Server bind address (default: 0.0.0.0) | `.env` |
| `LOG_LEVEL` | Pino log level (default: info) | `.env` |
| `SELF_REGISTRATION_ENABLED` | Allow tenant self-registration (default: true) | `.env` |
| `DELIVERY_CONCURRENCY` | Max concurrent delivery workers (default: 10) | `.env` |
| `DELIVERY_DEFAULT_TIMEOUT_MS` | HTTP delivery timeout (default: 10000) | `.env` |
| `DELIVERY_MAX_RETRIES` | Max retries before dead-lettering (default: 5) | `.env` |
| `DELIVERY_BACKOFF_BASE_MS` | Exponential backoff base (default: 1000) | `.env` |
| `REPLAY_BATCH_SIZE` | Events per replay batch (default: 100) | `.env` |
| `EVENT_ARCHIVE_DAYS` | Days before archival (default: 90) | `.env` |
| `MAX_PAYLOAD_BYTES` | Max webhook payload size (default: 1MB) | `.env` |
| `NOTIFICATION_HUB_URL` | Notification Hub base URL (optional) | `.env` |
| `NOTIFICATION_HUB_API_KEY` | Notification Hub API key (optional) | `.env` |
| `WORKFLOW_ENGINE_URL` | Workflow Engine base URL (optional) | `.env` |
| `WORKFLOW_ENGINE_SECRET` | Workflow Engine shared secret (optional) | `.env` |

## Commands

| Action | Command |
|--------|---------|
| Dev server | `npm run dev` |
| Run all tests | `npm test` |
| Run unit tests | `npm run test:unit` |
| Run integration tests | `npm run test:integration` |
| Run E2E tests | `npm run test:e2e` |
| Lint/check | `npx tsc --noEmit` |
| Build | `npm run build` |
| Migrate DB | `npx drizzle-kit migrate` |
| Generate migration | `npx drizzle-kit generate` |
| Seed DB | `npm run seed` |

## Tenant Model

- **Auth strategy:** API key per tenant (`X-API-Key` header)
- **Tenant resolution:** Hash incoming API key → lookup `tenants.api_key` → attach `tenant_id` to request context
- **Isolation:** Every DB query includes `WHERE tenant_id = ?`
- **Registration:** `POST /api/tenants/register` (controlled by `SELF_REGISTRATION_ENABLED`)
- **Webhook tenant scoping:** Source's `tenant_id` determines event ownership — no API key needed from external senders

## Key Patterns & Conventions

- File naming: `kebab-case.ts`
- Import conventions: ES modules, barrel exports from module `index.ts`
- Error handling: Centralized error classes in `src/lib/errors.ts` → standard `{ error: { code, message, details } }` response format via `error-handler.ts`
- Dependency hierarchy: `lib/ → db/ → {ingestion, delivery, replay, api} → server.ts`
- Multi-tenancy: All queries tenant-scoped, `request.tenantId` decorator
- Delivery: Persist-before-process, at-least-once delivery via BullMQ
- Source config: Source-agnostic — adding a source is a DB insert, not a code change

### Request-Scoped Caching

- **Tenant context:** Auth middleware resolves `X-API-Key` → `tenantId` via Fastify decorator. Downstream handlers read from decorator — never re-query.
- **Source config:** Cached in Redis (TTL 60s). Cache miss fetches from DB. Source update API invalidates cache.
- **Pattern:** Middleware sets context → handlers consume it.

### Data Fetching Strategy

- **Prefer joins over N+1 queries:** Use Drizzle relational queries or explicit joins when loading related data (e.g., event + deliveries, source + destinations).
- **Independent queries in parallel:** When a handler needs data from unrelated tables, use `Promise.all` — never sequential awaits for independent operations.

## Gotchas & Lessons Learned

> Discovered during implementation. Added automatically by `/implement-next` Step 9.3.

| Date | Area | Gotcha | Discovered In |
|------|------|--------|---------------|
| 2026-04-01 | config | Docker PostgreSQL mapped to port 5450 (not 5432) to avoid conflict with native PostgreSQL service on Windows | Testing infrastructure setup |

## Shared Foundation (MUST READ before any implementation)

> These files define the project's shared patterns, configuration, and utilities.
> The AI MUST read these **in full** before writing ANY new code. Never recreate what exists here.

| Category | File(s) | What it establishes |
|----------|---------|-------------------|
| Error handling | `src/lib/errors.ts` | Centralized error types (SOURCE_NOT_FOUND, SIGNATURE_INVALID, etc.) |
| Logging | `src/lib/logger.ts` | Pino structured JSON logger with request ID |
| Config | `src/config.ts` | Env variable loading and validation |
| DB client | `src/db/client.ts` | Drizzle PostgreSQL client |
| DB schema | `src/db/schema.ts` | All Drizzle table definitions |
| Auth middleware | `src/api/middleware/auth.ts` | API key → tenant resolution |
| Error handler | `src/api/middleware/error-handler.ts` | Standard error response format |
| Rate limiter | `src/api/middleware/rate-limit.ts` | Per-endpoint rate limiting |
| Queue | `src/delivery/queue.ts` | BullMQ queue configuration |
| Test DB helper | `tests/helpers/db.ts` | PostgreSQL test connection with lifecycle management |
| Test Redis helper | `tests/helpers/redis.ts` | Redis test connection with lifecycle management |
| Test setup | `tests/helpers/setup.ts` | Global test setup — loads `.env` for all test runs |

## Deep References

> For detailed implementation patterns, read the source directly.

| Topic | Where to look |
|-------|--------------|
| Ingestion pipeline | `src/ingestion/` |
| Delivery & retries | `src/delivery/` |
| Replay engine | `src/replay/` |
| Source management | `src/api/sources.routes.ts` |
| Dead letter handling | `src/api/dead-letters.routes.ts` |
| Tenant management | `src/api/tenants.routes.ts` |
| Event inspection | `src/api/events.routes.ts` |
| Health & stats | `src/api/health.routes.ts` |
| Test patterns | `tests/` |
| Test fixtures | `tests/fixtures/{stripe,github,shopify}/` |
