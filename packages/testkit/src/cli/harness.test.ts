import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("can bootstrap before the Prisma client has been generated", () => {
  // Simulate a clean checkout without removing artifacts used by running apps.
  const hook = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.includes("generated/prisma/")) {
    const error = new Error("Generated Prisma client is absent in this checkout");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return next(specifier, context);
} });`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(hook)}`,
      fileURLToPath(new URL("./harness.ts", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Pass exactly one of --integration or --e2e");
  expect(result.stderr).not.toContain("Generated Prisma client is absent");
});
