import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import type {
  CustomerChannelInput,
  CustomerProvider,
  CustomerProviderDefinition,
} from "@rakazo/contracts";
import type { MessagingPlatform } from "../chat-sdk-surface.js";
import { ChatSdkMessagingSurface } from "../chat-sdk-surface.js";
import type { CustomerChatAdapter } from "./base.js";
import { InstagramCustomerAdapter } from "./instagram.js";
import { LineCustomerAdapter } from "./line.js";
import { TikTokCustomerAdapter } from "./tiktok.js";

const field = (key: string, label: string, secret = true) => ({ key, label, secret });
export const CUSTOMER_PROVIDERS: Array<
  CustomerProviderDefinition & {
    replyWindowHours?: number;
    retryHours?: number;
    validate?: (credentials: Record<string, string>) => boolean;
    create: (
      accountId: string,
      credentials: Record<string, string>,
      fetcher: typeof fetch,
    ) => CustomerChatAdapter;
  }
> = [
  {
    id: "line",
    replyWindowHours: 168,
    retryHours: 24,
    create: (id, credentials, fetcher) => new LineCustomerAdapter(id, credentials, fetcher),
    name: "LINE",
    accountLabel: "Bot user ID",
    setupUrl: "https://developers.line.biz/en/docs/messaging-api/receiving-messages/",
    fields: [
      field("accessToken", "Channel access token"),
      field("channelSecret", "Channel secret"),
    ],
  },
  {
    id: "instagram",
    replyWindowHours: 24,
    validate: (credentials) => /^v\d{1,3}\.0$/.test(credentials.apiVersion!),
    create: (id, credentials, fetcher) => new InstagramCustomerAdapter(id, credentials, fetcher),
    name: "Instagram",
    accountLabel: "Instagram account ID",
    setupUrl:
      "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/",
    fields: [
      field("accessToken", "Access token"),
      field("appSecret", "App secret"),
      field("verifyToken", "Verify token"),
      field("apiVersion", "API version", false),
    ],
  },
  {
    id: "tiktok",
    create: (id, credentials, fetcher) => new TikTokCustomerAdapter(id, credentials, fetcher),
    name: "TikTok",
    accountLabel: "Business account ID",
    setupUrl: "https://business-api.tiktok.com/portal/docs?id=1832184403754242",
    fields: [field("accessToken", "Access token"), field("clientSecret", "Client secret")],
  },
];
export function customerProvider(id: CustomerProvider) {
  const definition = CUSTOMER_PROVIDERS.find((provider) => provider.id === id);
  if (!definition) throw new Error("Unknown customer provider");
  return definition;
}
export function validateCustomerCredentials(input: CustomerChannelInput) {
  const definition = customerProvider(input.provider);
  if (
    definition.fields.some((field) => !input.credentials[field.key]?.trim()) ||
    Object.keys(input.credentials).some(
      (key) => !definition.fields.some((field) => field.key === key),
    )
  )
    throw new Error("Missing or invalid channel credentials");
  if (definition.validate && !definition.validate(input.credentials))
    throw new Error("Invalid channel credentials");
}
export function createCustomerChannelSurface(
  input: Pick<CustomerChannelInput, "provider" | "accountId" | "credentials">,
  fetcher: typeof fetch = fetch,
) {
  const { provider, accountId, credentials } = input;
  const adapter = customerProvider(provider).create(accountId, credentials, fetcher);
  const platform: MessagingPlatform = {
    provider,
    adapter,
    receiptId: (raw) => (raw as { receiptId?: string }).receiptId,
    send: (request) => adapter.postMessage(request.threadId, request.body, request.idempotencyKey),
    capabilities: { direct: true, groups: false, typing: false },
  };
  return new ChatSdkMessagingSurface([platform], { state: new CustomerChatState() });
}

class CustomerChatState extends MemoryStateAdapter {
  override setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    // The SDK marks messages seen before the durable sink succeeds and keys
    // only by provider/message ID. Receipt IDs may differ from message IDs.
    // PostgreSQL owns inbound deduplication; retain SDK state for other purposes.
    if (key.startsWith("dedupe:")) return Promise.resolve(true);
    return super.setIfNotExists(key, value, ttlMs);
  }
}
