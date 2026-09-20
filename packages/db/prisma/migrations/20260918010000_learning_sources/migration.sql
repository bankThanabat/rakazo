-- AlterTable
ALTER TABLE "learning_revisions" ADD COLUMN     "sourceRef" JSONB;

-- CreateTable
CREATE TABLE "learning_imports" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "content" TEXT,
    "coverage" JSONB NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "learning_imports_spaceId_botId_digest_key" ON "learning_imports"("spaceId", "botId", "digest");

-- AddForeignKey
ALTER TABLE "learning_imports" ADD CONSTRAINT "learning_imports_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_imports" ADD CONSTRAINT "learning_imports_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

