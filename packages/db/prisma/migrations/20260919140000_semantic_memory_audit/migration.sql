CREATE TABLE "semantic_memory_mutations" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "sourceRunId" TEXT NOT NULL,
  "sourceThreadId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "configurationRevision" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "semantic_memory_mutations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_memory_mutations_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "semantic_memory_mutations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "semantic_memory_mutations_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "semantic_memory_mutations_spaceId_userId_botId_id_idx" ON "semantic_memory_mutations"("spaceId", "userId", "botId", "id");
