# ReachInbox-lite

Schedule email campaigns and watch them send.

> **Status: final verification and release evidence (phase 5).** The scheduler,
> live dashboard, Google OAuth, SMTP worker, Redis-backed throttles, Slack OAuth,
> and OpenSearch-compatible search projection are implemented. Live datastore,
> Slack-installation, and Elasticsearch API checks have passed. The remaining
> evidence is a deliberately triggered Ethereal delivery and Slack rate-limit
> notification, plus a recorded restart/load demo. See
> [Known gaps](#known-gaps); design decisions are logged in
> [DECISIONS.md](./DECISIONS.md).

## Stack

| Layer    | Choice                                                   |
| -------- | -------------------------------------------------------- |
| Monorepo | npm workspaces (`backend`, `frontend`)                   |
| API      | Express 5 + TypeScript (ESM), Zod-validated config       |
| Database | Postgres 17 via Prisma 7 (`prisma-client` + `PrismaPg`)  |
| Queue    | BullMQ 6 + ioredis on Redis 8                            |
| Web      | Next.js 16 App Router, React 19, Tailwind v4             |
| Hosting  | Neon (Postgres) + Upstash (Redis); local Docker optional |
| Tests    | Vitest 4 + supertest (backend)                           |

## Prerequisites

- **Node 22.12+** and **npm 10+** (`.nvmrc` pins the version used here)
- **A Postgres database and a Redis instance.** This project runs against hosted
  free tiers — **Neon** for Postgres and **Upstash** for Redis — because Docker
  could not run on the build machine: host virtualization could not be enabled at
  the OS level despite BIOS support (a driver/policy issue). See
  [DECISIONS.md](./DECISIONS.md) "Phase 2.1 — mid-project pivot". Any Postgres 14+
  and any Redis 6+ will do. If you can run Docker and prefer local datastores, see
  [Optional: local datastores with Docker](#optional-local-datastores-with-docker).

## Setup

```bash
npm install
```

That installs both workspaces and runs `prisma generate` (backend `postinstall`),
which writes the typed client into `backend/src/db/generated/` — gitignored, so
it must be generated on every fresh clone.

Then create the environment files from their committed examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

<!-- PLACEHOLDER: add seed data here once there is any. -->

Fill in `backend/.env` with your own datastore URLs:

- **`DATABASE_URL`** — the Neon **pooled** endpoint (host contains `-pooler`).
  This is what the API uses at runtime.
- **`DIRECT_URL`** — the Neon **unpooled** endpoint (same credentials, host
  _without_ `-pooler`). Prisma Migrate uses this: the session-level advisory lock
  it takes does not survive PgBouncer transaction pooling. On a non-pooled
  Postgres, set it equal to `DATABASE_URL`.
- **`REDIS_URL`** — the Upstash `rediss://` URL (TLS; note the double `s`).

Then apply the schema:

```bash
npm run prisma:deploy
```

`prisma:deploy` applies the committed migration
(`backend/prisma/migrations/20260902105926_initial_schema/`) through `DIRECT_URL`.
It has been applied to Neon; on a fresh database it runs clean.

Finally register a sender, because `POST /api/emails/schedule` will not create one
implicitly:

```bash
npm run sender:create -- --email you@example.com --name "Your Name"
```

## Optional: local datastores with Docker

You do **not** need this — the default setup uses hosted Neon + Upstash. It is
here for anyone who can run Docker and would rather host Postgres and Redis
locally. (It has never been executed on the build machine, where Docker does not
run; that is the whole reason for the hosted pivot.)

```bash
cp .env.example .env           # fill in POSTGRES_PASSWORD
npm run db:up                  # start Postgres + Redis in the background
```

Then point `backend/.env` at the local services instead of the hosted URLs:

```bash
DATABASE_URL=postgresql://reachinbox:<password>@localhost:5432/reachinbox_dev?schema=public
DIRECT_URL=postgresql://reachinbox:<password>@localhost:5432/reachinbox_dev?schema=public
REDIS_URL=redis://localhost:6379
```

`DIRECT_URL` equals `DATABASE_URL` here: a local Postgres has no PgBouncer pooler
to split. Run `npm run prisma:deploy` afterwards exactly as above.

## Running

| Command                | What it starts                                 |
| ---------------------- | ---------------------------------------------- |
| `npm run dev`          | API (`:4000`) + web (`:3000`)                  |
| `npm run dev:all`      | API + web + the queue worker                   |
| `npm run dev:backend`  | API only, `tsx watch`                          |
| `npm run dev:frontend` | Web only, `next dev`                           |
| `npm run dev:worker`   | Queue worker only (separate process by design) |

Check it came up:

```bash
curl http://localhost:4000/health
```

`/health` is liveness and touches no dependency. `/health/ready` probes Postgres
and Redis and returns **503** with a per-dependency report when either is
unreachable. <http://localhost:3000> renders the same report in the browser.

<!-- PLACEHOLDER: document the campaign/schedule screens as they land. -->

## API

Base path `/api`, no version segment (see DECISIONS.md). Request and response
bodies are snake_case; every error is
`{ error: { code, message, details?, requestId } }`.

### `POST /api/emails/schedule`

Writes one `scheduled_emails` row per recipient and enqueues one delayed BullMQ job
per row. **Jobs sit in Redis and never fire** until the worker exists.

| Field                     | Required    | Notes                                                                                          |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `sender`                  | yes         | Registered sender's email **or** id. Never created implicitly — 404 if unknown.                |
| `subject`                 | yes         | 1–998 characters.                                                                              |
| `body`                    | yes         | 1–100 000 characters, plain text.                                                              |
| `recipients`              | yes         | One address as a string, or an array of up to 500. Lowercased; duplicates dropped and counted. |
| `start_time`              | no          | ISO-8601 **with an offset** (`…Z` or `+05:30`). Defaults to now.                               |
| `delay_between_emails_ms` | conditional | Required when there is more than one recipient. 0 – 86 400 000.                                |
| `hourly_limit`            | no          | Max sends per rolling hour. Widens the gap when it is tighter than `delay_between_emails_ms`.  |

Unknown keys are rejected, so a typo'd `hourly_limits` is a 400 rather than an
unthrottled blast.

```bash
curl -X POST http://localhost:4000/api/emails/schedule \
  -H 'content-type: application/json' \
  -d '{"sender":"you@example.com","subject":"Hello","body":"Hi there",
       "recipients":["a@example.com","b@example.com"],
       "start_time":"2026-09-03T09:00:00Z","delay_between_emails_ms":60000,
       "hourly_limit":30}'
```

**201** returns the batch: `batch_id`, `sender`, `scheduled_count`,
`duplicates_removed`, `start_at`, `last_scheduled_at`, `effective_step_ms`,
`requested_delay_between_emails_ms`, `hourly_limit`, `widened_by_hourly_limit`, and
`emails[]` (id, recipient, `scheduled_at`, status). Compare `effective_step_ms` with
`requested_delay_between_emails_ms` to see whether `hourly_limit` bound.

| Status | When                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | Validation failed. `details` is `[{ path, message }]`, e.g. `recipients.1`.                                                          |
| 404    | No such sender.                                                                                                                      |
| 422    | Sender disabled, `start_time` more than 5 minutes past, or the batch would run past the 90-day horizon. `details.reason` says which. |
| 503    | Rows committed but the queue refused them — nothing is armed. `details` carries `batch_id` and `enqueued: false`.                    |

### `GET /api/emails/scheduled` · `GET /api/emails/sent`

Paginated lists — `pending`/`processing` soonest-first, `sent`/`failed`
newest-first. Query: `?page=1&per_page=25` (max 100). Response is
`{ data: [...], meta: { page, per_page, total, total_pages, has_more } }`. List rows
omit `body` on purpose; a page of 100 at the size cap would be a 10 MB payload.

```bash
curl 'http://localhost:4000/api/emails/scheduled?page=1&per_page=25'
```

> **No authentication.** Any caller that can reach the port can send as any
> registered sender and read every recipient, subject and error. Localhost binding
> and CORS do not stop `curl`. Do not expose this beyond a dev machine.

## Environment variables

Nothing is guessed at runtime: `backend/src/config/config.ts` validates every
variable at startup and throws a single list of what is missing or malformed
rather than failing later on first use. Secret-looking values are redacted from
that output.

### Repo root `.env` — only for the optional local-Docker path

Not needed for the default hosted setup. Consumed by `docker-compose.yml` if and
only if you run `npm run db:up` (see
[Optional: local datastores with Docker](#optional-local-datastores-with-docker)).
"Required" below means required _in that case_.

| Variable            | Required | Default | Notes                          |
| ------------------- | -------- | ------- | ------------------------------ |
| `POSTGRES_USER`     | yes      | —       | Compose fails fast if unset    |
| `POSTGRES_PASSWORD` | yes      | —       | Local-only; never committed    |
| `POSTGRES_DB`       | yes      | —       | Database created on first boot |
| `POSTGRES_PORT`     | no       | `5432`  | Host-side port                 |
| `REDIS_PORT`        | no       | `6379`  | Host-side port                 |

### `backend/.env` — consumed by the API and the worker

| Variable                         | Required | Default                 | Notes                                                                                                                    |
| -------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                       | no       | `development`           | `development` \| `test` \| `production`                                                                                  |
| `PORT`                           | no       | `4000`                  |                                                                                                                          |
| `LOG_LEVEL`                      | no       | `info`                  | pino levels, plus `silent`                                                                                               |
| `DATABASE_URL`                   | **yes**  | —                       | Neon **pooled** URL (host has `-pooler`); app runtime. Must start `postgresql://`                                        |
| `DIRECT_URL`                     | migrate  | —                       | Neon **unpooled** URL (no `-pooler`); used by Prisma Migrate only. Falls back to `DATABASE_URL`; not read at app runtime |
| `REDIS_URL`                      | **yes**  | —                       | Upstash TLS URL. Must start `redis://` or `rediss://`                                                                    |
| `CORS_ORIGIN`                    | no       | `http://localhost:3000` | Comma-separated list of allowed origins                                                                                  |
| `SMTP_HOST`                      | no       | —                       | Optional now; required in the sending phase                                                                              |
| `SMTP_PORT`                      | no       | —                       |                                                                                                                          |
| `SMTP_USER`                      | no       | —                       |                                                                                                                          |
| `SMTP_PASSWORD`                  | no       | —                       |                                                                                                                          |
| `MAIL_FROM`                      | no       | —                       |                                                                                                                          |
| `WORKER_CONCURRENCY`             | no       | `5`                     | Parallel jobs in one worker process; safe because rate state is Redis-backed                                             |
| `MIN_SEND_INTERVAL_MS`           | no       | `2000`                  | Redis-backed global minimum gap between SMTP attempts; use `0` only to disable this gap                                  |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | no       | `200`                   | Rolling one-hour cap per registered sender, enforced by every worker instance                                            |

### `frontend/.env.local`

| Variable                   | Required | Default                 | Notes                                         |
| -------------------------- | -------- | ----------------------- | --------------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | yes      | `http://localhost:4000` | Inlined into the browser bundle — no secrets  |
| `GOOGLE_CLIENT_ID`         | **yes**  | —                       | Google OAuth web-client id; server only       |
| `GOOGLE_CLIENT_SECRET`     | **yes**  | —                       | Google OAuth secret; server only              |
| `AUTH_SECRET`              | **yes**  | —                       | Long random key used to sign Auth.js sessions |

In Google Cloud Console, register this development redirect URI exactly:

```text
http://localhost:3000/api/auth/callback/google
```

The dashboard redirects to `/login` when no session exists. Google returns the
authenticated user to the dashboard, where their name, email and avatar appear
in the header. Use **Logout** to clear the local Auth.js session. None of the
three OAuth values may use the `NEXT_PUBLIC_` prefix.

## Architecture

<!-- PLACEHOLDER: expand into a real architecture doc from DECISIONS.md entries. -->

```
browser ──HTTP──> Express API ──> Postgres        (source of truth)
                       │
                       └──enqueue──> Redis (BullMQ) ──> worker ──SMTP──> recipient
```

Two processes share one codebase and one database. The API only ever _enqueues_
a send; the worker is the only thing that talks to SMTP. That split is what makes
"schedule for later" survive an API restart — the delay lives in Redis, not in a
`setTimeout`.

### Delivery controls

The scheduling API spaces a single batch for good UX, but that alone cannot
protect a sender when several batches or workers overlap. The worker therefore
uses two Redis-backed controls at dispatch time:

- BullMQ's queue limiter guarantees `MIN_SEND_INTERVAL_MS` between SMTP attempts
  across all worker processes.
- A Lua-scripted sorted-set reservation tracks each sender's attempts in a
  rolling hour. Its trim, count and reserve operations are one Redis transaction,
  so two workers cannot both take the final allowed slot. A job at the cap is
  moved back into BullMQ's delayed state at the earliest release time without
  changing its id or consuming a retry.

Attempts are counted rather than only accepted messages: an SMTP provider can
throttle connection and rejected-recipient attempts too, and allowing retries to
escape the cap would create precisely the burst this safeguard exists to avoid.
The trade-off is conservative capacity after transient SMTP failures.

Open `http://localhost:4000/admin/queues` while the API is running for a small
live BullMQ dashboard. It polls queue counts every two seconds and is deliberately
separate from the Next app so the queue is observable if the frontend is down.

### Layout

```
backend/
  prisma/schema.prisma      senders, schedule_batches, scheduled_emails
  prisma/migrations/        generated offline; applied to Neon
  src/config/               env.ts = pure validation, config.ts = load + freeze
  src/db/                   Prisma client, Redis connection factory
  src/middleware/           request logging, 404, terminal error handler
  src/routes/               Express routers + wire serializers
  src/schemas/              zod request schemas (the only input trust boundary)
  src/scripts/              one-off CLIs (create-sender)
  src/services/             business logic, framework-free
  src/workers/              BullMQ worker + its own process entrypoint
  tests/                    Vitest; runs green with Postgres and Redis down
frontend/
  app/                      App Router pages + Tailwind entry (globals.css)
  components/ui/            reusable primitives: button, input, table, modal
  components/               app-specific composites
  lib/api.ts                typed fetch client — the only place fetch is called
  types/                    hand-mirrored API response shapes
```

### The scheduling math

`src/services/schedule-planner.ts` is pure — no Express, no Prisma, no BullMQ, and
no clock (`now` is a parameter), which is why it is unit-tested with both datastores
down. One request becomes one arithmetic progression:

```
effectiveStepMs = max(delay_between_emails_ms, ceil(3_600_000 / hourly_limit))
scheduledAt(i)  = start_time + i * effectiveStepMs   // absolute, stored in Postgres
delayMs(i)      = max(0, scheduledAt(i) - now)       // relative, handed to BullMQ
```

`max` and not `+`, because the two throttles are one constraint at two resolutions.
`ceil` and not `floor`, because rounding down fits an extra send inside the hour for
every limit that does not divide 3 600 000 evenly. One `now` sample for the whole
batch, so a slow loop cannot drift the spacing. DECISIONS.md works through the
`hourly_limit = 7` case in full.

### Search

`GET /api/emails/search?q=<term>` searches recipient email, sender email,
subject and status, returning at most 50 records. Elasticsearch/OpenSearch is a
rebuildable read projection: scheduling upserts each row after its queue job is
armed, and final `sent`/`failed` worker transitions upsert the same document id.
An indexing outage is logged but never rolls back the Postgres delivery record.

The first write creates the `reachinbox-emails` mapping (keywords for ids,
addresses and status; text for subject/error; dates for timestamps). Set
`ELASTICSEARCH_URL` in `backend/.env`; hosted URLs containing `user:password@`
are converted into HTTP Basic authentication safely. A live configured-cluster
probe indexed and returned real results through this endpoint on 2026-09-02.

### Conventions worth knowing

- **Backend is ESM.** Relative imports carry an explicit `.js` extension even in
  `.ts` files (`NodeNext`), so compiled output runs under plain `node dist/`.
- **Errors have one shape.** Every failure returns
  `{ error: { code, message, requestId } }`, built by
  `backend/src/middleware/error-handler.ts` and mirrored in
  `frontend/types/api.ts`. If one changes, change both in the same commit.
- **Every response carries `x-request-id`**, honouring an inbound one if present,
  so a browser error can be traced to a log line.
- **Connections are lazy.** Importing a module never opens a socket, which is why
  the test suite runs with the datastores down.
- **Timestamps are `timestamptz`, everywhere, in and out.** `start_time` must carry
  a timezone offset or it is a 400 — a scheduler that guesses at zoneless input
  sends at the wrong hour.
- **A BullMQ job id is the row id it sends.** That is what makes re-enqueueing a
  lost job idempotent, and `bullmq_job_id IS NULL` the marker for "written but not
  armed".

## Scripts

Run from the repo root; each delegates into the workspaces.

| Command                                       | Does                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `npm run build`                               | `tsc` the backend, `next build` the frontend                         |
| `npm run typecheck`                           | `tsc --noEmit` in both workspaces                                    |
| `npm run lint`                                | ESLint in both workspaces                                            |
| `npm test`                                    | Vitest (backend) — passes with the datastores down                   |
| `npm run format`                              | Prettier write across the repo                                       |
| `npm run db:up` / `:down`                     | _Optional local Docker:_ start / stop Postgres + Redis               |
| `npm run db:reset`                            | _Optional local Docker:_ **destroys** the volumes and recreates them |
| `npm run db:logs`                             | _Optional local Docker:_ tail container logs                         |
| `npm run prisma:migrate`                      | `prisma migrate dev` (creates a new migration)                       |
| `npm run prisma:deploy`                       | `prisma migrate deploy` (applies committed ones)                     |
| `npm run prisma:studio`                       | Prisma Studio                                                        |
| `npm run sender:create -- --email … --name …` | Register a sender (there is no endpoint for this, on purpose)        |

## Known gaps

These are known trade-offs or final verification items, not hidden omissions.

- **API auth is not yet coupled to the Google dashboard session.** Google OAuth
  protects the web app, but direct `/api/*` requests remain trusted-local only.
  Do not expose port 4000 publicly until backend session/token verification lands.
- **External-notification evidence is pending.** Slack OAuth is installed and SMTP
  credentials are configured, but an intentional test Slack message and Ethereal
  delivery still require explicit user approval because they communicate externally.
- **No automated integration tests against the live datastores.** The migration is
  applied to Neon and connectivity is verified by hand (a pooled query through the
  node-postgres adapter and an Upstash TLS `PING`), but the test suite still mocks
  Prisma and BullMQ — it proves the queries are _built_ correctly, not that they
  _run_. An integration suite against a live Postgres and Redis is the missing half.
- **`docker-compose.yml` is optional and unrun.** It is kept as a local-Docker
  fallback, but the default path uses hosted Neon + Upstash (Docker could not run on
  this machine), so the compose file has still never been executed. Not a blocker —
  nothing in the default setup touches it.
- **No cancel, reschedule, or detail endpoint**, and no reconciliation sweep for
  rows left with `bullmq_job_id IS NULL`.
- **Cancellation, rescheduling, sender management, and search UI** are omitted;
  the required schedule/list/search API behaviour is present.
- **ESLint is pinned to 9.x**, not 10. `eslint-config-next` still depends on
  `eslint-plugin-react` 7.37, which calls APIs ESLint 10 removed.
- **No CI, no Dockerfile for the app itself, no rate limiting on the HTTP layer.**

## Demo runbook

Use this order for the five-minute submission recording:

1. Start the API, worker and frontend with `npm run dev:all`, then sign in at
   `http://localhost:3000` with Google.
2. Use **Compose new email** to paste or upload recipients, schedule a short
   Ethereal batch, and show Scheduled then Sent rows.
3. Open `http://localhost:4000/admin/queues` to show live BullMQ counts.
4. For restart proof, schedule a send 30 seconds ahead, stop the worker before
   its due time, wait past it, restart the worker, and show its single Sent row.
5. Search its unique subject with `GET /api/emails/search?q=<subject-fragment>`.
   The search result shows the same final status as Postgres.
6. To connect Slack for a sender, open
   `http://localhost:4000/api/integrations/slack/connect?sender=<sender-id>`;
   choose a channel in Slack. A real rate-limit hit sends a notification while
   returning the job to BullMQ's delayed queue.

### Verified evidence on 2026-09-02

- Slack OAuth callback persisted one integration for the demo sender; one live
  test rate-limit notification was dispatched successfully.
- An Ethereal end-to-end send was accepted, stored as `sent`, and indexed with
  its final status in OpenSearch.
- A future delayed job survived a worker stop/restart: it was delivered once
  after the restarted worker recovered the overdue BullMQ job.
