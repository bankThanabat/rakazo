const identifier = /^[A-Za-z0-9_-]{1,128}$/;

/** A link identifies a case; the session and RPC authorization still grant access. */
export function customerAlertTarget(params: URLSearchParams) {
  const spaceId = params.get("space");
  const conversationId = params.get("customer");
  if (!spaceId || !conversationId || !identifier.test(spaceId) || !identifier.test(conversationId))
    return null;
  return { spaceId, conversationId };
}

export function customerAlertPath(params: URLSearchParams) {
  const target = customerAlertTarget(params);
  return target
    ? `/app?${new URLSearchParams({ space: target.spaceId, customer: target.conversationId })}`
    : "/app";
}

/** Only known local destinations survive sign-in; never accept arbitrary redirects. */
export function safeSignInPath(next: string | null) {
  if (next === "/integrations/setup") return next;
  if (!next?.startsWith("/app?")) return "/app";
  const url = new URL(next, "https://app.invalid");
  return url.pathname === "/app" ? customerAlertPath(url.searchParams) : "/app";
}
