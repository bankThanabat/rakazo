import { createServer } from "node:http";
import { Sandbox } from "@e2b/desktop";
import { describe, expect, it, vi } from "vitest";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";

describe("E2B teardown receipts", () => {
  it.each(["stop", "destroy"] as const)(
    "does not confirm %s on provider failure",
    async (method) => {
      const sdk = {
        connect: vi.fn().mockRejectedValue(new Error("provider unavailable")),
        pause: vi.fn().mockRejectedValue(new Error("provider unavailable")),
        kill: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      } as unknown as E2BSandboxSdk;
      const provider = new E2BSandboxProvider("synthetic-key", sdk);
      await expect(
        provider[method](
          { id: "example", providerRef: "example", botId: "bot", kind: "e2b" },
          {
            userId: "user",
            spaceId: "space",
            operationId: "cleanup",
            traceId: "cleanup",
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow("provider unavailable");
    },
  );

  it.each(
    [false, true].flatMap((cached) =>
      ["stop", "destroy"].flatMap((method) =>
        [204, 404, 401, 429, 503, ...(method === "stop" ? [409] : [])].map((status) => ({
          cached,
          method,
          status,
        })),
      ),
    ),
  )(
    "uses real SDK HTTP semantics: $method $status cached=$cached",
    async ({ cached, method, status }) => {
      const requests: string[] = [];
      let responseStatus = status;
      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(responseStatus, { "content-type": "application/json" });
        response.end(
          responseStatus === 204
            ? undefined
            : JSON.stringify({ code: responseStatus, message: "Synthetic provider response" }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture address");
        const apiUrl = `http://127.0.0.1:${address.port}`;
        const desktop = new Sandbox({
          sandboxId: "example",
          envdVersion: "0.1.0",
          apiKey: "synthetic-key",
          validateApiKey: false,
          apiUrl,
        });
        const sdk: E2BSandboxSdk = {
          create: vi.fn(async () => desktop),
          connect: vi.fn(async () => {
            throw new Error("Teardown must not resume a sandbox");
          }),
          pause: vi.fn((id, options) =>
            Sandbox.pause(id, { ...options, ...{ apiUrl, validateApiKey: false, retries: 0 } }),
          ),
          kill: vi.fn((id, options) =>
            Sandbox.kill(id, { ...options, ...{ apiUrl, validateApiKey: false, retries: 0 } }),
          ),
        };
        const provider = new E2BSandboxProvider("synthetic-key", sdk);
        const context = {
          userId: "user",
          spaceId: "space",
          operationId: "cleanup",
          traceId: "cleanup",
          signal: new AbortController().signal,
        };
        const computer = {
          id: "example",
          providerRef: "example",
          botId: "bot",
          kind: "e2b" as const,
        };
        if (cached) await provider.provision({ botId: "bot", homePath: "/unused" }, context);
        const failed = status === 401 || status === 429 || status === 503;
        const action = () =>
          method === "stop"
            ? provider.stop(computer, context)
            : provider.destroy(computer, context);
        if (failed) {
          await expect(action()).rejects.toThrow();
          if (cached) {
            // A failed teardown retains its usable cached handle for recovery.
            await expect(
              provider.provision(
                { botId: "bot", homePath: "/unused", providerRef: "example", providerKind: "e2b" },
                context,
              ),
            ).resolves.toMatchObject({ providerRef: "example", fresh: false });
          }
          responseStatus = 204;
          await expect(action()).resolves.toBeUndefined();
        } else {
          await expect(action()).resolves.toBeUndefined();
        }
        expect(requests).toEqual(
          Array.from({ length: failed ? 2 : 1 }, () =>
            method === "stop" ? "POST /sandboxes/example/pause" : "DELETE /sandboxes/example",
          ),
        );
        expect(sdk.connect).not.toHaveBeenCalled();
        expect(method === "stop" ? sdk.pause : sdk.kill).toHaveBeenCalledWith("example", {
          apiKey: "synthetic-key",
          signal: context.signal,
          requestTimeoutMs: 30_000,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
