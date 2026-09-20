CREATE TABLE learning_histories (
  id TEXT PRIMARY KEY,
  "importId" TEXT NOT NULL UNIQUE REFERENCES learning_imports(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('bot', 'space')),
  "sourceKey" TEXT NOT NULL,
  "exportKey" TEXT,
  "connectionId" TEXT,
  "connectionOwnerId" TEXT,
  "providerRef" TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'complete', 'failed', 'cancelled')),
  "nextRow" INTEGER NOT NULL DEFAULT 0 CHECK ("nextRow" >= 0),
  accepted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  earliest TIMESTAMP(3), latest TIMESTAMP(3),
  errors TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  error TEXT,
  "completedAt" TIMESTAMP(3), "summarizedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK (("connectionId" IS NULL AND "connectionOwnerId" IS NULL AND "providerRef" IS NULL)
    OR ("connectionId" IS NOT NULL AND "connectionOwnerId" IS NOT NULL AND "providerRef" IS NOT NULL))
);
CREATE INDEX "learning_histories_status_updatedAt_idx" ON learning_histories(status, "updatedAt");
CREATE TABLE learning_history_items (
  "botId" TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "sourceKey" TEXT NOT NULL,
  identity TEXT NOT NULL,
  digest TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("botId", "sourceKey", identity, digest)
);
