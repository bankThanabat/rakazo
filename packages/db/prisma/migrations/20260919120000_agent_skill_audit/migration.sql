-- Remove inaccessible legacy orphan rows before enforcing account ownership.
DELETE FROM agent_skills WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE "user".id = agent_skills."userId");
ALTER TABLE agent_skills ADD CONSTRAINT "agent_skills_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE agent_skills VALIDATE CONSTRAINT "agent_skills_userId_fkey";
CREATE INDEX "agent_skills_userId_idx" ON agent_skills("userId");
ALTER TABLE agent_skills ADD COLUMN revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "removedAt" TIMESTAMP(3);
DROP INDEX "agent_skills_spaceId_userId_name_lower_key";
CREATE UNIQUE INDEX "agent_skills_spaceId_userId_name_lower_key"
  ON agent_skills ("spaceId", "userId", lower(name)) WHERE "removedAt" IS NULL;
CREATE TABLE agent_skill_revisions (
  id TEXT PRIMARY KEY,
  "skillId" TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE ON UPDATE CASCADE,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  removed BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'baseline',
  "actorKind" TEXT NOT NULL DEFAULT 'unknown',
  "agentId" TEXT, "sourceRunId" TEXT, "sourceThreadId" TEXT,
  "restoredFrom" INTEGER, "undoneRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "agent_skill_revisions_skillId_revision_key" ON agent_skill_revisions("skillId", revision);
INSERT INTO agent_skill_revisions (id, "skillId", revision, content, reason, "createdAt")
SELECT 'baseline:' || id, id, revision, content, 'Existing skill snapshot', "updatedAt" FROM agent_skills;
