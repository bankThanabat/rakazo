import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createCustomerConversations } from "../packages/adapters/src/customer-conversations.js";
import { LangflowCustomerRuntime } from "../packages/adapters/src/customer-runtime.js";
import { IntegrationProviderSettings } from "../packages/adapters/src/integration-provider-settings.js";
import { EncryptedSecretStore } from "../packages/adapters/src/secrets.js";
import { GraphileJobPublisher } from "../packages/adapters/src/wakeup.js";
import { createDb } from "../packages/db/src/client.js";

// Copied into the owned application container and executed with its dependencies.
void (async () => {
  // The supported local service origins use loopback. Forward only these two
  // fixed ports into the fixture's internal network; keep production URL guards.
  const bridges = [
    [17860, "langflow", 7860],
    [18000, "openrag-backend", 8000],
  ] as const;
  const servers = bridges.map(([, hostname, port]) =>
    createServer((incoming, outgoing) => {
      const upstream = request(
        {
          hostname,
          port,
          path: incoming.url,
          method: incoming.method,
          headers: { ...incoming.headers, host: `${hostname}:${port}` },
          timeout: 90_000,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502).end();
      });
      upstream.on("timeout", () => upstream.destroy());
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    }),
  );
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  const jobs = new GraphileJobPublisher(pool);
  const secrets = new EncryptedSecretStore(process.env.ENCRYPTION_KEY!);
  try {
    await Promise.all(
      servers.map(
        (server, index) =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(bridges[index]![0], "127.0.0.1", resolve);
          }),
      ),
    );
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: "recovery-example-bot" } });
    const actor = { userId: bot.userId, spaceId: bot.spaceId };
    const runtimeUrl = "http://127.0.0.1:17860/api/v1";
    const knowledgeUrl = "http://127.0.0.1:18000/v1";
    if (process.argv[2] === "seed") {
      const input = JSON.parse(await readFile("/dev/stdin", "utf8"));
      const login = await fetch(`${runtimeUrl}/auto_login`).then((r) => r.json());
      const response = await fetch(`${runtimeUrl}/api_key/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${login.access_token}`,
        },
        body: JSON.stringify({ name: "Synthetic coordinated recovery" }),
      });
      assert(response.ok);
      const { api_key: runtimeKey } = await response.json();
      for (const [name, baseUrl, key] of [
        ["recovery_runtime", runtimeUrl, runtimeKey],
        ["recovery_knowledge", knowledgeUrl, input.key],
      ]) {
        const id = randomUUID();
        await prisma.botSecret.create({
          data: {
            id,
            ...actor,
            botId: bot.id,
            name,
            origin: new URL(baseUrl).origin,
            auth: { type: "header", name: "x-api-key" },
            ciphertext: secrets.seal(key, id),
          },
        });
      }
      const runtime = new LangflowCustomerRuntime({
        baseUrl: runtimeUrl,
        apiKey: runtimeKey,
        knowledge: { baseUrl: knowledgeUrl, apiKey: input.key },
      });
      const instructions = "Use only the approved synthetic policy.";
      const flowId = await runtime.publish({
        staffId: bot.id,
        publicationId: randomUUID(),
        instructions,
        knowledgeFilterId: input.filterId,
        signal: AbortSignal.timeout(90_000),
      });
      await prisma.customerBehavior.create({
        data: {
          botId: bot.id,
          flowId,
          instructions,
          runtime: { credential: "recovery_runtime", baseUrl: runtimeUrl },
          knowledge: { credential: "recovery_knowledge", baseUrl: knowledgeUrl },
          knowledgeFilterId: input.filterId,
        },
      });
    }
    const behavior = await prisma.customerBehavior.findUniqueOrThrow({ where: { botId: bot.id } });
    const credential = await prisma.botSecret.findFirstOrThrow({
      where: { botId: bot.id, name: "recovery_runtime" },
    });
    const runtime = new LangflowCustomerRuntime({
      baseUrl: runtimeUrl,
      apiKey: secrets.load(credential.ciphertext, credential.id),
    });
    assert(
      await runtime.inspectPublication({
        staffId: bot.id,
        publicationId: behavior.flowId.split(":")[2]!,
        signal: AbortSignal.timeout(30_000),
      }),
    );
    const service = createCustomerConversations({
      prisma,
      secrets,
      jobs,
      integrations: new IntegrationProviderSettings(
        prisma,
        secrets,
        "synthetic-coordinated-identity",
      ),
    });
    const result = (await service.manage(actor, bot.id, "knowledge", {
      query: "parcel departure schedule",
    })) as { results: { text: string }[] };
    assert.deepEqual(
      result.results.map((item) => item.text),
      ["Synthetic orders leave the warehouse in two days."],
    );
    console.log(
      "Saved encrypted credentials and customer behavior resolve the restored flow and only the authorized knowledge document.",
    );
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    await jobs.close();
    await prisma.$disconnect();
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
