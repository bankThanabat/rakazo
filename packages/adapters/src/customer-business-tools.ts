import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectorTool, CustomerRuntime } from "@rakazo/adapter-kit";
import {
  CustomerActionGrantSchema,
  CustomerBindingSchema,
  KnowledgeSearchInput,
} from "@rakazo/contracts";
import { CUSTOMER_PREVIEW_PROVIDER, customerChannelUsesConnector } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { handoffCustomer, Prisma } from "@rakazo/db";
import { z } from "zod";
import type { createCustomerConnector } from "./customer-connector.js";
import { currentCustomerIdentity } from "./customer-identity.js";
import { customerDeliveryId, customerField, customerInput } from "./customer-mapping.js";
import { executeCustomerOperation } from "./customer-operation.js";
import { customerToolReply } from "./customer-tool-reply.js";
import type { KnowledgeService } from "./knowledge.js";
import {
  CATALOG_EXECUTE,
  CATALOG_LOAD,
  CATALOG_SEARCH,
  catalogActionId,
  parseConnectorToolArgs,
} from "./lazy-tool-catalog.js";

const hash = (value: string) => createHash("sha256").update(value).digest();
export function customerPolicyHash(behavior: {
  actions: unknown;
  knowledgeFilterId: string | null;
  credentialId?: string | null;
  runtime?: unknown;
  knowledge?: unknown;
  modelCredentialId?: string | null;
  modelId?: string | null;
}) {
  return hash(
    stableJsonValue([
      behavior.actions,
      behavior.knowledgeFilterId,
      behavior.credentialId,
      behavior.modelCredentialId,
      behavior.modelId,
      behavior.runtime,
      behavior.knowledge,
    ]),
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
const BUILT_IN_TOOLS = ["search_knowledge", "request_human"];
const isCatalogRead = (action?: string | null) =>
  action === CATALOG_SEARCH || action === CATALOG_LOAD;

function workflowReferences(value: unknown): string[] {
  if (typeof value === "string" && value.startsWith("$")) return [value];
  if (Array.isArray(value)) return value.flatMap(workflowReferences);
  if (value && typeof value === "object") return Object.values(value).flatMap(workflowReferences);
  return [];
}

/** Expand only approved templates. Model input never selects an account or a tool. */
export function customerWorkflowInput(
  template: Record<string, unknown>,
  values: Record<string, unknown>,
) {
  const replacements: Record<string, unknown> = {};
  for (const reference of workflowReferences(template)) {
    const path = reference.slice(1);
    replacements[path] = customerField(values, path.split("."));
  }
  return customerInput(template, replacements);
}

export function validateCustomerGrants(value: unknown) {
  const actions = grants(value);
  if (
    new Set(actions.map((a) => a.name)).size !== actions.length ||
    actions.some((a) => BUILT_IN_TOOLS.includes(a.name) || a.name.startsWith("openconnector_"))
  )
    throw new Error("Customer action names must be unique");
  for (const action of actions) {
    if (action.inputSchema.type !== "object")
      throw new Error("Customer actions need an object input schema");
    z.fromJSONSchema(action.inputSchema as never);
    const seen = new Set<string>();
    let scoped = false;
    const ownedReads = new Set<string>();
    for (const step of action.steps) {
      if (seen.has(step.name)) throw new Error("Workflow step names must be unique");
      seen.add(step.name);
      if (step.effect === "write" && !scoped)
        throw new Error("A customer ownership check must precede writes");
      if (
        step.effect === "write" &&
        (!step.operationKey || !ownedReads.has(step.operationKey.split(".")[1]!))
      )
        throw new Error("Writes need an operationKey from a preceding customer ownership read");
      if (step.effect === "write" && !step.receipt)
        throw new Error("Writes need an explicit receipt field mapping");
      if (step.effect === "write") {
        const references = workflowReferences(step.input);
        if (!references.includes(step.operationKey!))
          throw new Error("Write input must include its ownership-checked operation key");
        if (
          references.some(
            (reference) =>
              reference !== "$customerId" &&
              reference !== "$providerCustomerId" &&
              reference !== "$threadId" &&
              (!reference.startsWith("$steps.") || !ownedReads.has(reference.split(".")[1]!)),
          )
        )
          throw new Error(
            "Write values must come from ownership-checked provider records or the authenticated customer, not model input or unchecked results",
          );
      }
      if (
        (step.check?.equals === "$customerId" || step.check?.equals === "$providerCustomerId") &&
        step.effect === "read"
      ) {
        scoped = true;
        ownedReads.add(step.name);
      }
    }
    if (action.audience === "customer" && !scoped)
      throw new Error("Customer data requires an ownership check before returning results");
    const finalStep = action.steps.at(-1)!;
    if (
      action.audience === "customer" &&
      finalStep.effect === "read" &&
      !ownedReads.has(finalStep.name)
    )
      throw new Error("The returned customer record needs its own ownership check");
  }
  return actions;
}

export function createCustomerBusinessTools(deps: {
  knowledge?: KnowledgeService;
  prisma: PrismaClient;
  connector: ReturnType<typeof createCustomerConnector>;
  runtime: (
    channel: { userId: string; spaceId: string; botId: string },
    behavior: { runtime: unknown; knowledge?: unknown },
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
      !channel.autoReplies ||
      channel.bot.archivedAt ||
      (customerChannelUsesConnector(channel.provider) && !channel.connectionId) ||
      !channel.bot.customerBehavior ||
      row.executionPolicyHash !== customerPolicyHash(channel.bot.customerBehavior) ||
      !timingSafeEqual(hash(token), Buffer.from(row.executionKeyHash, "hex"))
    )
      throw denied();
    if (customerChannelUsesConnector(channel.provider))
      await deps.connector.connection(channel, channel.connectionId!);
    return { message: row, conversation, channel, behavior: channel.bot.customerBehavior };
  }
  type Scope = Awaited<ReturnType<typeof authenticate>>;
  /** Availability follows current sharing and connector effect declarations. */
  const usesIdentity = (grant: ReturnType<typeof grants>[number]) =>
    workflowReferences(grant.steps).includes("$providerCustomerId");
  const identityScope = (scope: Scope, grant: ReturnType<typeof grants>[number]) => ({
    conversationId: scope.conversation.id,
    customerId: scope.message.senderId!,
    connectionId: grant.connectionId,
  });
  async function workflowAvailable(scope: Scope, grant: ReturnType<typeof grants>[number]) {
    try {
      if (
        scope.channel.provider === CUSTOMER_PREVIEW_PROVIDER &&
        (grant.audience !== "public" || grant.steps.some((step) => step.effect !== "read"))
      )
        return false;
      // Stored workflows must obey the same rules as newly published revisions.
      validateCustomerGrants([grant]);
      if (
        usesIdentity(grant) &&
        !(await currentCustomerIdentity(prisma, identityScope(scope, grant)))
      )
        return false;
      if (
        !(await deps.connector.actionsAllowed(
          scope.channel,
          grant.connectionId,
          grant.steps.map((step) => step.action),
        ))
      )
        return false;
      await deps.connector.validateWorkflow(scope.channel, grant.connectionId, grant.steps);
      return true;
    } catch {
      return false;
    }
  }
  const recipient = (scope: Scope) => ({
    customerId: scope.message.senderId!,
    threadId: scope.conversation.externalThreadId,
  });
  function connectionIds(scope: Scope) {
    return [
      ...new Set([
        ...(scope.channel.connectionId ? [scope.channel.connectionId] : []),
        ...grants(scope.behavior.actions).map((grant) => grant.connectionId),
      ]),
    ];
  }
  return {
    async list(token: string) {
      const scope = await authenticate(token);
      const { behavior } = scope;
      const availableGrants = (
        await Promise.all(
          grants(behavior.actions).map(async (grant) =>
            (await workflowAvailable(scope, grant)) ? grant : null,
          ),
        )
      ).filter((grant) => grant !== null);
      const tools: Pick<ConnectorTool, "name" | "description" | "inputSchema">[] =
        availableGrants.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }));
      tools.push(
        ...(scope.channel.provider === CUSTOMER_PREVIEW_PROVIDER
          ? []
          : await deps.connector.discover(scope.channel, connectionIds(scope))
        ).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      );
      if (scope.channel.bot.knowledgeLibraryId || behavior.knowledgeFilterId)
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
      tools.push({
        name: "request_human",
        description:
          "Transfer this conversation to a human. Use when the customer requests a person, information is insufficient, or an action cannot be safely completed. This stops automatic replies and alerts staff.",
        inputSchema: {
          type: "object",
          properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
          required: ["reason"],
          additionalProperties: false,
        },
      });
      return { tools };
    },
    async execute(token: string, raw: unknown) {
      const call = Call.parse(raw);
      const scope = await authenticate(token);
      const grant = grants(scope.behavior.actions).find((g) => g.name === call.name);
      if (
        scope.channel.provider === CUSTOMER_PREVIEW_PROVIDER &&
        !grant &&
        !BUILT_IN_TOOLS.includes(call.name)
      )
        throw denied();
      if (grant && !(await workflowAvailable(scope, grant))) throw denied();
      const shared =
        !grant && !BUILT_IN_TOOLS.includes(call.name)
          ? await deps.connector.resolveTool(
              scope.channel,
              connectionIds(scope),
              call.name,
              call.arguments,
              `customer.tool:${scope.message.id}:${call.callId}`,
            )
          : undefined;
      const action = shared?.call.route?.toolName;
      if (action === CATALOG_EXECUTE) throw denied();
      const replyBody = shared
        ? customerToolReply(
            scope.channel.binding,
            scope.channel.connectionId,
            shared.call,
            recipient(scope),
          )
        : null;
      // Business actions must pass through a configured ownership-checked workflow.
      // Sharing a raw connector action must not bypass write deduplication or record scope.
      if (shared && !isCatalogRead(action) && replyBody === null) throw denied();
      const requestHash = hash(
        stableJsonValue({ name: call.name, arguments: call.arguments }),
      ).toString("hex");
      const messageId = scope.message.id;
      const ledger = await prisma.$transaction(async (tx) => {
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
          where: { messageId, OR: [{ callId: call.callId }, { requestHash }] },
        });
        if (prior) {
          // Catalog reads rerun against the current policy; a stored list or schema may be stale.
          const knowledgeRead = call.name === "search_knowledge" && prior.name === call.name;
          if (knowledgeRead && prior.requestHash !== requestHash) throw denied();
          // A knowledge read has no side effects, so a failed one may be retried as well.
          const rerun = (isCatalogRead(action) && isCatalogRead(prior.actionId)) || knowledgeRead;
          if (!rerun && (prior.requestHash !== requestHash || prior.status !== "completed"))
            throw new Error("Customer action outcome is uncertain; do not replay");
          return { callId: prior.callId, replay: !rerun, result: prior.result };
        }
        if ((await tx.customerToolCall.count({ where: { messageId } })) >= 16)
          throw new Error("Customer action limit reached");
        if (
          replyBody !== null &&
          (await tx.customerToolCall.count({
            where: { messageId, replyBody: { not: null } },
          }))
        )
          throw new Error("This customer turn already has a reply");
        await tx.customerToolCall.create({
          data: {
            messageId,
            callId: call.callId,
            name: call.name,
            requestHash,
            status: "executing",
            replyBody,
            // A workflow is recorded by name and account; its grant fixes the steps.
            connectionId: shared?.call.route?.resourceId ?? grant?.connectionId,
            actionId: action,
          },
        });
        return { callId: call.callId, replay: false, result: null };
      });
      if (ledger.replay) return ledger.result;
      const key = { messageId, callId: ledger.callId };
      try {
        let result: unknown;
        if (call.name === "request_human") {
          const { reason } = z
            .object({ reason: z.string().trim().min(1).max(500) })
            .strict()
            .parse(call.arguments);
          await prisma.$transaction((tx) => handoffCustomer(tx, scope.conversation.id, reason));
          result = { handedOff: true };
        } else if (call.name === "search_knowledge") {
          if (!scope.channel.bot.knowledgeLibraryId && !scope.behavior.knowledgeFilterId)
            throw denied();
          const { query } = KnowledgeSearchInput.parse(call.arguments);
          if (scope.channel.bot.knowledgeLibraryId) {
            if (!deps.knowledge) throw denied();
            result = await deps.knowledge.search(
              scope.channel,
              scope.channel.botId,
              "customer",
              query,
              AbortSignal.timeout(20_000),
            );
          } else {
            const runtime = await deps.runtime(scope.channel, scope.behavior);
            if (!runtime.search || !scope.behavior.knowledgeFilterId) throw denied();
            result = await runtime.search({
              query,
              knowledgeFilterId: scope.behavior.knowledgeFilterId,
              signal: AbortSignal.timeout(20_000),
            });
          }
          await authenticate(token);
        } else if (shared) {
          await authenticate(token);
          result = await deps.connector.executeTool(
            scope.channel,
            connectionIds(scope),
            shared.call,
          );
          const binding = CustomerBindingSchema.safeParse(scope.channel.binding);
          if (
            action === CATALOG_LOAD &&
            binding.success &&
            scope.channel.connectionId &&
            shared.call.args.id ===
              catalogActionId(scope.channel.connectionId, binding.data.send.action)
          )
            // Supply the current recipient without changing the shared provider schema.
            // Execution still checks the target against the server's conversation.
            result = {
              ...z.record(z.string(), z.unknown()).parse(result),
              suggestedArguments: customerInput(binding.data.send.input, {
                ...recipient(scope),
                body: "<your reply text>",
                messageId: customerDeliveryId(messageId, 0),
              }),
            };
        } else {
          if (!grant) throw denied();
          const input = parseConnectorToolArgs(grant.inputSchema, call.arguments);
          const identity = usesIdentity(grant)
            ? await currentCustomerIdentity(prisma, identityScope(scope, grant))
            : null;
          if (usesIdentity(grant) && !identity) throw denied();
          const recheckIdentity = async () => {
            if (!identity) return;
            const current = await currentCustomerIdentity(prisma, identityScope(scope, grant));
            if (current?.id !== identity.id || current.revision !== identity.revision)
              throw denied();
          };
          const values = {
            input,
            customerId: scope.message.senderId,
            providerCustomerId: identity?.value,
            threadId: scope.conversation.externalThreadId,
            steps: {} as Record<string, unknown>,
          };
          for (const step of grant.steps) {
            const current = await authenticate(token);
            await recheckIdentity();
            const currentGrant = grants(current.behavior.actions).find((g) => g.name === call.name);
            if (stableJsonValue(currentGrant ?? null) !== stableJsonValue(grant)) throw denied();
            const stepInput = customerWorkflowInput(step.input, values);
            const execute = (executionId: string) =>
              deps.connector.execute(
                scope.channel,
                grant.connectionId,
                step.action,
                stepInput,
                executionId,
                "customer",
                step.effect,
                identity?.providerRef,
              );
            if (step.effect === "write") {
              const operationKey = customerWorkflowInput({ key: step.operationKey! }, values).key;
              result = await executeCustomerOperation(
                prisma,
                {
                  spaceId: scope.channel.spaceId,
                  conversationId: scope.conversation.id,
                  receipt: step.receipt!,
                  connectionId: grant.connectionId,
                  action: step.action,
                  operationKey,
                  customerId: scope.message.senderId!,
                  input: stepInput,
                  identity: identity
                    ? {
                        id: identity.id,
                        revision: identity.revision,
                        providerRef: identity.providerRef,
                      }
                    : undefined,
                },
                execute,
              );
            } else {
              result = await execute(`customer.tool:${messageId}:${call.callId}:${step.name}`);
            }
            if (step.check) {
              const expected = customerWorkflowInput({ value: step.check.equals }, values).value;
              if (
                JSON.stringify(customerField(result, step.check.path)) !== JSON.stringify(expected)
              )
                throw denied();
            }
            await authenticate(token);
            await recheckIdentity();
            values.steps[step.name] = result;
          }
        }
        // Store what the caller receives: JSON drops a provider's undefined fields.
        const safeResult = z.json().parse(JSON.parse(JSON.stringify(result ?? null)));
        await prisma.$transaction(async (tx) => {
          // Serialize result retention with source withdrawal; retain the action identity.
          const source = await tx.$queryRaw<Array<{ status: string }>>`
            SELECT status FROM customer_messages WHERE id = ${messageId} FOR SHARE`;
          await tx.customerToolCall.update({
            where: { messageId_callId: key },
            data: {
              status: "completed",
              result:
                source[0]?.status === "withdrawn"
                  ? Prisma.DbNull
                  : safeResult === null
                    ? Prisma.JsonNull
                    : safeResult,
            },
          });
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
