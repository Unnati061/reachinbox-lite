# ReachInbox Lite

A full-stack email scheduling system built with **Next.js, Express.js, PostgreSQL, BullMQ, Redis, and Ethereal SMTP**.

ReachInbox Lite allows users to schedule email campaigns, process scheduled messages through a persistent Redis-backed queue, enforce sending limits, and track email delivery through a web dashboard.

## Features

* Google OAuth authentication
* Schedule emails for a future time
* Multiple recipients per campaign
* CSV/text recipient input
* Configurable delay between emails
* Per-sender hourly sending limits
* Redis-backed rate limiting
* Persistent BullMQ delayed jobs
* Dedicated email worker
* PostgreSQL persistence with Prisma
* Ethereal SMTP for safe email testing
* Scheduled Emails dashboard
* Sent Emails dashboard
* Email search
* Live BullMQ queue dashboard
* Configurable worker concurrency
* Idempotent job processing
* Restart-safe scheduled delivery
* Slack OAuth integration for rate-limit notifications
* Health and readiness endpoints

## Tech Stack

| Layer          | Technology                               |
| -------------- | ---------------------------------------- |
| Frontend       | Next.js, React, TypeScript, Tailwind CSS |
| Backend        | Express.js, TypeScript                   |
| Database       | PostgreSQL + Prisma                      |
| Queue          | BullMQ + Redis                           |
| Email          | Nodemailer + Ethereal SMTP               |
| Authentication | Auth.js + Google OAuth                   |
| Search         | Elasticsearch/OpenSearch-compatible API  |
| Testing        | Vitest + Supertest                       |

## Architecture

```text
                         ┌─────────────────────┐
                         │      Next.js UI     │
                         │  Dashboard / Compose│
                         └──────────┬──────────┘
                                    │ HTTP
                                    ▼
                         ┌─────────────────────┐
                         │    Express API      │
                         │                     │
                         │  Validate request   │
                         │  Store email        │
                         │  Enqueue job        │
                         └──────┬───────┬──────┘
                                │       │
                         Postgres│       │BullMQ
                                ▼       ▼
                       ┌───────────┐  ┌───────────┐
                       │ PostgreSQL│  │   Redis   │
                       │  Source   │  │   Queue   │
                       │ of truth  │  │           │
                       └───────────┘  └─────┬─────┘
                                            │
                                            ▼
                                   ┌─────────────────┐
                                   │  Email Worker   │
                                   │                 │
                                   │ Rate limiting   │
                                   │ Retry handling  │
                                   │ Idempotency     │
                                   └────────┬────────┘
                                            │
                                            ▼
                                      Ethereal SMTP
```

The API and worker run as separate processes.

The API persists scheduled emails in PostgreSQL and creates delayed BullMQ jobs. The worker consumes those jobs and handles SMTP delivery.

Scheduled jobs are stored in Redis/BullMQ rather than relying on in-memory timers, allowing future jobs to survive process restarts.

## Scheduling

For every recipient, the system creates:

1. A persistent `scheduled_emails` record in PostgreSQL.
2. A delayed BullMQ job in Redis.

The effective interval between emails considers both the requested delay and the hourly sending limit:

```text
effectiveStepMs =
  max(
    delay_between_emails_ms,
    ceil(3_600_000 / hourly_limit)
  )
```

Each email receives its own scheduled timestamp.

No cron jobs or in-memory timers are used for email scheduling.

## Rate Limiting

Email delivery is protected at worker execution time.

The system uses:

* Minimum interval between SMTP attempts
* Rolling hourly limit per sender
* Redis-backed shared rate-limit state

This allows rate limiting to work across multiple worker processes.

When the hourly limit is reached, the job is delayed until the next available sending slot instead of being dropped.

Example configuration:

```env
WORKER_CONCURRENCY=5
MIN_SEND_INTERVAL_MS=2000
MAX_EMAILS_PER_HOUR_PER_SENDER=200
```

## Persistence and Restart Safety

Email state is persisted in PostgreSQL and delivery jobs are persisted through BullMQ/Redis.

The worker does not depend on an in-memory schedule.

```text
Schedule email
      ↓
PostgreSQL + BullMQ
      ↓
Worker stopped
      ↓
Worker restarted
      ↓
BullMQ recovers delayed job
      ↓
Email sent
```

BullMQ job IDs use the scheduled email ID, providing an idempotent identifier for job processing.

## Dashboard

### Scheduled Emails

Displays:

* Recipient
* Subject
* Scheduled time
* Status

### Sent Emails

Displays:

* Recipient
* Subject
* Sent time
* Status

### Compose

The compose interface supports:

* Sender selection
* Subject
* Email body
* Multiple recipients
* CSV/text lead input
* Start time
* Delay between emails
* Hourly sending limit

## Search

Emails can be searched through:

```text
GET /api/emails/search?q=<term>
```

Search covers:

* Recipient email
* Sender email
* Subject
* Status

PostgreSQL remains the source of truth while Elasticsearch/OpenSearch acts as a searchable read projection.

## Live Queue Monitoring

