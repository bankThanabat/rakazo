ALTER TABLE "connections" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "connections" ADD CONSTRAINT "connections_scope_check" CHECK ("scope" IN ('user', 'team'));
CREATE INDEX "connections_spaceId_scope_idx" ON "connections"("spaceId", "scope");
