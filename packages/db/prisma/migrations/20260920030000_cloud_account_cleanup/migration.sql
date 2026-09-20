CREATE INDEX "cloud_agents_userId_idx" ON "cloud_agents"("userId");

-- Cloud records survive chat deletion to retain remote cleanup identities.
-- Serialize new records with the account deletion request's user lifecycle lock.
CREATE TRIGGER cloud_agent_account_deletion_guard BEFORE INSERT OR UPDATE OF "userId" ON cloud_agents
FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_resource_writes();

-- Existing deletion requests must also fence workers that captured old intent.
UPDATE cloud_agents SET "cancelRequested" = TRUE, version = version + 1,
  "nextPollAt" = CURRENT_TIMESTAMP
WHERE status = 'running' AND "userId" IN (SELECT "userId" FROM account_deletions);
