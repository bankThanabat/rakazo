import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { CustomerChannel, CustomerSnapshot } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("connect a customer channel, receive a bot reply, take over and resume", async ({
  page,
}, testInfo) => {
  page.setDefaultTimeout(10000);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("https://images.example.test/customer.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="white"/><text x="40" y="52" text-anchor="middle" font-family="sans-serif" font-size="30" fill="black">AC</text></svg>',
    }),
  );
  await signup(page, `customer-${Date.now()}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.getByRole("tab", { name: "Customer", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Channels", exact: true })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Integrations", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
  await expect(dialog.getByRole("tab", { name: "Apps", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await dialog.getByRole("tab", { name: "Channels", exact: true }).click();
  await expect(dialog.getByText("No channels connected", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Connect channel", exact: true }).click();
  await dialog.getByLabel("Channel", { exact: true }).selectOption("line");
  await dialog.getByLabel("Name", { exact: true }).fill("Store support");
  await dialog.getByLabel("Bot user ID", { exact: true }).fill(`test-${Date.now()}`);
  await dialog.getByLabel("Channel access token", { exact: true }).fill("test-access-token");
  await dialog.getByLabel("Channel secret", { exact: true }).fill("test-channel-secret");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByLabel("Webhook URL")).toBeVisible();
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog.locator("summary")).toContainText("Not connected");
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(dialog.locator("summary")).toContainText("Connected");
  const webhookUrl = await dialog.getByLabel("Webhook URL").inputValue();
  expect(new URL(webhookUrl).origin).not.toBe(new URL(page.url()).origin);
  await captureScreenshot(page, testInfo, "customer-channel-settings");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "integration-channels-narrow");
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole("tab", { name: "Apps", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Search apps" })).toBeVisible();
  await dialog.getByRole("tab", { name: "Channels", exact: true }).click();
  await expect(dialog.getByText("Store support", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByLabel("Webhook URL")).not.toBeVisible();
  await dialog.locator("summary").filter({ hasText: "Store support" }).click();
  await expect(dialog.getByLabel("Webhook URL")).toBeVisible();
  const [channel] = await rpc<CustomerChannel[]>(page, "customers/channels", {});
  expect(channel).toBeDefined();
  await page.keyboard.press("Escape");

  async function incoming(text: string, id: string) {
    const body = JSON.stringify({
      destination: channel!.accountId,
      events: [
        {
          type: "message",
          webhookEventId: id,
          timestamp: Date.now(),
          source: { type: "user", userId: "Customer" },
          message: { id, type: "text", text },
        },
      ],
    });
    const response = await page.request.post(channel!.webhookUrl!, {
      data: body,
      headers: {
        "content-type": "application/json",
        "x-line-signature": createHmac("sha256", "test-channel-secret")
          .update(body)
          .digest("base64"),
      },
    });
    expect(response.status()).toBe(200);
  }
  await incoming("Hello, I have a product question", "message-1");
  await sidebar.getByRole("button", { name: /Alex Customer Store support/ }).click();
  await expect(page.getByText("Alex Customer", { exact: true })).toHaveCount(2);
  const avatars = page.locator('[data-slot="avatar-image"]');
  await expect(avatars).toHaveCount(2);
  await expect
    .poll(() =>
      avatars.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
  const conversation = (await rpc<Array<{ id: string }>>(page, "customers/list", {}))[0]!;
  const snapshot = () => rpc<CustomerSnapshot>(page, "customers/snapshot", { id: conversation.id });
  await expect
    .poll(
      async () =>
        (await snapshot()).messages.filter((m) => m.role === "bot" && m.status === "sent").length,
    )
    .toBe(1);
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume bot", exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Reply to customer", exact: true })
    .fill("A team member is here to help.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () =>
      (await snapshot()).messages.some((m) => m.role === "staff" && m.status === "sent"),
    )
    .toBe(true);
  await expect(page.getByText("A team member is here to help.", { exact: true })).toBeVisible();
  await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "customer-staff-takeover");

  await page.getByRole("button", { name: "Resume bot", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Reply to customer", exact: true })).toHaveCount(
    0,
  );
  await incoming("Thank you", "message-2");
  await expect
    .poll(
      async () =>
        (await snapshot()).messages.filter((m) => m.role === "bot" && m.status === "sent").length,
    )
    .toBe(2);
  await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "customer-bot-resumed");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "customer-thread-narrow");
});
