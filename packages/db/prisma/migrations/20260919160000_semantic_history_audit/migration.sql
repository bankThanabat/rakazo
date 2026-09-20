-- Background conversation compaction has a thread source, but no agent run.
ALTER TABLE "semantic_memory_mutations" ALTER COLUMN "sourceRunId" DROP NOT NULL;
