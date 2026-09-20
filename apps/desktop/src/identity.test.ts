import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { configureDesktopIdentity } from "./identity.js";
import { readSetup, writeSetup } from "./setup-store.js";

it("opens the existing profile and keeps its encryption identity after the display rename", async () => {
  const appData = await mkdtemp(path.join(tmpdir(), "desktop-identity-"));
  try {
    const legacyProfile = path.join(appData, "Rakazo");
    const setup = { mode: "existing" as const, serverUrl: "https://shop.example.test" };
    await writeSetup(legacyProfile, setup);
    await writeFile(path.join(legacyProfile, "Cookies"), "opaque existing cookie data");
    const paths = {
      appData,
      userData: path.join(appData, "Deskazo"),
      sessionData: path.join(appData, "Deskazo"),
    };
    const setName = vi.fn();
    const setAboutPanelOptions = vi.fn();
    configureDesktopIdentity({
      setName,
      getPath: (key) => paths[key as keyof typeof paths],
      setPath: (key, value) => {
        paths[key as keyof typeof paths] = value;
      },
      setAboutPanelOptions,
    });
    await expect(readSetup(paths.userData)).resolves.toEqual(setup);
    await expect(readFile(path.join(paths.sessionData, "Cookies"), "utf8")).resolves.toBe(
      "opaque existing cookie data",
    );
    expect(setName).toHaveBeenCalledWith("Rakazo");
    expect(setAboutPanelOptions).toHaveBeenCalledWith({ applicationName: "Deskazo" });
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});
