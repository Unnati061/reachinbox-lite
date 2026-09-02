-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "email_status" AS ENUM ('pending', 'processing', 'sent', 'failed');

-- CreateTable
CREATE TABLE "senders" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "smtp_credential_ref" TEXT NOT NULL DEFAULT 'default',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "senders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_batches" (
    "id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "delay_between_emails_ms" INTEGER NOT NULL,
    "hourly_limit" INTEGER,
    "effective_step_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_emails" (
    "id" UUID NOT NULL,
    "batch_id" UUID,
    "sender_id" UUID NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "email_status" NOT NULL DEFAULT 'pending',
    "bullmq_job_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "scheduled_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "senders_email_key" ON "senders"("email");

-- CreateIndex
CREATE INDEX "schedule_batches_sender_id_created_at_idx" ON "schedule_batches"("sender_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_emails_bullmq_job_id_key" ON "scheduled_emails"("bullmq_job_id");

-- CreateIndex
CREATE INDEX "scheduled_emails_status_scheduled_at_idx" ON "scheduled_emails"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "scheduled_emails_sender_id_scheduled_at_idx" ON "scheduled_emails"("sender_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "scheduled_emails_batch_id_idx" ON "scheduled_emails"("batch_id");

-- AddForeignKey
ALTER TABLE "schedule_batches" ADD CONSTRAINT "schedule_batches_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "senders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "senders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_emails" ADD CONSTRAINT "scheduled_emails_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "schedule_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
