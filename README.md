# ReachInbox-lite

Schedule email campaigns and watch them send.

> **Status: scaffolding (phase 1).** Structure, config, tooling and health checks
> are real and verified. There is no data model, no auth and no email delivery
> yet — see [Known gaps](#known-gaps). Design decisions are logged in
> [DECISIONS.md](./DECISIONS.md).

## Stack

| Layer      | Choice                                                     |
| ---------- | ---------------------------------------------------------- |
| Monorepo   | npm workspaces (`backend`, `frontend`)                     |
| API        | Express 5 + TypeScript (ESM), Zod-validated config          |
| Database   | Postgres 17 via Prisma 7 (`prisma-client` + `PrismaPg`)     |
| Queue      | BullMQ 6 + ioredis on Redis 8                              |
| Web        | Next.js 16 App Router, React 19, Tailwind v4               |
| Local infra | Docker Compose (Postgres + Redis only)                    |
| Tests      | Vitest 4 + supertest (backend)                             |

## Prerequisites

- **Node 22.12+** and **npm 10+** (`.nvmrc` pins the version used here)
- **Docker Desktop** — required for Postgres and Redis

  Docker was **not installed** on the machine this was scaffolded on, so
  `docker-compose.yml` is written but has never been executed. Expect to debug it
  on first run; the file is small and commented.

## Setup

```bash
npm install
```

That installs both workspaces and runs `prisma generate` (backend `postinstall`),
which writes the typed client into `backend/src/db/generated/` — gitignored, so
it must be generated on every fresh clone.

Then create the three environment files from their committed examples:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

<!-- PLACEHOLDER: fill in once migrations and seed data exist. -->

Fill in `POSTGRES_PASSWORD` in `.env` and use the same value inside
`DATABASE_URL` in `backend/.env`. Then start the datastores:

```bash
npm run db:up
```

## Running

| Command                | What it starts                                  |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | API (`:4000`) + web (`:3000`)                   |
| `npm run dev:all`      | API + web + the queue worker                    |
| `npm run dev:backend`  | API only, `tsx watch`                           |
| `npm run dev:frontend` | Web only, `next dev`                            |
| `npm run dev:worker`   | Queue worker only (separate process by design)  |

Check it came up:

```bash
curl http://localhost:4000/health
```

`/health` is liveness and touches no dependency. `/health/ready` probes Postgres
and Redis and returns **503** with a per-dependency report when either is down —
which is the expected answer before `npm run db:up`. <http://localhost:3000>
renders the same report in the browser.

<!-- PLACEHOLDER: document the campaign/schedule screens as they land. -->

## Environment variables

Nothing is guessed at runtime: `backend/src/config/config.ts` validates every
variable at startup and throws a single list of what is missing or malformed
rather than failing later on first use. Secret-looking values are redacted from
that output.

### Repo root `.env` — consumed by `docker-compose.yml` only

| Variable            | Required | Default | Notes                                  |
| ------------------- | -------- | ------- | -------------------------------------- |
| `POSTGRES_USER`     | yes      | —       | Compose fails fast if unset            |
| `POSTGRES_PASSWORD` | yes      | —       | Local-only; never committed            |
| `POSTGRES_DB`       | yes      | —       | Database created on first boot         |
| `POSTGRES_PORT`     | no       | `5432`  | Host-side port                         |
| `REDIS_PORT`        | no       | `6379`  | Host-side port                         |

### `backend/.env` — consumed by the API and the worker

| Variable        | Required | Default                 | Notes                                        |
| --------------- | -------- | ----------------------- | -------------------------------------------- |
| `NODE_ENV`      | no       | `development`           | `development` \| `test` \| `production`      |
| `PORT`          | no       | `4000`                  |                                              |
| `LOG_LEVEL`     | no       | `info`                  | pino levels, plus `silent`                   |
| `DATABASE_URL`  | **yes**  | —                       | Must start `postgresql://`                   |
| `REDIS_URL`     | **yes**  | —                       | Must start `redis://` or `rediss://`         |
| `CORS_ORIGIN`   | no       | `http://localhost:3000` | Comma-separated list of allowed origins      |
| `SMTP_HOST`     | no       | —                       | Optional now; required in the sending phase  |
| `SMTP_PORT`     | no       | —                       |                                              |
| `SMTP_USER`     | no       | —                       |                                              |
| `SMTP_PASSWORD` | no       | —                       |                                              |
| `MAIL_FROM`     | no       | —                       |                                              |

### `frontend/.env.local`

| Variable                   | Required | Default                 | Notes                                     |
| -------------------------- | -------- | ----------------------- | ----------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | yes      | `http://localhost:4000` | Inlined into the browser bundle — no secrets |

<!-- PLACEHOLDER: add auth/session and provider credentials here when they land. -->

## Architecture

<!-- PLACEHOLDER: expand into a real architecture doc from DECISIONS.md entries. -->

```
browser ──HTTP──> Express API ──> Postgres        (source of truth)
                       │
                       └──enqueue──> Redis (BullMQ) ──> worker ──SMTP──> recipient
```

Two processes share one codebase and one database. The API only ever *enqueues*
a send; the worker is the only thing that talks to SMTP. That split is what makes
"schedule for later" survive an API restart — the delay lives in Redis, not in a
`setTimeout`.

### Layout

```
backend/
  prisma/schema.prisma      datasource + generator (no domain models yet)
  src/config/               env.ts = pure validation, config.ts = load + freeze
  src/db/                   Prisma client, Redis connection factory
  src/middleware/           request logging, 404, terminal error handler
  src/routes/               Express routers (health today)
  src/services/             business logic, framework-free
  src/workers/              BullMQ worker + its own process entrypoint
  tests/                    Vitest; app.test.ts drives Express in-process
frontend/
  app/                      App Router pages + Tailwind entry (globals.css)
  components/ui/            reusable primitives: button, input, table, modal
  components/               app-specific composites
  lib/api.ts                typed fetch client — the only place fetch is called
  types/                    hand-mirrored API response shapes
```

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

## Scripts

Run from the repo root; each delegates into the workspaces.

| Command                  | Does                                              |
| ------------------------ | ------------------------------------------------- |
| `npm run build`          | `tsc` the backend, `next build` the frontend      |
| `npm run typecheck`      | `tsc --noEmit` in both workspaces                 |
| `npm run lint`           | ESLint in both workspaces                         |
| `npm test`               | Vitest (backend)                                   |
| `npm run format`         | Prettier write across the repo                    |
| `npm run db:up` / `:down` | Start / stop Postgres + Redis                    |
| `npm run db:reset`       | **Destroys** the volumes and recreates them       |
| `npm run db:logs`        | Tail container logs                               |
| `npm run prisma:migrate` | `prisma migrate dev`                              |
| `npm run prisma:studio`  | Prisma Studio                                     |

## Known gaps

These are deliberate, not oversights — each is scheduled for a later phase.

- **No authentication.** Every route is publicly reachable. Today that is only
  `/health`; auth middleware must land before the first route touching user data.
- **No domain models.** `schema.prisma` has a datasource and generator only, so
  the first migration can be the real data model instead of a correction of a
  guessed one. `npm run prisma:migrate` has nothing to do until then.
- **The worker throws `NotImplementedError`.** A no-op processor would mark
  scheduled sends as completed with no email leaving — silent data loss.
- **`docker-compose.yml` is unverified.** Written, never run (no Docker on the
  scaffolding machine).
- **ESLint is pinned to 9.x**, not 10. `eslint-config-next` still depends on
  `eslint-plugin-react` 7.37, which calls APIs ESLint 10 removed.
- **No CI, no Dockerfile for the app itself, no rate limiting.**
