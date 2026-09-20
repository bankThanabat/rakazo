import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { MemoryDocument } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("memory and skills are readable and editable in the app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Space-wide documents live in Settings → Memory. Open that before bot
  // settings so the Knowledge Memory tab cannot steal this click.
  await openUserSettings(page, "memory");
  await expect(page.getByLabel("Close memory settings")).toBeVisible();
  const spaceDocs = page.getByTestId("space-memory-documents");
  await expect(spaceDocs.getByText("Your memory")).toBeVisible();
  const memoryRow = spaceDocs.getByRole("button", { name: /MEMORY\.md/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const docEditor = spaceDocs.locator("textarea");
  const marker = `Edited in e2e ${stamp}`;
  await docEditor.fill(`# Memory\n\n${marker}\n`);
  await captureScreenshot(page, testInfo, "83-space-memory-editor");
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/rpc/memory/update",
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(docEditor).toBeDisabled();
    await expect(memoryRow).toBeDisabled();
    await expect(spaceDocs.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(spaceDocs.getByText("rev 2")).toBeVisible();

  // The save persisted: reopen the document and find the marker.
  await memoryRow.click();
  await expect(docEditor).toHaveValue(new RegExp(marker));
  await captureScreenshot(page, testInfo, "84-space-memory-saved");
  const sharedDocuments = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(sharedDocuments).toContainEqual(
    expect.objectContaining({ content: `# Memory\n\n${marker}\n`, revision: 2 }),
  );
  // Export must fetch fresh content and exclude the bot's private document.
  const sharedDocument = sharedDocuments.find((doc) => doc.path === "MEMORY.md")!;
  const latestMarker = `Latest shared memory ${stamp}`;
  await rpc(page, "memory/update", {
    documentId: sharedDocument.id,
    content: latestMarker,
    expectedRevision: sharedDocument.revision,
  });
  const downloadPromise = page.waitForEvent("download");
  await spaceDocs.getByRole("button", { name: "Download as markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("space-memory.md");
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain(latestMarker);
  expect(exported).not.toContain(marker);
  expect(exported).not.toContain("# Chief");
  // Export refreshed list metadata, but the open draft still belongs to revision 2.
  await docEditor.fill("Stale draft after export");
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  await expect(spaceDocs.getByText("Could not save", { exact: true })).toBeVisible();
  expect(await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" })).toContainEqual(
    expect.objectContaining({ id: sharedDocument.id, content: latestMarker, revision: 3 }),
  );

  await page.getByLabel("Close memory settings").click();
  await expect(page.getByLabel("Close memory settings")).toHaveCount(0);

  // The bot's Knowledge section lives under Advanced in its settings panel.
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await settings.getByText("Advanced", { exact: true }).click();
  const knowledge = settings.getByTestId("bot-knowledge");
  await expect(knowledge).toBeVisible();
  await expect(knowledge.getByRole("tablist", { name: "Knowledge" })).toBeVisible();

  // Bot creation seeds MEMORY.md (`# Chief`); edit it and assert the revision bumps.
  const botMemory = knowledge.getByTestId("bot-knowledge-memory");
  const botMemoryRow = botMemory.getByRole("button", { name: /MEMORY\.md/ });
  await expect(botMemoryRow).toBeVisible();
  await botMemoryRow.click();
  const botDocEditor = botMemory.locator("textarea");
  await expect(botDocEditor).toHaveValue(/# Chief/);
  const botMarker = `Bot memory e2e ${stamp}`;
  await botDocEditor.fill(`# Chief\n\n${botMarker}\n`);
  await botMemory.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "80-knowledge-bot-memory");
  await botMemory.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botMemory.getByText("rev 2")).toBeVisible();
  expect(
    await rpc<MemoryDocument[]>(page, "memory/list", {
      botId: activeBotId(page),
      scope: "bot",
    }),
  ).toContainEqual(expect.objectContaining({ content: `# Chief\n\n${botMarker}\n`, revision: 2 }));
  await botMemoryRow.click();
  await expect(botDocEditor).toHaveValue(new RegExp(botMarker));
  await botMemory.getByRole("button", { name: "Cancel", exact: true }).click();

  // Skills: create one through the editor, reopen it, edit, then delete it.
  // Builtin catalog is currently empty; user skills still cover create/edit/delete.
  await knowledge.getByRole("tab", { name: "Skills", exact: true }).click();
  await knowledge.getByRole("button", { name: "New skill", exact: true }).click();
  const editor = knowledge.locator("textarea");
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Always open with a greeting.",
    ].join("\n"),
  );
  await captureScreenshot(page, testInfo, "81-knowledge-skill-editor");
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  const skillRow = knowledge.getByRole("button", { name: /greet-politely/ });
  await expect(skillRow).toBeVisible();
  await expect(knowledge.getByText("Say hello before anything else.")).toBeVisible();
  await captureScreenshot(page, testInfo, "82-knowledge-skill-listed");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/");
  await expect(
    page.getByRole("button", { name: "Skill greet-politely", exact: true }),
  ).toBeVisible();
  await composer.fill("");

  // A provider-owned skill uses the same viewer without mutation controls.
  await page.route(
    "**/rpc/agentSkills/get",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, json: { ...body.json, readOnly: true, source: "plugin" } },
      });
    },
    { times: 1 },
  );
  await skillRow.click();
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(knowledge.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(knowledge.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await knowledge.getByRole("button", { name: "Close", exact: true }).click();
  await skillRow.click();
  await expect(editor).toHaveValue(/Always open with a greeting/);
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Open with a warm greeting.",
    ].join("\n"),
  );
  let releaseSkillRefresh!: () => void;
  const skillRefreshGate = new Promise<void>((resolve) => {
    releaseSkillRefresh = resolve;
  });
  await page.route(
    "**/rpc/agentSkills/list",
    async (route) => {
      await skillRefreshGate;
      await route.continue();
    },
    { times: 1 },
  );
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(editor).toBeHidden();
    await expect(skillRow).toBeDisabled();
    await captureScreenshot(page, testInfo, "85-skill-refresh-pending");
  } finally {
    releaseSkillRefresh();
  }
  await skillRow.click();
  await expect(editor).toHaveValue(/warm greeting/);
  const activeSkill = await rpc<{ id: string; revision: number; content: string }>(
    page,
    "agentSkills/get",
    { name: "greet-politely" },
  );
  await rpc(page, "agentSkills/update", {
    skillId: activeSkill.id,
    expectedRevision: activeSkill.revision,
    body: "Open with the newer greeting.",
  });
  await editor.fill(activeSkill.content.replace("warm greeting", "stale greeting"));
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  await expect(knowledge.getByText("Could not save skill", { exact: true })).toBeVisible();
  expect(
    await rpc<{ content: string }>(page, "agentSkills/get", { skillId: activeSkill.id }),
  ).toMatchObject({ content: expect.stringContaining("newer greeting") });
  await captureScreenshot(page, testInfo, "86-skill-stale-edit-blocked");
  await knowledge.getByRole("button", { name: "Cancel", exact: true }).click();
  await skillRow.click();
  await expect(editor).toHaveValue(/newer greeting/);
  await knowledge.getByRole("button", { name: "Delete", exact: true }).click();
  await knowledge.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(skillRow).toBeHidden();
  await composer.fill("/");
  await expect(page.getByRole("button", { name: "Skill greet-politely", exact: true })).toHaveCount(
    0,
  );
  const history = await rpc<{ removed: boolean; items: Array<{ operation: string }> }>(
    page,
    "agentSkills/history",
    { skillId: activeSkill.id },
  );
  expect(history.removed).toBe(true);
  expect(history.items.map((item) => item.operation)).toEqual([
    "remove",
    "update",
    "update",
    "create",
  ]);
  expect(await rpc<Array<{ name: string }>>(page, "agentSkills/list", {})).not.toContainEqual(
    expect.objectContaining({ name: "greet-politely" }),
  );
});

