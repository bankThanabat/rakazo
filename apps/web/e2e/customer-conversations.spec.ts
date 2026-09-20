import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("connected customer conversation supports takeover, reply, and resume", async ({
  page,
}, testInfo) => {
  await signup(page, `customers-${Date.now()}@rakazo.test`, "password12", "Support owner");
  await completeOnboarding(page);
  const conversation = {
    id: "live-conversation",
    channelId: "connector-account",
    provider: "any-messenger",
    channelName: "Support",
    name: "Customer",
    avatarUrl: null,
    owner: "bot",
    canReply: true,
    needsHuman: false,
    handoffReason: null as string | null,
    preview: "Is the promotion available?",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
  const messages = [
    {
      id: "incoming",
      seq: 201,
      role: "customer",
      body: conversation.preview,
      mediaUrl: null,
      status: "received",
      errorCode: null as string | null,
      sentParts: 0,
      createdAt: conversation.updatedAt,
    },
  ];
  await page.route("**/rpc/customers/list", (route) =>
    route.fulfill({ json: { json: [conversation] } }),
  );
  await page.route("**/rpc/customers/snapshot", (route) => {
    const historical = Boolean(route.request().postDataJSON().json.before);
    return route.fulfill({
      json: {
        json: {
          conversation,
          messages: historical
            ? [{ ...messages[0], id: "earlier", seq: 1, body: "Earlier support request." }]
            : messages,
          before: historical ? null : 201,
          actions: historical
            ? [
                {
                  name: "Order lookup",
                  status: "completed",
                  createdAt: conversation.updatedAt,
                  outcome: "Confirmed historical order",
                },
              ]
            : [],
        },
      },
    });
  });
  await page.route("**/rpc/customers/updateCase", (route) =>
    route.fulfill({ json: { json: { ok: true } } }),
  );
  await page.route("**/rpc/customers/setOwner", async (route) => {
    conversation.owner = route.request().postDataJSON().json.owner;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await page.route("**/rpc/customers/reply", async (route) => {
    const input = route.request().postDataJSON().json;
    expect(input.id).toBe(conversation.id);
    expect(input.nonce).toBeTruthy();
    messages.push({
      id: "outgoing",
      seq: 202,
      role: "staff",
      body: input.body,
      mediaUrl: null,
      status: "sent",
      errorCode: null,
      sentParts: 1,
      createdAt: conversation.updatedAt,
    });
    await route.fulfill({ json: { json: { ok: true } } });
  });
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.getByRole("tab", { name: "Customer", exact: true }).click();
  await sidebar.getByRole("button", { name: /Customer.*Support/ }).click();
  await expect(page.getByRole("textbox", { name: "Reply to customer" })).toHaveCount(0);
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Reply to customer", exact: true });
  await composer.fill("Yes, the promotion is available tonight.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(
    page.getByText("Yes, the promotion is available tonight.", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "customer-conversation-takeover");
  await page.getByRole("button", { name: "Earlier messages", exact: true }).click();
  await expect(page.getByText("Earlier support request.", { exact: true })).toBeVisible();
  await page.getByText("Action history", { exact: true }).click();
  await expect(page.getByText("Confirmed historical order", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "customer-historical-action");
  await page.getByRole("button", { name: "Latest messages", exact: true }).click();
  await expect(page.getByText("Confirmed historical order", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume AI", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toBeVisible();
  conversation.owner = "staff";
  conversation.needsHuman = true;
  conversation.handoffReason =
    "Delivery or execution failed. Check the action outcome before retrying.";
  messages.push({
    id: "unconfirmed",
    seq: 203,
    role: "staff",
    body: "Your order is ready for dispatch.",
    mediaUrl: null,
    status: "failed",
    errorCode: "execution_uncertain",
    sentParts: 0,
    createdAt: conversation.updatedAt,
  });
  await expect(page.getByText("Delivery unconfirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("Reply failed", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "customer-delivery-unconfirmed");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Delivery unconfirmed", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "customer-delivery-unconfirmed-mobile");
});
