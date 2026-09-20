import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import type { BoxSandboxSdk } from "./box-sandbox.js";
import { BoxSandboxProvider } from "./box-sandbox.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { HostAwareSandbox } from "./host-aware-sandbox.js";

const context = {
  userId: "owner",
  spaceId: "space",
  operationId: "cleanup",
  traceId: "cleanup",
  signal: new AbortController().signal,
};
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["docker", "e2b", "daytona", "box", "desktop", "fake", "host-aware"])(
  "%s rejects foreign references before touching a provider",
  async (kind) => {
    const root = mkdtempSync(path.join(tmpdir(), "sandbox-kind-"));
    roots.push(root);
    const touched = vi.fn(async () => {
      throw new Error("Unexpected provider call");
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 404 }));
    const providers: Record<string, SandboxProvider> = {
      docker: new DockerSandboxProvider("http://supervisor.example.test", "synthetic"),
      e2b: new E2BSandboxProvider("synthetic", {
        create: touched,
        connect: touched,
        pause: touched,
        kill: touched,
      }),
      daytona: new DaytonaSandboxProvider(
        { apiKey: "synthetic" },
        { create: touched, get: touched },
      ),
      box: new BoxSandboxProvider({ apiKey: "synthetic" }, {
        get: touched,
        stop: touched,
        deleteBox: touched,
      } as unknown as BoxSandboxSdk),
      desktop: new DesktopSandboxProvider({ root }),
      fake: new FakeSandboxProvider(),
      "host-aware": new HostAwareSandbox(
        new DockerSandboxProvider("http://supervisor.example.test", "synthetic"),
        new DesktopSandboxProvider({ root }),
        async () => false,
      ),
    };
    const foreign: ComputerRef = {
      id: "existing",
      providerRef: "existing",
      botId: "home",
      kind: kind === "e2b" ? "docker" : "e2b",
    };
    for (const operation of ["stop", "destroy"] as const) {
      await expect(providers[kind]![operation](foreign, context)).rejects.toThrow(
        "Computer provider does not match",
      );
    }
    await expect(
      providers[kind]!.provision(
        {
          botId: foreign.botId,
          homePath: "/unused",
          providerRef: foreign.providerRef,
          providerKind: foreign.kind,
        },
        context,
      ),
    ).rejects.toThrow("Computer provider does not match");
    await expect(
      providers[kind]!.provision(
        { botId: foreign.botId, homePath: root, providerRef: foreign.providerRef },
        context,
      ),
    ).rejects.toThrow("Computer provider does not match");
    expect(touched).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("preserves an existing allocation with the same textual reference but a different provider kind", async () => {
  const provider = new FakeSandboxProvider();
  const owned = await provider.provision({ botId: "home", homePath: "/unused" }, context);
  const foreign = { ...owned, kind: "docker" as const };
  await expect(provider.stop(foreign, context)).rejects.toThrow("Computer provider does not match");
  await expect(provider.destroy(foreign, context)).rejects.toThrow(
    "Computer provider does not match",
  );
  expect(provider.boxes.get(owned.id)?.running).toBe(true);
});
