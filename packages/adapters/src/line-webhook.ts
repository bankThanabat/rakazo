import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { TeamChatInboundMessage, TeamChatSendRequest } from "@rakazo/adapter-kit";
import { z } from "zod";

const TextEvent = z.object({
  type: z.literal("message"),
  webhookEventId: z.string().min(1).max(256),
  source: z.object({ type: z.literal("user"), userId: z.string().min(1).max(256) }),
  message: z.object({ type: z.literal("text"), text: z.string().min(1).max(20000) }),
});

export async function parseLineWebhook(
  request: Request,
  secret: string,
  connectionId: string,
): Promise<{ status: number; events: TeamChatInboundMessage[] }> {
  const body = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get("x-line-signature") ?? "";
  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(signature, "base64");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return { status: 401, events: [] };
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, events: [] };
  }
  const parsed = z.object({ events: z.array(z.unknown()).max(100) }).safeParse(payload);
  if (!parsed.success) return { status: 400, events: [] };
  const events: TeamChatInboundMessage[] = [];
  for (const raw of parsed.data.events) {
    const event = TextEvent.safeParse(raw);
    if (!event.success) continue;
    const { webhookEventId, source, message } = event.data;
    events.push({
      eventId: `${connectionId}:${webhookEventId}`,
      workspaceId: connectionId,
      kind: "direct",
      conversationType: "im",
      conversationKey: source.userId,
      conversationId: source.userId,
      conversationName: "LINE conversation",
      replyThreadId: null,
      senderId: source.userId,
      senderName: "LINE contact",
      senderIsBot: false,
      content: message.text,
    });
  }
  return { status: 200, events };
}

export function lineReplyInput(
  connectionId: string,
  request: TeamChatSendRequest,
): { to: string; texts: string[]; retryKey: string } {
  if (!request.idempotencyKey) throw new Error("LINE replies require a stable delivery key");
  const bytes = createHash("sha256")
    .update(`${connectionId}:${request.idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  const retryKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const texts: string[] = [];
  let remaining = request.content.trim();
  while (remaining && texts.length < 5) {
    let end = Math.min(5000, remaining.length);
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--;
    texts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (!texts.length) throw new Error("LINE reply is empty");
  if (remaining) texts[4] = `${texts[4]!.slice(0, 4998).replace(/[\uD800-\uDBFF]$/, "")}…`;
  return { to: request.conversationId, texts, retryKey };
}
