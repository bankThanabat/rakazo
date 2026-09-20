ALTER TABLE "learning_documents" ADD COLUMN "botId" TEXT;
UPDATE "learning_documents" AS document SET "botId" = bot.id
FROM "bots" AS bot WHERE document."scopeKey" = bot.id AND document."spaceId" = bot."spaceId";
ALTER TABLE "learning_documents" ADD CONSTRAINT "learning_documents_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "learning_documents_botId_idx" ON "learning_documents"("botId");
