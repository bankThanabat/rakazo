ALTER TABLE memory_revisions
  ADD COLUMN "actorKind" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN reason TEXT NOT NULL DEFAULT 'Memory saved',
  ADD COLUMN "agentId" TEXT,
  ADD COLUMN "restoredFrom" INTEGER,
  ADD COLUMN "undoneRevision" INTEGER;
-- Preserve the only known version for legacy documents. Do not invent older content.
INSERT INTO memory_revisions (id, "documentId", revision, content, reason, "createdAt")
SELECT 'baseline:' || document.id, document.id, document.revision, document.content,
  'Existing memory snapshot', document."updatedAt"
FROM memory_documents document
WHERE NOT EXISTS (SELECT 1 FROM memory_revisions revision
  WHERE revision."documentId" = document.id AND revision.revision = document.revision);
