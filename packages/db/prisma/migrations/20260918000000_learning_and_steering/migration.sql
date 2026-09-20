-- AlterTable
ALTER TABLE "customer_behaviors" ADD COLUMN     "assessment" JSONB;

-- CreateTable
CREATE TABLE "customer_guidance" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "inFlight" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_guidance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_documents" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "customerVisible" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_revisions" (
    "agentId" TEXT,
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "customerVisible" BOOLEAN NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "restoredFrom" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_guidance_conversationId_nonce_key" ON "customer_guidance"("conversationId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "learning_documents_spaceId_scopeKey_kind_key_key" ON "learning_documents"("spaceId", "scopeKey", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "learning_revisions_documentId_revision_key" ON "learning_revisions"("documentId", "revision");

-- AddForeignKey
ALTER TABLE "customer_guidance" ADD CONSTRAINT "customer_guidance_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_documents" ADD CONSTRAINT "learning_documents_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_revisions" ADD CONSTRAINT "learning_revisions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "learning_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

