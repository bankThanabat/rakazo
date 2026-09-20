import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { LearningTaskDetail } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

for (const width of [1280, 390]) {
  test(`reviews complete learning proposals from a daily summary at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const email = `review-${width}-${Date.now()}@rakazo.test`;
    await signup(page, email, "password12", "Learning reviewer");
    await completeOnboarding(page);
    const fixture = await page.request.post(`${process.env.API_URL}/__e2e/learning-review`, {
      data: { email },
    });
    expect(fixture.ok()).toBe(true);
    const { botId, tasks } = (await fixture.json()) as {
      botId: string;
      tasks: Record<string, string>;
    };
    await page.reload();
    const updates = page.getByTestId("learning-updates");
    await expect(updates).toHaveCount(1);
    await updates.getByRole("button", { name: "Learning updates", exact: true }).click();
    await updates.getByRole("button", { name: /^Sizing memory/ }).click();
    const review = updates.getByRole("article", { name: "Review learning update" });
    await expect(
      review.getByText("Needs review · Private to this bot", { exact: true }),
    ).toBeVisible();
    await expect(review.locator("pre").filter({ hasText: "Final sizing condition" })).toContainText(
      "Final sizing condition: ask before making assumptions.",
    );
    await review.getByRole("button", { name: "View source", exact: true }).click();
    await expect(
      review.locator("pre").filter({ hasText: "Do not infer body measurements" }),
    ).toBeVisible();
    await review.getByRole("button", { name: "Hide source", exact: true }).click();
    await expect(
      review.getByRole("button", { name: "Approve change", exact: true }),
    ).toBeDisabled();
    await review
      .getByRole("textbox", { name: "Reason for decision" })
      .fill("Reviewed the full sizing guidance and private destination.");
    await review.getByRole("textbox", { name: "Reason for decision" }).scrollIntoViewIfNeeded();
    const captures = fileURLToPath(new URL("../../../.impeccable/review/", import.meta.url));
    await mkdir(captures, { recursive: true });
    await page.screenshot({
      path: `${captures}/${width === 1280 ? "desktop" : "mobile"}-before.png`,
      fullPage: true,
      animations: "disabled",
    });
    await review
      .getByRole("button", { name: "Approve change", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${captures}/${width === 1280 ? "desktop" : "mobile"}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await captureScreenshot(page, testInfo, `learning-proposal-${width}`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/rpc/learning/decideTask",
      async (route) => {
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    await review.getByRole("button", { name: "Approve change", exact: true }).click();
    try {
      await expect(review.getByRole("textbox", { name: "Reason for decision" })).toBeDisabled();
      await expect(updates.getByRole("button", { name: /^Sizing procedure/ })).toBeDisabled();
    } finally {
      release();
    }
    await expect(updates.getByText("Change saved.", { exact: true })).toBeVisible();
    const applied = await rpc<LearningTaskDetail>(page, "learning/task", {
      botId,
      taskId: tasks.memory,
    });
    expect(applied.task.status).toBe("applied");
    expect(applied.task.appliedRevision).toBe(1);
    await review.getByRole("button", { name: "History", exact: true }).click();
    await expect(review.getByRole("button", { name: /Version 1/ })).toBeVisible();
    await updates.getByRole("button", { name: /^Sizing procedure/ }).click();
    await expect(
      review.getByText("Needs review · Private across your bots", { exact: true }),
    ).toBeVisible();
    await review
      .getByRole("textbox", { name: "Reason for decision" })
      .fill("Keep this procedure for a later review.");
    await review.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(updates.getByText("Suggestion rejected.", { exact: true })).toBeVisible();
    await updates.getByRole("button", { name: /^Sizing policy/ }).click();
    await review.getByRole("button", { name: "Undo change", exact: true }).click();
    await expect(review.getByRole("textbox", { name: "Resulting content" })).toHaveValue("");
    // An empty new document still needs a valid title for the retained audit record.
    await review.getByRole("textbox", { name: "Resulting title" }).fill("Sizing policy");
    await review
      .getByRole("textbox", { name: "Reason for undo" })
      .fill("Synthetic policy was temporary.");
    await review.getByRole("button", { name: "Apply undo", exact: true }).click();
    await expect(updates.getByText("Change saved.", { exact: true })).toBeVisible();
    expect(
      (await rpc<LearningTaskDetail>(page, "learning/task", { botId, taskId: tasks.document })).task
        .status,
    ).toBe("rejected");
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();
    const settings = page.getByTestId("bot-settings");
    await settings.getByText("Advanced", { exact: true }).click();
    await settings.getByRole("tab", { name: "Learning", exact: true }).click();
    const allUpdates = settings.getByTestId("learning-updates");
    await allUpdates.getByRole("button", { name: "Learning updates", exact: true }).click();
    await allUpdates.getByRole("button", { name: "Older updates", exact: true }).click();
    await expect(
      allUpdates.getByRole("button", { name: /^Earlier sizing update 11/ }),
    ).toBeVisible();
    await expect(
      allUpdates.getByRole("button", { name: "Older updates", exact: true }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
