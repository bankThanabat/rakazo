import { describe, expect, it, vi } from "vitest";
import { waitForConnectionAuthorization } from "./connection-authorization.js";

describe("connection authorization observation", () => {
  it.each(["resolve", "reject"])("ignores a late %s after navigating away", async (mode) => {
    const controller = new AbortController();
    let resolve!: (value: { status: string }) => void;
    let reject!: (error: Error) => void;
    const request = new Promise<{ status: string }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const complete = vi.fn(() => request);
    const pending = waitForConnectionAuthorization(complete, controller.signal);
    controller.abort();
    if (mode === "resolve") resolve({ status: "connected" });
    else reject(new Error("aborted request"));
    expect(await pending).toEqual({ status: "cancelled" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
