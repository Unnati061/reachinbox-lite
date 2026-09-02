CREATE TABLE "slack_integrations" (
    "id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT,
    "channel_id" TEXT NOT NULL,
    "channel_name" TEXT,
    "webhook_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "slack_integrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "slack_integrations_sender_id_key" ON "slack_integrations"("sender_id");
ALTER TABLE "slack_integrations" ADD CONSTRAINT "slack_integrations_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "senders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
