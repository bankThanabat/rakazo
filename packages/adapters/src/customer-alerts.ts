import { randomUUID } from "node:crypto";
import type { NotificationProvider } from "@rakazo/adapter-kit";
import { NotificationDeliveryError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { CustomerQuietHoursSchema } from "@rakazo/contracts";
import { customerAlertResumeAt } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

type Attention = {
  id: string;
  botId: string;
  spaceId: string;
  userId: string;
  shared: boolean;
  assigneeId: string | null;
  attentionId: string;
  attentionStartedAt: Date;
  attentionAlertStage: number;
};
type AdditionalProviders = (
  recipient: Pick<Actor, "userId" | "spaceId">,
) => Promise<NotificationProvider[]>;

function schedule(owner: boolean, at: Date | null) {
  return owner ? { ownerAttentionAlertAt: at } : { nextAttentionAlertAt: at };
}

async function advance(tx: Prisma.TransactionClient, row: Attention, now: Date, owner: boolean) {
  const reminderAt = new Date(row.attentionStartedAt.getTime() + 10 * 60000);
  // One notification covers an initial alert and reminder both delayed by quiet hours.
  const stage =
    row.attentionAlertStage === 0 && reminderAt <= now ? 2 : row.attentionAlertStage + 1;
  await tx.customerConversation.update({
    where: { id: row.id },
    data: owner
      ? schedule(true, null)
      : {
          attentionAlertStage: stage,
          ...schedule(false, stage === 1 ? reminderAt : null),
        },
  });
}

/** Lock the case and current authorization again immediately before dispatch. */
async function context(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date,
  owner: boolean,
  expected?: { attentionId: string; recipientId: string; stage: number },
) {
  const [row] = await tx.$queryRaw<Attention[]>`
    SELECT conversation.id, conversation."assigneeId", conversation."attentionId",
      conversation."attentionStartedAt", conversation."attentionAlertStage",
      channel."botId", channel."spaceId", channel."userId", channel.shared
    FROM customer_conversations conversation
    JOIN customer_channels channel ON channel.id = conversation."channelId"
    JOIN bots bot ON bot.id = channel."botId"
    WHERE conversation.id = ${id} AND conversation."needsHuman" = true
      AND conversation."acknowledgedAt" IS NULL AND conversation.state <> 'resolved'
      AND ((NOT ${owner} AND conversation."nextAttentionAlertAt" <= ${now})
        OR (${owner} AND conversation."ownerAttentionAlertAt" <= ${now}))
      AND conversation."attentionId" IS NOT NULL AND conversation."attentionStartedAt" IS NOT NULL
      AND conversation."attentionAlertStage" BETWEEN 0 AND 2
      AND channel.enabled = true AND bot."archivedAt" IS NULL
      AND (channel."connectionId" IS NOT NULL OR channel.provider = 'web')
    FOR UPDATE OF conversation SKIP LOCKED
    FOR SHARE OF channel, bot`;
  if (
    !row ||
    (expected &&
      (row.attentionId !== expected.attentionId ||
        (owner ? 2 : row.attentionAlertStage) !== expected.stage))
  )
    return;
  const [recipient] = await tx.$queryRaw<Array<{ userId: string }>>`
    SELECT member."userId" FROM space_members member
    WHERE member."spaceId" = ${row.spaceId}
      AND (${row.shared} OR member."userId" = ${row.userId})
      AND (NOT ${owner} OR member.role = 'owner')
      AND (member."userId" = ${row.assigneeId} OR member.role = 'owner' OR member."userId" = ${row.userId})
    ORDER BY CASE WHEN member."userId" = ${row.assigneeId} THEN 0
      WHEN member.role = 'owner' THEN 1 ELSE 2 END, member."createdAt", member.id
    LIMIT 1 FOR SHARE OF member`;
  if (!recipient || (expected && recipient.userId !== expected.recipientId)) return;
  const [preference] = await tx.$queryRaw<Array<{ help: boolean; customerQuietHours: unknown }>>`
    SELECT help, "customerQuietHours" FROM notification_preferences
    WHERE "spaceId" = ${row.spaceId} AND "userId" = ${recipient.userId} FOR SHARE`;
  if (owner && (!row.assigneeId || row.assigneeId === recipient.userId)) {
    await advance(tx, row, now, owner);
    return;
  }
  if (preference?.customerQuietHours) {
    const resumeAt = customerAlertResumeAt(
      CustomerQuietHoursSchema.parse(preference.customerQuietHours),
      now,
    );
    if (resumeAt) {
      await tx.customerConversation.update({ where: { id }, data: schedule(owner, resumeAt) });
      return;
    }
  }
  return { row, recipientId: recipient.userId, appEnabled: preference?.help !== false };
}

/** Snapshot the destinations and persist every dispatch intent before sending. */
async function claim(
  prisma: PrismaClient,
  configured: ReadonlyMap<string, NotificationProvider>,
  id: string,
  now: Date,
  owner: boolean,
  additional?: AdditionalProviders,
) {
  return prisma.$transaction(async (tx) => {
    const current = await context(tx, id, now, owner);
    if (!current) return;
    const { row, recipientId } = current;
    const providers = new Map(current.appEnabled ? configured : []);
    for (const provider of (await additional?.({ userId: recipientId, spaceId: row.spaceId })) ??
      []) {
      const key = provider.describe().id;
      if (!key || providers.has(key)) throw new Error("Customer alert providers need unique IDs");
      providers.set(key, provider);
    }
    const stage = owner ? 2 : row.attentionAlertStage;
    const where = { attentionId: row.attentionId, stage };
    const prior = await tx.customerAlertDelivery.findMany({ where, orderBy: { provider: "asc" } });
    // Never add a newly configured provider to a partly delivered stage. A worker
    // restart, provider reorder or configuration change must not duplicate it.
    const destinations = prior.length
      ? prior.map((entry) => entry.provider)
      : [...providers.keys()];
    const deliveries = [];
    for (const provider of destinations) {
      const previous = prior.find((entry) => entry.provider === provider);
      if (previous?.status === "sending") {
        if (previous.leaseUntil && previous.leaseUntil > now) continue;
        // A crashed sender and a lost success receipt are indistinguishable.
        await tx.customerAlertDelivery.update({
          where: { id: previous.id },
          data: { status: "uncertain", retryable: false, claimToken: null, leaseUntil: null },
        });
        continue;
      }
      if (
        previous &&
        previous.status !== "cancelled" &&
        !(previous.status === "failed" && previous.retryable && previous.attempts < 3)
      )
        continue;
      if (!providers.has(provider)) {
        // Keep the missing destination visible; never redirect its retry.
        await tx.customerAlertDelivery.update({
          where: { id: previous!.id },
          data: {
            status: !current.appEnabled && configured.has(provider) ? "skipped" : "failed",
            retryable: false,
            claimToken: null,
            leaseUntil: null,
          },
        });
        continue;
      }
      const data = {
        recipientId,
        provider,
        status: "sending",
        claimToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 30000),
        retryable: false,
      };
      deliveries.push(
        await tx.customerAlertDelivery.upsert({
          where: { attentionId_stage_provider: { ...where, provider } },
          create: { conversationId: id, ...where, ...data },
          update: { ...data, attempts: { increment: 1 } },
        }),
      );
    }
    return { ...where, recipientId, deliveries, providers };
  });
}

