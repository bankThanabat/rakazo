import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`merchant setup at ${viewport.width}px`, () => {
    test.use({ viewport });
    for (const [label, question] of [
      ["Customer replies", "Where do customers contact you, and which store do you use?"],
      [
        "Products & policies",
        "Share your product catalog or policies. Which source has current prices and stock?",
      ],
      [
        "My brand voice",
        "Share a few replies your business has written, or tell me which account has them.",
      ],
    ]) {
      test(`${label} collects business context and survives reload`, async ({ page }, testInfo) => {
        await signup(
          page,
          `merchant-${testInfo.workerIndex}-${Date.now()}@rakazo.test`,
          "password12",
          "Robin",
        );
        await completeOnboarding(page);
        await expect(
          page.getByText("What would you like to set up first?", { exact: true }),
        ).toBeVisible();
        for (const option of ["Customer replies", "Products & policies", "My brand voice"]) {
          await expect(page.getByRole("button", { name: new RegExp(option) })).toBeVisible();
        }
        await expect(page.getByRole("button", { name: /Day-to-day work/ })).toHaveCount(0);
        await captureScreenshot(page, testInfo, "merchant-setup-choice");
        await page.getByRole("button", { name: new RegExp(label!) }).click();
        await expect(
          page.getByTestId("transcript").getByText(question!, { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("group", { name: / connection$/ })).toHaveCount(0);
        await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
        await captureScreenshot(page, testInfo, "merchant-setup-question");
        await page.reload();
        await expect(
          page.getByTestId("transcript").getByText(question!, { exact: true }),
        ).toHaveCount(1);
        await expect(page.getByRole("button", { name: new RegExp(label!) })).toBeDisabled();
        await expect(page.locator("main").getByText("Chief", { exact: true })).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
      });
    }
  });
}

test("choice refresh failures leave options available for retry", async ({ page }) => {
  await signup(page, `choice-refresh-${Date.now()}@rakazo.test`, "password12", "Choice Retry");
  await completeOnboarding(page);
  const choice = page.getByRole("button", { name: /Customer replies/ });
  await expect(choice).toBeEnabled();
  // Keep the existing choice rendered while its save succeeds and navigation refresh fails.
  await page.route("**/rpc/onboarding/choose", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    }),
  );
  await page.route("**/rpc/spaces/list", (route) => route.abort());
  await Promise.all([page.waitForRequest("**/rpc/spaces/list"), choice.click()]);
  await expect(choice).toBeEnabled();
});
