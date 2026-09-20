import type { LearningEvidence as Evidence } from "@rakazo/contracts";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function LearningEvidence({
  botId,
  revisionId,
  taskId,
  disabled = false,
}: { botId: string; disabled?: boolean } & (
  | { revisionId: string; taskId?: never }
  | { taskId: string; revisionId?: never }
)) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [evidence, setEvidence] = useState<Evidence>();
  const [busy, setBusy] = useState(false);
  const text = { color: tokens.foreground, fontSize: 16 };
  const button = { paddingVertical: 12, minHeight: 48 };
  const read = () =>
    taskId
      ? rpc<Evidence>("learning/taskEvidence", { botId, taskId })
      : rpc<Evidence>("learning/evidence", { botId, revisionId });
  async function open() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      setEvidence(await read());
    } catch {
      setEvidence(undefined);
      Alert.alert(t("Source unavailable or you no longer have access."));
    } finally {
      setBusy(false);
    }
  }
  async function remove(sourceId: string) {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await rpc("learning/withdrawSource", { botId, sourceId });
      setEvidence(await read());
    } catch {
      Alert.alert(t("Could not remove this source. Reload and try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        disabled={busy || disabled}
        style={button}
        onPress={() => (evidence ? setEvidence(undefined) : void open())}
      >
        <Text style={text}>{evidence ? t("Hide source") : t("View source")}</Text>
      </Pressable>
      {evidence && (
        <>
          <Text style={text}>{evidence.label}</Text>
          {evidence.coverage && (
            <Text style={text}>
              {evidence.kind === "social"
                ? t("Saved posts: {accepted}", { accepted: evidence.coverage.accepted })
                : t("{accepted} business replies · {skipped} skipped · {duplicates} duplicates", {
                    accepted: evidence.coverage.accepted,
                    skipped: evidence.coverage.skipped,
                    duplicates: evidence.coverage.duplicates,
                  })}
            </Text>
          )}
          {evidence.windowEnd && (
            <Text style={text}>
              {t("Evidence through {date}", {
                date: new Date(evidence.windowEnd).toLocaleString(),
              })}
            </Text>
          )}
          {evidence.withdrawn ? (
            <Text style={text}>{t("Source removed. It cannot be used for future learning.")}</Text>
          ) : (
            <>
              <ScrollView nestedScrollEnabled style={{ maxHeight: 280 }}>
                <Text selectable style={text}>
                  {evidence.content.slice(0, 16000)}
                </Text>
              </ScrollView>
              <Text style={{ color: tokens.mutedForeground }}>
                {taskId || evidence.kind === "social"
                  ? t("Download the full source on web.")
                  : t("Download the full original on web.")}
              </Text>
              {evidence.kind !== "conversation" && (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || disabled}
                  style={button}
                  onPress={() =>
                    Alert.alert(
                      evidence.kind === "social"
                        ? t("Remove saved posts")
                        : t("Remove imported source"),
                      evidence.kind === "social"
                        ? t(
                            "Deletes this saved copy. Source settings and learned documents stay unchanged.",
                          )
                        : t(
                            "Deletes the original import and stops future learning from it. Existing documents keep their current content.",
                          ),
                      [
                        { text: t("Cancel"), style: "cancel" },
                        {
                          text: t("Remove"),
                          style: "destructive",
                          onPress: () => void remove(evidence.sourceId),
                        },
                      ],
                    )
                  }
                >
                  <Text style={{ ...text, color: tokens.destructive }}>
                    {evidence.kind === "social"
                      ? t("Remove saved posts")
                      : t("Remove imported source")}
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
