import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CustomerRuntime } from "@rakazo/adapter-kit";
import { CustomerActionGrantSchema } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import type { createCustomerConnector } from "./customer-connector.js";
import { customerField, customerInput } from "./customer-mapping.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";

const hash = (value: string) => createHash("sha256").update(value).digest();
export function customerPolicyHash(behavior: {
  actions: unknown;
  knowledgeFilterId: string | null;
  credentialId: string;
}) {
  return hash(
    stableJsonValue([behavior.actions, behavior.knowledgeFilterId, behavior.credentialId]),
  ).toString("hex");
}
export function customerExecutionKey(messageId: string) {
  const token = `ce_${messageId}.${randomBytes(32).toString("base64url")}`;
  return { token, keyHash: hash(token).toString("hex") };
}
const Call = z
  .object({
    name: z.string().min(1).max(64),
    callId: z.string().min(1).max(120),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
const grants = (value: unknown) => z.array(CustomerActionGrantSchema).parse(value);
const denied = () => new Error("Customer operation is unavailable");

/** Expand only approved templates. Model input never selects an account or a tool. */
export function customerWorkflowInput(
  template: Record<string, unknown>,
  values: Record<string, unknown>,
) {
  const replacements: Record<string, unknown> = {};
  function visit(value: unknown): void {
    if (typeof value === "string" && value.startsWith("$")) {
      const path = value.slice(1);
      replacements[path] = customerField(values, path.split("."));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(template);
  return customerInput(template, replacements);
}

export function validateCustomerGrants(value: unknown) {
  const actions = grants(value);
  if (
    new Set(actions.map((a) => a.name)).size !== actions.length ||
    actions.some((a) => a.name === "search_knowledge")
  )
    throw new Error("Customer action names must be unique");
  for (const action of actions) {
    if (action.inputSchema.type !== "object")
      throw new Error("Customer actions need an object input schema");
    z.fromJSONSchema(action.inputSchema as never);
    const seen = new Set<string>();
    let scoped = false;
    for (const step of action.steps) {
      if (seen.has(step.name)) throw new Error("Workflow step names must be unique");
      seen.add(step.name);
      if (step.effect === "write" && !scoped)
        throw new Error("A customer ownership check must precede writes");
      if (step.check?.equals === "$customerId" && step.effect === "read") scoped = true;
    }
  }
  return actions;
}

export function createCustomerBusinessTools(deps: {
  prisma: PrismaClient;
  connector: ReturnType<typeof createCustomerConnector>;
  runtime: (
    channel: { userId: string; spaceId: string },
    credentialId: string,
  ) => Promise<CustomerRuntime>;
}) {
  const { prisma } = deps;
  async function authenticate(token: string) {
    const id = /^ce_([^.]+)\.[A-Za-z0-9_-]{43}$/.exec(token)?.[1];
    if (!id) throw denied();
    const row = await prisma.customerMessage.findUnique({
      where: { id },
      include: {
        conversation: {
          include: { channel: { include: { bot: { include: { customerBehavior: true } } } } },
        },
      },
    });
    const conversation = row?.conversation;
    const channel = conversation?.channel;
    if (
      !row?.executionKeyHash ||
      !row.senderId ||
      row.role !== "customer" ||
      !row.executionUntil ||
      row.executionUntil <= new Date() ||
      row.status !== "processing" ||
      !conversation ||
      conversation.owner !== "bot" ||
      conversation.generation !== row.generation ||
      !conversation.leaseUntil ||
      conversation.leaseUntil <= new Date() ||
      !channel?.enabled ||
      channel.bot.archivedAt ||
      !channel.connectionId ||
      !channel.bot.customerBehavior ||
      row.executionPolicyHash !== customerPolicyHash(channel.bot.customerBehavior) ||
      !timingSafeEqual(hash(token), Buffer.from(row.executionKeyHash, "hex"))
    )
      throw denied();
    await deps.connector.connection(channel, channel.connectionId);
    return { message: row, conversation, channel, behavior: channel.bot.customerBehavior };
  }
  return {
    async list(token: string) {
      const { behavior } = await authenticate(token);
      const tools = grants(behavior.actions).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
      if (behavior.knowledgeFilterId)
        tools.push({
          name: "search_knowledge",
          description: "Search approved business knowledge",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", minLength: 1, maxLength: 4000 } },
            required: ["query"],
            additionalProperties: false,
          },
        });
      return { tools };
    },
    async execute(token: string, raw: unknown) {
      const call = Call.parse(raw);
      const scope = await authenticate(token);
      const requestHash = hash(
        stableJsonValue({ name: call.name, arguments: call.arguments }),
      ).toString("hex");
      const key = { messageId: scope.message.id, callId: call.callId };
      const cached = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_conversations WHERE id = ${scope.conversation.id} FOR UPDATE`;
        const live = await tx.customerMessage.count({
          where: {
            id: scope.message.id,
            status: "processing",
            executionKeyHash: scope.message.executionKeyHash,
            executionUntil: { gt: new Date() },
            conversation: {
              generation: scope.message.generation,
              owner: "bot",
              leaseUntil: { gt: new Date() },
              channel: { enabled: true },
            },
          },
        });
        if (!live) throw denied();
        const prior = await tx.customerToolCall.findFirst({
          where: { messageId: key.messageId, OR: [{ callId: key.callId }, { requestHash }] },
        });
        if (prior) {
          if (prior.requestHash !== requestHash || prior.status !== "completed")
            throw new Error("Customer action outcome is uncertain; do not replay");
          return { found: true, result: prior.result };
        }
        await tx.customerToolCall.create({ data: { ...key, requestHash, status: "executing" } });
        return { found: false, result: null };
      });
      if (cached.found) return cached.result;
      try {
        let result: unknown;
        if (call.name === "search_knowledge") {
          if (!scope.behavior.knowledgeFilterId) throw denied();
          const { query } = z
            .object({ query: z.string().trim().min(1).max(4000) })
            .strict()
            .parse(call.arguments);
          const runtime = await deps.runtime(scope.channel, scope.behavior.credentialId);
          if (!runtime.search) throw denied();
          result = await runtime.search({
            query,
            knowledgeFilterId: scope.behavior.knowledgeFilterId,
            signal: AbortSignal.timeout(20_000),
          });
        } else {
          const grant = grants(scope.behavior.actions).find((g) => g.name === call.name);
          if (!grant) throw denied();
          const input = parseConnectorToolArgs(grant.inputSchema, call.arguments);
          const values = {
            input,
            customerId: scope.message.senderId,
            threadId: scope.conversation.externalThreadId,
            steps: {} as Record<string, unknown>,
          };
          for (const step of grant.steps) {
            const current = await authenticate(token);
            const currentGrant = grants(current.behavior.actions).find((g) => g.name === call.name);
            if (stableJsonValue(currentGrant ?? null) !== stableJsonValue(grant)) throw denied();
            result = await deps.connector.execute(
              scope.channel,
              grant.connectionId,
              step.action,
              customerWorkflowInput(step.input, values),
              `customer.tool:${scope.message.id}:${call.callId}:${step.name}`,
            );
            if (step.check) {
              const expected = customerWorkflowInput({ value: step.check.equals }, values).value;
              if (
                JSON.stringify(customerField(result, step.check.path)) !== JSON.stringify(expected)
              )
                throw denied();
            }
            values.steps[step.name] = result;
          }
        }
        const safeResult = z.json().parse(result ?? null);
        await prisma.customerToolCall.update({
          where: { messageId_callId: key },
          data: { status: "completed", result: safeResult === null ? Prisma.JsonNull : safeResult },
        });
        return safeResult;
      } catch {
        await prisma.customerToolCall.update({
          where: { messageId_callId: key },
          data: { status: "uncertain" },
        });
        throw denied();
      }
    },
  };
}
