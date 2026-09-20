CREATE TABLE instagram_comment_writes (
  id TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "executionKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "commentId" TEXT,
  result JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT instagram_comment_writes_result_check CHECK (
    ("commentId" IS NULL AND result IS NULL) OR
    ("commentId" IS NOT NULL AND result IS NOT NULL AND
      COALESCE(jsonb_typeof(result) = 'object' AND result->>'commentId' = "commentId", false))
  )
);
CREATE UNIQUE INDEX "instagram_comment_writes_spaceId_executionKey_key"
  ON instagram_comment_writes("spaceId", "executionKey");
CREATE INDEX "instagram_comment_writes_spaceId_commentId_idx"
  ON instagram_comment_writes("spaceId", "commentId");
