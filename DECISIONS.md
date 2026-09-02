# Decisions

Running log of design decisions and the trade-offs behind them. Each entry says
what was chosen, what was rejected, and why — the "why" is the part that stops a
future change from quietly undoing a deliberate call. Newest entries go at the
bottom; this file is the raw material for the eventual architecture doc.

<!-- Template for new entries:
### <Decision>
**Chose** … **over** … — <reason>. <Consequence or revisit trigger.>
-->

## 2026-09-02 — Phase 1: scaffolding

Everything below was verified by execution (`npm install`, typecheck, lint, tests,
`next build`, live `/health` request) except where explicitly marked unverified.

### Monorepo with npm workspaces

**Chose** npm workspaces **over** pnpm workspaces + Turborepo, and over two
separate repositories. The frontend and backend share response types that will
change together for months; two repos means a version dance on every field
rename. Turborepo's caching and pnpm's stricter linking are real wins, but they
add a toolchain to install and explain before a single feature exists — and npm
ships with Node, so `npm install` at the root is the whole setup story. Revisit
if the build gets slow enough to want remote caching, or if phantom-dependency
bugs start appearing.

### Prisma 7 as the ORM

**Chose** Prisma **over** Drizzle (the brief left it open) and over raw `pg`.
The deciding factor is that this app's hard part is scheduling, not SQL: Prisma's
migration workflow (`migrate dev` → reviewable SQL → `migrate deploy`) and Studio
mean less time spent on data plumbing. Drizzle would win on bundle size, on
SQL-shaped queries and on avoiding a codegen step; Prisma 7's driver adapters
removed the Rust engine binary that was the main reason to avoid it. Cost
accepted: a `prisma generate` step, so the client is gitignored and regenerated
on every clone (`postinstall`).

### Prisma 7 specifics that are not obvious

- **`prisma-client` generator, output into `src/db/generated/`.** The old
  `prisma-client-js` generator is deprecated in 7, and the new one requires an
  explicit `output` path. Generating into the source tree (not `node_modules`)
  means the emitted code is ESM TypeScript that `tsc` type-checks like any other
  file.
- **`importFileExtension = "js"`** so generated imports match the hand-written
  `NodeNext` style and `dist/` runs under plain `node`.
- **No `url` in the `datasource` block.** Prisma 7 removed it — Migrate reads the
  URL from `prisma.config.ts`, the runtime client gets it from the driver adapter.
  This was found by `prisma generate` failing with P1012, not by reading ahead.
  Upside: no connection string in a committed file.
- **`prisma.config.ts` uses `process.env.DATABASE_URL ?? ''`, not `env()`.**
  `env()` throws when the variable is absent, which breaks `prisma generate` on a
  fresh clone or in CI where no database exists yet.
- **`import 'dotenv/config'` in `prisma.config.ts`.** Prisma 7 no longer loads
  `.env` automatically.

### No domain models yet

`schema.prisma` deliberately contains only a datasource and generator. Inventing
`Campaign`/`Recipient` tables during scaffolding would make the first migration a
correction of a guess. The cost is that `npm run prisma:migrate` does nothing
today; the benefit is that the first migration is the real data model.

### Backend is ESM with `NodeNext`

