import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { CustomerPreviewInput } from "@rakazo/contracts";
import { CUSTOMER_PREVIEW_PROVIDER } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createCustomerInbox, requirePrivateOwner } from "@rakazo/db";

/** Exercise the real customer processor in a private, disposable local channel. */
export async function previewCustomerReply(
  prisma: PrismaClient,
  process: (conversationId: string, signal?: AbortSignal) => Promise<void>,
  actor: Pick<Actor, "spaceId" | "userId">,
  botId: string,
  raw: unknown,
  signal?: AbortSignal,
) {
  const { message } = CustomerPreviewInput.parse(raw);
  signal?.throwIfAborted();
  await requirePrivateOwner(prisma, actor, botId);
  const behavior = await prisma.customerBehavior.findUnique({ where: { botId } });
  if (!behavior) throw new Error("Configure customer behavior before trying a sample.");
  const channel = await prisma.customerChannel.create({
    data: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId,
      provider: CUSTOMER_PREVIEW_PROVIDER,
      accountId: randomUUID(),
      name: "Practice",
      ciphertext: "",
      enabled: true,
      autoReplies: true,
    },
  });
  try {
    const id = await createCustomerInbox(prisma).receive(channel.id, {
      externalId: randomUUID(),
      externalThreadId: randomUUID(),
      customerId: randomUUID(),
      name: "Practice customer",
      body: message,
    });
    await process(id, signal);
    signal?.throwIfAborted();
    await requirePrivateOwner(prisma, actor, botId);
    const current = await prisma.customerBehavior.findUnique({ where: { botId } });
    if (current?.revision !== behavior.revision)
      throw new Error("Customer behavior changed. Try the sample again.");
    const result = await prisma.customerConversation.findUniqueOrThrow({
      where: { id },
      include: {
        channel: true,
        messages: { orderBy: { seq: "asc" }, include: { toolCalls: true } },
      },
    });
    if (!result.channel.enabled) throw new Error("The sample was interrupted. Try it again.");
    const failed = result.messages.some((item) => item.status === "failed");
    const response = result.messages.findLast(
      (item) => item.role === "bot" || item.role === "system",
    );
    const actions = result.messages.flatMap((item) => item.toolCalls);
    return {
      status: failed ? "failed" : result.needsHuman ? "handoff" : response ? "reply" : "failed",
      reply: response?.body ?? null,
      reason: result.handoffReason,
      revision: behavior.revision,
      assessment: actions.find((item) => item.name === "Escalation assessment")?.result ?? null,
      actions: actions.map(({ name, status }) => ({ name, status })),
    };
  } finally {
    await prisma.customerChannel.deleteMany({ where: { id: channel.id } });
  }
}

/** Dispose of hidden practice transcripts left behind by crashed workers. */
export async function deleteExpiredCustomerPreviews(prisma: PrismaClient) {
  const rows = await prisma.customerChannel.findMany({
    where: {
      provider: CUSTOMER_PREVIEW_PROVIDER,
      createdAt: { lt: new Date(Date.now() - 300_000) },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });
  if (rows.length)
    await prisma.customerChannel.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
}
