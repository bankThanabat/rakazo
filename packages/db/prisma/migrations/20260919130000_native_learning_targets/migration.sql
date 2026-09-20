ALTER TABLE learning_tasks ADD COLUMN "targetKind" TEXT NOT NULL DEFAULT 'document';
ALTER TABLE memory_revisions ADD COLUMN "learningTaskId" TEXT;
ALTER TABLE agent_skill_revisions ADD COLUMN "learningTaskId" TEXT;
ALTER TABLE memory_revisions ADD CONSTRAINT memory_revisions_learning_task_fkey FOREIGN KEY ("learningTaskId") REFERENCES learning_tasks(id) ON DELETE SET NULL;
ALTER TABLE agent_skill_revisions ADD CONSTRAINT agent_skill_revisions_learning_task_fkey FOREIGN KEY ("learningTaskId") REFERENCES learning_tasks(id) ON DELETE SET NULL;
CREATE INDEX memory_revisions_learning_task_idx ON memory_revisions("learningTaskId");
CREATE INDEX agent_skill_revisions_learning_task_idx ON agent_skill_revisions("learningTaskId");
CREATE INDEX learning_tasks_native_target_idx ON learning_tasks("spaceId", "userId", "targetKind", "documentId");
