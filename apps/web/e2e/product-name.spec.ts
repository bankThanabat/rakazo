import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const width of [1280, 390]) {
  for (const locale of ["en", "ru"]) {
    test(`Deskazo sign-in at ${width}px in ${locale} keeps saved preferences`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((savedLocale) => {
        localStorage.setItem("rakazo.uiLocale", savedLocale);
        localStorage.setItem("rakazo.uiAppearance", "light");
      }, locale);
      await page.goto("/sign-in");
      await expect(page).toHaveTitle("Deskazo");
      await expect(
        page.getByRole("heading", {
          name: locale === "ru" ? "Войти в Deskazo" : "Sign in to Deskazo",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
        "content",
        "Deskazo",
      );
      const manifest = await (await page.request.get("/site.webmanifest")).json();
      expect(manifest).toMatchObject({ name: "Deskazo", short_name: "Deskazo", start_url: "/" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureScreenshot(page, testInfo, "deskazo-sign-in");
      await page.goto("/");
      await expect(page.getByText("Deskazo", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureScreenshot(page, testInfo, "deskazo-welcome");
    });
  }
}
