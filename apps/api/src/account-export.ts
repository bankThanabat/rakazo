import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { AccountExportLimitError, writeAccountExport } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";

export function mountAccountExport(
  app: Hono,
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  authenticate: (c: Context) => Promise<string | null>,
) {
  const active = new Set<string>();
  app.get("/api/account/export", async (c) => {
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    const userId = await authenticate(c);
    if (!userId) return c.json({ error: "Sign in to export your data" }, 401);
    if (active.has(userId) || active.size >= 2)
      return c.json({ error: "An export is already running. Try again shortly." }, 429);
    active.add(userId);
    let directory: string | undefined;
    let file: FileHandle | undefined;
    const cleanup = async () => {
      active.delete(userId);
      await file?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    };
    try {
      directory = await mkdtemp(path.join(tmpdir(), "deskazo-export-"));
      const filename = path.join(directory, "account.jsonl");
      file = await open(filename, "wx+", 0o600);
      // Keep only the open descriptor before writing private data. A crash closes
      // it automatically, so a plaintext archive cannot survive a server restart.
      await unlink(filename);
      await rm(directory, { recursive: true, force: true });
      let bytesWritten = 0;
      const maxBytes = 100 * 1024 * 1024;
      await writeAccountExport(
        deps.prisma,
        userId,
        async (record) => {
          const line = `${JSON.stringify(record)}\n`;
          bytesWritten += Buffer.byteLength(line);
          if (bytesWritten > maxBytes) throw new AccountExportLimitError();
          await file!.writeFile(line);
        },
        async (entry) => {
          if (entry.size !== undefined && bytesWritten + 4 * Math.ceil(entry.size / 3) > maxBytes)
            throw new AccountExportLimitError();
          const bytes = Buffer.from(
            await deps.artifacts.get(entry.storageKey, {
              spaceId: entry.spaceId,
              userId: entry.userId,
              operationId: "account-export",
              traceId: "account-export",
              signal: c.req.raw.signal,
            }),
          );
          if (
            (entry.size !== undefined && bytes.length !== entry.size) ||
            (entry.hash && createHash("sha256").update(bytes).digest("hex") !== entry.hash)
          )
            throw new Error("Export file integrity check failed");
          return bytes.toString("base64");
        },
        c.req.raw.signal,
      );
      // Generate completely before returning 200. Missing files or failed queries
      // must not produce a successful, incomplete download.
      c.req.raw.signal.throwIfAborted();
      c.header("content-type", "application/x-ndjson; charset=utf-8");
      c.header("content-disposition", 'attachment; filename="deskazo-account.jsonl"');
      c.header("content-length", String((await file.stat()).size));
      return stream(c, async (output) => {
        const source = file!.createReadStream({ start: 0, autoClose: false });
        output.onAbort(() => {
          source.destroy();
        });
        try {
          await output.pipe(Readable.toWeb(source) as ReadableStream<Uint8Array>);
        } finally {
          source.destroy();
          await cleanup();
        }
      });
    } catch (error) {
      await cleanup();
      if (error instanceof AccountExportLimitError)
        return c.json({ error: "Export is too large", code: "EXPORT_TOO_LARGE" }, 413);
      return c.json({ error: "Couldn't export your data. Try again." }, 503);
    }
  });
}
