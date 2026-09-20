-- Keep the existing table and ID column so historical comment receipts need no rewrite.
-- A confirmed DM must match both its returned message ID and intended recipient.
ALTER TABLE instagram_comment_writes
  DROP CONSTRAINT instagram_comment_writes_result_check,
  ADD CONSTRAINT instagram_comment_writes_result_check CHECK (
    ("commentId" IS NULL AND result IS NULL) OR
    ("commentId" IS NOT NULL AND result IS NOT NULL AND
      COALESCE(jsonb_typeof(result) = 'object' AND
        CASE
          WHEN action = 'instagram.send_message' THEN
            jsonb_typeof(result->'messageId') = 'string' AND
            result->>'messageId' = "commentId" AND
            jsonb_typeof(result->'recipientId') = 'string' AND
            result->>'recipientId' = "targetId"
          WHEN action IS NULL OR action IN ('instagram.create_comment', 'instagram.reply_to_comment') THEN
            result->>'commentId' = "commentId"
          ELSE false
        END, false))
  );
