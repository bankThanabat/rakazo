import type { LearningRestore, LearningState, LearningUndoPreview } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, Pressable, Switch, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { LearningEvidence } from "./learning-evidence";

export function LearningDocuments({ botId }: { botId: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LearningState>();
  const [selected, setSelected] = useState<string>();
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [undo, setUndo] = useState<{ input: LearningRestore; preview: LearningUndoPreview }>();
  const [undoReason, setUndoReason] = useState("");
  const doc = state?.documents.find((d) => d.id === selected);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void rpc<LearningState>("learning/state", { botId })
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => {
        if (active) Alert.alert(t("Could not load learning"));
      });
    return () => {
      active = false;
    };
  }, [botId, open, t]);
  useEffect(() => {
    setContent(doc?.content ?? "");
    setVisible(doc?.customerVisible ?? false);
    setReason("");
    setUndo(undefined);
    setUndoReason("");
  }, [doc?.id, doc?.revision]);
  async function run(path: string, input: object) {
    if (busy) return;
    setBusy(true);
    try {
      await rpc(path, input);
      setState(await rpc<LearningState>("learning/state", { botId }));
    } catch {
      Alert.alert(t("Could not save. Reload and try again."));
    } finally {
      setBusy(false);
    }
  }
  const text = { color: tokens.foreground, fontSize: 16 };
  const button = { paddingVertical: 12, minHeight: 44 };
  return (
    <View style={{ marginVertical: 12, gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={button}
      >
        <Text style={text}>{t("Learning and brand voice")}</Text>
      </Pressable>
      {open && (
        <>
          {!state?.documents.length && (
            <Text style={{ color: tokens.mutedForeground }}>
              {t(
                "Ask your staff agent to create brand voice or learning documents. File imports are available on web.",
              )}
            </Text>
          )}
          {state?.documents.map((d) => (
            <Pressable
              key={d.id}
              accessibilityRole="button"
              onPress={() => setSelected(d.id)}
              style={button}
            >
              <Text style={text}>
                {d.title} · {d.scope === "space" ? t("Space default") : t("Bot override")}
              </Text>
            </Pressable>
          ))}
          {doc && (
            <>
              <TextInput
                accessibilityLabel={t("Learning content")}
                multiline
                value={content}
                onChangeText={setContent}
                editable={doc.canEdit && !busy}
                maxLength={16000}
                style={{
                  ...text,
                  minHeight: 150,
                  padding: 12,
                  borderWidth: 1,
                  borderColor: tokens.border,
                  borderRadius: 8,
                  textAlignVertical: "top",
                }}
              />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={text}>{t("Use in customer replies")}</Text>
                <Switch
                  accessibilityLabel={t("Use in customer replies")}
                  value={visible}
                  onValueChange={setVisible}
                  disabled={!doc.canEdit || busy}
                />
              </View>
              {doc.canEdit && (
                <>
                  <TextInput
                    accessibilityLabel={t("Reason for change")}
                    placeholder={t("Reason for change")}
                    placeholderTextColor={tokens.mutedForeground}
                    value={reason}
                    onChangeText={setReason}
                    maxLength={1000}
                    style={{
                      ...text,
                      padding: 12,
                      borderWidth: 1,
                      borderColor: tokens.border,
                      borderRadius: 8,
                    }}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !reason.trim()}
                    style={button}
                    onPress={() =>
                      void run("learning/save", {
                        botId,
                        scope: doc.scope,
                        kind: doc.kind,
                        key: doc.key,
                        title: doc.title,
                        content,
                        customerVisible: visible,
                        expectedRevision: doc.revision,
                        reason,
                        source: "Staff instruction",
                      })
                    }
                  >
                    <Text style={text}>{busy ? t("Saving…") : t("Save document")}</Text>
                  </Pressable>
                </>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() => setHistory(!history)}
                style={button}
              >
                <Text style={text}>{t("Audit history")}</Text>
              </Pressable>
              {history &&
                state?.history
                  .filter((r) => r.documentId === doc.id)
                  .map((r) => (
                    <View
                      key={r.id}
                      style={{
                        gap: 8,
                        paddingVertical: 12,
                        borderTopWidth: 1,
                        borderTopColor: tokens.border,
                      }}
                    >
                      <Text style={text}>
                        {r.title} · {r.revision}
                      </Text>
                      <Text style={{ color: tokens.mutedForeground }}>
                        {r.actor} · {r.reason}
                      </Text>
                      <Text selectable style={text}>
                        {r.content}
                      </Text>
                      {r.hasEvidence && <LearningEvidence botId={botId} revisionId={r.id} />}
                      {doc.canEdit && (
                        <Pressable
                          accessibilityRole="button"
                          disabled={busy}
                          style={button}
                          onPress={async () => {
                            if (busy) return;
                            setBusy(true);
                            try {
                              const input = {
                                botId,
                                documentId: doc.id,
                                revision: r.revision,
                                expectedRevision: doc.revision,
                              };
                              const preview = await rpc<LearningUndoPreview>(
                                "learning/previewUndo",
                                input,
                              );
                              setUndo({ input, preview });
                              setUndoReason("");
                            } catch {
                              Alert.alert(t("Could not load learning"));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <Text style={text}>{t("Undo change")}</Text>
                        </Pressable>
                      )}
                    </View>
                  ))}
              {undo && (
                <View style={{ gap: 12 }}>
                  <Text accessibilityRole="header" style={text}>
                    {t("Undo version {revision}", { revision: undo.input.revision })}
                  </Text>
                  {undo.preview.conflicts.length > 0 && (
                    <Text style={text}>
                      {t(
                        "Later edits overlap this change. They are kept below. Review before applying.",
                      )}
                    </Text>
                  )}
                  {(
                    [
                      [t("Before this change"), undo.preview.before],
                      [t("After this change"), undo.preview.after],
                      [t("Current version"), undo.preview.current],
                    ] as const
                  ).map(([label, version]) => (
                    <View key={label} style={{ gap: 4 }}>
                      <Text style={{ color: tokens.mutedForeground }}>{label}</Text>
                      <Text selectable style={text}>
                        {version.title} ·{" "}
                        {version.customerVisible ? t("Use in customer replies") : t("Staff only")}
                      </Text>
                      <Text selectable style={text}>
                        {version.content}
                      </Text>
                    </View>
                  ))}
                  <TextInput
                    accessibilityLabel={t("Resulting title")}
                    value={undo.preview.proposed.title}
                    editable={!busy}
                    maxLength={120}
                    style={text}
                    onChangeText={(title) =>
                      setUndo({
                        ...undo,
                        preview: { ...undo.preview, proposed: { ...undo.preview.proposed, title } },
                      })
                    }
                  />
                  <TextInput
                    accessibilityLabel={t("Resulting content")}
                    multiline
                    value={undo.preview.proposed.content}
                    editable={!busy}
                    maxLength={16000}
                    style={{
                      ...text,
                      minHeight: 150,
                      padding: 12,
                      borderWidth: 1,
                      borderColor: tokens.border,
                      borderRadius: 8,
                      textAlignVertical: "top",
                    }}
                    onChangeText={(content) =>
                      setUndo({
                        ...undo,
                        preview: {
                          ...undo.preview,
                          proposed: { ...undo.preview.proposed, content },
                        },
                      })
                    }
                  />
                  <Text style={text}>{t("Use in customer replies after undo")}</Text>
                  <Switch
                    accessibilityLabel={t("Use in customer replies after undo")}
                    disabled={busy}
                    value={undo.preview.proposed.customerVisible}
                    onValueChange={(customerVisible) =>
                      setUndo({
                        ...undo,
                        preview: {
                          ...undo.preview,
                          proposed: { ...undo.preview.proposed, customerVisible },
                        },
                      })
                    }
                  />
                  <TextInput
                    accessibilityLabel={t("Reason for undo")}
                    placeholder={t("Reason for undo")}
                    placeholderTextColor={tokens.mutedForeground}
                    value={undoReason}
                    editable={!busy}
                    maxLength={1000}
                    onChangeText={setUndoReason}
                    style={text}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !undoReason.trim() || !undo.preview.proposed.title.trim()}
                    style={button}
                    onPress={() =>
                      void run("learning/undo", {
                        ...undo.input,
                        resolution: undo.preview.proposed,
                        reason: undoReason,
                      })
                    }
                  >
                    <Text style={text}>{t("Apply undo")}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    style={button}
                    onPress={() => setUndo(undefined)}
                  >
                    <Text style={text}>{t("Cancel")}</Text>
                  </Pressable>
                </View>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
