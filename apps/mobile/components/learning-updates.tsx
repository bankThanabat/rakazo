import type { LearningReviewApi } from "@rakazo/chat-ui/learning-review";
import { useLearningReview } from "@rakazo/chat-ui/learning-review";
import type { LearningTaskDetail } from "@rakazo/contracts";
import { useState } from "react";
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
import { PrivateHistoryReview } from "./private-history";

const api: LearningReviewApi = {
  taskList: (input) => rpc("learning/taskList", input),
  task: (input) => rpc("learning/task", input),
  decideTask: (input) => rpc("learning/decideTask", input),
  previewUndo: (input) => rpc("learning/previewUndo", input),
  undo: (input) => rpc("learning/undo", input),
};
export function LearningUpdates({ botId, ids }: { botId: string; ids?: string[] }) {
  const { t, locale } = useI18n();
  const styles = useThemedStyles(createStyles);
  const review = useLearningReview(api, botId, ids);
  const [historyTask, setHistoryTask] = useState<string>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const [decisionsTask, setDecisionsTask] = useState<string>();
  const locked = review.busy || historyBusy;
  const detail = review.current;
  const task = detail?.task;
  const proposal = task?.proposal;
  const statuses = {
    review: t("Needs review"),
    applied: t("Applied"),
    rejected: t("Rejected"),
    failed: t("Could not finish"),
    cancelled: t("Cancelled"),
    ignored: t("No change needed"),
    queued: t("Queued"),
    running: t("Learning…"),
  };
  const decisions: Record<string, string> = {
    approve: t("Approved"),
    reject: t("Rejected"),
    retry: t("Learning restarted"),
    undo: t("Undone"),
    restore: t("Restored"),
  };
  const scopes = {
    space: t("Shared across this Space"),
    bot: t("This bot"),
    "private-bot": t("Private to this bot"),
    "private-user": t("Private across your bots"),
  };
  const date = (value: string) => new Date(value).toLocaleString(dateLocaleForUi(locale));
  return (
    <View style={styles.section}>
      <Action
        label={t("Learning updates")}
        expanded={review.open}
        disabled={locked}
        onPress={review.toggle}
      />
      {review.open && (
        <View style={styles.section}>
          <Action
            label={t("Reload updates")}
            disabled={locked}
            onPress={() => void review.refresh()}
          />
          {review.busy && <ActivityIndicator />}
          {review.list?.items.length === 0 && (
            <Text style={styles.muted}>{t("No learning updates.")}</Text>
          )}
          {review.list?.items.map((item) => (
            <Pressable
              key={item.id}
              style={[styles.button, item.id === task?.id && styles.selected]}
              accessibilityRole="button"
              accessibilityState={{ selected: item.id === task?.id, disabled: locked }}
              disabled={locked}
              onPress={() => void review.select(item.id)}
            >
              <Text style={styles.text}>{item.title || t("Learning update")}</Text>
              <Text style={styles.muted}>
                {statuses[item.status]} · {date(item.createdAt)}
              </Text>
            </Pressable>
          ))}
          {review.list?.nextCursor && (
            <Action
              label={t("Older updates")}
              disabled={locked}
              onPress={() => void review.more()}
            />
          )}
          {detail && task && (
            <View style={styles.review}>
              <Text style={styles.heading} accessibilityRole="header">
                {proposal?.save.title || t("Learning update")}
              </Text>
              <Text style={styles.muted}>
                {statuses[task.status]} · {scopes[detail.scope]}
              </Text>
              <LearningEvidence key={task.id} botId={botId} taskId={task.id} disabled={locked} />
              {task.error && <Text style={styles.error}>{task.error}</Text>}
              {proposal && (
                <>
                  <Text style={styles.heading}>{t("Applies when")}</Text>
                  <Text style={styles.text}>{proposal.conditions}</Text>
                  {proposal.changesBusinessRules && (
                    <Text style={styles.text}>{t("Changes a business rule.")}</Text>
                  )}
                  {!proposal.publicSafe && (
                    <Text style={styles.text}>{t("Contains guidance for staff only.")}</Text>
                  )}
                  {!proposal.supported && (
                    <Text style={styles.text}>
                      {t("The source does not fully support this suggestion. Review the evidence.")}
                    </Text>
                  )}
                  {detail.before ? (
                    <ReviewText
                      label={t("Before")}
                      version={detail.before}
                      privateScope={Boolean(proposal.native)}
                    />
                  ) : (
                    <Text style={styles.muted}>{t("Earlier content is unavailable.")}</Text>
                  )}
                  {detail.after && (
                    <ReviewText
                      label={t("After")}
                      version={detail.after}
                      privateScope={Boolean(proposal.native)}
                    />
                  )}
                </>
              )}
              {task.status === "review" && detail.stale && (
                <Text style={styles.text}>
                  {t("The destination changed. Regenerate this proposal before approving it.")}
                </Text>
              )}
              {!review.undo &&
                ["review", "failed", "rejected", "cancelled"].includes(task.status) && (
                  <>
                    <Text style={styles.heading}>{t("Reason for decision")}</Text>
                    <TextInput
                      style={styles.input}
                      accessibilityLabel={t("Reason for decision")}
                      value={review.reason}
                      onChangeText={review.setReason}
                      editable={!locked}
                      maxLength={900}
                    />
                    <View style={styles.actions}>
                      {task.status === "review" && (
                        <Action
                          primary
                          label={t("Approve change")}
                          disabled={
                            locked ||
                            !detail.canEdit ||
                            !review.reason.trim() ||
                            detail.stale ||
                            !detail.before ||
                            !proposal
                          }
                          onPress={() => void review.decide("approve")}
                        />
                      )}
                      {["review", "failed"].includes(task.status) && (
                        <Action
                          label={t("Reject")}
                          disabled={locked || !review.reason.trim()}
                          onPress={() => void review.decide("reject")}
                        />
                      )}
                      <Action
                        label={task.status === "review" ? t("Regenerate") : t("Retry learning")}
                        disabled={locked || !review.reason.trim()}
                        onPress={() => void review.decide("retry")}
                      />
                    </View>
                  </>
                )}
              {task.documentId && task.appliedRevision && (
                <>
                  <Text style={styles.muted}>
                    {t("Applied version {revision}", { revision: task.appliedRevision })}
                  </Text>
                  {task.targetKind !== "document" ? (
                    <>
                      <Action
                        label={t("History")}
                        expanded={historyTask === task.id}
                        disabled={locked}
                        onPress={() =>
                          setHistoryTask(historyTask === task.id ? undefined : task.id)
                        }
                      />
                      {historyTask === task.id && (
                        <PrivateHistoryReview
                          key={`${task.targetKind}:${task.documentId}`}
                          target={{ kind: task.targetKind, id: task.documentId }}
                          onApplied={review.refresh}
                          onBusyChange={setHistoryBusy}
                        />
                      )}
                    </>
                  ) : (
                    detail.canEdit &&
                    !review.undo && (
                      <Action
                        label={t("Undo change")}
                        disabled={locked}
                        onPress={() => void review.prepareUndo()}
                      />
                    )
                  )}
                </>
              )}
              {review.undo && (
                <View style={styles.review}>
                  <Text accessibilityRole="header" style={styles.heading}>
                    {t("Review undo")}
                  </Text>
                  <ReviewText label={t("Current")} version={review.undo.preview.current} />
                  {review.undo.preview.conflicts.length > 0 && (
                    <Text style={styles.text}>
                      {t("Later edits overlap. Review the result before applying.")}
                    </Text>
                  )}
                  <Text style={styles.heading}>{t("Resulting title")}</Text>
                  <TextInput
                    style={styles.input}
                    accessibilityLabel={t("Resulting title")}
                    value={review.undo.preview.proposed.title}
                    onChangeText={(title) => review.changeUndo({ title })}
                    editable={!locked}
                    maxLength={120}
                  />
                  <Text style={styles.heading}>{t("Resulting content")}</Text>
                  <TextInput
                    style={[styles.input, styles.editor]}
                    accessibilityLabel={t("Resulting content")}
                    value={review.undo.preview.proposed.content}
                    multiline
                    onChangeText={(content) => review.changeUndo({ content })}
                    editable={!locked}
                    maxLength={16000}
                  />
                  <Text style={styles.text}>{t("Use in customer replies after undo")}</Text>
                  <Switch
                    accessibilityLabel={t("Use in customer replies after undo")}
                    value={review.undo.preview.proposed.customerVisible}
                    onValueChange={(customerVisible) => review.changeUndo({ customerVisible })}
                    disabled={locked}
                  />
                  {review.undo.preview.conflicts.length > 0 && (
                    <>
                      <Text style={styles.text}>{t("I reviewed the overlapping edits.")}</Text>
                      <Switch
                        accessibilityLabel={t("I reviewed the overlapping edits.")}
                        value={review.resolved}
                        onValueChange={review.setResolved}
                        disabled={locked}
                      />
                    </>
                  )}
                  <Text style={styles.heading}>{t("Reason for undo")}</Text>
                  <TextInput
                    style={styles.input}
                    accessibilityLabel={t("Reason for undo")}
                    value={review.reason}
                    onChangeText={review.setReason}
                    editable={!locked}
                    maxLength={900}
                  />
                  <Action
                    primary
                    label={t("Apply undo")}
                    disabled={
                      locked ||
                      !review.reason.trim() ||
                      !review.undo.preview.proposed.title.trim() ||
                      Boolean(review.undo.preview.conflicts.length && !review.resolved)
                    }
                    onPress={() => void review.applyUndo()}
                  />
                  <Action
                    label={t("Cancel review")}
                    disabled={locked}
                    onPress={review.cancelUndo}
                  />
                </View>
              )}
              {task.reviews.length > 0 && (
                <>
                  <Action
                    label={t("Recent decisions")}
                    expanded={decisionsTask === task.id}
                    disabled={locked}
                    onPress={() =>
                      setDecisionsTask(decisionsTask === task.id ? undefined : task.id)
                    }
                  />
                  {decisionsTask === task.id &&
                    task.reviews.map((entry, index) => (
                      <View key={`${entry.createdAt}:${index}`} style={styles.review}>
                        <Text style={styles.text}>{entry.reason}</Text>
                        <Text style={styles.muted}>
                          {decisions[entry.decision] ?? entry.decision} · {date(entry.createdAt)}
                        </Text>
                      </View>
                    ))}
                </>
              )}
            </View>
          )}
          {review.error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {t("Could not complete this review. Reload updates and try again.")}
            </Text>
          )}
          {review.notice && (
            <Text accessibilityLiveRegion="polite" style={styles.text}>
              {review.notice === "queued"
                ? t("Learning queued. Reload updates when it finishes.")
                : review.notice === "rejected"
                  ? t("Suggestion rejected.")
                  : t("Change saved.")}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
function Action({
  label,
  disabled,
  onPress,
  expanded,
  primary = false,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  expanded?: boolean;
  primary?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded }}
      style={[styles.button, primary && styles.primary, disabled && styles.disabled]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={primary ? styles.primaryText : styles.text}>{label}</Text>
    </Pressable>
  );
}
function ReviewText({
  label,
  version,
  privateScope = false,
}: {
  label: string;
  version: NonNullable<LearningTaskDetail["after"]>;
  privateScope?: boolean;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{label}</Text>
      {version.title ? <Text style={styles.muted}>{version.title}</Text> : null}
      {!privateScope && (
        <Text style={styles.muted}>
          {version.customerVisible ? t("Use in customer replies") : t("Staff only")}
        </Text>
      )}
      <ScrollView nestedScrollEnabled style={styles.version}>
        <Text selectable style={styles.text}>
          {version.content || t("Empty")}
        </Text>
      </ScrollView>
    </View>
  );
}
const createStyles = () => {
  const tokens = mobileTokens();
  return StyleSheet.create({
    section: { gap: 12, marginVertical: 8 },
    review: { gap: 12, paddingTop: 16, borderTopWidth: 1, borderTopColor: tokens.border },
    text: { color: tokens.foreground, fontSize: 16, lineHeight: 24 },
    heading: { color: tokens.foreground, fontSize: 16, fontWeight: "600" },
    muted: { color: tokens.mutedForeground, fontSize: 14, lineHeight: 20 },
    error: { color: tokens.destructive, fontSize: 16 },
    button: { minHeight: 48, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 8 },
    selected: { backgroundColor: tokens.muted },
    primary: { backgroundColor: tokens.primary },
    primaryText: { color: tokens.primaryForeground, fontSize: 16 },
    disabled: { opacity: 0.5 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    input: {
      color: tokens.foreground,
      fontSize: 16,
      borderColor: tokens.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
    },
    editor: { minHeight: 160, textAlignVertical: "top" },
    version: { maxHeight: 280, backgroundColor: tokens.muted, borderRadius: 8, padding: 12 },
  });
};