test("private history reviews selective undo, overlap, stale restore and removed skills", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(
    page,
    `private-history-${stamp}@rakazo.test`,
    "password12",
    "Synthetic history reviewer",
  );
  await completeOnboarding(page);
  const docs = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  const doc = docs.find((entry) => entry.path === "MEMORY.md")!;
  const update = (content: string, expectedRevision: number) =>
    rpc(page, "memory/update", { documentId: doc.id, content, expectedRevision });
  await update("Greeting: hello\n\nDelivery: verify", 1);
  await update("Greeting: welcome\n\nDelivery: verify", 2);
  await update("Greeting: welcome\n\nDelivery: ask staff", 3);
  await openUserSettings(page, "memory");
  const memory = page.getByTestId("space-memory-documents");
  const row = memory.getByRole("button", { name: /MEMORY\.md/ });
  const editor = memory.getByRole("textbox", { name: "MEMORY.md" });
  await row.click();
  await editor.fill("Unsaved draft");
  await expect(memory.getByRole("button", { name: "History", exact: true })).toBeDisabled();
  await editor.fill("Greeting: welcome\n\nDelivery: ask staff");
  await memory.getByRole("button", { name: "History", exact: true }).click();
  await memory.getByRole("button", { name: /^Version 3\b/ }).click();
  await memory.getByRole("button", { name: "Undo change", exact: true }).click();
  let review = memory.getByRole("form", { name: "Review undo" });
  await expect(
    review.getByText("Greeting: hello\n\nDelivery: ask staff", { exact: true }),
  ).toBeVisible();
  await expect(review.getByRole("button", { name: "Apply change" })).toBeDisabled();
  await review
    .getByRole("textbox", { name: "Reason for change" })
    .fill("Restore greeting, preserve delivery correction");
  await review.getByRole("button", { name: "Apply change" }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "87-private-history-review-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await review.getByRole("button", { name: "Apply change" }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "88-private-history-review-mobile");
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390);
  let releaseHistorySave!: () => void;
  const historySaveGate = new Promise<void>((resolve) => {
    releaseHistorySave = resolve;
  });
  await page.route(
    "**/rpc/privateHistory/apply",
    async (route) => {
      await historySaveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await review.getByRole("button", { name: "Apply change" }).click();
  try {
    await expect(editor).toBeDisabled();
    await expect(row).toBeDisabled();
    await expect(memory.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally {
    releaseHistorySave();
  }
  await expect(memory.getByText("rev 5")).toBeVisible();
  expect(
    (await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" })).find(
      (d) => d.id === doc.id,
    )?.content,
  ).toBe("Greeting: hello\n\nDelivery: ask staff");
  await page.setViewportSize({ width: 1280, height: 900 });
  // An overlapping later correction needs an explicitly reviewed result.
  await update("Greeting: good day\n\nDelivery: ask staff", 5);
  await row.click();
  await memory.getByRole("button", { name: "History", exact: true }).click();
  await memory.getByRole("button", { name: /^Version 3\b/ }).click();
  await memory.getByRole("button", { name: "Undo change", exact: true }).click();
  review = memory.getByRole("form", { name: "Review undo" });
  await review
    .getByRole("textbox", { name: "Result", exact: true })
    .fill("Greeting: hello, good day\n\nDelivery: ask staff");
  await review.getByRole("textbox", { name: "Reason for change" }).fill("Keep both greetings");
  await expect(review.getByRole("button", { name: "Apply change" })).toBeDisabled();
  await review.getByRole("checkbox", { name: "I reviewed the overlapping changes" }).check();
  await review.getByRole("button", { name: "Apply change" }).click();
  await expect(memory.getByText("rev 7")).toBeVisible();
  // Review is bound to the current revision, even if another writer changes it after preview.
  await row.click();
  await memory.getByRole("button", { name: "History", exact: true }).click();
  await memory.getByRole("button", { name: /^Version 2\b/ }).click();
  await memory.getByRole("button", { name: "Restore version", exact: true }).click();
  review = memory.getByRole("form", { name: "Review restore" });
  await review.getByRole("textbox", { name: "Reason for change" }).fill("Reviewed old text");
  await update("Concurrent correction survives", 7);
  await review.getByRole("button", { name: "Apply change" }).click();
  await expect(memory.getByRole("alert")).toHaveText(
    "Could not complete this review. Reload history and try again.",
  );
  expect(
    (await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" })).find(
      (d) => d.id === doc.id,
    )?.content,
  ).toBe("Concurrent correction survives");
  await page.getByLabel("Close memory settings").click();
  // Removed recipes stay reviewable and can be restored from their retained history.
  const skill = await rpc<{ id: string }>(page, "agentSkills/create", {
    name: "history-recipe",
    description: "Synthetic history recipe",
    body: "Check delivery before answering.",
  });
  await rpc(page, "agentSkills/remove", { skillId: skill.id, expectedRevision: 1 });
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByText("Advanced", { exact: true }).click();
  const knowledge = settings.getByTestId("bot-knowledge");
  await knowledge.getByRole("tab", { name: "Skills", exact: true }).click();
  await knowledge.getByRole("button", { name: "Removed skills", exact: true }).click();
  const removed = knowledge.getByRole("region", { name: "Removed skills", exact: true });
  await expect(removed.getByText("history-recipe", { exact: true })).toBeVisible();
  await removed.getByRole("button", { name: "History", exact: true }).click();
  await removed.getByRole("button", { name: /^Version 1\b/ }).click();
  await removed.getByRole("button", { name: "Restore version", exact: true }).click();
  await removed
    .getByRole("textbox", { name: "Reason for change" })
    .fill("Use reviewed recipe again");
  await removed.getByRole("button", { name: "Apply change" }).click();
  await expect(knowledge.getByRole("button", { name: /history-recipe/ })).toBeVisible();
  expect(
    await rpc<{ content: string }>(page, "agentSkills/get", { skillId: skill.id }),
  ).toMatchObject({ content: expect.stringContaining("Check delivery before answering.") });
});
