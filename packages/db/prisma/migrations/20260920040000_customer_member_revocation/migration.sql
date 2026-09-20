-- Customer work also runs outside the staff run queue. Retire its authority in
-- the membership transaction so a later rejoin cannot revive an old execution.
CREATE FUNCTION stop_space_member_customer_work(target_space TEXT, target_user TEXT) RETURNS void AS $$
BEGIN
  UPDATE customer_channels SET enabled = false, "autoReplies" = false,
    "pollToken" = NULL, "pollUntil" = NULL, "nextPollAt" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "spaceId" = target_space AND "userId" = target_user;

  -- Match receive/dispatch lock order: channels, conversations, then messages.
  -- Keep leases and already-dispatched sends for recording their actual outcome.
  UPDATE customer_conversations SET generation = generation + 1, owner = 'staff',
    "needsHuman" = false, "nextAttentionAlertAt" = NULL,
    "ownerAttentionAlertAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "channelId" IN (
    SELECT id FROM customer_channels WHERE "spaceId" = target_space AND "userId" = target_user
  );

  UPDATE customer_messages SET status = 'cancelled'
  WHERE status IN ('queued', 'processing') AND "conversationId" IN (
    SELECT c.id FROM customer_conversations c JOIN customer_channels ch ON ch.id = c."channelId"
    WHERE ch."spaceId" = target_space AND ch."userId" = target_user
  );
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION revoke_space_member_customer_work() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."spaceId" IS DISTINCT FROM NEW."spaceId"
     OR OLD."userId" IS DISTINCT FROM NEW."userId" THEN
    PERFORM stop_space_member_customer_work(OLD."spaceId", OLD."userId");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER space_member_customer_revocation
AFTER DELETE OR UPDATE OF "spaceId", "userId" ON space_members
FOR EACH ROW EXECUTE FUNCTION revoke_space_member_customer_work();

CREATE FUNCTION require_customer_channel_membership() RETURNS trigger AS $$
BEGIN
  IF NOT NEW.enabled THEN RETURN NEW; END IF;
  -- An UPDATE already holds the channel row. Do not wait on a removal that
  -- holds membership and needs that channel; reject activation until it finishes.
  PERFORM id FROM space_members
    WHERE "spaceId" = NEW."spaceId" AND "userId" = NEW."userId" FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Space membership required for customer channel' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_channel_membership_guard
BEFORE INSERT OR UPDATE OF "spaceId", "userId", enabled, "autoReplies" ON customer_channels
FOR EACH ROW EXECUTE FUNCTION require_customer_channel_membership();

-- Retire legacy orphan channels without deleting conversations or receipts.
SELECT stop_space_member_customer_work(orphan."spaceId", orphan."userId") FROM (
  SELECT DISTINCT "spaceId", "userId" FROM customer_channels
) AS orphan
WHERE NOT EXISTS (
  SELECT 1 FROM space_members m
  WHERE m."spaceId" = orphan."spaceId" AND m."userId" = orphan."userId"
);