BullMQ queue state is available at:

```text
http://localhost:4000/admin/queues
```

The dashboard provides visibility into:

* Waiting jobs
* Active jobs
* Delayed jobs
* Completed jobs
* Failed jobs

## How to Run

### Prerequisites

Make sure you have:

* Node.js 22.12+
* npm 10+
* PostgreSQL 14+
* Redis 6+

The project can use hosted PostgreSQL and Redis services such as Neon and Upstash.

You also need:

* Google OAuth credentials
* Ethereal SMTP credentials

### 1. Clone the repository

```bash
git clone https://github.com/Unnati061/reachinbox.git
cd reachinbox
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create environment files

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

### 4. Configure the backend

Update `backend/.env`:

```env
NODE_ENV=development
PORT=4000

DATABASE_URL=your_postgresql_connection_string
DIRECT_URL=your_direct_postgresql_connection_string

REDIS_URL=your_redis_connection_string

SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_USER=your_ethereal_username
SMTP_PASSWORD=your_ethereal_password
MAIL_FROM=your_ethereal_email

CORS_ORIGIN=http://localhost:3000

WORKER_CONCURRENCY=5
MIN_SEND_INTERVAL_MS=2000
MAX_EMAILS_PER_HOUR_PER_SENDER=200
```

For Upstash Redis, use the TLS connection URL provided by Upstash.

### 5. Configure Google OAuth

Update `frontend/.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
AUTH_SECRET=your_auth_secret
```

Configure this redirect URI in Google Cloud Console:

```text
http://localhost:3000/api/auth/callback/google
```

Do not commit `.env` or `.env.local` files.

### 6. Apply database migrations

```bash
npm run prisma:deploy
```

### 7. Register a sender

Before scheduling emails, register a sender:

```bash
npm run sender:create -- --email you@example.com --name "Your Name"
```

The sender must be registered before it can be used for scheduling.

### 8. Start the application

The easiest way to start the complete application is:

```bash
npm run dev:all
```

This starts:

```text
Frontend  → http://localhost:3000
Backend   → http://localhost:4000
Worker    → BullMQ email worker
```

Open:

```text
http://localhost:3000
```

Sign in with Google to access the dashboard.

## Run Services Individually

### Backend

```bash
npm run dev:backend
```

Runs the API on:

```text
http://localhost:4000
```

### Frontend

```bash
npm run dev:frontend
```

Runs the Next.js application on:

```text
http://localhost:3000
```

### Worker

```bash
npm run dev:worker
```

Starts the BullMQ email worker.

## Verify the Application

Check backend health:

```bash
curl http://localhost:4000/health
```

Check backend readiness:

```bash
curl http://localhost:4000/health/ready
```

Open the frontend:

```text
http://localhost:3000
```

Open the BullMQ dashboard:

```text
http://localhost:4000/admin/queues
```

## API

### Schedule Emails

```http
POST /api/emails/schedule
```

Example:

```json
{
  "sender": "you@example.com",
  "subject": "Hello",
  "body": "Hi there",
  "recipients": [
    "first@example.com",
    "second@example.com"
  ],
  "start_time": "2026-09-03T09:00:00Z",
  "delay_between_emails_ms": 60000,
  "hourly_limit": 30
}
```

### Scheduled Emails

```http
GET /api/emails/scheduled?page=1&per_page=25
```

### Sent Emails

```http
GET /api/emails/sent?page=1&per_page=25
```

### Search

```http
GET /api/emails/search?q=hello
```

### Health

```http
GET /health
```

### Readiness

```http
GET /health/ready
```

## Assignment Coverage

| Requirement           | Implementation                       |
| --------------------- | ------------------------------------ |
| Email scheduling      | BullMQ delayed jobs                  |
| Persistent scheduling | PostgreSQL + Redis                   |
| No cron               | BullMQ delayed jobs                  |
| Multiple recipients   | Batch scheduling                     |
| Sending delay         | Configurable per batch               |
| Hourly sending limit  | Redis-backed rolling limit           |
| Worker concurrency    | Configurable `WORKER_CONCURRENCY`    |
| Restart safety        | Persistent BullMQ jobs               |
| Idempotency           | Scheduled email ID as BullMQ job ID  |
| Email delivery        | Nodemailer + Ethereal                |
| Scheduled dashboard   | Next.js                              |
| Sent dashboard        | Next.js                              |
| Google OAuth          | Auth.js + Google                     |
| Queue visibility      | Live BullMQ dashboard                |
| Email search          | Elasticsearch/OpenSearch projection  |
| Slack integration     | OAuth-based rate-limit notifications |

## Testing

Run the test suite:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run typecheck
```

Run linting:

```bash
npm run lint
```

Build the application:

```bash
npm run build
```

## Security Notes

This project is intended for the hiring-assignment/demo environment.

Never commit:

* `.env`
* `.env.local`
* OAuth secrets
* SMTP credentials
* Database passwords
* Redis credentials

The backend API currently relies on local trusted access rather than coupling every `/api/*` request to the Google dashboard session. Do not expose the backend publicly without adding appropriate API authentication.
