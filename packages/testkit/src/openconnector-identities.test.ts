import { describe, expect, it } from "vitest";
import { verifyIdentities } from "../../../scripts/verify-openconnector-identities.mjs";

describe("hosted identity verifier", () => {
  it("executes only fixed reads with explicit aliases and emits no account details", async () => {
    const calls: string[] = [];
    const report = await verifyIdentities(
      "private-token",
      async (url: string, init: RequestInit) => {
        calls.push(url);
        expect(init.redirect).toBe("error");
        const headers = init.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer private-token");
        if (url.endsWith("/api/connections")) {
          return Response.json([
            { service: "line", configured: true, connectionName: "private-line-alias" },
            { service: "instagram", configured: true, connectionName: "private-instagram-alias" },
            { service: "line", configured: false, connectionName: "disabled" },
            { service: "other", configured: true, connectionName: "unrelated" },
          ]);
        }
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ input: {} });
        const line = url.endsWith("line.get_bot_info");
        expect(headers["x-oo-connector-alias"]).toBe(
          line ? "private-line-alias" : "private-instagram-alias",
        );
        return Response.json({
          success: true,
          data: line ? { userId: "private-id" } : { user: { id: "private-id" } },
        });
      },
    );
    expect(calls).toEqual([
      "http://127.0.0.1:3000/api/connections",
      "http://127.0.0.1:3000/v1/actions/line.get_bot_info",
      "http://127.0.0.1:3000/v1/actions/instagram.get_current_user",
    ]);
    expect(report.passed).toBe(true);
    expect(report.providers.map((provider: { actionId: string }) => provider.actionId)).toEqual([
      "line.get_bot_info",
      "instagram.get_current_user",
    ]);
    expect(JSON.stringify(report)).not.toContain("private-");
  });

  it("reports failures without echoing provider bodies or transport errors", async () => {
    const report = await verifyIdentities("private-token", async (url: string) => {
      if (url.endsWith("/api/connections"))
        return Response.json([
          { service: "line", configured: true, connectionName: "private-line" },
          { service: "instagram", configured: true, connectionName: "private-instagram" },
        ]);
      if (url.endsWith("line.get_bot_info"))
        return Response.json({ success: false, error: "private-error" }, { status: 401 });
      throw new Error("private-transport-error");
    });
    expect(report.passed).toBe(false);
    expect(report.providers.map((provider: { checks: unknown[] }) => provider.checks)).toEqual([
      [{ httpStatus: 401, passed: false }],
      [{ httpStatus: null, passed: false }],
    ]);
    expect(JSON.stringify(report)).not.toContain("private-");
  });

  it("does not count missing connections as provider acceptance", async () => {
    const report = await verifyIdentities("private-token", async () => Response.json([]));
    expect(report.passed).toBe(false);
  });

  it("cancels an oversized identity body without exposing it", async () => {
    let cancelled = false;
    const report = await verifyIdentities("private-token", async (url: string) => {
      if (url.endsWith("/api/connections")) {
        return Response.json([
          { service: "line", configured: true, connectionName: "private-line" },
        ]);
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(128 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    expect(cancelled).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.providers[0]!.checks).toEqual([{ httpStatus: null, passed: false }]);
  });

  it("rejects missing aliases before a runtime call", async () => {
    let calls = 0;
    await expect(
      verifyIdentities("private-token", async () => {
        calls += 1;
        return Response.json([{ service: "line", configured: true }]);
      }),
    ).rejects.toThrow("Connection alias missing");
    expect(calls).toBe(1);
  });
});
