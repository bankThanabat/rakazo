import { ORPCError } from "@orpc/server";
import { BUILTIN_AGENT_SKILLS } from "@rakazo/adapters";
import type { Actor, AgentSkill } from "@rakazo/contracts";
import { findSkillByName, mergeBuiltinSkills } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createAgentSkillStore, IsolationError } from "@rakazo/db";

function builtinCatalog(): AgentSkill[] {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    ...skill,
    id: `builtin:${skill.name}`,
    source: "builtin",
    readOnly: true,
    revision: 0,
    removedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
}

export function createAgentSkillsService(prisma: PrismaClient) {
  const store = createAgentSkillStore(
    prisma,
    BUILTIN_AGENT_SKILLS.map((skill) => skill.name),
  );
  async function listWithContent(actor: Actor): Promise<AgentSkill[]> {
    return mergeBuiltinSkills(builtinCatalog(), await store.list(actor));
  }
  async function mutation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof IsolationError) throw error;
      throw new ORPCError("BAD_REQUEST", {
        message:
          error instanceof Error && (error.name === "Error" || error.name === "ZodError")
            ? error.message
            : "Could not change skill.",
      });
    }
  }
  return {
    listWithContent,
    async list(actor: Actor) {
      return (await listWithContent(actor)).map(({ content: _content, ...entry }) => entry);
    },
    async get(actor: Actor, input: { skillId?: string; name?: string }) {
      const skills = await listWithContent(actor);
      const found = input.skillId
        ? skills.find((skill) => skill.id === input.skillId)
        : findSkillByName(skills, input.name ?? "");
      if (!found) throw new IsolationError();
      return found;
    },
    create: (actor: Actor, input: Parameters<typeof store.create>[1]) =>
      mutation(() => store.create(actor, input)),
    update: (actor: Actor, input: Parameters<typeof store.update>[1]) =>
      mutation(() => store.update(actor, input)),
    remove: (actor: Actor, input: unknown) => mutation(() => store.remove(actor, input)),
    listHistory: store.listHistory,
    history: store.history,
    readVersion: store.readVersion,
    previewUndo: store.previewUndo,
    undo: (actor: Actor, input: unknown) => mutation(() => store.undo(actor, input)),
    restore: (actor: Actor, input: unknown) => mutation(() => store.restore(actor, input)),
  };
}
export type AgentSkillsService = ReturnType<typeof createAgentSkillsService>;
