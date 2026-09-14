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
    preview: "Is the promotion available?",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
  const messages = [
    {
      id: "incoming",
      seq: 1,
      role: "customer",
      body: conversation.preview,
      mediaUrl: null,
      status: "received",
      createdAt: conversation.updatedAt,
    },
  ];
  await page.route("**/rpc/customers/list", (route) =>
    route.fulfill({ json: { json: [conversation] } }),
  );
  await page.route("**/rpc/customers/snapshot", (route) =>
    route.fulfill({ json: { json: { conversation, messages } } }),
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
      seq: 2,
      role: "staff",
      body: input.body,
      mediaUrl: null,
      status: "sent",
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
  await page.getByRole("button", { name: "Resume staff", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toBeVisible();
});
