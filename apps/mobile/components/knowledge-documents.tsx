import type { KnowledgeSource, KnowledgeState } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, KnowledgeUploadInput, knowledgeMimeType } from "@rakazo/contracts";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";

export function KnowledgeDocuments({ botId }: { botId: string }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connectionOpen, setConnectionOpen] = useState(false);
  useEffect(() => {
    if (!open || pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await rpc<KnowledgeState>("knowledge/state", { botId });
        if (!active) return;
        setState(next);
        if (next.sources.some((s) => s.status === "queued" || s.status === "processing"))
          timer = setTimeout(refresh, 3000);
      } catch {
        if (active) setError(t("Could not load documents. Try again."));
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [botId, open, pending, t]);
  async function run(action: () => Promise<KnowledgeState | undefined>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const next = await action();
      if (next) setState(next);
    } catch {
      setError(t("Could not save the document change. Try again."));
    } finally {
      setPending(false);
    }
  }
  async function upload(sourceId?: string) {
    await run(async () => {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
        type: [
          "application/pdf",
          "text/*",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
      });
      if (result.canceled) return;
      const asset = result.assets[0]!;
      const file = new File(asset.uri);
      if (file.size > ATTACHMENT_MAX_BYTES) {
        setError(t("Choose a file smaller than 10 MiB."));
        return;
      }
      const input = KnowledgeUploadInput.parse({
        botId,
        sourceId,
        name: asset.name,
        mimeType: knowledgeMimeType(asset.name, asset.mimeType),
        contentBase64: await file.base64(),
      });
      return rpc<KnowledgeState>("knowledge/upload", input);
    });
  }
  async function download(source: KnowledgeSource) {
    await run(async () => {
      const result = await rpc<{ name: string; mimeType: string; contentBase64: string }>(
        "knowledge/download",
        { botId, sourceId: source.id },
      );
      const file = new File(
        Paths.cache,
        `knowledge-${source.id}-${result.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      );
      file.create({ overwrite: true });
      file.write(result.contentBase64, { encoding: "base64" });
      try {
        if (!(await Sharing.isAvailableAsync())) {
          setError(t("File sharing is unavailable on this device."));
          return;
        }
        await Sharing.shareAsync(file.uri, { mimeType: result.mimeType });
      } finally {
        file.delete();
      }
    });
  }
  function status(source: KnowledgeSource) {
    if (source.status === "ready") return t("Ready");
    if (source.status === "failed")
      return source.activeRevisionId
        ? t("Update failed. Previous version is available.")
        : t("Processing failed. Replace the file to retry.");
    return source.activeRevisionId ? t("Updating") : t("Processing");
  }
  const button = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      disabled={pending}
      onPress={onPress}
      style={styles.button}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.button}
      >
        <Text style={styles.title}>{t("Documents")}</Text>
      </Pressable>
      {open ? (
        <>
          {error ? (
            <View>
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
              {button(
                t("Retry"),
                () => void run(() => rpc<KnowledgeState>("knowledge/state", { botId })),
              )}
            </View>
          ) : null}
          {!state && !error ? <ActivityIndicator /> : null}
          {state ? (
            <>
              {state.configured ? (
                <View style={styles.row}>
                  <Text style={styles.text}>{t("Use shared knowledge")}</Text>
                  <Switch
                    accessibilityLabel={t("Use shared knowledge")}
                    value={state.enabled}
                    disabled={pending}
                    onValueChange={(enabled) =>
                      void run(() => rpc<KnowledgeState>("knowledge/attach", { botId, enabled }))
                    }
                  />
                </View>
              ) : null}
              {(!state.configured || connectionOpen) && state.canManage ? (
                <View>
                  <TextInput
                    style={styles.input}
                    accessibilityLabel={t("Knowledge service URL")}
                    placeholder={t("Knowledge service URL")}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    value={baseUrl}
                    onChangeText={setBaseUrl}
                    editable={!pending}
                  />
                  <TextInput
                    style={styles.input}
                    accessibilityLabel={t("API key")}
                    placeholder={t("API key")}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={apiKey}
                    onChangeText={setApiKey}
                    editable={!pending}
                  />
                  {button(
                    t("Connect knowledge"),
                    () =>
                      void run(async () => {
                        const next = await rpc<KnowledgeState>("knowledge/configure", {
                          botId,
                          baseUrl,
                          apiKey,
                        });
                        setApiKey("");
                        setConnectionOpen(false);
                        return next;
                      }),
                  )}
                </View>
              ) : null}
              {state.configured ? (
                <>
                  {state.canManage ? (
                    <View style={styles.row}>
                      {button(t("Add document"), () => void upload())}
                      {button(t("Connection"), () => {
                        setBaseUrl(state.baseUrl ?? "");
                        setConnectionOpen(!connectionOpen);
                      })}
                    </View>
                  ) : null}
                  {!state.sources.length ? (
                    <Text style={styles.secondary}>{t("No documents yet.")}</Text>
                  ) : null}
                  {state.sources.map((source) => (
                    <View key={source.id} style={styles.source}>
                      <View style={styles.row}>
                        <View style={styles.name}>
                          <Text style={styles.title}>{source.name}</Text>
                          <Text style={styles.secondary}>{status(source)}</Text>
                        </View>
                        <View style={styles.toggle}>
                          <Text style={styles.secondary}>{t("Internal")}</Text>
                          <Switch
                            accessibilityLabel={t("Internal: {name}", { name: source.name })}
                            value={source.internal}
                            disabled={pending || !state.canManage}
                            onValueChange={(internal) =>
                              void run(() =>
                                rpc<KnowledgeState>("knowledge/visibility", {
                                  botId,
                                  sourceId: source.id,
                                  internal,
                                }),
                              )
                            }
                          />
                        </View>
                      </View>
                      <View style={styles.actions}>
                        {button(t("Download"), () => void download(source))}
                        {state.canManage ? (
                          <>
                            {button(t("Replace"), () => void upload(source.id))}
                            {button(t("Delete"), () =>
                              Alert.alert(t("Delete document?"), source.name, [
                                { text: t("Cancel"), style: "cancel" },
                                {
                                  text: t("Delete"),
                                  style: "destructive",
                                  onPress: () =>
                                    void run(() =>
                                      rpc<KnowledgeState>("knowledge/remove", {
                                        botId,
                                        sourceId: source.id,
                                      }),
                                    ),
                                },
                              ]),
                            )}
                          </>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
const createStyles = () => {
  const tokens = mobileTokens();
  return StyleSheet.create({
    section: { marginTop: 16 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    toggle: { flexDirection: "row", alignItems: "center", gap: 6 },
    name: { flex: 1 },
    source: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      paddingVertical: 12,
    },
    button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
    title: { fontSize: 15, fontWeight: "600", color: tokens.foreground },
    text: { fontSize: 14, color: tokens.foreground },
    secondary: { fontSize: 12, color: tokens.mutedForeground },
    error: { fontSize: 14, color: tokens.destructive },
    input: {
      minHeight: 44,
      marginTop: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 8,
      color: tokens.foreground,
      backgroundColor: tokens.background,
    },
  });
};
