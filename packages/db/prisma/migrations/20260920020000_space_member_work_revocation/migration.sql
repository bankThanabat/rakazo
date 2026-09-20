-- Keep cancellation and the orphan backfill bounded to each member's work.
CREATE INDEX "runs_spaceId_userId_status_idx" ON runs ("spaceId", "userId", status);
CREATE INDEX "routines_spaceId_userId_active_idx" ON routines ("spaceId", "userId", active);

-- Membership can disappear through an organization cascade as well as direct
-- removal. Stop work in that same transaction, retaining its history and effects.
CREATE FUNCTION stop_space_member_work(target_space TEXT, target_user TEXT) RETURNS void AS $$
BEGIN
  WITH stopped AS (
    UPDATE runs SET status = 'cancelled', "completedAt" = CURRENT_TIMESTAMP,
      "leaseOwner" = NULL, "leaseExpiresAt" = NULL, error = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "spaceId" = target_space AND "userId" = target_user
      AND status IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
    RETURNING id, "taskId"
  ), stopped_attempts AS (
    UPDATE attempts SET status = 'cancelled', "finishedAt" = CURRENT_TIMESTAMP
    WHERE "runId" IN (SELECT id FROM stopped) AND status = 'running'
  )
  UPDATE tasks SET status = 'cancelled', "updatedAt" = CURRENT_TIMESTAMP
  WHERE id IN (SELECT "taskId" FROM stopped);

  UPDATE routines SET active = false, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "spaceId" = target_space AND "userId" = target_user AND active;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION revoke_space_member_work() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."spaceId" IS DISTINCT FROM NEW."spaceId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId" THEN
    PERFORM stop_space_member_work(OLD."spaceId", OLD."userId");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER space_member_work_revocation
AFTER DELETE OR UPDATE OF "spaceId", "userId" ON space_members
FOR EACH ROW EXECUTE FUNCTION revoke_space_member_work();

-- A request authenticated before removal must not create work afterward. The
-- membership lock orders new work against removal until its transaction commits.
CREATE FUNCTION require_work_membership() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'routines' THEN
    IF NOT NEW.active THEN RETURN NEW; END IF;
  END IF;
  PERFORM id FROM space_members
    WHERE "spaceId" = NEW."spaceId" AND "userId" = NEW."userId" FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Space membership required for work' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER run_membership_guard BEFORE INSERT OR UPDATE OF "spaceId", "userId" ON runs
FOR EACH ROW EXECUTE FUNCTION require_work_membership();
CREATE TRIGGER routine_membership_guard BEFORE INSERT OR UPDATE OF "spaceId", "userId", active ON routines
FOR EACH ROW EXECUTE FUNCTION require_work_membership();

-- Retire previously orphaned work once, without changing terminal outcomes or
-- deleting retained requests, receipts, or any member's data.
SELECT stop_space_member_work(orphan."spaceId", orphan."userId") FROM (
  SELECT "spaceId", "userId" FROM runs
    WHERE status IN ('queued', 'leased', 'running', 'waiting_input', 'waiting_takeover')
  UNION
  SELECT "spaceId", "userId" FROM routines WHERE active
) AS orphan
WHERE NOT EXISTS (
  SELECT 1 FROM space_members AS m
  WHERE m."spaceId" = orphan."spaceId" AND m."userId" = orphan."userId"
);
