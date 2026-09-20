import { useSemanticHistory } from "@rakazo/chat-ui/semantic-history";
import type {
  SemanticMemoryHistory as History,
  SemanticMemoryDetail,
  SemanticMemoryReversalPreview,
  SemanticMemoryReversalResult,
} from "@rakazo/contracts";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { newClientNonce } from "../lib/client-nonce";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";

export function SemanticMemoryHistory({ botId }: { botId: string }) {
  const { t, locale } = useI18n();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const history = useSemanticHistory({
    botId,
    nonce: newClientNonce,
    preview: (input) => rpc<SemanticMemoryReversalPreview>("semanticMemory/preview", input),
    apply: (input) => rpc<SemanticMemoryReversalResult>("semanticMemory/apply", input),
    history: (cursor) => rpc<History>("semanticMemory/history", { botId, cursor }),
    detail: (mutationId) =>
      rpc<SemanticMemoryDetail>("semanticMemory/detail", { botId, mutationId }),
  });
  const operation = (value: string) =>
    value === "save"
      ? t("Save memory")
      : value === "forget"
        ? t("Remove memory")
        : value === "undo_save"
          ? t("Undo memory save")
          : value === "undo_forget"
            ? t("Restore memory")
            : t("Memory change");
  const status = (value: string) =>
    value === "completed"
      ? t("Confirmed")
      : value === "failed"
        ? t("Failed")
        : t("Outcome unknown");
  const selected = history.detail;
  const action = (label: string, onPress: () => void, expanded?: boolean, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: history.busy || disabled, expanded }}
      style={[styles.button, (history.busy || disabled) && styles.disabled]}
      disabled={history.busy || disabled}
      onPress={onPress}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.section}>
      {action(t("Provider memory history"), history.toggle, history.open)}
      {history.open && (
        <View style={styles.section}>
          {action(t("Reload history"), () => void history.load())}
          {history.busy && <ActivityIndicator />}
          {history.error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {history.reviewError ??
                (history.pending
                  ? t("Could not confirm the change. Retry or reload history.")
                  : t("Could not load history. Try again."))}
            </Text>
          )}
          {history.pending &&
            !history.review &&
            action(t("Retry confirmation"), () => void history.apply())}
          {history.page?.items.length === 0 && (
            <Text style={styles.muted}>{t("No recorded changes yet.")}</Text>
          )}
          {history.page?.items.map((item) => (
            <View key={item.id} style={styles.row}>
              {action(
                `${operation(item.operation)} · ${status(item.status)}`,
                () => void history.select(item.id),
                selected?.id === item.id,
              )}
              <Text style={styles.muted}>
                {new Date(item.createdAt).toLocaleString(dateLocaleForUi(locale))}
              </Text>
              {selected?.id === item.id && (
                <View style={styles.section}>
                  <Text style={styles.muted}>
                    {selected.botName} · {selected.provider} ·{" "}
                    {selected.scope === "shared"
                      ? t("Private across your bots")
                      : t("Private to this bot")}
                  </Text>
                  {selected.reason && (
                    <Text selectable style={styles.text}>
                      {selected.reason}
                    </Text>
                  )}
                  {selected.status !== "completed" && selected.status !== "failed" && (
                    <Text style={styles.text}>
                      {t("The provider outcome is unknown. Verify it before another change.")}
                    </Text>
                  )}
                  {selected.sourceThreadId &&
                    action(t("Source conversation"), () =>
                      router.push({ pathname: "/thread", params: { botId } }),
                    )}
                  {selected.reversesId &&
                    action(t("Original change"), () => void history.select(selected.reversesId!))}
                  {history.requestedContent !== null && (
                    <Version
                      title={t("Requested content")}
                      value={{ state: "recorded", content: history.requestedContent }}
                    />
                  )}
                  {!selected.changes.length && (
                    <Text style={styles.muted}>{t("Recorded versions are unavailable.")}</Text>
                  )}
                  {selected.changes.map((change, index) => (
                    <View key={`${change.id}:${index}`} style={styles.row}>
                      <Text selectable style={styles.muted}>
                        {change.id}
                        {change.entity ? ` · ${change.entity}` : ""}
                      </Text>
                      <Version title={t("Before")} value={change.before} />
                      <Version title={t("After")} value={change.after} />
                      {change.entity &&
                        (history.draft?.id === change.id &&
                        history.draft.entity === change.entity ? (
                          <View style={styles.section}>
                            <Text style={styles.text}>{t("Reason for undo")}</Text>
                            <TextInput
                              autoFocus
                              accessibilityLabel={t("Reason for undo")}
                              value={history.draft.reason}
                              maxLength={1000}
                              editable={!history.busy}
                              onChangeText={history.setReason}
                              style={styles.input}
                            />
                            {history.review ? (
                              <>
                                <Version
                                  title={
                                    history.review.value.action === "restore"
                                      ? t("Restore this fact")
                                      : t("Remove this fact")
                                  }
                                  value={{
                                    state: "recorded",
                                    content: history.review.value.content,
                                  }}
                                />
                                {action(
                                  history.review.value.action === "restore"
                                    ? t("Confirm restoration")
                                    : t("Confirm removal"),
                                  () => void history.apply(),
                                )}
                              </>
                            ) : (
                              action(
                                t("Preview change"),
                                () => void history.preview(),
                                undefined,
                                !history.draft.reason.trim(),
                              )
                            )}
                            {action(t("Cancel"), history.cancelReview)}
                          </View>
                        ) : (
                          action(t("Review undo"), () => history.startReview(change))
                        ))}
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
          {history.page?.nextCursor && action(t("Older changes"), () => void history.load(true))}
        </View>
      )}
    </View>
  );
}
function Version({
  title,
  value,
}: {
  title: string;
  value: SemanticMemoryDetail["changes"][number]["before"];
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.text}>{title}</Text>
      <ScrollView nestedScrollEnabled style={styles.contentScroll}>
        <Text selectable style={styles.text}>
          {value.state === "recorded"
            ? value.content
            : value.state === "absent"
              ? t("Not stored")
              : t("Unavailable")}
        </Text>
      </ScrollView>
    </View>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    section: { gap: 8, marginVertical: 8 },
    row: { borderTopWidth: 1, borderTopColor: tokens.border, paddingVertical: 12, gap: 8 },
    text: { color: tokens.foreground, fontSize: 16, lineHeight: 24 },
    muted: { color: tokens.mutedForeground, fontSize: 14 },
    error: { color: tokens.destructive, fontSize: 14 },
    button: { minHeight: 48, paddingVertical: 12 },
    disabled: { opacity: 0.5 },
    contentScroll: { maxHeight: 280 },
    input: {
      minHeight: 48,
      padding: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 12,
      color: tokens.foreground,
      fontSize: 16,
    },
  });
}
