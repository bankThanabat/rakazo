-- Enforce new writes first. Existing orphan cleanup and validation follow in a
-- separate migration so the metadata locks do not cover the data scan.
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "customer_conversation_reads" ADD CONSTRAINT "customer_conversation_reads_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "customer_conversations" ADD CONSTRAINT "customer_conversations_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
