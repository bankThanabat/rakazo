import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Models } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultModelCredential, findModelCredential } from "@rakazo/db";
import { z } from "zod";
import {
  bridgeCompletion,
  ModelBridgeRequest,
  modelBridgeContext,
} from "./model-bridge-protocol.js";
import { resolveModelKey } from "./model-credentials.js";
import { selectConfiguredModel } from "./model-selection.js";
import { parseModelSecret } from "./pi-oauth.js";
import { modelsForRequest, reliableStreamOptions } from "./pi-runtime.js";
import type { EncryptedSecretStore } from "./secrets.js";

const grantKind = "model-bridge";
const FixedModel = z
  .object({
    credentialId: z.string().min(1).max(256),
    modelId: z.string().min(1).max(256),
  })
  .strict();
const StaffModel = z.object({ botId: z.string().min(1).max(256) }).strict();
export const ModelBridgeGrantInput = z.union([FixedModel, StaffModel]);
const grantMetadata = {
  expiresAt: z.number().optional(),
  keyHash: z.string().regex(/^[a-f0-9]{64}$/),
};
const Grant = z.union([FixedModel.extend(grantMetadata), StaffModel.extend(grantMetadata)]);
type ModelSelection = z.infer<typeof ModelBridgeGrantInput>;
const requestedModel = (selection: ModelSelection) =>
  "botId" in selection ? "rakazo-staff" : selection.modelId;
type Scope = Pick<Actor, "userId" | "spaceId">;
export class ModelBridgeError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 429 | 502,
    message: string,
  ) {
    super(message);
  }
}
const unavailable = () => new ModelBridgeError(401, "Model connection is unavailable");
const digest = (value: string) => createHash("sha256").update(value).digest();

