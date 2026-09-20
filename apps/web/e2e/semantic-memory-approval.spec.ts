import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const variant of ["semantic", "document"] as const) {
  for (const width of [1280, 390]) {
    test(`complete ${variant} approval at ${width}px survives reload and scrolling`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const email = `${variant}-approval-${width}-${Date.now()}@rakazo.test`;
      await signup(page, email, "password12", "Memory reviewer");
      await completeOnboarding(page);
      const response = await page.request.post(`${process.env.API_URL}/__e2e/semantic-approval`, {
        data: { email, variant },
      });
      expect(response.ok()).toBe(true);
      const fixture = (await response.json()) as {
        botId: string;
        request: Record<string, unknown>;
        toolName: string;
      };
      await page.goto(`/app/${fixture.botId}`);
      if (variant === "document") {
        const proposal = fixture.request.reviewedProposal as {
          native: { content: string; beforeContent: string };
        };
        await expect(page.getByRole("heading", { name: "Review memory change" })).toBeVisible();
        await expect(page.getByText("Private to this bot", { exact: true })).toBeVisible();
        await expect(
          page.getByText("Contains guidance for staff only.", { exact: true }),
        ).toBeVisible();
        for (const [label, content] of [
          ["After", proposal.native.content],
          ["Before", proposal.native.beforeContent],
        ]) {
          await page.getByRole("button", { name: label, exact: true }).click();
          const version = page.getByRole("region", { name: label, exact: true });
          expect(await version.textContent()).toBe(content);
          await version.focus();
          await page.keyboard.press("End");
          await expect
            .poll(() =>
              version.evaluate(
                (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
              ),
            )
            .toBe(true);
          await captureScreenshot(page, testInfo, `document-${width}-${label}-end`);
          await page.keyboard.press("Home");
          await expect.poll(() => version.evaluate((node) => node.scrollTop)).toBe(0);
          await captureScreenshot(page, testInfo, `document-${width}-${label}-start`);
          expect(await version.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        }
        await page.getByRole("button", { name: "Request details", exact: true }).click();
      }
      const detail = page.getByRole("region", {
        name: variant === "document" ? "Request details" : `Review before ${fixture.toolName}`,
        exact: true,
      });
      await expect(detail).toHaveCount(1);
      expect(JSON.parse((await detail.textContent())!)).toEqual(fixture.request);
      await page.reload();
      if (variant === "document") {
        await expect(page.getByRole("region", { name: "After", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Request details", exact: true }).click();
      }
      await expect(detail).toHaveCount(1);
      expect(JSON.parse((await detail.textContent())!)).toEqual(fixture.request);
      await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
      await detail.scrollIntoViewIfNeeded();
      await detail.focus();
      await expect(detail).toBeFocused();
      await page.keyboard.press("End");
      await expect
        .poll(() =>
          detail.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1),
        )
        .toBe(true);
      await captureScreenshot(page, testInfo, `${variant}-approval-${width}-end`);
      await page.keyboard.press("Home");
      await expect.poll(() => detail.evaluate((node) => node.scrollTop)).toBe(0);
      await captureScreenshot(page, testInfo, `${variant}-approval-${width}-start`);
      expect(await detail.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      // Stop the synthetic run; approving a real effect is exercised by the integration suite.
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.getByText("No longer active", { exact: true })).toBeVisible();
    });
  }
}
