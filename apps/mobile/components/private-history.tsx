import type {
  MemoryDocument,
  PrivateHistory,
  PrivateHistoryApply,
  PrivateHistoryPreview,
  PrivateHistoryTarget,
  PrivateHistoryValue,
  PrivateHistoryVersion,
} from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { LearningEvidence } from "./learning-evidence";

type SkillPage = {
  items: { id: string; name: string; removed: boolean }[];
  nextCursor: string | null;
};
type Review = {
  input: Omit<PrivateHistoryApply, "reason" | "reviewed" | "resolveConflict">;
  preview: PrivateHistoryPreview;
};
/** Private bot memory lives in bot settings; cross-bot memory and skills live in account settings. */
export function PrivateKnowledgeHistory({ botId }: { botId?: string }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [skills, setSkills] = useState<SkillPage>();
  const [selected, setSelected] = useState<PrivateHistoryTarget>();
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const locked = busy || reviewBusy;
  const [error, setError] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function load(more = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const current = generation.current;
    try {
      const [memory, recipes] = await Promise.all([
        more
          ? Promise.resolve(docs)
          : rpc<MemoryDocument[]>("memory/list", { scope: botId ? "bot" : "user", botId }),
        botId
          ? Promise.resolve(undefined)
          : rpc<SkillPage>("agentSkills/listHistory", {
              includeRemoved: true,
              cursor: more ? (skills?.nextCursor ?? undefined) : undefined,
            }),
      ]);
      if (current !== generation.current) return;
      setDocs(memory);
      setSkills(
        more && recipes ? { ...recipes, items: [...skills!.items, ...recipes.items] } : recipes,
      );
    } catch {
      if (current === generation.current) setError(t("Could not load history. Try again."));
    } finally {
      running.current = false;
      if (current === generation.current) setBusy(false);
    }
  }
  const title = botId ? t("Memory history") : t("Memory and skill history");
  return (
    <View style={styles.section}>
      <Pressable
        style={styles.button}
        disabled={locked}
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: locked }}
        onPress={() => {
          setOpen(!open);
          if (!open) {
            setSelected(undefined);
            void load();
          }
        }}
      >
        <Text style={styles.text}>{title}</Text>
      </Pressable>
      {open && (
        <>
          {busy && <ActivityIndicator />}
          {error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {error && <Action label={t("Retry")} disabled={locked} onPress={() => void load()} />}
          {!busy && !error && !docs.length && !skills?.items.length && (
            <Text style={styles.muted}>{t("No recorded changes yet.")}</Text>
          )}
          {docs.map((doc) => (
            <Action
              key={doc.id}
              label={doc.path}
              disabled={locked}
              onPress={() => setSelected({ kind: "memory", id: doc.id })}
            />
          ))}
          {skills?.items.map((skill) => (
            <Action
              key={skill.id}
              label={skill.removed ? t("{name} · Removed", { name: skill.name }) : skill.name}
              disabled={locked}
              onPress={() => setSelected({ kind: "skill", id: skill.id })}
            />
          ))}
          {skills?.nextCursor && (
            <Action label={t("More skills")} disabled={locked} onPress={() => void load(true)} />
          )}
          {selected && (
            <PrivateHistoryReview
              key={`${selected.kind}:${selected.id}`}
              target={selected}
              onBusyChange={setReviewBusy}
              onApplied={async () => {
                await load();
              }}
            />
          )}
        </>
      )}
    </View>
  );
}

