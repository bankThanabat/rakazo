import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Context, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { z } from "zod";

const text = z.union([
  z.string(),
  z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()),
]);
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const toolCall = z
  .object({
    id: z.string().min(1).max(512),
    type: z.literal("function"),
    function: z.object({ name, arguments: z.string() }).strict(),
  })
  .strict();
const message = z.discriminatedUnion("role", [
  z
    .object({ role: z.enum(["system", "developer", "user"]), content: text, name: name.optional() })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: text.nullish(),
      tool_calls: z.array(toolCall).max(128).optional(),
    })
    .strict(),
  z
    .object({ role: z.literal("tool"), content: text, tool_call_id: z.string().min(1).max(512) })
    .strict(),
]);

/** Deliberately bounded Chat Completions subset; unsupported semantics fail explicitly. */
export const ModelBridgeRequest = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(message).min(1).max(500),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name,
                description: z.string().optional(),
                parameters: z.object({ type: z.literal("object") }).catchall(z.json()),
                strict: z.literal(false).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    tool_choice: z.enum(["auto", "none"]).optional(),
    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().nullish(),
    max_tokens: z.number().int().min(1).max(8192).nullish(),
    max_completion_tokens: z.number().int().min(1).max(8192).nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    n: z.literal(1).optional(),
    response_format: z
      .object({ type: z.literal("text") })
      .strict()
      .optional(),
  })
  .strict();
export type ModelBridgeRequest = z.infer<typeof ModelBridgeRequest>;

export const emptyBridgeUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const contentText = (value: z.infer<typeof text>) =>
  typeof value === "string" ? value : value.map((part) => part.text).join("\n");

export function modelBridgeContext(input: ModelBridgeRequest, model: Model<Api>): Context {
  const context: Context = { messages: [] };
  const system: string[] = [];
  const pending = new Map<string, string>();
  const callIds = new Set<string>();
  for (const item of input.messages) {
    if (item.role === "system" || item.role === "developer") {
      system.push(contentText(item.content));
    } else if (item.role === "user") {
      if (pending.size) throw new Error("Missing tool results");
      context.messages.push({ role: "user", content: contentText(item.content), timestamp: 0 });
    } else if (item.role === "assistant") {
      if (pending.size) throw new Error("Missing tool results");
      const content: AssistantMessage["content"] = item.content
        ? [{ type: "text", text: contentText(item.content) }]
        : [];
      for (const call of item.tool_calls ?? []) {
        if (callIds.has(call.id)) throw new Error("Duplicate tool call");
        callIds.add(call.id);
        const args = z.record(z.string(), z.json()).parse(JSON.parse(call.function.arguments));
        pending.set(call.id, call.function.name);
        content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: args });
      }
      context.messages.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyBridgeUsage,
        stopReason: pending.size ? "toolUse" : "stop",
        timestamp: 0,
      });
    } else if (item.role === "tool") {
      const toolName = pending.get(item.tool_call_id);
      if (!toolName) throw new Error("Unknown tool result");
      pending.delete(item.tool_call_id);
      context.messages.push({
        role: "toolResult",
        toolCallId: item.tool_call_id,
        toolName,
        content: [{ type: "text", text: contentText(item.content) }],
        isError: false,
        timestamp: 0,
      });
    }
  }
  if (pending.size) throw new Error("Missing tool results");
  if (system.length) context.systemPrompt = system.join("\n\n");
  if (input.tools) {
    if (new Set(input.tools.map((tool) => tool.function.name)).size !== input.tools.length)
      throw new Error("Duplicate tool names");
    context.tools = input.tools.map(({ function: tool }) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters as Tool["parameters"],
    }));
  }
  return context;
}

export function bridgeCompletion(
  result: AssistantMessage,
  modelId: string,
  id = `chatcmpl-${randomUUID()}`,
) {
  const calls = result.content
    .filter((part) => part.type === "toolCall")
    .map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  const content = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const promptTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason:
          result.stopReason === "length" ? "length" : calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: result.usage.output,
      total_tokens: promptTokens + result.usage.output,
    },
  };
}
