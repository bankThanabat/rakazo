import { Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountExportSizeError, exportAccount } from "./account-export";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  remove: vi.fn(),
  share: vi.fn(),
  available: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    static downloadFileAsync = mocks.download;
    uri = "cache/export.jsonl";
    exists = true;
    delete = mocks.remove;
  },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-sharing", () => ({ shareAsync: mocks.share, isAvailableAsync: mocks.available }));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: "https://example.test",
    headers: { authorization: "Bearer fixture-token" },
  }),
}));

describe("mobile account export", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Platform.OS = "ios";
    mocks.available.mockResolvedValue(true);
    mocks.download.mockResolvedValue(undefined);
    mocks.share.mockResolvedValue(undefined);
  });
  it("downloads using the captured authentication and erases the cached archive after sharing", async () => {
    await exportAccount();
    expect(mocks.download).toHaveBeenCalledWith(
      "https://example.test/api/account/export",
      expect.anything(),
      {
        headers: { authorization: "Bearer fixture-token" },
      },
    );
    expect(mocks.share).toHaveBeenCalledWith(
      "cache/export.jsonl",
      expect.objectContaining({ mimeType: "application/x-ndjson" }),
    );
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("removes partial downloads and never shares after an HTTP or network failure", async () => {
    mocks.download.mockRejectedValue(new Error("503"));
    await expect(exportAccount()).rejects.toThrow("503");
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("erases the archive if sharing fails", async () => {
    mocks.share.mockRejectedValue(new Error("Share failed"));
    await expect(exportAccount()).rejects.toThrow("Share failed");
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("does not download when the device cannot save or share", async () => {
    mocks.available.mockResolvedValue(false);
    await expect(exportAccount()).rejects.toThrow("Sharing is unavailable");
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("keeps a successful Android share available for the receiving app", async () => {
    Platform.OS = "android";
    await exportAccount();
    expect(mocks.share).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("still cleans up failed Android shares", async () => {
    Platform.OS = "android";
    mocks.share.mockRejectedValue(new Error("Share failed"));
    await expect(exportAccount()).rejects.toThrow("Share failed");
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
  it("reports the export size limit without encouraging repeated retries", async () => {
    mocks.download.mockRejectedValue(
      new Error("UnableToDownload: Server returned status code 413"),
    );
    await expect(exportAccount()).rejects.toBeInstanceOf(AccountExportSizeError);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
});
