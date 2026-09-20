CREATE TABLE "computer_provisions" (
  "id" TEXT PRIMARY KEY,
  "computerId" TEXT NOT NULL UNIQUE,
  "homeKey" TEXT NOT NULL UNIQUE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE RESTRICT,
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'cleanup', 'cleaning', 'uncertain')),
  "kind" TEXT,
  "providerRef" TEXT,
  "cleanup" TEXT CHECK ("cleanup" IN ('stop', 'destroy', 'none')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "computer_provisions_status_updatedAt_idx" ON "computer_provisions"("status", "updatedAt");
CREATE INDEX "computer_provisions_userId_idx" ON "computer_provisions"("userId");
