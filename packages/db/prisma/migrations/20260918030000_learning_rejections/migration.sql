ALTER TABLE "learning_tasks" ADD COLUMN "correctionKey" TEXT,
ADD COLUMN "inferenceKey" TEXT,
ADD COLUMN "rejectedAt" TIMESTAMP(3),
ADD COLUMN "rejectionOverride" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "learning_tasks_botId_rejectedAt_idx" ON "learning_tasks"("botId", "rejectedAt");
