import { expect, it } from "vitest";
import { actionInternal, readActionPolicy, sharedActions } from "./connector-action-policy.js";

it("honors overrides and keeps unknown actions internal", () => {
  const policy = readActionPolicy({
    defaults: { send: false, publish: true, comment: false },
    overrides: { send: true, publish: false },
  });
  expect(actionInternal(policy, "send")).toBe(true);
  expect(actionInternal(policy, "publish")).toBe(false);
  expect(actionInternal(policy, "new_action")).toBe(true);
  expect(actionInternal(policy, "toString")).toBe(true);
  expect(sharedActions(policy).sort()).toEqual(["comment", "publish"]);
});

it("reads a missing or malformed policy as empty", () => {
  for (const stored of [undefined, null, {}, "shared", { defaults: { send: "false" } }])
    expect(sharedActions(readActionPolicy(stored))).toEqual([]);
});
