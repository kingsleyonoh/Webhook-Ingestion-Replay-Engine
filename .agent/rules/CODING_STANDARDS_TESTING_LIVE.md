# Webhook Ingestion Engine — Coding Standards: Live & E2E Testing

> Part 3 of 4. Also loaded: `CODING_STANDARDS.md`, `CODING_STANDARDS_TESTING.md` (core TDD), `CODING_STANDARDS_DOMAIN.md`
> This file covers mock policy, integration testing, and E2E testing.

## Live Integration Testing (Mock Policy)

### The Rule: Don't Mock What You Own
If you control the service and can run it locally → test against the real thing.

### Service Fallback Hierarchy
When deciding how to test a service, follow this order:
1. **Local instance** (best) — Docker, CLI, emulator on your machine
2. **Cloud dev instance** (good) — dedicated test project / staging environment
3. **Mock** (last resort) — only when options 1 and 2 are impossible

### Test LIVE (Never Mock)
- Your database (local PostgreSQL on port 5450, local Redis on port 6379) — validates schema, column names, constraints, query behavior
- Your own API endpoints — call the actual route, not a stub
- Your own server actions / business logic — test the real function
- File storage you control (local filesystem, local object storage)

### Mock ONLY These
- Third-party payment APIs (Stripe charges money)
- Email/SMS delivery (SendGrid/Twilio sends messages)
- Rate-limited external APIs you don't control
- Services with irreversible side effects
- Cloud-only services with no local emulator AND no dev tier

### No Services? No Problem
If the project has no external services (CLI tool, library, static site), this policy doesn't apply — just write standard unit tests.

### Why This Matters
A mock that returns `{ user_id: 1 }` will pass even when the real column is `userId`. A mock that returns success will pass even when the real constraint rejects your data. Mocks test your ASSUMPTIONS about the service. Live tests test REALITY.

### Common Mock Violations (DO NOT DO THESE)
- ❌ Mocking your database client to return fake rows — hit the real database
- ❌ Mocking your own API routes with `nock`/`msw` — call the real endpoint via test client
- ❌ Using an in-memory SQLite when production uses PostgreSQL — use the real PostgreSQL
- ❌ Mocking Redis/cache when it's running in Docker — connect to the real instance
- ✅ Mocking Stripe's charge API — you don't want to charge real money in tests
- ✅ Mocking SendGrid — you don't want to send real emails in tests
- ✅ Mocking an external API with rate limits — you don't control their uptime

### Test Cleanup
- Each test MUST clean up after itself (delete rows, reset state)
- Use transactions with rollback when possible for speed

## Backend API & Integration Testing

### When to Write API Integration Tests
- Every **API endpoint**: test request → response cycle with real HTTP semantics
- Every **BullMQ worker/handler**: test job processing with real Redis + PostgreSQL
- Every **background job**: test job execution with actual service dependencies
- Every **middleware**: test request interception, auth guards, validation layers

### What to Test
| Priority | Test This | Example |
|----------|-----------|---------|
| 1 | Request/response cycle | POST /api/sources → 201, returns created source |
| 2 | Input validation | Missing required field → 400 with specific error |
| 3 | Auth & authorization | No API key → 401; inactive tenant → 403 |
| 4 | Error handling | Invalid ID → 404; duplicate slug → 409 |
| 5 | Edge cases | Empty body, oversized payload, duplicate idempotency key |
| 6 | Tenant isolation | Tenant A cannot see Tenant B's sources/events/deliveries |

### API Testing Patterns
- Use Fastify `inject()` for API integration tests — no network needed
- Test full request lifecycle — serialization, middleware, handler, response
- Assert on status codes, response body structure, AND headers where relevant
- Test pagination, filtering, and cursor-based pagination with real DB rows

### BullMQ Worker Testing
- Enqueue test jobs to a real local Redis instance
- Assert the worker processes them correctly (DB writes, HTTP delivery attempts)
- Test error handling: malformed jobs, destination timeouts, retry exhaustion
- Mock only external destination URLs (use `nock` or `msw` for outbound HTTP)

### File Naming & Location
- Name: `module-name.test.ts` — in `tests/unit/` or `tests/integration/` mirror
- Group shared test helpers in `tests/helpers/`
- Webhook payload fixtures in `tests/fixtures/{stripe,github,shopify}/`

## E2E Testing (Real Endpoints)

> E2E tests hit a RUNNING server over HTTP — not in-process test clients like `inject()` or `supertest`.
> The point is testing the deployed stack: server startup, middleware chain, database, cache, and response serialization.
> These catch issues that unit/integration tests miss: port binding, CORS headers, middleware ordering, connection pool behavior under load.

### When E2E is Required
- **Any batch that creates or modifies an API endpoint** → E2E MUST hit the running server
- **Any batch that creates or modifies a webhook handler** → E2E MUST send a real HTTP request
- **Pure utility/library/config batches with no endpoints** → E2E not required (skip with note)
- **`[SETUP]` items** → E2E not required unless the setup itself starts a server

### E2E Test Architecture

**Backend E2E (this project):**
1. Start the actual server: `npm run dev` (NOT a test-mode in-process server)
2. Wait for ready signal (`/api/health` returns 200)
3. Hit real endpoints via HTTP (fetch or undici)
4. Assert on status codes, response bodies, headers
5. Stop the server after tests complete

**Requires local services running** (Docker PostgreSQL on 5450, Redis on 6379) — this aligns with the existing mock policy ("Don't Mock What You Own").

### E2E Test File Structure
```
tests/e2e/
  api/                        ← Backend E2E tests
    webhooks.e2e.test.ts      ← Webhook ingestion endpoint tests
    sources.e2e.test.ts       ← Source management endpoint tests
    health.e2e.test.ts        ← Health endpoint tests
  helpers/
    server.ts                 ← Start/stop server utilities
    seed.ts                   ← Test data seeding
```

### E2E vs Integration Tests
| Aspect | Integration (Fastify inject) | E2E (running server) |
|--------|-------------------------------|---------------------|
| Server | In-process, no real HTTP | Real HTTP, real port |
| Speed | Fast (~1ms per test) | Slower (~100ms+ per test) |
| What it catches | Handler logic, validation, DB | Middleware ordering, CORS, startup, ports |
| When to use | Every endpoint (RED/GREEN phase) | After REGRESSION passes (Step 7d) |
| Run command | `npm test` | `npm run test:e2e` |

**Both are required.** Integration tests are your fast feedback loop (TDD). E2E tests are your deployment confidence check.

### E2E Test Cleanup
- Each E2E test must clean up its own data (delete created records, reset state)
- Use a dedicated test database or schema to avoid polluting dev data
- Kill the server process reliably in the `afterAll` hook — leaked processes block ports

### Bootstrap Setup for E2E
A `[SETUP]` item should configure the E2E framework:
- Create `tests/e2e/` directory structure
- Install E2E dependencies (`undici` or built-in `fetch` for HTTP requests)
- Add `test:e2e` script to `package.json`
- Verify the E2E command runs and exits cleanly (even with 0 tests)
