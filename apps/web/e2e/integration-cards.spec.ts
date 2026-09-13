import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("integration cards separate connected apps and adapt to the viewport", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `integration-cards-${Date.now()}@rakazo.test`,
    "password12",
    "Integration cards",
  );
  await completeOnboarding(page);
  await page.getByText("Integrations", { exact: true }).click();

  const connected = page.getByRole("region", { name: "Your integrations", exact: true });
  const available = page.getByRole("region", { name: "Available integrations", exact: true });
  const gmail = page.getByTestId("connection-tile-gmail");
  const search = page.getByRole("textbox", { name: "Search apps", exact: true });
  await expect(available).toBeVisible();
  await expect(connected).toHaveCount(0);
  await gmail.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connected.getByRole("group", { name: "Gmail", exact: true })).toBeVisible();
  await expect(available.getByRole("group", { name: "Gmail", exact: true })).toHaveCount(0);
  await expect(gmail.getByText("Connected", { exact: true })).toBeVisible();

  for (const [width, columns] of [
    [1280, 3],
    [768, 2],
    [390, 1],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        available
          .locator(":scope > .grid")
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
      )
      .toBe(columns);
    const list = page.locator("#integration-list");
    expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await captureScreenshot(page, testInfo, `integration-cards-${width}`);
  }

  await search.fill("gmail");
  await expect(gmail).toBeVisible();
  await expect(available).toHaveCount(0);
  await gmail.getByRole("button", { name: "Manage", exact: true }).click();
  const detail = page.getByTestId("connection-detail");
  await expect(detail.getByLabel("Account label")).toHaveCount(1);
  await detail.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(connected).toHaveCount(0);
  await expect(available.getByRole("group", { name: "Gmail", exact: true })).toBeVisible();
  await expect(gmail.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await search.fill("no-such-integration");
  await expect(page.getByRole("status")).toHaveText("No apps match your search.");
});
