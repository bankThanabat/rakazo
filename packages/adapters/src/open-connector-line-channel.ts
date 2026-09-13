import { lineReplyInput, parseLineWebhook } from "./line-webhook.js";
import type { OpenConnectorChannel } from "./open-connector.js";

/** Incoming-event translation only. Accounts and tools use the generic adapter. */
export const openConnectorLineChannel: OpenConnectorChannel = {
  provider: "line",
  receive: parseLineWebhook,
  reply(request, connectionId) {
    const input = lineReplyInput(connectionId, request);
    return { actionId: "line.send_push_text", input, handle: input.retryKey };
  },
};
