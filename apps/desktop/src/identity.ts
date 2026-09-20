import path from "node:path";
import type { App } from "electron";

/** Keep existing profiles and OS encryption keys when the display name changes. */
export function configureDesktopIdentity(
  app: Pick<App, "setName" | "getPath" | "setPath" | "setAboutPanelOptions">,
) {
  // Electron derives both profile paths and macOS/Linux key names from app.name.
  app.setName("Rakazo");
  const profile = path.join(app.getPath("appData"), "Rakazo");
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setAboutPanelOptions({ applicationName: "Deskazo" });
}
