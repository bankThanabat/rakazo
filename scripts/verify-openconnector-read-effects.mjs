#!/usr/bin/env node
// Reproduce the locked connector source, then audit its handlers with synthetic responses.
// Usage: node scripts/verify-openconnector-read-effects.mjs /path/to/open-connector-with-dependencies
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openConnectorReadActions } from "../packages/adapters/src/open-connector-effects.ts";
import { prepareSource } from "./customer-sources.mjs";

if (!process.argv[2])
  throw new Error("Provide an OpenConnector checkout with installed dependencies");
const dependencies = realpathSync(resolve(process.argv[2], "node_modules"));
const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(readFileSync(resolve(root, "infra/compose/customer-sources.json"), "utf8"));
const connector = lock.find((item) => item.name === "OpenConnector");
const directory = mkdtempSync(resolve(tmpdir(), "rakazo-read-effects-"));
const source = resolve(directory, "source");
try {
  prepareSource(connector, root, source);
  symlinkSync(dependencies, resolve(source, "node_modules"), "dir");
  execFileSync(process.execPath, ["scripts/generate-provider-registry.ts"], {
    cwd: source,
    stdio: "pipe",
  });
  globalThis.fetch = () => {
    throw new Error("Unexpected network access in offline conformance");
  };
  const upstream = (file) => import(pathToFileURL(resolve(source, `src/providers/${file}`)).href);
  const { woocommerceActionHandlers } = await upstream("woocommerce/runtime.ts");
  const { shopifyAdminActionHandlers } = await upstream("shopify_admin/runtime.ts");
  const { googlesheetsActionHandlers } = await upstream("googlesheets/executors.ts");
  const { executeLineAction } = await upstream("line/runtime.ts");
  const { instagramActionHandlers } = await upstream("instagram/runtime.ts");
  const handlers = {
    instagram: instagramActionHandlers,
    line: {
      get_bot_info: (input, context) =>
        executeLineAction("get_bot_info", input, context.apiKey, context.fetcher),
    },
    woocommerce: woocommerceActionHandlers,
    shopify_admin: shopifyAdminActionHandlers,
    googlesheets: googlesheetsActionHandlers,
  };
  const connection = { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } };
  const graphData = {
    products: connection,
    productVariants: connection,
    product: { id: "gid://shopify/Product/7", title: "Example product" },
    order: {
      id: "gid://shopify/Order/7",
      name: "Example order",
      customer: { id: "example-customer" },
    },
    customer: { id: "example-customer", displayName: "Example customer" },
    inventoryItem: null,
  };
  const checked = [];
  for (const [service, actions] of Object.entries(openConnectorReadActions)) {
    const { provider } = await upstream(`${service}/definition.ts`);
    for (const action of actions) {
      assert.ok(
        provider.actions.some((item) => item.id === `${service}.${action}`),
        "Action must exist in catalog",
      );
      for (const extra of [
        {},
        {
          method: "DELETE",
          accountId: "unapproved-account",
          query: "mutation { deleteSomething }",
          endpoint: "/delete",
          body: { destructive: true },
        },
      ]) {
        const requests = [];
        const fetcher = async (target, init) => {
          const url = new URL(String(target));
          const method = init?.method ?? "GET";
          if (service === "shopify_admin") {
            assert.equal(method, "POST");
            assert.equal(url.pathname.endsWith("/graphql.json"), true);
            const body = JSON.parse(init.body);
            assert.match(body.query, /^\s*query\s/);
            assert.doesNotMatch(body.query, /\bmutation\b/);
          } else {
            assert.equal(method, "GET");
            assert.equal(init?.body, undefined);
            if (service === "line") assert.equal(url.pathname, "/v2/bot/info");
            if (service === "instagram") {
              assert.equal(url.origin, "https://graph.instagram.com");
              assert.equal(
                url.pathname,
                {
                  get_current_user: "/v25.0/me",
                  list_media: "/v25.0/owned-account/media",
                  list_media_comments: "/v25.0/owned-media/comments",
                  list_comment_replies: "/v25.0/owned-comment/replies",
                  list_conversations: "/v25.0/owned-account/conversations",
                  list_conversation_messages: "/v25.0/owned-conversation/messages",
                  get_message: "/v25.0/owned-message",
                }[action],
              );
            }
          }
          requests.push({ method, path: url.pathname });
          return Response.json(
            service === "instagram"
              ? action === "get_current_user"
                ? {
                    id: "owned-account",
                    user_id: "owned-account",
                    username: "synthetic",
                    account_type: "BUSINESS",
                  }
                : action === "get_message"
                  ? { id: "owned-message" }
                  : { data: [], paging: {} }
              : service === "shopify_admin"
                ? { data: graphData }
                : service === "woocommerce"
                  ? action.startsWith("list_")
                    ? []
                    : { id: 7, customer_id: 7 }
                  : { range: "Products!A1:B2", values: [["SKU", "Stock"]], valueRanges: [] },
          );
        };
        const result = await handlers[service][action](
          {
            id: "gid://shopify/Example/7",
            productId: 7,
            mediaId: "owned-media",
            commentId: "owned-comment",
            conversationId: "owned-conversation",
            messageId: "owned-message",
            variationId: 7,
            orderId: 7,
            customerId: 7,
            couponId: 7,
            inventoryItemId: "gid://shopify/InventoryItem/7",
            locationId: "gid://shopify/Location/7",
            spreadsheetId: "example-sheet",
            range: "Products!A1:B2",
            ranges: ["Products!A1:B2"],
            ...extra,
          },
          {
            apiKey: "fake-key",
            shopDomain: "example.myshopify.com",
            accessToken: "fake-token",
            accountId: "owned-account",
            apiBaseUrl: "https://store.example.test/wp-json/wc/v3",
            storeUrl: "https://store.example.test",
            consumerKey: "fake-key",
            consumerSecret: "fake-secret",
            fetcher,
          },
        );
        assert.ok(result && typeof result === "object", "Provider handler must complete");
        assert.equal(requests.length, 1, "Audited reads each issue one fixed request");
      }
      checked.push(`${service}.${action}`);
    }
  }
  console.log(
    JSON.stringify(
      {
        revision: connector.revision,
        tree: connector.tree,
        patches: connector.patches,
        networking: "disabled",
        actions: checked,
        checks: checked.length * 2,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
