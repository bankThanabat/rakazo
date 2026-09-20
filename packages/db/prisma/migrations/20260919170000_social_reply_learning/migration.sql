ALTER TABLE learning_feeds
  ADD COLUMN "includeReplies" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN coverage JSONB NOT NULL DEFAULT '{}';
