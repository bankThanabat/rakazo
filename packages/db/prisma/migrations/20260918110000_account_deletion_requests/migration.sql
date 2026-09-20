CREATE TABLE "account_deletions" (
  "userId" TEXT PRIMARY KEY REFERENCES "user"("id") ON DELETE RESTRICT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "errorCode" TEXT
);
CREATE INDEX "account_deletions_nextAttemptAt_idx" ON "account_deletions"("nextAttemptAt");
CREATE TABLE "account_deletion_resources" (
  "userId" TEXT NOT NULL REFERENCES "account_deletions"("userId") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "providerKind" TEXT,
  "providerRef" TEXT,
  PRIMARY KEY ("userId", "kind", "spaceId", "key")
);

-- Serialize membership changes with the deletion claim. The resource record survives
-- a process restart, including organizations with no Space rows.
CREATE FUNCTION prevent_joining_deleted_account_organization() RETURNS trigger AS $$
BEGIN
  PERFORM id FROM "user" WHERE id = NEW."userId" FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM account_deletions WHERE "userId" = NEW."userId") THEN
    RAISE EXCEPTION 'Account unavailable' USING ERRCODE = '23503';
  END IF;
  PERFORM id FROM organization WHERE id = NEW."organizationId" FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM account_deletion_resources
             WHERE kind = 'organization' AND key = NEW."organizationId") THEN
    RAISE EXCEPTION 'Organization deletion requested' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER member_account_deletion_guard BEFORE INSERT OR UPDATE OF "organizationId", "userId" ON member
FOR EACH ROW EXECUTE FUNCTION prevent_joining_deleted_account_organization();

-- These resources deliberately outlive some other relationships. Guard new writes
-- with the user row lock so an already-authorized request cannot recreate them.
CREATE FUNCTION prevent_deleted_account_resource_writes() RETURNS trigger AS $$
BEGIN
  PERFORM id FROM "user" WHERE id = NEW."userId" FOR SHARE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM account_deletions WHERE "userId" = NEW."userId") THEN
    RAISE EXCEPTION 'Account unavailable' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bot_account_deletion_guard BEFORE INSERT OR UPDATE OF "userId" ON bots
FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_resource_writes();
CREATE TRIGGER artifact_account_deletion_guard BEFORE INSERT OR UPDATE OF "userId" ON artifacts
FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_resource_writes();
CREATE TRIGGER computer_account_deletion_guard BEFORE INSERT OR UPDATE OF "userId" ON computers
FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_resource_writes();
CREATE TRIGGER runtime_account_deletion_guard BEFORE INSERT OR UPDATE OF "userId" ON gateway_runtimes
FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_resource_writes();
CREATE TRIGGER session_account_deletion_guard BEFORE INSERT OR UPDATE OF "userId" ON session
FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_resource_writes();

-- Retain cleanup identities even when an ordinary bot deletion precedes the account request.
ALTER TABLE bot_deletions ADD COLUMN "userId" TEXT,
  ADD COLUMN "artifactKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "homeKey" TEXT,
  ADD COLUMN "computerKind" TEXT,
  ADD COLUMN "providerRef" TEXT;
CREATE TRIGGER connection_account_deletion_guard BEFORE INSERT OR UPDATE OF "userId" ON connections
FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_resource_writes();

-- A membership removal must recheck after the account worker's organization lock.
-- Cascading organization/user deletion is handled by its own lifecycle transaction.
CREATE FUNCTION prevent_last_membership_removal() RETURNS trigger AS $$
BEGIN
  PERFORM id FROM organization WHERE id = OLD."organizationId" FOR UPDATE;
  IF FOUND AND EXISTS (SELECT 1 FROM "user" WHERE id = OLD."userId")
     AND NOT EXISTS (SELECT 1 FROM member WHERE "organizationId" = OLD."organizationId" AND id <> OLD.id) THEN
    RAISE EXCEPTION 'Cannot remove the last organization member' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER member_deletion_guard BEFORE DELETE ON member
FOR EACH ROW EXECUTE FUNCTION prevent_last_membership_removal();
