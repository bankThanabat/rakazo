// Read-only preflight. Run inside the connector container so credentials stay there:
// docker exec -i <connector-container> node --input-type=module < this-file
// Reports only fixed provider names and aggregate counts, never account details.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const selected = [
  "line",
  "instagram",
  "whatsapp",
  "telegram",
  "meta",
  "shopify_admin",
  "shopify_storefront",
  "woocommerce",
  "googlesheets",
  "googledrive",
  "hubspot",
  "invoice_ninja",
  "xero",
  "elorus",
];
// These are the concrete V1 actions being validated, not a claim that a listed
// handler or configured account has passed provider acceptance.
export const actionChecks = {
  line: ["get_bot_info", "send_push_text"],
  instagram: [
    "get_current_user",
    "list_media",
    "list_media_comments",
    "list_comment_replies",
    "list_conversations",
    "list_conversation_messages",
    "get_message",
    "reply_to_comment",
    "send_message",
  ],
  woocommerce: [
    "get_product",
    "get_store_product",
    "get_order",
    "create_cart",
    "get_cart",
    "add_cart_item",
    "update_cart_item",
    "remove_cart_item",
    "apply_cart_coupon",
    "remove_cart_coupon",
    "update_cart_customer",
    "select_cart_shipping_rate",
    "get_checkout",
    "submit_checkout",
  ],
};

export function inspectAcceptance(catalog, connections) {
  assert.ok(
    Array.isArray(catalog) && Array.isArray(connections),
    "Connector preflight expected lists",
  );
  return {
    readOnly: true,
    providerAcceptance: "not established by configuration or catalog presence",
    providers: selected.map((service) => {
      const provider = catalog.find((item) => item.service === service);
      const actions = provider?.actions ?? [];
      return {
        service,
        catalogPresent: Boolean(provider),
        actions: actions.length,
        locallyExecutable: actions.filter((action) => action.execution?.locallyExecutable === true)
          .length,
        declaredReadOnly: actions.filter((action) => action.readOnly === true).length,
        configuredConnections: connections.filter(
          (connection) => connection.service === service && connection.configured === true,
        ).length,
        actionChecks: (actionChecks[service] ?? []).map((name) => {
          const id = `${service}.${name}`;
          const action = actions.find((item) => item.id === id);
          return {
            id,
            catalogPresent: Boolean(action),
            locallyExecutable: action?.execution?.locallyExecutable === true,
          };
        }),
      };
    }),
  };
}

if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: The deployed connector owns this credential.
  const admin = process.env.OOMOL_CONNECT_ADMIN_TOKEN;
  assert.ok(admin, "Connector admin authentication is required");
  const read = async (path) => {
    const response = await fetch(`http://127.0.0.1:3000${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${admin}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    assert.ok(response.ok, "Connector preflight request failed");
    return response.json();
  };
  const [catalog, connections] = await Promise.all([
    read("/api/providers"),
    read("/api/connections"),
  ]);
  console.log(JSON.stringify(inspectAcceptance(catalog, connections), null, 2));
}
