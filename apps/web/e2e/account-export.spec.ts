import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

for (const width of [1280, 390]) {
  test(`account data export downloads and recovers at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const email = `export-${width}-${Date.now()}@rakazo.test`;
    await signup(page, email, "password12", "Export tester");
    await completeOnboarding(page);
    if (width === 390) await page.getByRole("button", { name: "Open navigation" }).click();
    const settings = await openUserSettings(page);
    const button = settings.getByRole("button", { name: "Export data", exact: true });
    await button.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `account-export-${width}`);
    for (const [status, message] of [
      [413, "This export is too large. Ask your server administrator for help."],
      [429, "An export is already running. Try again shortly."],
    ] as const) {
      await page.route(
        "**/api/account/export",
        (route) => route.fulfill({ status, body: "Unavailable" }),
        { times: 1 },
      );
      await button.click();
      await expect(settings.getByRole("alert")).toHaveText(message);
      await expect(button).toBeEnabled();
    }
    await page.route(
      "**/api/account/export",
      (route) => route.fulfill({ status: 503, body: "Unavailable" }),
      { times: 1 },
    );
    await button.click();
    await expect(settings.getByRole("alert")).toHaveText("Couldn't export your data. Try again.");
    await expect(button).toBeEnabled();
    const downloaded = page.waitForEvent("download");
    await button.click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("deskazo-account.jsonl");
    expect(await download.failure()).toBeNull();
    const records = (await readFile((await download.path())!, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0].data.format).toBe("deskazo-account-export");
    expect(records.find((record) => record.type === "account").data.email).toBe(email);
    expect(records.at(-1).type).toBe("complete");
    await expect(settings.getByRole("alert")).toHaveCount(0);
  });
}
