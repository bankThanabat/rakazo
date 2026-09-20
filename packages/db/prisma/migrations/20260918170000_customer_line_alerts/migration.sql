CREATE TABLE "customer_alert_destinations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "connectionId" TEXT REFERENCES "connections"("id") ON DELETE SET NULL,
  "providerRef" TEXT NOT NULL,
  "botAccountId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "activeKey" TEXT UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'testing',
  "codeHash" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "failedVerifications" INTEGER NOT NULL DEFAULT 0,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("spaceId", "userId", "nonce")
);
CREATE INDEX "customer_alert_destinations_userId_idx" ON "customer_alert_destinations"("userId");
CREATE INDEX "customer_alert_destinations_connectionId_idx" ON "customer_alert_destinations"("connectionId");

-- A delivery ID must never acquire a different destination after an approval.
CREATE FUNCTION keep_customer_alert_destination_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW."spaceId", NEW."userId", NEW."providerRef", NEW."botAccountId", NEW."recipientId", NEW.kind, NEW.nonce)
     IS DISTINCT FROM ROW(OLD.id, OLD."spaceId", OLD."userId", OLD."providerRef", OLD."botAccountId", OLD."recipientId", OLD.kind, OLD.nonce)
     OR (NEW."connectionId" IS NOT NULL AND NEW."connectionId" IS DISTINCT FROM OLD."connectionId") THEN
    RAISE EXCEPTION 'Alert destination bindings are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_alert_destination_binding
  BEFORE UPDATE ON "customer_alert_destinations"
  FOR EACH ROW EXECUTE FUNCTION keep_customer_alert_destination_binding();
