import type { PrismaClient } from "@rakazo/db";
import { vi } from "vitest";
import { createModelBridge } from "./model-bridge.js";
import { serializeModelSecret } from "./pi-oauth.js";
import { modelsForRequest } from "./pi-runtime.js";
import type { EncryptedSecretStore } from "./secrets.js";

export const bridgeTestActor = { userId: "owner", spaceId: "space" };
// Synthetic unsigned fixture token; it cannot authenticate to a real service.
export const bridgeTestAccess = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.test`;
export const bridgeTestModel = "gpt-6-astra";
export function codexBridgeResponse(tool = false) {
  const item = tool
    ? {
        type: "function_call",
        id: "fc_test",
        call_id: "call_test",
        name: "search_documents",
        arguments: '{"query":"hours"}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Open until six.", annotations: [] }],
      };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) },
    },
    ...(tool
      ? []
      : [
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "Open until six.",
          },
        ]),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [item],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

export function modelBridgeFixture(
  options: { provider?: string; modelId?: string; access?: string } = {},
) {
  const provider = options.provider ?? "openai-codex";
  const modelId = options.modelId ?? bridgeTestModel;
  const credential = { id: "credential", userId: "owner", provider, secretId: "oauth-secret" };
  const rows = new Map<
    string,
    { id: string; userId: string; spaceId: string | null; kind: string; ciphertext: string }
  >();
  rows.set("oauth-secret", {
    id: "oauth-secret",
    userId: "owner",
    spaceId: null,
    kind: "model",
    ciphertext: serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        access: options.access ?? bridgeTestAccess,
        refresh: "fake-refresh",
        expires: 4_000_000_000_000,
      },
    }),
  });
  const matches = (row: object, where: object) =>
    Object.entries(where).every(([key, value]) => Reflect.get(row, key) === value);
  const secret = {
    findFirst: vi.fn(
      async ({ where }) => [...rows.values()].find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }) => [...rows.values()].filter((row) => matches(row, where))),
    create: vi.fn(async ({ data }) => {
      rows.set(data.id, data);
      return data;
    }),
    update: vi.fn(async ({ where, data }) => {
      Object.assign(rows.get(where.id)!, data);
      return rows.get(where.id);
    }),
    deleteMany: vi.fn(async ({ where }) => {
      let count = 0;
      for (const [id, row] of rows)
        if (matches(row, where)) {
          rows.delete(id);
          count++;
        }
      return { count };
    }),
  };
  const prisma = {
    secret,
    spaceMember: {
      findFirst: vi.fn(async ({ where }) =>
        matches(bridgeTestActor, where) ? bridgeTestActor : null,
      ),
    },
    userModelCredential: {
      findFirst: vi.fn(async ({ where }) => (matches(credential, where) ? credential : null)),
    },
  };
  // Crypto has its own conformance suite. Avoid scrypt work in each protocol assertion.
  const secrets = {
    seal: (value: string) => value,
    load: (value: string) => value,
    put: async (value: string, _context: unknown, id: string) => ({ id, ciphertext: value }),
  } as unknown as EncryptedSecretStore;
  const upstream = vi.fn<typeof fetch>(async () => codexBridgeResponse());
  const payloads: unknown[] = [];
  const configurations: Parameters<typeof modelsForRequest>[0][] = [];
  const bridge = createModelBridge({
    prisma: prisma as unknown as PrismaClient,
    secrets,
    modelRegistry(request, selected) {
      configurations.push(request);
      const models = modelsForRequest(request, selected);
      return {
        getModel: models.getModel.bind(models),
        streamSimple: (model, context, opts) =>
          models.streamSimple(model, context, {
            ...opts,
            fetch: upstream,
            onPayload: (payload) => {
              payloads.push(payload);
            },
          }),
      };
    },
  });
  const issue = () => bridge.create(bridgeTestActor, { credentialId: credential.id, modelId });
  return { bridge, issue, upstream, rows, prisma, credential, configurations, payloads, modelId };
}
