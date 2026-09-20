ALTER TABLE "semantic_memory_mutations"
  ADD COLUMN "reversesId" TEXT,
  ADD COLUMN "reversalKey" TEXT;

-- Retained across source-run deletion. Failed pre-dispatch reversals release their key.
CREATE UNIQUE INDEX "semantic_memory_mutations_reversalKey_key"
  ON "semantic_memory_mutations"("reversalKey");
