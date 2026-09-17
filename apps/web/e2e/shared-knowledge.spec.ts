import { expect, test } from "@playwright/test";
import type { KnowledgeState } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const width of [1280, 390]) {
  test(`shared documents and Internal controls at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signup(
      page,
      `documents-${width}-${Date.now()}@rakazo.test`,
      "password12",
      "Knowledge tester",
    );
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);
    const state: KnowledgeState = {
      configured: true,
      canManage: true,
      enabled: true,
      baseUrl: "http://localhost:8000/v1",
      sources: [
        {
          id: "source-internal",
          name: "Staff handbook.pdf",
          internal: true,
          status: "ready",
          activeRevisionId: "revision-internal",
        },
        {
          id: "source-shared",
          name: "Return policy.pdf",
          internal: false,
          status: "ready",
          activeRevisionId: "revision-shared",
        },
      ],
    };
    await page.route("**/rpc/knowledge/*", async (route) => {
      const operation = new URL(route.request().url()).pathname.split("/").pop();
      const input = route.request().postDataJSON()?.json;
      if (operation === "visibility")
        state.sources.find((source) => source.id === input.sourceId)!.internal = input.internal;
      if (operation === "attach") state.enabled = input.enabled;
      if (operation === "remove")
        state.sources = state.sources.filter((source) => source.id !== input.sourceId);
      if (operation === "upload")
        state.sources.push({
          id: "source-uploaded",
          name: input.name,
          internal: true,
          status: "processing",
          activeRevisionId: null,
        });
      await route.fulfill({ json: { json: state } });
    });
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();
    const panel = page.getByTestId("bot-settings");
    await panel.getByText("Advanced", { exact: true }).click();
    await panel.getByRole("tab", { name: "Documents", exact: true }).click();
    const documents = page.getByTestId("knowledge-documents");
    await expect(
      documents.getByRole("switch", { name: "Internal: Staff handbook.pdf", exact: true }),
    ).toBeChecked();
    const shared = documents.getByRole("switch", {
      name: "Internal: Return policy.pdf",
      exact: true,
    });
    await expect(shared).not.toBeChecked();
    await documents.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `knowledge-documents-${width}`);
    await shared.click();
    await expect(shared).toBeChecked();
    await documents.locator('input[type="file"]').setInputFiles({
      name: "Support notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Support notes"),
    });
    await expect(documents.getByText("Support notes.txt", { exact: true })).toBeVisible();
    await expect(
      documents.getByRole("switch", { name: "Internal: Support notes.txt", exact: true }),
    ).toBeChecked();
    await documents.getByRole("button", { name: "Delete", exact: true }).last().click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(documents.getByText("Support notes.txt", { exact: true })).toHaveCount(0);
  });
}
