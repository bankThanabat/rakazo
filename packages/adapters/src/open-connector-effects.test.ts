import { describe, expect, it } from "vitest";
import { openConnectorReadOnly } from "./open-connector-effects.js";

describe("OpenConnector action effects", () => {
  it("requires an exact audited action and matching provider", () => {
    expect(openConnectorReadOnly({ service: "line", id: "line.get_bot_info" })).toBe(true);
    for (const id of [
      "instagram.list_media_comments",
      "instagram.list_comment_replies",
      "instagram.list_conversations",
      "instagram.list_conversation_messages",
      "instagram.get_message",
    ]) {
      expect(openConnectorReadOnly({ service: "instagram", id })).toBe(true);
      expect(openConnectorReadOnly({ service: "instagram", id, readOnly: false })).toBe(false);
    }
    expect(openConnectorReadOnly({ service: "instagram", id: "instagram.reply_to_comment" })).toBe(
      false,
    );
    expect(openConnectorReadOnly({ service: "instagram", id: "instagram.send_message" })).toBe(
      false,
    );
    expect(openConnectorReadOnly({ service: "line", id: "line.send_push_text" })).toBe(false);
    expect(openConnectorReadOnly({ service: "woocommerce", id: "woocommerce.get_order" })).toBe(
      true,
    );
    expect(openConnectorReadOnly({ service: "sample", id: "woocommerce.get_order" })).toBe(false);
    expect(
      openConnectorReadOnly({ service: "woocommerce", id: "woocommerce.get_order_and_delete" }),
    ).toBe(false);
    expect(openConnectorReadOnly({ service: "__proto__", id: "__proto__.get" })).toBe(false);
  });

  it("keeps generic GraphQL, writes and unaudited lookups consequential", () => {
    for (const id of [
      "shopify_admin.execute_graphql",
      "shopify_admin.submit_bulk_query",
      "woocommerce.create_order",
      "googlesheets.upsert_rows",
      "sample.get_data",
    ])
      expect(openConnectorReadOnly({ id, service: id.split(".")[0]! })).toBe(false);
  });

  it("allows audited order discovery without granting writes or overriding explicit metadata", () => {
    expect(openConnectorReadOnly({ service: "woocommerce", id: "woocommerce.list_orders" })).toBe(
      true,
    );
    expect(openConnectorReadOnly({ service: "sample", id: "woocommerce.list_orders" })).toBe(false);
    expect(
      openConnectorReadOnly({ service: "woocommerce", id: "woocommerce.list_orders_and_delete" }),
    ).toBe(false);
    expect(
      openConnectorReadOnly({
        service: "woocommerce",
        id: "woocommerce.list_orders",
        readOnly: false,
      }),
    ).toBe(false);
  });

  it("honors explicit provider metadata, including withdrawal of a read-only classification", () => {
    expect(openConnectorReadOnly({ service: "sample", id: "sample.lookup", readOnly: true })).toBe(
      true,
    );
    expect(
      openConnectorReadOnly({
        service: "woocommerce",
        id: "woocommerce.get_order",
        readOnly: false,
      }),
    ).toBe(false);
  });
});
