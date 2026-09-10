import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("Staff preserves the agent list and Customer starts empty", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signup(page, `inbox-tabs-${Date.now()}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.getByTestId("bots-sidebar");
  const staff = sidebar.getByRole("tab", { name: "Staff", exact: true });
  const customer = sidebar.getByRole("tab", { name: "Customer", exact: true });
  const chief = sidebar.getByRole("button", { name: /^Chief/ });
  const search = sidebar.getByPlaceholder("Search");
  const empty = sidebar.getByText("No customer conversations yet", { exact: true });

  await expect(staff).toHaveAttribute("aria-selected", "true");
  await expect(chief).toBeVisible();
  const tabsBox = await sidebar.getByRole("tablist").boundingBox();
  const searchBox = await search.boundingBox();
  expect(tabsBox!.y + tabsBox!.height).toBeLessThan(searchBox!.y);
  await captureScreenshot(page, testInfo, "inbox-staff");

  let searchRequests = 0;
  await page.route("**/rpc/search/query", (route) => {
    searchRequests += 1;
    return route.fulfill({
      json: {
        json: {
          hits: [{ kind: "conversation", botId: "staff-bot", title: "Staff result", snippet: "" }],
        },
      },
    });
  });
  await search.fill("Staff result");
  await expect(sidebar.getByText("Staff result", { exact: true })).toBeVisible();

  await customer.click();
  await expect(customer).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveValue("");
  await expect(empty).toBeVisible();
  await expect(chief).toHaveCount(0);
  await expect(sidebar.getByText("Staff result", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "inbox-customer");
  await page.emulateMedia({ colorScheme: "light" });
  await captureScreenshot(page, testInfo, "inbox-customer-light");
  await page.emulateMedia({ colorScheme: "dark" });

  await page.clock.install();
  await search.fill("Chief");
  await page.clock.runFor(300);
  await expect(sidebar.getByText("No results", { exact: true })).toBeVisible();
  expect(searchRequests).toBe(1);

  await customer.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(staff).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(staff).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveValue("");
  await expect(chief).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(staff).toBeVisible();
  await customer.click();
  await expect(empty).toBeVisible();
  await captureScreenshot(page, testInfo, "inbox-customer-narrow");

  await sidebar.getByTestId("create-menu-trigger").click();
  await expect(staff).toHaveAttribute("aria-selected", "true");
  await expect(chief).toBeVisible();
  await page.keyboard.press("Escape");
});
