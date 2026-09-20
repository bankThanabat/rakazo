ALTER TABLE instagram_comment_writes
  ADD COLUMN "bindingHash" TEXT,
  ADD COLUMN action TEXT,
  ADD COLUMN "targetId" TEXT;
CREATE INDEX "instagram_comment_writes_spaceId_bindingHash_id_idx"
  ON instagram_comment_writes("spaceId", "bindingHash", id);
