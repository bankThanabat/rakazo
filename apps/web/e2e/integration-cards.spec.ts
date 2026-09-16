import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("integration list groups connected apps and adapts to the viewport", async ({
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

  const connected = page.getByRole("region", { name: "Connected", exact: true });
  const gmail = page.getByTestId("connection-tile-gmail");
  const detail = page.getByTestId("connection-detail");
  const search = page.getByRole("textbox", { name: "Search apps", exact: true });
  await expect(gmail).toBeVisible();
  await expect(connected).toHaveCount(0);
  await expect(detail).toHaveCount(0);

  await gmail.click();
  await detail.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connected.getByTestId("connection-tile-gmail")).toBeVisible();
  await expect(gmail.getByText("Connected", { exact: true })).toBeVisible();
  await expect(detail.getByLabel("Account label")).toHaveValue("Gmail");

  await search.fill("gmail");
  await expect(gmail).toBeVisible();
  await expect(page.getByTestId("connection-tile-linear")).toHaveCount(0);
  await search.fill("no-such-integration");
  await expect(page.getByRole("status")).toHaveText("No apps match your search.");
  await search.fill("");

  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureScreenshot(page, testInfo, `integration-cards-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await detail.getByRole("button", { name: "Disconnect", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await captureScreenshot(page, testInfo, "integration-disconnect-confirm");
  await confirm.getByRole("button", { name: "Disconnect account" }).click();
  await expect(connected).toHaveCount(0);
  await expect(gmail.getByText("Connected", { exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
});
