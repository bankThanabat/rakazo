-- Shared Spaces survive account deletion. Remove orphan private records left
-- by older versions; the preceding constraints already prevent new orphans.
DELETE FROM "memory_documents" WHERE NOT EXISTS (
  SELECT 1 FROM "user" WHERE "user".id = "memory_documents"."userId"
);
DELETE FROM "notification_preferences" WHERE NOT EXISTS (
  SELECT 1 FROM "user" WHERE "user".id = "notification_preferences"."userId"
);
DELETE FROM "customer_conversation_reads" WHERE NOT EXISTS (
  SELECT 1 FROM "user" WHERE "user".id = "customer_conversation_reads"."userId"
);
UPDATE "customer_conversations" SET "assigneeId" = NULL
WHERE "assigneeId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "user" WHERE "user".id = "customer_conversations"."assigneeId"
);

ALTER TABLE "memory_documents" VALIDATE CONSTRAINT "memory_documents_userId_fkey";
ALTER TABLE "notification_preferences" VALIDATE CONSTRAINT "notification_preferences_userId_fkey";
ALTER TABLE "customer_conversation_reads" VALIDATE CONSTRAINT "customer_conversation_reads_userId_fkey";
ALTER TABLE "customer_conversations" VALIDATE CONSTRAINT "customer_conversations_assigneeId_fkey";
