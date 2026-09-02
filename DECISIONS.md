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

Consequence in the typed client: 503 here is a *valid typed response*, not an
error, so `request()` grew an `acceptStatuses` option instead of the frontend
pattern-matching on error details.

### The readiness report flattens the error `cause` chain

Found by running the probe with no datastores up: the Postgres check reported
`"\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\n"`. Prisma 7 wraps
driver-adapter failures in an error whose own `message` is a near-empty preamble
and puts the actual reason — `ECONNREFUSED`, authentication failed, no such
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
observation so far is of the *failure* branch.


