#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Rerunnable symbol rename. Physical table/column names stay compatible with existing data.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync("rg", ["--files", "packages", "-g", "*.ts", "-g", "schema.prisma"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n");
let changed = 0;
for (const file of files) {
  const path = new URL(file, new URL("../", import.meta.url));
  const before = readFileSync(path, "utf8");
  const after = before
    .replace(/\bInstagramCommentWrite\b/g, "InstagramSend")
    .replace(/\binstagramCommentWrites\b/g, "instagramSends")
    .replace(/\binstagramCommentWrite\b/g, "instagramSend");
  if (before === after) continue;
  writeFileSync(path, after);
  changed++;
}
console.log(`Renamed receipt model symbols in ${changed} files.`);
