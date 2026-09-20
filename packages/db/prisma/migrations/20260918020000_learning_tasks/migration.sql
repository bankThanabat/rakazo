-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "learningEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "learningSummaryAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "learning_tasks" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "proposal" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "documentId" TEXT,
    "appliedRevision" INTEGER,
    "reviewedByUserId" TEXT,
    "reviewReason" TEXT,
    "summarizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_task_reviews" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_task_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_tasks_status_nextAttemptAt_idx" ON "learning_tasks"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "learning_tasks_botId_sourceKey_key" ON "learning_tasks"("botId", "sourceKey");

-- CreateIndex
CREATE INDEX "learning_task_reviews_taskId_createdAt_idx" ON "learning_task_reviews"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "learning_tasks" ADD CONSTRAINT "learning_tasks_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_tasks" ADD CONSTRAINT "learning_tasks_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_tasks" ADD CONSTRAINT "learning_tasks_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_task_reviews" ADD CONSTRAINT "learning_task_reviews_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "learning_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

