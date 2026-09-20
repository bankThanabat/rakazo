import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("website visitor hands off to the real staff inbox and receives a reply", async ({
  page,
  context,
  browser,
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
  const failure = await page.request.post(`${process.env.API_URL}/__e2e/customer-alert`, {
    data: { email, channelId, status: "failed" },
  });
  expect(failure.ok()).toBe(true);
  await expect(page.getByText("Could not notify staff.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "website-staff-notification-failed");
  const { conversationId, spaceId } = await failure.json();
  const alertUrl = `${origin}/app?${new URLSearchParams({ space: spaceId, customer: conversationId })}`;
  const signedOut = await browser.newContext();
  const fromAlert = await signedOut.newPage();
  await fromAlert.goto(alertUrl);
  await expect(fromAlert).toHaveURL(/\/sign-in\?next=/);
  await expect(fromAlert.getByText("Please check my delivery.", { exact: true })).toHaveCount(0);
  await fromAlert.getByPlaceholder("Your email address").fill(email);
  await fromAlert.getByPlaceholder("Password").fill("password12");
  await fromAlert.getByRole("button", { name: "Continue with email", exact: true }).click();
  await expect(fromAlert.getByText("Please check my delivery.", { exact: true })).toBeVisible();
  await captureScreenshot(fromAlert, testInfo, "staff-alert-authenticated-case");
  await fromAlert.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(fromAlert, testInfo, "staff-alert-authenticated-case-mobile");
  await signedOut.close();
  const stranger = await browser.newContext();
  const denied = await stranger.newPage();
  await signup(denied, `unrelated-${Date.now()}@rakazo.test`, "password12", "Unrelated staff");
  await completeOnboarding(denied);
  await denied.goto(alertUrl);
  await expect(denied.getByText("Could not update conversation", { exact: true })).toBeVisible();
  await expect(denied.getByText("Please check my delivery.", { exact: true })).toHaveCount(0);
  await stranger.close();

  const uncertain = await page.request.post(`${process.env.API_URL}/__e2e/customer-alert`, {
    data: { email, channelId, status: "uncertain" },
  });
  expect(uncertain.ok()).toBe(true);
  await expect(
    page.getByText("Staff notification delivery is unconfirmed.", { exact: true }),
  ).toBeVisible();
  const desktopViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "website-staff-notification-mobile");
  await page.setViewportSize(desktopViewport);
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByRole("button", { name: "Acknowledged", exact: true })).toBeDisabled();
  await expect(
    page.getByText("Staff notification delivery is unconfirmed.", { exact: true }),
  ).toHaveCount(0);
  await expect(widget.getByText("Waiting for support")).toBeVisible();
  await captureScreenshot(page, testInfo, "website-staff-acknowledgement");
  await page.getByRole("button", { name: "Guide agent", exact: true }).click();
  const guidance =
    "PRIVATE: Ask for the order reference before checking delivery. Do not assume it was paid.";
  await page.getByRole("textbox", { name: "Private guidance", exact: true }).fill(guidance);
  await page.getByRole("button", { name: "Apply guidance", exact: true }).click();
  await expect(page.getByText(guidance, { exact: true })).toBeVisible();
  await expect(widget.getByText(guidance, { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "website-private-guidance");
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Reply to customer", exact: true })
    .fill("I will check your delivery now.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(widget.getByText("I will check your delivery now.", { exact: true })).toBeVisible();
  await expect(widget.getByText(guidance, { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "website-staff-inbox");
  await captureScreenshot(visitor, testInfo, "website-visitor-reply");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(widget.getByRole("textbox", { name: "Message support" })).toBeVisible();
  await captureScreenshot(visitor, testInfo, "website-visitor-mobile");
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  await visitor.close();
});

test("website shopper reviews an exact quote before staff checkout", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const email = `purchase-${Date.now()}@rakazo.test`;
  await signup(page, email, "password12", "Store owner");
  await completeOnboarding(page);
  const response = await page.request.post(`${process.env.API_URL}/__e2e/customer`, {
    data: { email },
  });
  const { channelId } = await response.json();
  const origin = new URL(page.url()).origin;
  const visitor = await context.newPage();
  await visitor.goto(`${origin}/api/__e2e/widget?channel=${channelId}`);
  const widget = visitor.frameLocator('iframe[title="Customer support"]');
  await widget.getByRole("button", { name: "Open support" }).click();
  await widget.getByRole("textbox", { name: "Message support" }).fill("One shirt, please.");
  await widget.getByRole("button", { name: "Send", exact: true }).click();
  await expect(widget.getByText("One shirt, please.", { exact: true })).toBeVisible();
  const publish = (quantity: number) =>
    page.request.post(`${process.env.API_URL}/__e2e/customer-purchase`, {
      data: { email, channelId, quantity },
    });
  expect((await publish(1)).ok()).toBe(true);
  await expect(widget.getByRole("heading", { name: "Review order details" })).toBeVisible();
  await expect(widget.getByText("THB 125.00", { exact: true })).toBeVisible();
  await expect(widget.getByText("Payment method: Bank transfer", { exact: true })).toBeVisible();
  await widget.getByRole("heading", { name: "Review order details" }).scrollIntoViewIfNeeded();
  await captureScreenshot(visitor, testInfo, "shopper-review-desktop-items");
  await widget
    .getByRole("button", { name: "Confirm details", exact: true })
    .scrollIntoViewIfNeeded();
  await captureScreenshot(visitor, testInfo, "shopper-review-desktop");
  await widget.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(
    widget.getByText("Changes requested. Tell support what to update.", { exact: true }),
  ).toBeVisible();
  expect((await publish(2)).ok()).toBe(true);
  await expect(widget.getByText("THB 250.00", { exact: true })).toBeVisible();
  await visitor.setViewportSize({ width: 390, height: 844 });
  await widget.getByRole("heading", { name: "Review order details" }).scrollIntoViewIfNeeded();
  await captureScreenshot(visitor, testInfo, "shopper-review-mobile");
  const confirm = widget.getByRole("button", { name: "Confirm details", exact: true });
  await confirm.focus();
  await expect(confirm).toBeFocused();
  await confirm.press("Enter");
  await expect(
    widget.getByText("Details confirmed. Your order has not been placed yet.", { exact: true }),
  ).toBeVisible();
  await expect(widget.getByRole("button", { name: "Confirm details", exact: true })).toHaveCount(0);
  const sidebar = page.getByTestId("bots-sidebar");
  await sidebar.getByRole("tab", { name: "Customer", exact: true }).click();
  await sidebar.getByRole("button", { name: /Visitor.*Website support/ }).click();
  await expect(page.getByText("Shopper confirmed order details", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await visitor.reload();
  await widget.getByRole("button", { name: "Open support" }).click();
  await expect(
    widget.getByText("Details confirmed. Your order has not been placed yet.", { exact: true }),
  ).toBeVisible();
  await widget
    .getByRole("button", { name: "Request changes", exact: true })
    .scrollIntoViewIfNeeded();
  await captureScreenshot(visitor, testInfo, "shopper-review-confirmed-mobile");
  await widget.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(
    widget.getByText("Changes requested. Tell support what to update.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Shopper requested changes to order details", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Acknowledge", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "shopper-review-staff-attention");
  const otherContext = await browser.newContext();
  const otherVisitor = await otherContext.newPage();
  await otherVisitor.goto(`${origin}/api/__e2e/widget?channel=${channelId}`);
  const otherWidget = otherVisitor.frameLocator('iframe[title="Customer support"]');
  await otherWidget.getByRole("button", { name: "Open support" }).click();
  await expect(otherWidget.getByRole("textbox", { name: "Message support" })).toBeVisible();
  await expect(otherWidget.getByText("Everyday cotton shirt", { exact: true })).toHaveCount(0);
  await expect(otherWidget.getByText("shopper@example.test", { exact: false })).toHaveCount(0);
  await otherContext.close();
  await visitor.close();
});
