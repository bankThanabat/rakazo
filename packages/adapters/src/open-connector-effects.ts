/** Fixed reads audited with scripts/verify-openconnector-read-effects.mjs.
 * Unknown actions stay consequential; names, scopes and HTTP POST alone do not
 * establish whether an action can change provider state.
 */
export const openConnectorReadActions: Record<string, readonly string[]> = {
  instagram: [
    "get_current_user",
    "list_media",
    "list_media_comments",
    "list_comment_replies",
    "list_conversations",
    "list_conversation_messages",
    "get_message",
  ],
  line: ["get_bot_info"],
  woocommerce: [
    "list_products",
    "get_product",
    "list_product_variations",
    "get_product_variation",
    "list_orders",
    "get_order",
    "get_customer",
    "list_coupons",
    "get_coupon",
  ],
  shopify_admin: [
    "list_products",
    "get_product",
    "list_product_variants",
    "get_order",
    "get_customer",
    "get_inventory_quantities",
  ],
  googlesheets: ["values_get", "batch_get"],
};

export function openConnectorReadOnly(action: { id: string; service: string; readOnly?: boolean }) {
  if (action.readOnly !== undefined) return action.readOnly;
  const actions = Object.hasOwn(openConnectorReadActions, action.service)
    ? openConnectorReadActions[action.service]!
    : [];
  return actions.some((name) => action.id === `${action.service}.${name}`);
}