export function createModelBridge(deps: {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  /** Offline conformance tests inject the transport, never a second credential path. */
  modelRegistry?: (
    ...args: Parameters<typeof modelsForRequest>
  ) => Pick<Models, "getModel" | "streamSimple">;
}) {
  const registry = deps.modelRegistry ?? modelsForRequest;
  const active = new Map<string, number>();

  async function connection(scope: Scope, selection: ModelSelection) {
    if (!(await deps.prisma.spaceMember.findFirst({ where: scope }))) throw unavailable();
    if ("botId" in selection) {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: selection.botId, ...scope, archivedAt: null },
        select: { modelProvider: true, modelId: true, thinkingLevel: true },
      });
      if (!bot) throw unavailable();
      const [overrideCredential, defaultCredential] = await Promise.all([
        bot.modelProvider && bot.modelId
          ? findModelCredential(deps.prisma, scope, bot.modelProvider, bot.modelId)
          : Promise.resolve(null),
        findDefaultModelCredential(deps.prisma, scope),
      ]);
      const selected = selectConfiguredModel({
        bot,
        overrideCredential,
        defaultCredential,
        settings: null,
        deployment: null,
      });
      // A bridge can only follow a connection owned by its user, never a deployment key.
      if (!selected.credential || !selected.id) throw unavailable();
      return { credential: selected.credential, modelId: selected.id };
    }
    const credential = await deps.prisma.userModelCredential.findFirst({
      where: { id: selection.credentialId, userId: scope.userId },
    });
    if (!credential) throw unavailable();
    return { credential, modelId: selection.modelId };
  }

  async function authenticate(token: string) {
    const match = /^rmb_([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw unavailable();
    const row = await deps.prisma.secret.findFirst({ where: { id: match[1], kind: grantKind } });
    if (!row?.spaceId) throw unavailable();
    const grant = Grant.parse(JSON.parse(deps.secrets.load(row.ciphertext, row.id)));
    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) throw unavailable();
    if (!timingSafeEqual(digest(token), Buffer.from(grant.keyHash, "hex"))) throw unavailable();
    const scope = { userId: row.userId, spaceId: row.spaceId };
    const selected = await connection(scope, grant);
    return { grant, scope, ...selected };
  }

  return {
    async create(scope: Scope, raw: unknown, options: { expiresAt?: Date } = {}) {
      scope = { userId: scope.userId, spaceId: scope.spaceId };
      const input = ModelBridgeGrantInput.safeParse(raw);
      if (!input.success) throw new ModelBridgeError(400, "Invalid model connection");
      const { credential, modelId } = await connection(scope, input.data);
      let compatible = {};
      if (credential.provider === "openai-compatible") {
        const secret = await deps.prisma.secret.findFirst({
          where: { id: credential.secretId, userId: scope.userId, spaceId: null },
        });
        if (!secret) throw unavailable();
        const saved = parseModelSecret(deps.secrets.load(secret.ciphertext, secret.id));
        if (saved.kind !== "openai_compatible") throw unavailable();
        compatible = saved;
      }
      // Catalog lookup needs no OAuth refresh, network request, or new login.
      const models = registry(
        { model: { ...compatible, provider: credential.provider, id: modelId } },
        credential.provider,
      );
      if (!models.getModel(credential.provider, modelId))
        throw new ModelBridgeError(400, "Unknown model for this connection");
      const id = randomBytes(16).toString("hex");
      const apiKey = `rmb_${id}.${randomBytes(32).toString("base64url")}`;
      const grant = {
        ...input.data,
        keyHash: digest(apiKey).toString("hex"),
        expiresAt: options.expiresAt?.getTime(),
      };
      await deps.prisma.secret.create({
        data: {
          id,
          ...scope,
          kind: grantKind,
          ciphertext: deps.secrets.seal(JSON.stringify(grant), id),
        },
      });
      return { id, apiKey, model: requestedModel(input.data), basePath: "/api/model-bridge/v1" };
    },
    async list(scope: Scope) {
      scope = { userId: scope.userId, spaceId: scope.spaceId };
      if (!(await deps.prisma.spaceMember.findFirst({ where: scope }))) throw unavailable();
      const rows = await deps.prisma.secret.findMany({
        where: { ...scope, kind: grantKind },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((row) => {
        const grant = Grant.parse(JSON.parse(deps.secrets.load(row.ciphertext, row.id)));
        return {
          id: row.id,
          ...("botId" in grant ? { botId: grant.botId } : { credentialId: grant.credentialId }),
          model: requestedModel(grant),
        };
      });
    },
    async revoke(scope: Scope, id: string) {
      scope = { userId: scope.userId, spaceId: scope.spaceId };
      if (!(await deps.prisma.spaceMember.findFirst({ where: scope }))) throw unavailable();
      await deps.prisma.secret.deleteMany({ where: { ...scope, id, kind: grantKind } });
    },
    async models(token: string) {
      const { grant, credential } = await authenticate(token);
      return {
        object: "list",
        data: [
          { id: requestedModel(grant), object: "model", created: 0, owned_by: credential.provider },
        ],
      };
    },
    async respond(token: string, raw: unknown, requestSignal: AbortSignal): Promise<Response> {
      const { grant, scope, credential, modelId } = await authenticate(token);
      const parsed = ModelBridgeRequest.safeParse(raw);
      if (!parsed.success)
        throw new ModelBridgeError(400, "Unsupported or invalid chat completion request");
      const input = parsed.data;
      if (input.model !== requestedModel(grant))
        throw new ModelBridgeError(403, "Model is not granted to this key");
      // Bound simultaneous subscription use per connection, including multiple bridge keys.
      if ((active.get(credential.id) ?? 0) >= 2)
        throw new ModelBridgeError(429, "Model connection is busy");
      active.set(credential.id, (active.get(credential.id) ?? 0) + 1);
      const controller = new AbortController();
      const signal = AbortSignal.any([
        requestSignal,
        controller.signal,
        AbortSignal.timeout(120_000),
      ]);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", release);
        const count = (active.get(credential.id) ?? 1) - 1;
        if (count) active.set(credential.id, count);
        else active.delete(credential.id);
      };
      signal.addEventListener("abort", release, { once: true });
      try {
        signal.throwIfAborted();
        const resolved = await resolveModelKey(
          { prisma: deps.prisma, secretStore: deps.secrets },
          scope.userId,
          scope.spaceId,
          credential,
          credential.provider,
          modelId,
        );
        if (!resolved.oauth && !resolved.apiKey && credential.provider !== "openai-compatible")
          throw unavailable();
        const config: AgentRunRequest["model"] = {
          provider: credential.provider,
          id: modelId,
          ...resolved,
          oauth: resolved.oauth
            ? { credential: resolved.oauth, persist: resolved.persistOAuth }
            : undefined,
        };
        const models = registry({ model: config }, credential.provider);
        const model = models.getModel(credential.provider, modelId);
        if (!model) throw unavailable();
        let context: Context;
        try {
          context = modelBridgeContext(input, model);
        } catch {
          throw new ModelBridgeError(400, "Invalid message or tool history");
        }
        signal.throwIfAborted();
        const stream = models.streamSimple(
          model,
          context,
          reliableStreamOptions(model, {
            signal,
            apiKey: resolved.oauth
              ? undefined
              : resolved.apiKey ||
                (credential.provider === "openai-compatible" ? "local" : undefined),
            maxTokens: Math.min(
              input.max_completion_tokens ?? input.max_tokens ?? 8192,
              model.maxTokens,
            ),
            temperature: input.temperature ?? undefined,
            toolChoice: input.tool_choice,
            reasoning: model.reasoning ? (input.reasoning_effort ?? "medium") : undefined,
            maxRetries: 0,
          }),
        );
        const id = `chatcmpl-${randomUUID()}`;
        if (!input.stream) {
          const result = await stream.result();
          if (!["stop", "length", "toolUse"].includes(result.stopReason))
            throw new Error("Model request failed");
          return Response.json(bridgeCompletion(result, modelId, id), {
            headers: { "cache-control": "no-store" },
          });
        }
        const events = (async function* () {
          const encoder = new TextEncoder();
          const encode = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
          const base = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
          };
          const chunk = (delta: unknown, finish: string | null = null) => ({
            ...base,
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
          let toolIndex = 0;
          try {
            yield encode(chunk({ role: "assistant", content: "" }));
            for await (const event of stream) {
              if (event.type === "text_delta") yield encode(chunk({ content: event.delta }));
              // Emit authoritative arguments once; provider delta formats differ.
              if (event.type === "toolcall_end")
                yield encode(
                  chunk({
                    tool_calls: [
                      {
                        index: toolIndex++,
                        id: event.toolCall.id,
                        type: "function",
                        function: {
                          name: event.toolCall.name,
                          arguments: JSON.stringify(event.toolCall.arguments),
                        },
                      },
                    ],
                  }),
                );
              if (event.type === "error") throw new Error("Model request failed");
              if (event.type === "done") {
                const completion = bridgeCompletion(event.message, modelId, id);
                yield encode(chunk({}, completion.choices[0]!.finish_reason));
                if (input.stream_options?.include_usage)
                  yield encode({ ...base, choices: [], usage: completion.usage });
              }
            }
            yield encoder.encode("data: [DONE]\n\n");
          } catch {
            yield encode({
              error: { message: "Model request failed", type: "model_bridge_error" },
            });
          } finally {
            controller.abort();
            release();
          }
        })();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(target) {
              const next = await events.next();
              if (next.done) target.close();
              else target.enqueue(next.value);
            },
            async cancel() {
              controller.abort();
              release();
              await events.return();
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              "x-accel-buffering": "no",
            },
          },
        );
      } catch (error) {
        release();
        controller.abort();
        if (error instanceof ModelBridgeError) throw error;
        throw new ModelBridgeError(502, "Model request failed");
      } finally {
        if (!input.stream) {
          controller.abort();
          release();
        }
      }
    },
  };
}
export type ModelBridge = ReturnType<typeof createModelBridge>;
