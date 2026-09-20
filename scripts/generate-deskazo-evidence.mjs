#!/usr/bin/env node
// Rebuild a standalone review artifact from explicitly selected, synthetic evidence.
// Usage: node scripts/generate-deskazo-evidence.mjs path/to/manifest.json [output.html]
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
if (!input) throw new Error("Pass an evidence manifest, then an optional output HTML path");
const manifest = JSON.parse(await readFile(input, "utf8"));
const base = path.dirname(path.resolve(input));
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
const items = await Promise.all(
  manifest.screenshots.map(async (item) => {
    const file = path.resolve(base, item.file);
    if (path.relative(base, file).startsWith("..") || path.extname(file) !== ".png")
      throw new Error("Evidence images must be PNG files inside the manifest directory");
    const bytes = await readFile(file);
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid PNG");
    const sha = createHash("sha256").update(bytes).digest("hex");
    return `<figure><figcaption><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p></figcaption><a href="data:image/png;base64,${bytes.toString("base64")}" target="_blank" rel="noopener"><img src="data:image/png;base64,${bytes.toString("base64")}" alt="${escapeHtml(item.title)}" loading="lazy"></a><details><summary>Evidence fingerprint</summary><code>${escapeHtml(item.file)} · SHA-256 ${sha}</code></details></figure>`;
  }),
);
const list = (items) => `<ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deskazo V1 · Implementation evidence</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.6}body{max-width:1100px;margin:auto;padding:48px 24px 80px;background:Canvas;color:CanvasText}header{border-bottom:2px solid;padding-bottom:28px}h1{font-size:clamp(2rem,5vw,3.7rem);line-height:1.08;letter-spacing:-.05em;margin:16px 0}h2{font-size:1.55rem;margin-top:48px}h3{margin:0;font-size:1.1rem}p{max-width:82ch}.eyebrow{letter-spacing:.1em;text-transform:uppercase;font-size:.8rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid GrayText;padding:14px 8px;vertical-align:top}th:first-child,td:first-child{width:26%}figure{margin:36px 0 0;border-top:1px solid GrayText;padding-top:20px}img{display:block;max-width:100%;width:auto;height:auto;max-height:900px;object-fit:contain;border:1px solid GrayText;border-radius:8px}figcaption p{margin-top:8px}code{overflow-wrap:anywhere;font-size:.75rem}summary{cursor:pointer}li{margin:10px 0}.status{border-left:4px solid;padding:12px 20px;background:ButtonFace}.muted{color:GrayText}@media(max-width:600px){body{padding:24px 16px}th:first-child,td:first-child{width:auto}table{font-size:.9rem}}@media print{details{display:none}figure{break-inside:avoid}body{max-width:none;padding:0}}
</style></head><body><header><div class="eyebrow">Deskazo · Engineering evidence · ${escapeHtml(manifest.date)}</div><h1>What works.<br>What still needs proof.</h1><p>${escapeHtml(manifest.summary)}</p><div class="status"><strong>${escapeHtml(manifest.status)}</strong><p>${escapeHtml(manifest.boundary)}</p></div></header>
<section><h2>Verification environment</h2>${list(manifest.environment)}</section>
<section><h2>Executed checks</h2><table><thead><tr><th>Check</th><th>Result</th><th>Reproduce</th></tr></thead><tbody>${manifest.checks.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.result)}</td><td><code>${escapeHtml(c.command)}</code></td></tr>`).join("")}</tbody></table></section>
<section><h2>Implemented in this change</h2>${list(manifest.implemented)}</section>
<section><h2>Browser evidence</h2><p>These are captured application screens, not design mockups. Each caption states what the screenshot establishes.</p>${items.join("\n")}</section>
<section><h2>Open V1 gates</h2>${list(manifest.open)}</section>
<section><h2>Review notes</h2>${list(manifest.review)}</section>
<footer><h2>Reproduce the report</h2><code>node scripts/generate-deskazo-evidence.mjs &lt;manifest.json&gt; &lt;report.html&gt;</code><p class="muted">Images are embedded. The report needs no network access. Provider fixtures verify application behavior and transport; they do not establish model quality or production-provider readiness.</p></footer></body></html>`;
const output = process.argv[3] ?? path.join(base, "report.html");
await writeFile(output, html);
console.log(`Wrote ${path.basename(output)} with ${items.length} evidence images`);
