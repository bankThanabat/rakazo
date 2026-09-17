-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "knowledgeLibraryId" TEXT;

-- CreateTable
CREATE TABLE "knowledge_libraries" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT true,
    "activeRevisionId" TEXT,
    "pendingRevisionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_revisions" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "providerDocumentKey" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "providerTaskId" TEXT,
    "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
    "cleanupAfter" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "claimId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_libraries_spaceId_key" ON "knowledge_libraries"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sources_activeRevisionId_key" ON "knowledge_sources"("activeRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sources_pendingRevisionId_key" ON "knowledge_sources"("pendingRevisionId");

-- CreateIndex
CREATE INDEX "knowledge_sources_libraryId_deletedAt_idx" ON "knowledge_sources"("libraryId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_revisions_providerDocumentKey_key" ON "knowledge_revisions"("providerDocumentKey");

-- CreateIndex
CREATE INDEX "knowledge_revisions_status_leaseUntil_idx" ON "knowledge_revisions"("status", "leaseUntil");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_knowledgeLibraryId_fkey" FOREIGN KEY ("knowledgeLibraryId") REFERENCES "knowledge_libraries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_libraries" ADD CONSTRAINT "knowledge_libraries_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "knowledge_libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

