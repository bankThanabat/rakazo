ALTER TABLE customer_channels
  ADD COLUMN shared BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "websiteOrigins" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "dailyMessageLimit" INTEGER NOT NULL DEFAULT 1000 CHECK ("dailyMessageLimit" > 0),
  ADD COLUMN "hourlyCustomerLimit" INTEGER NOT NULL DEFAULT 30 CHECK ("hourlyCustomerLimit" > 0),
  ADD COLUMN "retentionDays" INTEGER CHECK ("retentionDays" > 0);
ALTER TABLE customer_conversations
  ADD COLUMN state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  ADD COLUMN "assigneeId" TEXT,
  ADD COLUMN "handoffReason" TEXT,
  ADD COLUMN "draftText" TEXT,
  ADD COLUMN "draftForSeq" INTEGER,
  ADD COLUMN "notifiedGeneration" INTEGER NOT NULL DEFAULT -1,
  ADD COLUMN "lastCustomerSeq" INTEGER NOT NULL DEFAULT 0;
UPDATE customer_conversations c SET "lastCustomerSeq" = COALESCE(
  (SELECT max(seq) FROM customer_messages m WHERE m."conversationId" = c.id AND m.role = 'customer'), 0);
ALTER TABLE customer_messages
  ADD COLUMN "sentParts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "errorCode" TEXT;
ALTER TABLE customer_tool_calls ADD COLUMN name TEXT NOT NULL DEFAULT '';
CREATE TABLE customer_conversation_reads (
  "conversationId" TEXT NOT NULL REFERENCES customer_conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("conversationId", "userId")
);
CREATE TABLE customer_visitor_sessions (
  "tokenHash" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES customer_conversations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  origin TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX customer_visitor_sessions_expiry ON customer_visitor_sessions ("expiresAt");
