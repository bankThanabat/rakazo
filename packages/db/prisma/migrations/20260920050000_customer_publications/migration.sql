CREATE TABLE "customer_publications" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'preparing',
  "flowId" TEXT,
  "confirmed" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "inUseUntil" TIMESTAMP(3),
  "claimId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "customer_publications_nextAttemptAt_idx" ON "customer_publications"("nextAttemptAt");
CREATE INDEX "customer_publications_userId_idx" ON "customer_publications"("userId");
ALTER TABLE "customer_behaviors" ADD COLUMN "publicationId" TEXT;
CREATE UNIQUE INDEX "customer_behaviors_publicationId_key" ON "customer_behaviors"("publicationId");
ALTER TABLE "customer_behaviors" ADD CONSTRAINT "customer_behaviors_publicationId_fkey"
  FOREIGN KEY ("publicationId") REFERENCES "customer_publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