/** Advance the shared schedule only after every destination has a receipt. */
async function settle(
  prisma: PrismaClient,
  id: string,
  now: Date,
  owner: boolean,
  expected: { attentionId: string; recipientId: string; stage: number },
) {
  await prisma.$transaction(async (tx) => {
    const current = await context(tx, id, now, owner, expected);
    if (!current) return;
    const deliveries = await tx.customerAlertDelivery.findMany({
      where: { attentionId: expected.attentionId, stage: expected.stage },
    });
    if (deliveries.some((entry) => entry.status === "sending" || entry.status === "cancelled"))
      return;
    const retries = deliveries.filter((entry) => entry.status === "failed" && entry.retryable);
    if (retries.length) {
      await tx.customerConversation.update({
        where: { id },
        data: schedule(
          owner,
          new Date(now.getTime() + Math.max(...retries.map((entry) => entry.attempts)) * 60000),
        ),
      });
    } else {
      await advance(tx, current.row, now, owner);
    }
  });
}

async function dispatch(
  prisma: PrismaClient,
  notifications: NotificationProvider,
  id: string,
  now: Date,
  owner: boolean,
  delivery: NonNullable<Awaited<ReturnType<typeof claim>>>["deliveries"][number],
  appDestination: boolean,
) {
  let failure: unknown;
  await prisma.$transaction(
    async (tx) => {
      const current = await context(tx, id, now, owner, delivery);
      if (!current) {
        await tx.customerAlertDelivery.updateMany({
          where: { id: delivery.id, status: "sending", claimToken: delivery.claimToken },
          data: {
            status: "cancelled",
            attempts: { decrement: 1 },
            claimToken: null,
            leaseUntil: null,
          },
        });
        return;
      }
      const held = await tx.customerAlertDelivery.findUnique({ where: { id: delivery.id } });
      if (held?.status !== "sending" || held.claimToken !== delivery.claimToken) return;
      let status: "accepted" | "skipped" | "failed" | "uncertain" = "accepted";
      let reference: string | null = null;
      let retryable = false;
      try {
        const result =
          appDestination && !current.appEnabled
            ? { status: "skipped" as const }
            : await notifications.send(
                {
                  kind: "help",
                  title: "Customer needs attention",
                  body: "Open the customer inbox to follow up.",
                  botId: current.row.botId,
                  threadId: id,
                  customerConversationId: id,
                },
                {
                  userId: delivery.recipientId,
                  spaceId: current.row.spaceId,
                  operationId: `customer.alert:${delivery.id}`,
                  traceId: id,
                  signal: AbortSignal.timeout(10000),
                },
              );
        status = result.status;
        reference = result.status === "accepted" ? (result.reference?.slice(0, 200) ?? null) : null;
      } catch (error) {
        failure = error;
        const rejected = error instanceof NotificationDeliveryError && error.outcome === "rejected";
        status = rejected ? "failed" : "uncertain";
        retryable = rejected && error.retryable && delivery.attempts < 3;
      }
      await tx.customerAlertDelivery.update({
        where: { id: delivery.id },
        data: {
          status,
          reference,
          retryable,
          claimToken: null,
          leaseUntil: null,
        },
      });
    },
    { timeout: 15000 },
  );
  if (failure) throw failure;
}

/** Provider IDs identify stable destinations, not individual send attempts. */
export async function sendCustomerAttentionAlert(
  prisma: PrismaClient,
  notifications: NotificationProvider | readonly NotificationProvider[],
  id: string,
  now = new Date(),
  additional?: AdditionalProviders,
) {
  const configured = Array.isArray(notifications) ? notifications : [notifications];
  const providers = new Map<string, NotificationProvider>();
  for (const provider of configured) {
    const key = provider.describe().id;
    if (!key || providers.has(key)) throw new Error("Customer alert providers need unique IDs");
    providers.set(key, provider);
  }
  if (!providers.size && !additional) return;
  // A failed destination must not prevent another send or the owner's escalation.
  const failures: unknown[] = [];
  for (const owner of [false, true]) {
    try {
      const batch = await claim(prisma, providers, id, now, owner, additional);
      if (!batch) continue;
      for (const delivery of batch.deliveries) {
        try {
          await dispatch(
            prisma,
            batch.providers.get(delivery.provider)!,
            id,
            now,
            owner,
            delivery,
            providers.has(delivery.provider),
          );
        } catch (error) {
          failures.push(error);
        }
      }
      await settle(prisma, id, now, owner, batch);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Customer notification failed");
}