export function PrivateHistoryReview({
  target,
  onApplied,
  onBusyChange,
}: {
  target: PrivateHistoryTarget;
  onApplied: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const [history, setHistory] = useState<PrivateHistory>();
  const [selected, setSelected] = useState<{ revision: number; value: PrivateHistoryVersion }>();
  const [review, setReview] = useState<Review>();
  const [result, setResult] = useState<PrivateHistoryValue>({ content: "", removed: false });
  const [reason, setReason] = useState("");
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    void run(() => load());
    return () => {
      generation.current++;
      running.current = false;
      onBusyChange(false);
    };
  }, []);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    const current = generation.current;
    try {
      await work();
    } catch {
      if (current === generation.current)
        setError(t("Could not complete this review. Reload history and try again."));
    } finally {
      if (current === generation.current) {
        running.current = false;
        onBusyChange(false);
        setBusy(false);
      }
    }
  }
  async function load(more = false) {
    const current = generation.current;
    const next = await rpc<PrivateHistory>("privateHistory/history", {
      ...target,
      beforeRevision: more ? (history?.nextBeforeRevision ?? undefined) : undefined,
    });
    if (current !== generation.current) return;
    if (more && next.revision !== history?.revision) throw new Error("Changed");
    setHistory(more ? { ...next, items: [...history!.items, ...next.items] } : next);
    if (!more) {
      setSelected(undefined);
      setReview(undefined);
    }
  }
  async function select(revision: number) {
    const current = generation.current;
    const value = await rpc<PrivateHistoryVersion>("privateHistory/version", {
      ...target,
      revision,
    });
    if (current !== generation.current) return;
    if (value.currentRevision !== history?.revision) throw new Error("Changed");
    setSelected({ revision, value });
    setReview(undefined);
  }
  async function preview(action: "undo" | "restore") {
    const current = generation.current;
    const input = {
      ...target,
      action,
      revision: selected!.revision,
      expectedRevision: history!.revision,
    };
    const value = await rpc<PrivateHistoryPreview>("privateHistory/preview", input);
    if (current !== generation.current) return;
    setReview({ input, preview: value });
    setResult(value.proposed);
    setReason("");
    setResolved(false);
  }
  async function apply() {
    const current = generation.current;
    await rpc("privateHistory/apply", {
      ...review!.input,
      reason,
      reviewed: result,
      resolveConflict: review!.preview.conflict && resolved,
    });
    if (current !== generation.current) return;
    setReview(undefined);
    setSelected(undefined);
    setNotice(t("Change saved."));
    try {
      await onApplied();
      if (current === generation.current) await load();
    } catch {
      if (current === generation.current)
        setError(t("Change saved. Reload to see the latest version."));
    }
  }
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.text}>
        {history?.title}
      </Text>
      <Text style={styles.muted}>
        {history?.scope === "bot" ? t("Private to this bot") : t("Private across your bots")}
      </Text>
      <Action label={t("Reload history")} disabled={busy} onPress={() => void run(() => load())} />
      {busy && <ActivityIndicator />}
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {notice}
        </Text>
      )}
      {history?.items.length === 0 && (
        <Text style={styles.muted}>{t("No recorded changes yet.")}</Text>
      )}
      {history?.items.map((item) => (
        <View key={item.revision} style={styles.section}>
          <Action
            label={t("Version {revision}", { revision: item.revision })}
            disabled={busy}
            onPress={() => void run(() => select(item.revision))}
          />
          <Text style={styles.muted}>
            {item.actor} · {item.reason}
          </Text>
          <Text style={styles.muted}>
            {new Date(item.createdAt).toLocaleString(dateLocaleForUi(locale))}
          </Text>
          {selected?.revision === item.revision && (
            <>
              {item.sourceTarget && (item.sourceTarget.botId || item.sourceTarget.groupId) && (
                <Action
                  label={t("Source conversation")}
                  disabled={busy}
                  onPress={() =>
                    router.push({
                      pathname: "/thread",
                      params: item.sourceTarget!.groupId
                        ? { groupId: item.sourceTarget!.groupId }
                        : { botId: item.sourceTarget!.botId! },
                    })
                  }
                />
              )}
              {item.learningSource && <LearningEvidence {...item.learningSource} />}
              {selected.value.before ? (
                <VersionText title={t("Before")} value={selected.value.before} />
              ) : (
                <Text style={styles.muted}>{t("Earlier content is unavailable.")}</Text>
              )}
              <VersionText title={t("After")} value={selected.value.after} />
              {!history.readOnly && (
                <>
                  <Action
                    label={t("Undo change")}
                    disabled={busy || !item.canUndo || !selected.value.before}
                    onPress={() => void run(() => preview("undo"))}
                  />
                  <Action
                    label={t("Restore version")}
                    disabled={busy}
                    onPress={() => void run(() => preview("restore"))}
                  />
                </>
              )}
            </>
          )}
        </View>
      ))}
      {history?.nextBeforeRevision && (
        <Action
          label={t("Older changes")}
          disabled={busy}
          onPress={() => void run(() => load(true))}
        />
      )}
      {review && (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.text}>
            {review.input.action === "undo" ? t("Review undo") : t("Review restore")}
          </Text>
          {review.input.action === "restore" && (
            <Text style={styles.muted}>{t("Replaces the entire current version.")}</Text>
          )}
          <VersionText title={t("Current")} value={review.preview.current} />
          {review.preview.conflict ? (
            <>
              <Text style={styles.text}>
                {t("Later edits overlap. Review the result before applying.")}
              </Text>
              <TextInput
                accessibilityLabel={t("Result")}
                multiline
                maxLength={100000}
                editable={!busy}
                value={result.content}
                onChangeText={(content) => {
                  setResult({ ...result, content });
                  setResolved(false);
                }}
                style={styles.editor}
              />
              {target.kind === "skill" && (
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>{t("Available to future runs")}</Text>
                  <Switch
                    accessibilityLabel={t("Available to future runs")}
                    disabled={busy}
                    value={!result.removed}
                    onValueChange={(available) => {
                      setResult({ ...result, removed: !available });
                      setResolved(false);
                    }}
                  />
                </View>
              )}
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>{t("I reviewed the overlapping changes")}</Text>
                <Switch
                  accessibilityLabel={t("I reviewed the overlapping changes")}
                  disabled={busy}
                  value={resolved}
                  onValueChange={setResolved}
                />
              </View>
            </>
          ) : (
            <VersionText title={t("Result")} value={result} />
          )}
          <Text style={styles.text}>{t("Reason for change")}</Text>
          <TextInput
            accessibilityLabel={t("Reason for change")}
            maxLength={1000}
            editable={!busy}
            value={reason}
            onChangeText={setReason}
            style={styles.input}
          />
          <Action
            label={t("Apply change")}
            disabled={busy || !reason.trim() || (review.preview.conflict && !resolved)}
            onPress={() => void run(apply)}
          />
          <Action label={t("Cancel review")} disabled={busy} onPress={() => setReview(undefined)} />
        </View>
      )}
    </View>
  );
}
function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}
function VersionText({ title, value }: { title: string; value: PrivateHistoryValue }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.text}>{title}</Text>
      {value.removed && <Text style={styles.muted}>{t("Removed from future runs")}</Text>}
      <ScrollView nestedScrollEnabled style={styles.versionScroll}>
        <Text selectable style={styles.content}>
          {value.content || t("Empty")}
        </Text>
      </ScrollView>
    </View>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    section: { gap: 8, marginVertical: 8 },
    text: { color: tokens.foreground, fontSize: 16 },
    muted: { color: tokens.mutedForeground, fontSize: 14 },
    error: { color: tokens.destructive, fontSize: 14 },
    button: { minHeight: 44, paddingVertical: 12 },
    disabled: { opacity: 0.5 },
    versionScroll: { maxHeight: 280 },
    content: {
      color: tokens.foreground,
      backgroundColor: tokens.muted,
      padding: 12,
      fontSize: 15,
      lineHeight: 22,
    },
    editor: {
      color: tokens.foreground,
      borderColor: tokens.border,
      borderWidth: 1,
      padding: 12,
      fontSize: 16,
      minHeight: 180,
      textAlignVertical: "top",
    },
    input: {
      color: tokens.foreground,
      borderColor: tokens.border,
      borderWidth: 1,
      padding: 12,
      fontSize: 16,
      minHeight: 44,
    },
    switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    switchLabel: { color: tokens.foreground, fontSize: 16, flex: 1 },
  });
}
