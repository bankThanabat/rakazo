import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test.describe.configure({ mode: "serial" });
for (const width of [1280, 390]) {
  test(`staff directly reviews removal and restoration at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const email = `semantic-direct-${width}-${Date.now()}@rakazo.test`;
    await signup(page, email, "password12", "Memory reviewer");
    await completeOnboarding(page);
    const seeded = await page.request.post(`${process.env.API_URL}/__e2e/semantic-direct`, {
      data: { email },
    });
    expect(seeded.ok()).toBe(true);
    const fixture = (await seeded.json()) as {
      botId: string;
      mutationId: string;
      entity: string;
      content: string;
    };
    const providerState = async () =>
      (
        await page.request.get(`${process.env.API_URL}/__e2e/semantic-direct-state`, {
          params: { entity: fixture.entity },
        })
      ).json();
    await page.goto(`/app/${fixture.botId}`);
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();
    await page.getByTestId("bot-settings").getByText("Advanced", { exact: true }).click();
    const panel = page.getByTestId("semantic-memory-history");
    await panel.getByRole("button", { name: "Provider memory history", exact: true }).click();
    await panel.getByRole("button", { name: /^Save memory · Confirmed/ }).click();
    await panel.getByRole("button", { name: "Review undo", exact: true }).click();
    const reason = panel.getByRole("textbox", { name: "Reason for undo", exact: true });
    await expect(reason).toBeFocused();
    await expect(panel.getByRole("button", { name: "Preview change", exact: true })).toBeDisabled();
    await reason.fill("Remove the obsolete guidance");
    await panel.getByRole("button", { name: "Preview change", exact: true }).click();
    const removal = panel.getByRole("region", { name: "Remove this fact", exact: true });
    await expect(removal).toHaveText(fixture.content);
    expect((await providerState()).writes).toBe(0);
    await removal.focus();
    await page.keyboard.press("End");
    await expect
      .poll(() =>
        removal.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1),
      )
      .toBe(true);
    await captureScreenshot(page, testInfo, `semantic-direct-${width}-review`);
    const confirmations: unknown[] = [];
    await page.route("**/rpc/semanticMemory/apply", async (route) => {
      confirmations.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (confirmations.length === 1) {
        expect(response.ok()).toBe(true);
        await route.abort("failed");
      } else await route.fulfill({ response });
    });
    await panel.getByRole("button", { name: "Confirm removal", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText(
      "Could not confirm the change. Retry or reload history.",
    );
    await expect(panel.locator("article")).toHaveCount(0);
    expect((await providerState()).writes).toBe(1);
    await panel.getByRole("button", { name: "Retry confirmation", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: /^Undo memory save · Confirmed/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toEqual(confirmations[0]);
    expect((await providerState()).writes).toBe(1);
    await panel.getByRole("button", { name: "Review undo", exact: true }).click();
    await reason.fill("Restore the complete recorded preference");
    await panel.getByRole("button", { name: "Preview change", exact: true }).click();
    await expect(panel.getByRole("region", { name: "Restore this fact", exact: true })).toHaveText(
      fixture.content,
    );
    await panel.getByRole("button", { name: "Confirm restoration", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: /^Restore memory · Confirmed/ }),
    ).toHaveAttribute("aria-expanded", "true");
    const state = await providerState();
    expect(state.writes).toBe(2);
    expect(state.facts.filter((fact: { isForgotten: boolean }) => !fact.isForgotten)).toEqual([
      expect.objectContaining({ id: "restored-1", memory: fixture.content }),
    ]);
    const history = await rpc<{ items: { id: string }[] }>(page, "semanticMemory/history", {
      botId: fixture.botId,
    });
    expect(history.items).toHaveLength(3);
    await panel.getByRole("button", { name: "Original change", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: /^Undo memory save · Confirmed/ }),
    ).toBeFocused();
    await captureScreenshot(page, testInfo, `semantic-direct-${width}-restored`);
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  });
}
