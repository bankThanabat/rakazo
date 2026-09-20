import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { captureApiRequestContext } from "./api";
import { t } from "./i18n";

export class AccountExportSizeError extends Error {}

export async function exportAccount(): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error(t("Sharing is unavailable"));
  const { apiBase, headers } = await captureApiRequestContext();
  const directory = new Directory(Paths.cache, "deskazo-account-exports");
  directory.create({ idempotent: true });
  const now = Date.now();
  for (const entry of directory.list()) {
    const timestamp = /^deskazo-account-(\d+)\.jsonl$/.exec(entry.name)?.[1];
    if (entry instanceof File && timestamp && now - Number(timestamp) > 86_400_000) entry.delete();
  }
  const file = new File(directory, `deskazo-account-${now}.jsonl`);
  let shared = false;
  try {
    try {
      await File.downloadFileAsync(`${apiBase}/api/account/export`, file, { headers });
    } catch (error) {
      if (error instanceof Error && /\b413\b/.test(error.message))
        throw new AccountExportSizeError();
      throw error;
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/x-ndjson",
      UTI: "public.plain-text",
      dialogTitle: t("Export data"),
    });
    shared = true;
  } finally {
    // Android resolves when the chooser returns, before the target has necessarily
    // read its FileProvider URI. Retain successful shares in cache until a later export.
    if ((!shared || Platform.OS !== "android") && file.exists) file.delete();
  }
}