**Chose** `"type": "module"` + `module/moduleResolution: NodeNext` **over**
CommonJS and over a bundler-style setup. The ecosystem this depends on (pino 10,
BullMQ 6, Prisma's generated client) is ESM-first. The visible cost is the `.js`
extension on relative imports inside `.ts` files, which looks wrong and is
correct: it means `tsc` output runs under `node dist/` with no rewriting step and
no bundler in production.

### TypeScript pinned to 6.0.3, not 7.0.2

`typescript@latest` is 7.0.2, but `typescript-eslint@8.69.0` declares
`typescript: >=4.8.4 <6.1.0`. Installing 7 silently disables type-aware linting,
which is most of the value of having ESLint here at all. Pinned 6.0.3 in both
workspaces. Revisit when typescript-eslint widens its peer range.

### ESLint pinned to 9.39.5, not 10.9.1

Found by execution: ESLint 10 works fine for the backend, but the frontend
crashes with `contextOrFilename.getFilename is not a function` inside
`eslint-plugin-react@7.37.5`, which `eslint-config-next@16.3.4` depends on and
which still calls context methods ESLint 10 removed. The alternative was dropping
`eslint-config-next` and hand-wiring `@next/eslint-plugin-next` +
`typescript-eslint`, which also loses `jsx-a11y` — not worth it for an app whose
UI is forms and tables. Both workspaces are on one ESLint major rather than a
split. **Revisit trigger:** a stable `eslint-plugin-react` release with ESLint 10
support (currently only on the `next` tag as `7.8.0-rc.0`).

### Config: pure validation module + side-effecting loader

`src/config/env.ts` is a pure function over a `process.env`-shaped record;
`src/config/config.ts` is the only thing that reads `.env` from disk and freezes
the result. That split is why the test suite can assert validation behaviour
without a `.env` file on disk and without a real database.

Three properties worth keeping:

- **Fail fast at startup, not on first use.** `config.ts` is imported before the
  port is bound, so a bad environment cannot produce a server that accepts
  requests and then 500s.
- **Report every problem at once.** Every Zod issue is mapped, so one restart
  tells you all five missing variables instead of one per attempt.
- **Never echo secrets.** Keys matching `PASSWORD|SECRET|TOKEN|CREDENTIAL|KEY|URL|DSN`
  print as `<redacted>`; a `missing (required)` marker distinguishes absent from
  malformed. There is a test asserting a planted password never appears in the
  error message.

`.env` is resolved relative to the module (`import.meta.dirname`), not
`process.cwd()`, so `src/` and `dist/` both find `backend/.env`.

### Express 5 over Fastify and NestJS

**Chose** Express 5 (the brief named it). Worth recording what 5 changes: async
handlers that reject are forwarded to the error middleware automatically, so
routes carry no `try/catch` boilerplate. Error middleware must keep all four
parameters or Express treats it as a normal handler — the reason
`error-handler.ts` has an unused `next` in its signature.

### BullMQ, and the worker is a separate process

**Chose** BullMQ + Redis **over** pg-boss (Postgres-backed, one less service) and
over `setTimeout` in the API process. `setTimeout` loses every pending send on
restart, which for a scheduler is the whole product. pg-boss was the real
contender — it would have removed Redis entirely — but BullMQ was named in the
brief and its delayed-job and retry/backoff semantics are the better-trodden path.

The worker gets its **own entrypoint** (`src/workers/index.ts`, `npm run
dev:worker`) rather than being started inside the API. Sending is CPU- and
IO-bursty; a slow SMTP provider must not make HTTP requests queue behind it, and
the two need to scale independently. Its shutdown timeout is 30s versus the API's
10s, so an in-flight send finishes rather than being retried and possibly
duplicated.

Two BullMQ-specific settings that are load-bearing:

- **`maxRetriesPerRequest: null` on queue connections.** BullMQ uses blocking
  Redis commands; ioredis's default retry cap aborts them and the worker stalls.
  App-role connections keep a finite cap (2) so a health probe fails fast instead
  of hanging.
- **Redis runs with AOF (`--appendonly yes`).** Delayed jobs live in Redis. With
  the default RDB snapshots, a container restart can silently drop sends
  scheduled in the window since the last snapshot.

Jobs carry `{ scheduledEmailId }` and nothing else, so the worker reads current
state at send time. A job payload snapshotted at enqueue time would send a body
the user has since edited, or send something they cancelled.

### The worker processor throws instead of no-op'ing

`processEmailDispatch` throws `NotImplementedError`. A stub that returned
successfully would mark scheduled sends completed with no email ever leaving —
silent data loss, and the failure mode would surface as "the product doesn't
work" rather than as an error. Throwing means jobs retry, then land in the failed
set where they are visible and re-runnable once sending exists.

### Liveness and readiness are different endpoints

`GET /health` touches no dependency; `GET /health/ready` probes Postgres and
Redis in parallel with a 2s timeout each and answers **503** with a
per-dependency report. Collapsing them into one endpoint means a database outage
makes an orchestrator kill an otherwise-healthy process, turning a degradation
into an outage. Health deliberately sits **outside** `/api/v1` — probes should not
have to follow API versioning.

Consequence in the typed client: 503 here is a _valid typed response_, not an
error, so `request()` grew an `acceptStatuses` option instead of the frontend
pattern-matching on error details.

### The readiness report flattens the error `cause` chain

Found by running the probe with no datastores up: the Postgres check reported
`"\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\n"`. Prisma 7 wraps
driver-adapter failures in an error whose own `message`is a near-empty preamble
and puts the actual reason —`ECONNREFUSED`, authentication failed, no such
database — on `cause`. A per-dependency report that cannot distinguish "Postgres
is not running" from "wrong password" defeats the point of reporting per
dependency.

`describeError()` therefore walks the `cause` chain (with a `seen` set, because a
cycle here would hang a health check), appends the driver's machine-readable
`code` that both `pg` and `ioredis` attach, joins with `<-`, collapses the
newlines Prisma pads its messages with, and truncates at 300 characters so one
sick dependency cannot dominate the response body. Non-`Error` throws go through
an explicit primitive/`JSON.stringify` path rather than `String()` — a report
saying `[object Object]` is worse than one saying nothing, which is also what
`@typescript-eslint/no-base-to-string` was pointing at.

### One error envelope, and a request id on everything

Every failure returns `{ error: { code, message, requestId, details? } }` from a
single terminal handler. Handlers throw `HttpError.notFound(...)`; nothing builds
an ad-hoc error body. `ZodError` maps to 400 `VALIDATION_ERROR` with field paths;
anything unrecognised is logged with its stack and returned as a generic 500, so
internal messages never reach a client.

`x-request-id` is honoured if inbound and generated otherwise, echoed on the
response, and attached to every log line — so a user-reported error id maps to a
log entry.

**The frontend mirrors these types by hand** (`frontend/types/api.ts`) rather than
generating them from an OpenAPI spec. At two endpoints, codegen is more
infrastructure than it saves; the file carries a comment saying that a backend
shape change must be mirrored in the same commit. Revisit once the API has enough
surface that drift becomes likely.

### pino with redaction, pretty-printed only in development

**Chose** pino **over** winston and over `console.log`. Structured JSON is what
makes logs greppable in aggregation later; `pino-pretty` is loaded only when
`isDevelopment`, so production never pays for formatting. `redact` covers
`authorization`, `cookie`, `password`, `DATABASE_URL` and `REDIS_URL` — connection
strings contain the password, so a logged config object is a credential leak.
`no-console: 'error'` in ESLint keeps the logger the only output path.

### Lazy connections everywhere

Neither the Prisma client nor Redis connects at import time (`lazyConnect` for
app-role Redis, lazy singletons for the queue). Importing a module never opens a
socket. That is what lets the whole backend test suite run with Postgres and
Redis down — which is also the state this scaffold was built in, since Docker was
not installed.

### Vitest over Jest

**Chose** Vitest **over** Jest. Jest needs extra configuration to run ESM
TypeScript; Vitest reads the TypeScript directly and resolves the `.js`-extension
imports that `NodeNext` requires. Tests use **supertest against `createApp()`**,
never a listening port — `createApp()` builds the app without binding, so
`index.ts` owns the lifecycle and tests own the requests. `tests/setup.ts` forces
`NODE_ENV=test` and fake datastore URLs, so a test can never point at a real
database.

### Frontend: Next.js App Router over React + Vite

**Chose** Next.js 16 App Router (the brief allowed either). A scheduler will want
server-side data loading and server actions for the campaign screens; starting as
a Vite SPA means migrating later or hand-rolling a server. Cost accepted: the
server/client boundary is a real constraint — `'use client'` is needed in
`input.tsx` and `modal.tsx` because they use hooks, and that is now explicit in
comments rather than something to rediscover.

### Data fetching lives in the server component, not in an effect

The home page started as a client component fetching `/health` in a `useEffect`.
`react-hooks/set-state-in-effect` (eslint-plugin-react-hooks 7, on by default in
`eslint-config-next`) rejects that: it flags **any** call in an effect body that
transitively reaches `setState`, so hoisting the synchronous `setState` calls
before the first `await` does not satisfy it. The rule is deliberately static and
conservative, and it is right about the pattern — an effect that sets state on
mount is a render the user pays for twice.

**Chose** to move the fetch into `app/page.tsx` as an async server component,
leaving `components/status-panel.tsx` presentational and refreshing via
`useTransition()` + `router.refresh()` — which also gives a pending flag for the
button spinner with no local loading state. **Rejected** disabling the rule (the
scaffold's job is to be the pattern that gets copied) and **rejected** adding SWR
or React Query to make effect-fetching legitimate (a data library is a real
decision, not a way to silence a linter; when client-side fetching is genuinely
needed, that is when to pick one — noted in the component).

`export const dynamic = 'force-dynamic'` keeps the build free of a running API:
without it, Next prerenders `/` at build time and `next build` fails whenever the
backend or its database is down. Verified — `next build` reports `ƒ /` (dynamic)
and succeeds with nothing listening on port 4000.

### Next 16 removed `next lint`, and owns `tsconfig.json`'s `jsx` setting

Two things `next build` forced, both now carrying comments so they are not
"cleaned up" later:

- **`"jsx": "react-jsx"` is mandatory.** Next 16 uses React's automatic JSX
  runtime and rejects `"preserve"`; `next build` rewrites the file if you change
  it. `.next/types/**` and `.next/dev/types/**` stay in `include` for the same
  reason — generated route types are how typed routing works — so `exclude` is
  narrowed to `["node_modules"]` alone.
- **No `eslint` key in `next.config.ts`.** `next lint` and its build-time ESLint
  integration are gone in 16, and an `eslint` key is now a type error. Linting is
  a standalone `npm run lint` (`eslint .`) per workspace, which is where it
  belongs for CI anyway.

### Tailwind v4 with semantic tokens, no component library

**Chose** Tailwind v4's CSS-first configuration — there is no `tailwind.config.js`
at all; tokens are declared in `@theme` in `app/globals.css`.

The tokens are **semantic** (`surface`, `ink`, `line`, `accent`, `danger`) rather
than literal (`slate-50`, `gray-900`), and dark mode is a variable swap in one
`@media (prefers-color-scheme: dark)` block. **Rejected** the common alternative
of `bg-white dark:bg-slate-900` pairs at every call site: that duplicates the
theme across hundreds of class strings and makes a palette change a find-and-replace.
`@theme inline` (not plain `@theme`) is required for this — it inlines
`var(--surface)` into each utility so the utility resolves against whichever
`:root` block is active; a non-inline `@theme` captures the value once and dark
mode stops following.

**Rejected** shadcn/ui, Radix and MUI. The brief asked for four reusable
primitives; pulling in a component library to get them means adopting its
conventions and its upgrade cadence for the rest of the project.

### Modals use the native `<dialog>` element

**Chose** `<dialog>` + `showModal()` **over** a portal-and-div implementation.
It gives focus trapping, Escape handling, `inert` on the background, top-layer
stacking (no z-index arithmetic) and focus restoration on close — the exact list
of things hand-rolled modals get subtly wrong. Body scroll-lock is
`body:has(dialog[open]) { overflow: hidden }` in CSS, so there is no JS
scroll-position bookkeeping.

The cost is that open state has to be pushed into the DOM node through an effect,
and Escape needs care: the `cancel` event is `preventDefault`ed so React state
stays the single source of truth and the DOM never disagrees with the props.

### `DataTable` has no `onRowClick`

A click handler on `<tr>` is invisible to keyboard and screen-reader users, and
"add a button in a cell" is not a worse UI. Skeleton rows render while loading and
an explicit empty message renders when there are no rows — both states belong in
the shared component, because a per-screen empty state is the thing everyone
forgets.

### No `next/font`

`next/font` fetches Google Fonts at build time, which makes `next build` fail
without network access — including in CI behind a proxy. Using a system font stack
instead. Revisit if the design needs a specific typeface, and self-host it then.

### Compose runs datastores only

`docker-compose.yml` has Postgres 17 and Redis 8 (both `-alpine`, both pinned to a
major) and **not** the app. Running the API in a container during development
costs live reload and adds a rebuild to every change; `tsx watch` on the host with
containerised datastores is the faster loop. Deployment containers are a later
concern and should not be conflated with local dev.

Details worth keeping:

- **`${POSTGRES_PASSWORD:?message}` interpolation**, so compose refuses to start
  with a clear message rather than booting Postgres with an empty password.
- **Named volumes** (`reachinbox-pgdata`, `reachinbox-redisdata`), so data
  survives `docker compose down`. `npm run db:reset` is the explicit
  `down -v` escape hatch and is labelled destructive in the README.
- **Healthchecks** on both services, so `depends_on: condition: service_healthy`
  works when the app is eventually containerised.

**Unverified:** Docker was not installed on the machine this was scaffolded on, so
this file has never been executed. That is called out in the README rather than
left as an assumption.

### Credentials

The Postgres password was generated locally with `crypto.randomBytes` over an
alphanumeric alphabet — alphanumeric specifically so it needs no percent-encoding
inside `DATABASE_URL` and no quoting in YAML. It exists only in the two gitignored
`.env` files; `.env.example` files are committed with blanks. No placeholder
credential was invented anywhere: per the brief, values that cannot be derived get
asked for.

### No authentication yet — explicit deferral

There is no auth layer. Every route mounted in `app.ts` is publicly reachable;
today that is only `/health`, which is intentional. This is recorded here and as a
`NOTE` in `app.ts` because "we'll add auth later" is exactly the decision that
gets forgotten until the first route touching user data is already shipped. Auth
middleware must land **before** that route.

### Deferred deliberately

CI pipeline, a Dockerfile for the app, rate limiting, and OpenAPI/codegen for the
client types — all noted, none blocking a scaffold.

### The 4 open `npm audit` advisories, named

"Dev-only, no runtime exposure" is the kind of claim that needs its receipts, so
here they are. All four are high severity and all four reach the tree only through
the `prisma` **CLI**:

- **`deepmerge-ts` — stack exhaustion on deeply nested input**, via
  `@prisma/config`. Reached only when Prisma reads `prisma.config.ts`, on inputs
  from this repo.
- **`mysql2` — credential leak via an auth-plugin downgrade**, via `prisma`. This
  project is Postgres-only and never opens a MySQL connection; the package is
  present because the CLI ships every connector.

Neither is imported by `src/`, so neither is in `dist/` or in the request path.
The fix is a `prisma` release that bumps its own dependencies — not something to
force with `npm audit fix`, which would try to move Prisma itself. **Revisit** on
the next Prisma minor; re-run `npm audit` then rather than trusting this note.

### How "verified by execution" was established

So the claim at the top of this entry can be audited rather than trusted:
`npm install` from a clean tree, `tsc --noEmit` and `eslint .` in both workspaces,
`vitest run` (11 tests, 2 files), `next build`, `tsc -p tsconfig.build.json`, then
`node dist/index.js` with live `curl` against `/health` (200), `/health/ready`
(503 with both dependencies `down` and a reason per dependency) and `/nope` (404
carrying the shared envelope and echoing an inbound `x-request-id`), with helmet
headers present and `x-powered-by` absent.

Graceful shutdown was exercised by importing `dist/index.js` in a throwaway
harness and emitting `SIGINT`, which runs the handler the entrypoint registers:
server close → `closeQueues()` → `disconnectDatabase()` → `disconnectRedis()` →
`exit 0`, logging `Shutdown complete` in 3 ms. **Not** verified: OS signal
delivery, because Windows has no real SIGTERM to deliver — that only gets proven
on the Linux host this eventually deploys to.

Also not verified, and listed here rather than buried: `docker-compose.yml` has
never run (no Docker on this machine), no migration has ever been applied, and no
code path that touches Postgres or Redis has succeeded — every datastore
observation so far is of the _failure_ branch.

## 2026-09-02 — Phase 2: data model and API skeleton

Verified by execution: `prisma validate`, `prisma generate`, `prisma migrate diff`
(offline SQL generation), `tsc --noEmit`, `tsc -p tsconfig.build.json`, `eslint .`
(0 problems), `vitest run` — **57 tests, 5 files, all passing with Postgres and
Redis down**. Not verified: any statement actually executing against Postgres, or
any job actually landing in Redis. The last section of this entry says exactly
where that line falls.

### Three tables, plus a fourth the brief did not ask for

`senders` and `scheduled_emails` are as specified. The addition is
**`schedule_batches`**, one row per `POST /api/emails/schedule` call, holding
`start_at`, `delay_between_emails_ms`, `hourly_limit` and `effective_step_ms`.

**Chose** a batch table **over** denormalising those four values onto every
`scheduled_emails` row, and over not recording them at all. Without it the request
that produced 400 rows is unreconstructable: "why is this campaign sending one
email every eight and a half minutes?" has no answer in the data, only in a log
line that has since rotated. It also gives the one honest place to record
`effective_step_ms` — _what the planner used_ — next to `delay_between_emails_ms` —
_what was asked for_. Those two differ whenever `hourly_limit` binds, and a
schedule that silently disagrees with its own request is the bug this table exists
to make visible.

`scheduled_emails.batch_id` is **nullable** with `ON DELETE CASCADE`. Nullable
because a future single send, or a worker-side retry clone, should not be forced to
invent a batch; cascade because a batch is a description of its rows and deleting
one without the other leaves a schedule that describes nothing.

### `rate_limit_counters`: neither a table nor Redis

**This is the deliberate deviation from the brief**, which offered a counter table
or "purely in Redis". I took a third option: there is no counter at all.

`scheduled_emails` _is_ the counter. Sends per rolling hour for a sender is
`COUNT(*) WHERE sender_id = $1 AND scheduled_at >= $2 AND scheduled_at < $3` —
exactly what `@@index([sender_id, scheduled_at])` is in the schema to serve. The
number is derived from the same rows that are the source of truth for delivery, so
it cannot disagree with them.

**Rejected — a `rate_limit_counters` table:** it is a cache of a number the
database can already compute. Two writers now have to keep it in step with the rows
(insert, cancel, retry, worker failure, manual `DELETE`), and every path that
forgets one of those drifts. A cache that can be wrong about "have I already sent
50 this hour" is worse than no cache, because it will be trusted.

**Rejected — Redis:** faster and the usual answer, but Redis here is configured for
queue durability, not for being a system of record. With AOF `everysec` a crash
loses up to a second of writes, and `INCR`s are exactly the writes that vanish.
The failure mode is over-sending — the one failure this feature exists to prevent,
and the one that gets a sender domain blacklisted. Losing a _job_ is recoverable
from Postgres; losing the _count_ is not recoverable from anywhere.

**Revisit when** the count query shows up in slow logs, or a limit has to be
enforced at _send_ time across processes rather than at _schedule_ time. At that
point the right shape is a Redis counter treated as a hint in front of the
Postgres count, not as the truth — and Postgres stays authoritative.

Worth being precise about what ships now: `hourly_limit` is enforced **at schedule
time**, by spacing. Nothing yet enforces it at send time, because nothing sends yet.

### Every timestamp is `timestamptz(3)`

**Chose** `@db.Timestamptz(3)` on every datetime column **over** Prisma's default
`timestamp(3)` (no zone). A scheduler that stores naive local times sends at the
wrong hour the first time a client, a server or a DST boundary disagrees about what
"14:30" meant. Millisecond precision because that is BullMQ's resolution; storing
microseconds would imply a guarantee the queue cannot keep.

The same rule reaches the API boundary: `start_time` must carry an offset
(`z.iso.datetime({ offset: true })`), so `2026-09-02T14:30:00` is a **400**. Guessing
that a zoneless string means UTC is how a campaign goes out at 09:00 to an audience
the sender pictured at 14:00.

### Senders store a credential _reference_, and the pool is shared

The brief left this open. **Chose** one shared credential set, named by
`smtp_credential_ref` (default `'default'`), resolved outside the database against
the `SMTP_*` env vars — **over** per-sender SMTP secrets in the `senders` row.

Two reasons. Secrets in a table get into `pg_dump` output, into the CI restore of a
production snapshot, and into `prisma studio` screenshots; env vars at least stay in
one gitignored place with an existing redaction path in the logger. And Ethereal is
a single test mailbox — per-sender credentials would be per-sender copies of the
same string, which is a schema modelling a fiction.

The column is a _reference_ rather than a boolean so the shape does not have to
change when it stops being a fiction: pointing at `'aws-ses-eu'` or a secrets
manager key is the same column with a different value.

### Subject and body are copied onto every row, not held once on the batch

**Chose** duplication **over** normalising the content onto `schedule_batches`.
`scheduled_emails` is the delivery record: what was sent to whom, at what time. If
the content lives one join away, editing a batch mid-flight rewrites the history of
the emails that already went out, and the row can no longer answer "what did this
person actually receive?". The cost is real — 400 recipients means 400 copies of the
body — and Postgres TOAST compresses it out of the main heap anyway. Correct history
beats the bytes.

This is also why list responses omit `body` (`ScheduledEmailListItem`): 100 rows at
the 100k-character cap is a 10 MB payload for a table that renders subject and
status. Full content belongs on a detail endpoint that does not exist yet.

### The scheduling math

Requested explicitly by the brief. All of it lives in
`backend/src/services/schedule-planner.ts`, which imports nothing — no Express, no
Prisma, no BullMQ, no clock. `now` is a parameter. That is what makes it testable
with both datastores down, and it is the only real arithmetic in the phase.

One request becomes one arithmetic progression:

```
effectiveStepMs = max(delayBetweenEmailsMs, ceil(HOUR_MS / hourlyLimit))
scheduledAt(i)  = startAt + i * effectiveStepMs        // absolute, stored
delayMs(i)      = max(0, scheduledAt(i) - now)         // relative, handed to BullMQ
```

`startAt` defaults to `now` when `start_time` is omitted. Four choices inside those
three lines are load-bearing:

**`max`, not `+`.** `delay_between_emails_ms` and `hourly_limit` express the same
constraint at different resolutions, so the tighter one wins. Adding them would turn
`delay=1000, hourly_limit=60` into 61-second gaps — neither what was asked for nor
what the cap requires.

**`ceil`, not `floor` or exact division.** Take `hourly_limit = 7`:
`3_600_000 / 7 = 514_285.71…`. Floor gives 514_285 ms, so sends land at 0, 514_285,
…, `7 × 514_285 = 3_599_995` ms — still inside the first hour. That is **8 sends in
60 minutes under a limit of 7**. Ceil gives 514_286 ms and the eighth send lands at
3_600_002 ms, just outside. Rounding down breaks the cap for every limit that does
not divide an hour evenly, which is most of them.

**One `now` for the whole batch.** Sampling the clock per email lets a slow loop
drift the spacing: email 0 measured at T and email 400 at T+80 ms yields gaps that
are subtly short, and subtly short is what trips a provider's rate limiter. One
sample keeps the progression exact.

**Both representations are kept.** `scheduled_at` is absolute and lives in Postgres;
`delay` is relative and lives in Redis, because relative ms is BullMQ's only
interface. If a job is ever lost and re-enqueued, `scheduled_at` is the surviving
truth and the new delay is recomputed from it. Storing only the delay would make the
schedule unreadable without the queue.

`delayMs` is clamped at 0: a `start_time` inside the grace window below is in the
past, and BullMQ rejects a negative delay rather than treating it as "now".

### Two guard rails on the plan, both 422 rather than 400

- **`START_AT_GRACE_MS = 5 min`.** A `start_time` further in the past than this is
  rejected, not clamped. Zero tolerance would refuse a client that computed "now" and
  then spent 200 ms in DNS, TLS and JSON. Five minutes absorbs ordinary browser/server
  clock skew without silently back-dating a campaign meant for next week.
- **`MAX_HORIZON_MS = 90 days`**, measured `startAt` → last send. This is the typo
  guard: `6000000` instead of `600000` turns a ten-minute gap into one hour forty,
  and 500 recipients into fourteen months of sending. The error names the computed
  duration and the three ways to fix it.

**422, not 400**, for both: the request parsed and every field was individually valid.
"Nine hundred recipients four hours apart" is a coherent sentence that happens to
describe five months. `SchedulePlanError` carries a machine-readable `reason`
(`start_too_far_past` | `horizon_exceeded` | `empty_batch`) into
`error.details.reason`, so a client can branch without matching on prose.

### Commit first, enqueue second

**Chose** insert → commit → `addBulk` **over** enqueue-then-insert, and over doing
both inside one transaction (which is not available anyway: Redis is not in the
Postgres transaction).

The two failure modes are not symmetric. A job whose row was rolled back fires
against something that will never exist and burns five retries reaching that
conclusion. A committed row with no job sends nothing, is queryable
(`bullmq_job_id IS NULL`), and is repairable by re-enqueueing — which is safe because
**the BullMQ job id is the row id**, so a duplicate enqueue is a no-op rather than a
second copy of the same email. Test `commits before it enqueues` pins the order.

### `bullmq_job_id` is nullable, unique, and stamped after the enqueue succeeds

Setting it at insert time would be tidier and would destroy the only signal that
matters: `NULL` means _not armed_. That is precisely the marker a reconciliation
sweep looks for, and it cannot exist if the column is populated optimistically.

The write is one parameterised statement for the whole batch:

```sql
UPDATE scheduled_emails SET bullmq_job_id = id::text, updated_at = now()
 WHERE batch_id = $1::uuid AND bullmq_job_id IS NULL
```

**Chose** this **over** N `prisma.update` calls in a transaction (400 round trips to
copy a value the application already knows) and over `updateMany` (which cannot set a
column from another column). `AND bullmq_job_id IS NULL` makes it idempotent, so a
repair pass can run it again without touching rows that are already armed. The
`::text` cast is required because `id` is `uuid` and `bullmq_job_id` is `text` — that
type pairing was confirmed against the generated migration SQL, not assumed.

The column is `text` rather than `uuid` because it holds _BullMQ's_ identifier, and
BullMQ job ids are strings. They happen to be UUIDs today by our choice; typing the
column as `uuid` would make that coincidence a constraint.

A failure of this `UPDATE` **warns and returns 201**. The jobs are real and will
fire; the column is bookkeeping, and failing a request that actually succeeded would
be the wrong answer.

### 503, not 201, when the rows commit but the queue refuses

The inverse call. If `addBulk` throws, the rows are already committed — but nothing
is armed, so `201 Created` would tell the caller mail is going out when it is not.
The response is **503** carrying `{ batchId, scheduledCount, enqueued: false }` and a
message that says the rows exist, that retrying is safe, and that re-**posting** would
duplicate them. No rollback: the rows are the evidence a repair needs.

### Validation: strict body, lax query

`scheduleEmailsBodySchema` is a `z.strictObject` — an unrecognised key is a 400.
`hourly_limits` silently dropped is the difference between a throttled warm-up and
500 emails in one second, and zod's default strip-unknown behaviour would make that
typo invisible. `listQuerySchema` is deliberately **not** strict: a stray
`?utm_source=newsletter` changes nothing about what gets sent, and rejecting it would
break links for no safety gained.

Other choices in the schemas:

- **`recipients` accepts a bare string or an array**, normalising to an array. The
  brief asked for "a list of recipient emails (or a single one)"; two shapes at the
  edge, one shape everywhere inside.
- **Addresses are trimmed and lowercased before validation**, so `' ONE@Example.com'`
  and `'one@example.com'` collapse to the same key. Deduplication then works with a
  plain `Set`, and the response reports `duplicates_removed` rather than silently
  dropping recipients — the count is what turns a surprise into an explanation.
- **`sender` is a union of UUID and email**, discriminated to
  `{ kind: 'id' | 'email', value }` at parse time so the service does no sniffing.
- **`delay_between_emails_ms` is required once there is more than one recipient**
  (a `superRefine`, so the error lands on that field). Defaulting a multi-recipient
  batch to 0 means a simultaneous blast, which is both a spam signal and never what
  someone scheduling a campaign meant.
- **Caps**: 500 recipients, 998-char subject (RFC 5322 line limit), 100k body, 24 h
  delay, 10 000 hourly limit, 100 per page.

Handlers call `schema.parse()` with **no try/catch**. Express 5 forwards a rejected
promise to the error middleware, which already renders `ZodError` as
`{ error: { code: 'VALIDATION_ERROR', details: [{ path, message }], requestId } }`.
A local catch would produce a second, subtly different envelope.

### The wire format is snake_case in both directions

**Chose** snake_case on the wire (`delay_between_emails_ms`, `scheduled_at`) with
camelCase inside TypeScript, translated in one place per direction —
`src/schemas/email.schemas.ts` inbound, `src/routes/email.serializers.ts` outbound.

The brief's field names are snake_case, and matching them exactly means no client has
to guess a casing convention. Serialising explicitly rather than returning Prisma rows
also means a column rename is not automatically a breaking API change, and a column
added for internal bookkeeping does not leak by default.

### Offset pagination, with an `id` tie-break that is not decoration

`page`/`per_page` → `skip`/`take`, ordered `[{ scheduledAt: dir }, { id: dir }]`.

The tie-break is the whole point. With `delay_between_emails_ms = 0` an entire batch
shares one `scheduled_at`, and offset pagination over a non-unique sort key silently
**repeats and skips rows** across pages — Postgres is free to order equal keys
differently per query. Adding `id` makes the sort total.

**Chose** offset **over** cursor pagination: this is a dashboard that wants a page
count and a jump-to-page control, and both lists are bounded by what one operator
scheduled. Revisit at the point deep pages get slow, which is a table-size problem
this project does not have yet.

`GET /scheduled` (pending, processing) sorts **ascending** — what matters about a
queue is what goes out next. `GET /sent` (sent, failed) sorts **descending** on
`scheduled_at`, _not_ `sent_at`: failed rows never get a `sent_at`, and sorting on a
nullable column files every failure at one end of the list instead of next to the
sends it happened among.

`count` and `findMany` share a `$transaction`. Under READ COMMITTED each statement
still takes its own snapshot, so `total` can drift by a row against a batch being
written concurrently. For a list view that is a better trade than the lock contention
of `SERIALIZABLE`, and it is written down here so the drift is not read as a bug.

### uuid v4, generated in the application

**Chose** `randomUUID()` in Node **over** `gen_random_uuid()` in Postgres, because the
BullMQ job id must equal the row id and the jobs are built in the same pass as the
rows — a database-generated id is not known until after the insert, which would force
a second statement between commit and enqueue.

**Chose** v4 **over** v7, knowingly. v7 is time-ordered and would give better index
locality on insert. But the natural read orders here are `scheduled_at` and
`(status, scheduled_at)`, which have their own indexes, and 500-row batches do not
make B-tree fragmentation a real cost. Revisit if insert throughput ever matters.

### Four indexes, one per query that exists

Not speculative. Each one is here because a shipped query needs it:

| Index                                        | Serves                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `scheduled_emails (status, scheduled_at)`    | both list endpoints, and the worker's future "what is due" sweep |
| `scheduled_emails (sender_id, scheduled_at)` | the rolling-hour `COUNT(*)` that replaces `rate_limit_counters`  |
| `scheduled_emails (batch_id)`                | the `bullmq_job_id` stamp, and per-batch reads                   |
| `schedule_batches (sender_id, created_at)`   | a sender's batch history, newest first                           |

Plus two unique constraints: `senders.email` (the address _is_ the natural key, and
two rows for one mailbox is an ambiguity nothing can resolve) and
`scheduled_emails.bullmq_job_id` (a second row claiming the same job would make
"which email did this job send?" unanswerable — and it is the constraint that turns
a double-enqueue bug into an error instead of a duplicate send).

### `ON DELETE RESTRICT` on both sender FKs

Deleting a sender that has scheduled emails is refused. `CASCADE` would delete the
delivery history along with the identity; `SET NULL` would leave rows that cannot say
who sent them. The intended path is `is_active = false` — soft disable, which the
schedule endpoint honours with a **422** (`Sender … is disabled and cannot send`)
before it writes anything. History stays intact and readable; the sender simply stops
being usable.

### Senders are never created implicitly

`resolveSender` **404s** rather than upserting, with a message that says so: _"Senders
are not created implicitly — register one first."_ Auto-creating on an unresolved name
turns a typo into a sender with no credential behind it, and the batch then fails at
send time, hundreds of rows deep, long after the request returned 201.

Registration is a CLI — `npm run sender:create -- --email … --name …` — and
**not** an endpoint, deliberately: an unauthenticated API that can mint send-as
identities is not something to expose even on localhost. The script writes no SMTP
secret; it only records which credential set to resolve later.

### No `/v1` in the path

Phase 1 left an `API_PREFIX = '/api/v1'` constant that was **never mounted** — the
router served `/health` and nothing else. Rather than adopt a version segment by
accident, the constant is gone and routes mount under `API_BASE = '/api'`. The same
dead constant in `frontend/lib/api.ts` was replaced with the matching `API_BASE`.

A version segment that exists only in an unused constant is worse than no version at
all: it looks like a decision while guaranteeing that the first real client hard-codes
a path the server does not answer on. Versioning arrives with the first breaking
change, applied to both sides in one commit.

### The migration was generated offline and has never been applied

`prisma migrate dev` needs a running database; Docker still does not start on this
machine. So the SQL was produced with

```bash
prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
```

and committed as `prisma/migrations/20260902105926_initial_schema/migration.sql`
alongside a hand-written `migration_lock.toml` (`provider = "postgresql"`).

**Chose** committing generated-but-unapplied SQL **over** leaving the repo with no
migration. The file is reviewable, it is what `prisma migrate deploy` will run, and
reading it is how the `id uuid` / `bullmq_job_id text` pairing behind the `::text`
cast was confirmed. But it is **unapplied and untested**: the first `migrate deploy`
may need a `--create-only` correction, and the checksum in `_prisma_migrations` will
be written on that first run. Treat it as a proposal, not a fact.

### The security posture got materially worse, and `app.ts` says so

Phase 1's "no auth yet" was close to harmless — the only route was `/health`. That is
no longer true, and the `NOTE` in `app.ts` was replaced with a `SECURITY` block
stating it plainly: **`/api/emails/*` lets any caller who can reach the port send mail
as any registered sender, and read every recipient address, subject and error in the
database.** Binding to localhost and setting `CORS_ORIGIN` limits browsers; neither
limits `curl`.

Auth must land before this is reachable from anything but a local dev machine. It is
recorded in three places — here, in `app.ts`, and in the README's known gaps —
because a deferral written down once is a deferral that gets forgotten.

### Tests mock Prisma and BullMQ, and that is the design

57 tests across 5 files, all passing with **both datastores down** — the property
Phase 1 committed to, now under load from code whose whole job is to talk to them.

The split is deliberate:

- **`schedule-planner.test.ts` (12)** tests real code with no mocks, because the
  planner is pure. This is where the math is actually proven.
- **`email.schemas.test.ts` (17)** tests real zod schemas, no mocks.
- **`email.routes.test.ts` (17)** mocks `prisma` and the queue and drives Express
  in-process with supertest. It proves routing, status codes, the error envelope, and
  **the shape and arguments of every write** — the rows handed to
  `createManyAndReturn`, the `jobId`/`delay` on every job, the `where`/`orderBy`/
  `skip`/`take` of every query. It does **not** prove the SQL executes.

That last sentence is the limit, and it is written in the file's header comment too.
Mocked-Prisma tests catch "we built the wrong query"; only a live database catches
"the query is invalid". The second half needs an integration suite against a real
Postgres, which needs Docker.

### The hourly-limit test was mutation-tested

A property test that passes for the wrong reason is worse than no test, so this one was
checked against a deliberate break. `Math.ceil` in `minStepForHourlyLimit` was
temporarily changed to `Math.floor` and the suite re-run. Exactly two assertions failed
and both were the intended ones: `expected 514285 to be 514286`, and the rolling-window
property with `limit 7 from 1788343200000: expected 8 to be less than or equal to 7`.
`Math.ceil` was restored immediately.

The property test sweeps limits `[1, 2, 3, 7, 11, 13, 17, 23, 59, 60, 61, 97, 360,
3600]` and asserts that no 60-minute window starting at any planned send contains more
than `hourly_limit` sends. Every one of those limits fails if `ceil` becomes `floor`.

### `restoreMocks: true` does not clear a bare `vi.fn()`

Worth recording because it cost real time and will recur. `vitest.config.ts` sets
`restoreMocks: true`, which restores spies created with `vi.spyOn` — it does **not**
clear the call history of standalone `vi.fn()` mocks created in a `vi.hoisted` block.
Eleven route tests failed on the first run reading a _previous_ test's calls:
`expected "vi.fn()" to not be called at all, but actually been called 6 times`.

Fixed with an explicit `vi.clearAllMocks()` at the top of `beforeEach` (before the
implementations are reinstalled), and by making the argument-inspection helpers read
`.mock.calls.at(-1)` — the most recent call, which is what their names always claimed.

### Deferred deliberately, again

The worker still throws `NotImplementedError` — jobs enqueue and sit, exactly as the
brief specified. No cancel/reschedule endpoint, no detail endpoint, no send-time rate
limiting, no reconciliation sweep for `bullmq_job_id IS NULL`, no auth. Each is named
in the README's known gaps rather than left to be discovered.

### What is unverified after this phase

Stated in full so the "verified by execution" claim at the top can be audited:

- **No SQL has ever been executed.** No migration applied, no row written, no query
  planned by Postgres. Every Prisma call in the test suite is a mock.
- **No job has ever reached Redis.** `addBulk` is mocked; the queue's real behaviour
  with a 500-job bulk insert and multi-day delays is unobserved.
- **Docker still will not start.** `docker info` now reaches the named pipe but returns
  `500 Internal Server Error` from `dockerDesktopLinuxEngine` — progress from "cannot
  find the file specified", but the Linux engine never finishes booting. Blocked on
  Docker Desktop first-run / WSL2 setup on this machine.
- **No SMTP credentials exist.** The `SMTP_*` variables are blank in
  `backend/.env.example` and no Ethereal account has been created. Per the standing
  instruction these will be asked for rather than invented — and nothing needs them
  until the worker exists.
- **`prisma generate` output is gitignored**, so a fresh clone must run `npm install`
  (the `postinstall` hook) before `tsc` can resolve `src/db/generated/client.js`.
