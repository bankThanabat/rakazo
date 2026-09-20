import { randomUUID } from "node:crypto";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

/** Loopback-only synthetic memory service for authenticated browser preview/apply journeys. */
export function semanticDirectFixture(
  prisma: PrismaClient,
  baseUrl: string,
  encryptionKey: string,
) {
  const entities = new Map<
    string,
    {
      facts: { id: string; memory: string; isLatest: boolean; isForgotten: boolean }[];
      writes: number;
    }
  >();
  const key = "synthetic-direct-memory-key";
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/semantic-direct" && request.method === "POST") {
      const { email } = (await request.json()) as { email: string };
      if (!email.endsWith("@rakazo.test")) return new Response(null, { status: 400 });
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      const bot = await prisma.bot.findFirstOrThrow({
        where: { userId: user.id, archivedAt: null },
      });
      const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      await prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", ownerUserId: user.id },
        update: { ownerUserId: user.id },
      });
      const secretId = randomUUID();
      const secret = await prisma.secret.create({
        data: {
          id: secretId,
          userId: user.id,
          spaceId: bot.spaceId,
          kind: "memory",
          ciphertext: new EncryptedSecretStore(encryptionKey).seal(
            JSON.stringify({ apiKey: key }),
            secretId,
          ),
        },
      });
      const config = await prisma.spaceMemoryConfig.create({
        data: {
          userId: user.id,
          spaceId: bot.spaceId,
          secretId: secret.id,
          provider: "supermemory",
          settings: { mode: "local", baseUrl: `${baseUrl}/__e2e/semantic-provider` },
        },
      });
      const entity = `rakazo:${bot.id}`;
      const ending = "\nEnd of reviewed fact.";
      const body = `Start of owner-reviewed fact.\n${"Keep staff context private.\n".repeat(400)}`;
      const content = `${body.slice(0, 10000 - ending.length)}${ending}`;
      const id = randomUUID();
      entities.set(entity, {
        facts: [{ id: "original-fact", memory: content, isLatest: true, isForgotten: false }],
        writes: 0,
      });
      await prisma.semanticMemoryMutation.create({
        data: {
          id,
          userId: user.id,
          spaceId: bot.spaceId,
          botId: bot.id,
          sourceRunId: "retained-synthetic-run",
          sourceThreadId: thread.id,
          provider: "supermemory",
          configurationRevision: `${config.id}:${config.updatedAt.toISOString()}`,
          scope: "isolated",
          operation: "save",
          status: "completed",
          request: { content, reason: "Synthetic staff preference" },
          result: {
            ok: true,
            value: [{ version: 1, id: "original-fact", entity, content, created: true }],
          },
        },
      });
      return Response.json({ botId: bot.id, mutationId: id, entity, content });
    }
    if (url.pathname === "/__e2e/semantic-direct-state")
      return Response.json(entities.get(url.searchParams.get("entity") ?? "") ?? null);
    if (!url.pathname.startsWith("/__e2e/semantic-provider/")) return null;
    if (request.headers.get("authorization") !== `Bearer ${key}`)
      return new Response(null, { status: 401 });
    const body = (await request.json()) as {
      containerTag?: string;
      containerTags?: string[];
      id?: string;
      memories?: { content: string }[];
    };
    const state = entities.get(body.containerTag ?? body.containerTags?.[0] ?? "");
    if (!state) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/v4/memories/list"))
      return Response.json({
        memoryEntries: state.facts,
        pagination: { currentPage: 1, totalPages: 1, totalItems: state.facts.length },
      });
    if (request.method === "DELETE") {
      const fact = state.facts.find((value) => value.id === body.id);
      if (!fact) return new Response(null, { status: 404 });
      fact.isForgotten = true;
      state.writes++;
      return Response.json({ id: fact.id, forgotten: true });
    }
    if (url.pathname.endsWith("/v4/memories") && body.memories?.length === 1) {
      const fact = {
        id: `restored-${state.writes}`,
        memory: body.memories[0]!.content,
        isLatest: true,
        isForgotten: false,
      };
      state.facts.push(fact);
      state.writes++;
      return Response.json({ memories: [{ id: fact.id, memory: fact.memory }] }, { status: 201 });
    }
    return new Response(null, { status: 400 });
  };
}
