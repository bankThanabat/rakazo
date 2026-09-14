import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("website visitor hands off to the real staff inbox and receives a reply", async ({
  page,
  context,
}, testInfo) => {
  const email = `website-${Date.now()}@rakazo.test`;
  await signup(page, email, "password12", "Support owner");
  await completeOnboarding(page);
  const fixture = await page.request.post(`${process.env.API_URL}/__e2e/customer`, {
    data: { email },
  });
  expect(fixture.ok()).toBe(true);
  const { channelId } = await fixture.json();
  const origin = new URL(page.url()).origin;
  const visitor = await context.newPage();
  // Only the host page and channel are fixtures; visitor and staff workflows use the real API.
  await visitor.goto(`${origin}/api/__e2e/widget?channel=${channelId}`);
  const widget = visitor.frameLocator('iframe[title="Customer support"]');
  await widget.getByRole("button", { name: "Open support" }).click();
  await widget.getByRole("button", { name: "Talk to a person" }).click();
  await expect(widget.getByText("Waiting for support")).toBeVisible();
  await widget.getByRole("textbox", { name: "Message support" }).fill("Please check my delivery.");
  await widget.getByRole("button", { name: "Send", exact: true }).click();
  await expect(widget.getByText("Please check my delivery.", { exact: true })).toBeVisible();
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.getByRole("tab", { name: "Customer", exact: true }).click();
  await sidebar.getByRole("button", { name: /Visitor.*Website support/ }).click();
  await expect(page.getByText("Please check my delivery.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reply to customer", exact: true })
    .fill("I will check your delivery now.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(widget.getByText("I will check your delivery now.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "website-staff-inbox");
  await captureScreenshot(visitor, testInfo, "website-visitor-reply");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(widget.getByRole("textbox", { name: "Message support" })).toBeVisible();
  await captureScreenshot(visitor, testInfo, "website-visitor-mobile");
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  await visitor.close();
});
