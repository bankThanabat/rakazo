import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { PrismaClient } from "@rakazo/db";
import { createCustomerInbox, startCustomerAttention } from "@rakazo/db";

/** Synthetic web conversation: no external messaging account or model is used. */
export async function customerNativeReview(prisma: PrismaClient, botId: string) {
  const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
  const channel = await prisma.customerChannel.create({
    data: {
      spaceId: bot.spaceId,
      userId: bot.userId,
      botId,
      provider: "web",
      accountId: "native-review-shop",
      name: "Review shop",
      ciphertext: "synthetic-unused-web-credentials",
      autoReplies: false,
    },
  });
  const id = await createCustomerInbox(prisma).receive(channel.id, {
    externalId: "native-review-question",
    externalThreadId: "native-review-conversation",
    customerId: "native-review-shopper",
    name: "Review customer",
    body: "Can you help me choose a size?",
  });
  await prisma.customerConversation.update({
    where: { id },
    data: {
      ...startCustomerAttention(),
      owner: "staff",
      handoffReason: "A staff member should check the size chart.",
    },
  });
  return {
    id,
    async verify() {
      const row = await prisma.customerConversation.findUniqueOrThrow({
        where: { id },
        include: { messages: true, guidance: true, acknowledgements: true },
      });
      const staff = row.messages.filter((message) => message.role === "staff");
      const checks = {
        acknowledged: row.acknowledgements.some((ack) => ack.userId === bot.userId),
        assignedToStaff: row.assigneeId === bot.userId,
        guidanceSavedOnce:
          row.guidance.length === 1 &&
          row.guidance[0]?.content === "Ask for measurements before recommending a size.",
        guidancePrivate: row.messages.every(
          (message) => !message.body.includes("Ask for measurements before recommending a size."),
        ),
        oneSentReply:
          staff.length === 1 &&
          staff[0]?.status === "sent" &&
          staff[0]?.body === "Please share your measurements so I can check the size chart.",
        resolvedUnderStaffControl: row.state === "resolved" && row.owner === "staff",
        attentionCleared:
          !row.needsHuman && !row.nextAttentionAlertAt && !row.ownerAttentionAlertAt,
      };
      await writeFile(
        "test-report/deskazo-v1/checks/native-customer-state.json",
        JSON.stringify(
          { checks, scope: "Synthetic web-channel native controls; automatic replies disabled." },
          null,
          2,
        ),
      );
      assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
      console.log("Native customer state verified.");
    },
  };
}
