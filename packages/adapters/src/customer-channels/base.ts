import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  FetchResult,
  FormattedContent,
  RawMessage,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { Message } from "chat";

export interface CustomerWireMessage {
  id: string;
  receiptId?: string;
  sender: string;
  conversation: string;
  name?: string;
  text: string;
  timestamp: number;
  mediaUrl?: string;
}
export function validSignature(
  secret: string,
  body: string,
  signature: string | null,
  encoding: "hex" | "base64" = "hex",
) {
  if (!signature) return false;
  return validSecret(createHmac("sha256", secret).update(body).digest(encoding), signature);
}
export function validSecret(secret: string, value: string | null) {
  if (value === null) return false;
  const expected = Buffer.from(secret);
  const supplied = Buffer.from(value);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
export abstract class CustomerChatAdapter implements Adapter<string, CustomerWireMessage> {
  readonly userName = "Rakazo";
  renderFormatted(content: FormattedContent): string {
    const read = (node: { type: string; value?: string; children?: unknown[] }): string =>
      node.value ?? (node.children ?? []).map((child) => read(child as typeof node)).join("");
    return content.children.map((child) => read(child)).join("\n");
  }
  protected chat?: ChatInstance;
  abstract readonly name: string;
  constructor(
    protected readonly accountId: string,
    protected readonly credentials: Record<string, string>,
    protected readonly fetcher: typeof fetch = fetch,
  ) {}
  async initialize(chat: ChatInstance) {
    this.chat = chat;
  }
  encodeThreadId(id: string) {
    return `${this.name}:${encodeURIComponent(this.accountId)}:${encodeURIComponent(id)}`;
  }
  decodeThreadId(id: string) {
    const parts = id.split(":");
    if (
      parts.length !== 3 ||
      parts[0] !== this.name ||
      decodeURIComponent(parts[1]!) !== this.accountId
    )
      throw new Error("Invalid customer thread");
    return decodeURIComponent(parts[2]!);
  }
  channelIdFromThreadId(id: string) {
    this.decodeThreadId(id);
    return id;
  }
  isDM() {
    return true;
  }
  async openDM(id: string) {
    return this.encodeThreadId(id);
  }
  async fetchThread(id: string): Promise<ThreadInfo> {
    this.decodeThreadId(id);
    return { id, channelId: id, isDM: true, metadata: {} };
  }
  async fetchMessages(): Promise<FetchResult<CustomerWireMessage>> {
    return { messages: [] };
  }
  async addReaction(): Promise<void> {
    throw new Error("Reactions are not supported by this channel");
  }
  async removeReaction(): Promise<void> {
    throw new Error("Reactions are not supported by this channel");
  }
  async deleteMessage(): Promise<void> {
    throw new Error("Deleting messages is not supported by this channel");
  }
  async editMessage(): Promise<RawMessage<CustomerWireMessage>> {
    throw new Error("Editing messages is not supported by this channel");
  }
  async startTyping(): Promise<void> {}
  parseMessage(raw: CustomerWireMessage) {
    return new Message({
      id: raw.id,
      threadId: this.encodeThreadId(raw.conversation),
      text: raw.text,
      formatted: {
        type: "root",
        children: [{ type: "paragraph", children: [{ type: "text", value: raw.text }] }],
      },
      raw,
      attachments: raw.mediaUrl ? [{ type: "file", url: raw.mediaUrl }] : [],
      author: {
        userId: raw.sender,
        userName: raw.name ?? raw.sender,
        fullName: raw.name ?? raw.sender,
        isMe: false,
        isBot: false,
      },
      metadata: { dateSent: new Date(raw.timestamp), edited: false },
    });
  }
  protected async dispatch(messages: CustomerWireMessage[], options?: WebhookOptions) {
    if (!this.chat) throw new Error("Adapter not initialized");
    for (const raw of messages)
      await this.chat.processMessage(
        this,
        this.encodeThreadId(raw.conversation),
        this.parseMessage(raw),
        options,
      );
    return new Response("OK");
  }
  protected text(message: AdapterPostableMessage) {
    if (typeof message === "string") return message;
    if ("raw" in message) return message.raw;
    if ("markdown" in message) return message.markdown;
    throw new Error("Only text messages are supported by this channel");
  }
  abstract handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
  abstract postMessage(
    threadId: string,
    message: AdapterPostableMessage,
    idempotencyKey?: string,
  ): Promise<RawMessage<CustomerWireMessage>>;
  protected sent(threadId: string, id: string, text: string): RawMessage<CustomerWireMessage> {
    return {
      id,
      threadId,
      raw: {
        id,
        sender: this.accountId,
        conversation: this.decodeThreadId(threadId),
        text,
        timestamp: Date.now(),
      },
    };
  }
  protected async post(url: string, body: unknown, headers: Record<string, string>) {
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Channel send failed (${response.status})`);
    return response.json();
  }
}

export function parseCustomerJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
