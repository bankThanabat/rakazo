import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("retired channels leave a readable customer archive without sending controls", async ({
  page,
}, testInfo) => {
  await signup(page, `archive-${Date.now()}@rakazo.test`, "password12", "Archive owner");
  await completeOnboarding(page);
  const conversation = {
    id: "archived-conversation",
    channelId: "retired-channel",
    provider: "line",
    channelName: "Former support",
    name: "Archived customer",
    avatarUrl: null,
    owner: "staff",
    needsHuman: false,
    preview: "Historical reply",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
  await page.route("**/rpc/customers/list", (route) =>
    route.fulfill({ json: { json: [conversation] } }),
  );
  await page.route("**/rpc/customers/snapshot", (route) =>
    route.fulfill({
      json: {
        json: {
          conversation,
          messages: [
            {
              id: "message",
              seq: 1,
              role: "staff",
              body: "Historical reply",
              mediaUrl: null,
              status: "sent",
              createdAt: "2026-09-10T00:00:00.000Z",
            },
          ],
        },
      },
    }),
  );
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.getByRole("tab", { name: "Customer", exact: true }).click();
  await sidebar.getByRole("button", { name: /Archived customer/ }).click();
  await expect(page.getByText("Historical reply", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume AI", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Reply to customer", exact: true })).toHaveCount(
    0,
  );
  await captureScreenshot(page, testInfo, "customer-archive");
  await sidebar.getByRole("button", { name: "Integrations", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Search apps", exact: true })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Channels", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Connect channel", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-without-native-channels");
  const removed = await page.request.post("/api/v1/customers/channels/retired-channel/webhook", {
    data: {},
  });
  expect(removed.status()).toBe(404);
});
