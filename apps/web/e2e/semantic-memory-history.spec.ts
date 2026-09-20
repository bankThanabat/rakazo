import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`provider memory history ${viewport.width}: inspect retained versions and unknown outcomes`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const email = `semantic-history-${viewport.width}-${Date.now()}@rakazo.test`;
    await signup(page, email, "password12", "History tester");
    await completeOnboarding(page);
    const response = await page.request.post(`${process.env.API_URL}/__e2e/semantic-history`, {
      data: { email },
    });
    expect(response.ok()).toBe(true);
    const fixture = (await response.json()) as {
      botId: string;
      originalId: string;
      undoId: string;
      content: string;
    };
    await page.goto(`/app/${fixture.botId}`);
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();
    const settings = page.getByTestId("bot-settings");
    await settings.getByText("Advanced", { exact: true }).click();
    const panel = page.getByTestId("semantic-memory-history");
    await panel.getByRole("button", { name: "Provider memory history", exact: true }).click();
    await panel.getByRole("button", { name: "Undo memory save · Outcome unknown" }).click();
    await expect(
      panel.getByText("The provider outcome is unknown. Verify it before another change."),
    ).toBeVisible();
    await expect(panel.getByRole("link", { name: "Source conversation" })).toHaveCount(0);
    await expect(panel.getByText("Unavailable", { exact: true })).toBeVisible();
    await panel.getByText("Undo memory save · Outcome unknown").scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `semantic-history-${viewport.width}-unknown`);
    expect(
      await page.evaluate(() =>
        Boolean(
          document
            .elementFromPoint(window.innerWidth - 40, window.innerHeight - 50)
            ?.closest('[data-testid="side-panel"]'),
        ),
      ),
    ).toBe(true);
    await panel.getByRole("button", { name: "Original change" }).click();
    const originalRow = panel.locator("article").filter({ hasText: "Synthetic staff correction" });
    const originalButton = originalRow.getByRole("button", { name: "Save memory · Confirmed" });
    await expect(originalButton).toBeFocused();
    await expect(originalButton).toBeInViewport();
    await expect(panel.getByText("Not stored", { exact: true })).toBeVisible();
    await expect(panel.getByText(fixture.content, { exact: true })).toHaveCount(1);
    const after = panel.getByRole("region", { name: "After", exact: true });
    await after.focus();
    await expect(after).toBeFocused();
    await page.keyboard.press("End");
    await expect
      .poll(() =>
        after.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1),
      )
      .toBe(true);
    await page.keyboard.press("Home");
    await expect.poll(() => after.evaluate((node) => node.scrollTop)).toBe(0);
    await panel.getByText("Not stored", { exact: true }).scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `semantic-history-${viewport.width}-original`);
    await panel.getByRole("button", { name: "Older changes" }).click();
    await expect(panel.locator("article")).toHaveCount(12);
    await expect(panel.getByRole("button", { name: "Older changes" })).toHaveCount(0);
    // The actual authenticated API supplies the complete record even while disconnected.
    const record = await rpc<{ requestedContent: string; sourceThreadId: string | null }>(
      page,
      "semanticMemory/detail",
      { botId: fixture.botId, mutationId: fixture.originalId },
    );
    expect(record.requestedContent).toBe(fixture.content);
    expect(record.sourceThreadId).toBeNull();
    await page.route(
      "**/rpc/semanticMemory/detail",
      (route) => route.fulfill({ status: 403, json: { error: "Synthetic revoked access" } }),
      { times: 1 },
    );
    await panel.getByRole("button", { name: "Undo memory save · Outcome unknown" }).click();
    await expect(panel.getByRole("alert")).toHaveText("Could not load history. Try again.");
    await expect(panel.locator("article")).toHaveCount(0);
    await panel.getByRole("button", { name: "Reload history" }).click();
    await expect(panel.locator("article")).toHaveCount(10);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  });
}
