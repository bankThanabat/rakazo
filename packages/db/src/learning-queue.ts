import { createHash } from "node:crypto";
import { CUSTOMER_PREVIEW_PROVIDER } from "@rakazo/core";
import type { Prisma } from "./client.js";

/** Capture staff evidence in the same transaction as the correction or resolution. */
export async function queueCustomerLearning(
  tx: Prisma.TransactionClient,
  conversationId: string,
  correctedByUserId: string,
  guidance?: string,
) {
  const row = await tx.customerConversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { channel: true },
  });
  if (row.channel.provider === CUSTOMER_PREVIEW_PROVIDER) return;
  const messages = await tx.customerMessage.findMany({
    where: {
      conversationId,
      status: { not: "withdrawn" },
      OR: [{ role: "customer" }, { role: "staff", status: "sent" }],
    },
    orderBy: { seq: "desc" },
    take: 20,
    select: { role: true, body: true, seq: true },
  });
  if (!guidance && !messages.some((message) => message.role === "staff")) return;
  const evidence = {
    correctedByUserId,
    guidance: guidance ?? null,
    resolved: !guidance,
    messages: messages.reverse(),
  };
  // A repeated correction with no new conversation evidence remains the same
  // task, including when that task was rejected. Agent output is never evidence.
  const sourceKey = createHash("sha256")
    .update(JSON.stringify([conversationId, evidence]))
    .digest("hex");
  await tx.learningTask.createMany({
    skipDuplicates: true,
    data: {
      spaceId: row.channel.spaceId,
      botId: row.channel.botId,
      userId: row.channel.userId,
      conversationId,
      sourceKey,
      correctionKey: guidance
        ? createHash("sha256")
            .update(
              conversationId +
                ":" +
                guidance.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase(),
            )
            .digest("hex")
        : null,
      evidence,
    },
  });
}
