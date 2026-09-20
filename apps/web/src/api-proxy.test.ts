import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { expect, it } from "vitest";
import { apiProxyOptions } from "./api-proxy.js";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

it("closes an interrupted upstream stream so clients can reconnect", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deskazo-proxy-"));
  let incoming: ServerResponse | undefined;
  const upstream = createServer((req, res) => {
    if (req.url === "/rpc/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true }));
      return;
    }
    incoming = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: ready\n\n");
  });
  const target = await listen(upstream);
  const vite = await createViteServer({
    configFile: false,
    root,
    logLevel: "silent",
    server: {
      middlewareMode: true,
      hmr: false,
      watch: null,
      proxy: { "/rpc": apiProxyOptions(target) },
    },
  });
  const downstream = createServer(vite.middlewares);
  const origin = await listen(downstream);
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(`${origin}/rpc/events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n");
    const next = reader.read().then(
      () => "closed",
      () => "closed",
    );
    incoming!.destroy();
    const outcome = await Promise.race([
      next,
      new Promise<string>((resolve) => {
        deadline = setTimeout(() => resolve("still open"), 500);
      }),
    ]);
    expect(outcome).toBe("closed");
    const retry = await fetch(`${origin}/rpc/ready`, { signal: abort.signal });
    expect(await retry.json()).toEqual({ ready: true });
  } finally {
    clearTimeout(deadline);
    abort.abort();
    downstream.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => downstream.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      vite.close(),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
