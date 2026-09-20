import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const width of [1280, 390]) {
  test(`learning documents persist, override and restore at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await signup(
      page,
      `learning-${width}-${Date.now()}@rakazo.test`,
      "password12",
      "Learning tester",
    );
    await completeOnboarding(page);
    async function openLearning() {
      await page
        .locator("main")
        .getByRole("button", { name: /^Chief/ })
        .click();
      const panel = page.getByTestId("bot-settings");
      await panel.getByText("Advanced", { exact: true }).click();
      await panel.getByRole("tab", { name: "Learning", exact: true }).click();
    }
    await openLearning();
    const editor = page.getByRole("region", { name: "Learning documents" });
    const content = editor.getByRole("textbox", { name: "Content", exact: true });
    const reason = editor.getByRole("textbox", { name: "Reason for change" });
    const save = editor.getByRole("button", { name: "Save document" });
    await expect(content).toBeEnabled();
    await content.fill("ตอบภาษาไทยอย่างสุภาพ ไม่กดดันให้ซื้อ");
    await reason.fill("Reviewed synthetic brand examples");
    await save.click();
    await expect(editor.getByText("Saved with an audit record.")).toBeVisible();
    await page.reload();
    await openLearning();
    await expect(content).toHaveValue("ตอบภาษาไทยอย่างสุภาพ ไม่กดดันให้ซื้อ");
    await content.fill("A shorter second version");
    await reason.fill("Try a shorter style");
    await save.click();
    await expect(reason).toHaveValue("");
    await editor.getByText("Audit history", { exact: true }).click();
    await editor.getByRole("button", { name: "Undo change", exact: true }).first().click();
    await expect(editor.getByRole("textbox", { name: "Resulting content" })).toHaveValue(
      "ตอบภาษาไทยอย่างสุภาพ ไม่กดดันให้ซื้อ",
    );
    await editor
      .getByRole("textbox", { name: "Reason for undo" })
      .fill("Keep the approved Thai voice");
    await editor.getByRole("button", { name: "Apply undo", exact: true }).click();
    await expect(content).toHaveValue("ตอบภาษาไทยอย่างสุภาพ ไม่กดดันให้ซื้อ");
    await expect(
      editor.getByText("Undo version 2: Keep the approved Thai voice", { exact: true }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "Bot override", exact: true }).click();
    await expect(content).toHaveValue("");
    await content.fill("Use formal language for wholesale customers.");
    await reason.fill("Approved wholesale variation");
    await save.click();
    await expect(reason).toHaveValue("");
    await editor.getByRole("button", { name: "Space default", exact: true }).click();
    await expect(content).toHaveValue("ตอบภาษาไทยอย่างสุภาพ ไม่กดดันให้ซื้อ");
    await content.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `learning-documents-${width}`);
    if (width === 1280) {
      await editor.getByText("Source and reply imports", { exact: true }).click();
      const recent = new Date(Date.now() - 86400000).toISOString();
      const old = new Date(Date.now() - 40 * 86400000).toISOString();
      const rows = [
        "thread_id,message_id,sent_at,author_role,text",
        `thread,one,${recent},business,ยินดีช่วยค่ะ`,
        `thread,one,${recent},business,ยินดีช่วยค่ะ`,
        `thread,two,${recent},customer,PRIVATE CUSTOMER FACT`,
        `thread,old,${old},business,Outdated reply`,
      ];
      await editor.locator('input[type="file"]').setInputFiles({
        name: "synthetic-replies.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(rows.join("\n")),
      });
      await expect(editor.getByText("1 business replies · 2 skipped · 1 duplicates")).toBeVisible();
      await expect(editor.locator("pre").filter({ hasText: "PRIVATE CUSTOMER FACT" })).toHaveCount(
        0,
      );
      await captureScreenshot(page, testInfo, "learning-import-preview");
      await editor.getByRole("button", { name: "Use reviewed examples" }).click();
      await expect(content).toHaveValue(/ยินดีช่วยค่ะ/);
      await save.click();
      await expect(reason).toHaveValue("");
      await editor.getByRole("button", { name: "View source", exact: true }).click();
      await expect(editor.getByRole("button", { name: "Download original" })).toBeVisible();
      await expect(editor.locator("pre").filter({ hasText: "PRIVATE CUSTOMER FACT" })).toHaveCount(
        1,
      );
      await editor.getByRole("button", { name: "Download original" }).scrollIntoViewIfNeeded();
      await captureScreenshot(page, testInfo, "learning-original-source");
      await editor.getByText("Remove source", { exact: true }).click();
      await editor.getByRole("button", { name: "Remove imported source", exact: true }).click();
      await expect(
        editor.getByText("Source removed. It cannot be used for future learning."),
      ).toBeVisible();
      await expect(editor.locator("pre").filter({ hasText: "PRIVATE CUSTOMER FACT" })).toHaveCount(
        0,
      );
      await expect(content).toHaveValue(/ยินดีช่วยค่ะ/);
    }
    for (const [text, why] of [
      ["Formal\nAsk one question\nVerify stock", "Approved baseline"],
      ["Friendly\nAsk one question\nVerify stock", "Try a different tone"],
      ["Warm and concise\nAsk one question\nVerify current stock", "A later staff correction"],
    ]) {
      await content.fill(text!);
      await reason.fill(why!);
      await save.click();
      await expect(reason).toHaveValue("");
    }
    await editor.getByRole("button", { name: "Undo change", exact: true }).nth(1).click();
    const review = editor.getByRole("region", { name: "Review undo" });
    await expect(
      review.getByText(
        "Later edits overlap this change. They are kept below. Review before applying.",
      ),
    ).toBeVisible();
    const result = review.getByRole("textbox", { name: "Resulting content" });
    await expect(result).toHaveValue("Warm and concise\nAsk one question\nVerify current stock");
    await result.fill("Formal and concise\nAsk one question\nVerify current stock");
    await review
      .getByRole("textbox", { name: "Reason for undo" })
      .fill("Keep the later stock correction");
    await result.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `learning-selective-undo-${width}`);
    await review.getByRole("button", { name: "Apply undo" }).click();
    await expect(content).toHaveValue("Formal and concise\nAsk one question\nVerify current stock");
    await expect(review).toHaveCount(0);
  });
}

for (const width of [1280, 390]) {
  test(`social learning evidence download and removal at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const email = `social-learning-${width}-${Date.now()}@rakazo.test`;
    await signup(page, email, "password12", "Learning tester");
    await completeOnboarding(page);
    const fixture = await page.request.post(`${process.env.API_URL}/__e2e/social-learning`, {
      data: { email },
    });
    expect(fixture.ok()).toBe(true);
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();
    const panel = page.getByTestId("bot-settings");
    await panel.getByText("Advanced", { exact: true }).click();
    await panel.getByRole("tab", { name: "Learning", exact: true }).click();
    const editor = page.getByRole("region", { name: "Learning documents" });
    await expect(editor.getByRole("textbox", { name: "Content", exact: true })).toHaveValue(
      "Use short, calm sentences.",
    );
    await editor.getByText("Audit history", { exact: true }).click();
    await editor.getByRole("button", { name: "View source", exact: true }).click();
    await expect(editor.getByText("Saved posts: 1", { exact: true })).toBeVisible();
    await expect(
      editor.locator("pre").filter({ hasText: "A quiet morning in our studio." }),
    ).toBeVisible();
    const download = page.waitForEvent("download");
    await editor.getByRole("button", { name: "Download source", exact: true }).click();
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toContain("A quiet morning in our studio.");
    await editor.getByText("Remove source", { exact: true }).click();
    await editor
      .getByRole("button", { name: "Remove saved posts", exact: true })
      .scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `social-learning-evidence-${width}`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await editor.getByRole("button", { name: "Remove saved posts", exact: true }).click();
    await expect(
      editor.getByText("Source removed. It cannot be used for future learning."),
    ).toBeVisible();
    await expect(
      editor.locator("pre").filter({ hasText: "A quiet morning in our studio." }),
    ).toHaveCount(0);
    await expect(editor.getByRole("textbox", { name: "Content", exact: true })).toHaveValue(
      "Use short, calm sentences.",
    );
  });
}
