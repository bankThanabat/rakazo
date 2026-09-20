ALTER TABLE instagram_comment_writes ADD COLUMN "accountHash" TEXT;
CREATE INDEX "instagram_comment_writes_accountHash_commentId_idx"
  ON instagram_comment_writes("accountHash", "commentId");
