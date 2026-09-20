import type { LearningApprovalReview } from "@rakazo/core";
import { useState } from "react";
import type { TextProps } from "react-native";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { ApprovalDetail } from "./approval-detail";

export function LearningApprovalDetail({
  review,
  detail,
  textProps,
}: {
  review: LearningApprovalReview;
  detail: string;
  textProps?: Pick<TextProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [view, setView] = useState<"before" | "after" | "request">("after");
  const { proposal, native } = review;
  const labels = { before: t("Before"), after: t("After"), request: t("Request details") };
  const content =
    view === "request" ? detail : view === "before" ? native.beforeContent : native.content;
  const text = { color: tokens.foreground, fontSize: 14, lineHeight: 21 };
  return (
    <View style={{ gap: 12 }}>
      <Text
        {...textProps}
        accessibilityRole="header"
        style={{ ...text, fontSize: 15.5, fontWeight: "600" }}
      >
        {native.kind === "memory" ? t("Review memory change") : t("Review skill change")}
      </Text>
      <View>
        <Text style={text}>{proposal.save.title}</Text>
        <Text style={{ ...text, color: tokens.mutedForeground }}>
          {native.scope === "bot" ? t("Private to this bot") : t("Private across your bots")}
        </Text>
        {native.kind === "memory" && (
          <Text style={{ ...text, color: tokens.mutedForeground }}>{native.path}</Text>
        )}
      </View>
      <View>
        <Text style={{ ...text, fontWeight: "600" }}>{t("Applies when")}</Text>
        <Text style={text}>{proposal.conditions}</Text>
      </View>
      {review.reviewReason ? <Text style={text}>{review.reviewReason}</Text> : null}
      {proposal.changesBusinessRules && <Text style={text}>{t("Changes a business rule.")}</Text>}
      {!proposal.publicSafe && <Text style={text}>{t("Contains guidance for staff only.")}</Text>}
      {!proposal.supported && (
        <Text style={text}>
          {t("The source does not fully support this suggestion. Review the evidence.")}
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(["before", "after", "request"] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityState={{ selected: view === item }}
            onPress={() => setView(item)}
            style={{
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: 8,
              justifyContent: "center",
              borderRadius: 8,
              backgroundColor: view === item ? tokens.muted : undefined,
            }}
          >
            <Text style={text}>{labels[item]}</Text>
          </Pressable>
        ))}
      </View>
      <ApprovalDetail key={view} detail={content || t("Empty")} plain={view !== "request"} />
    </View>
  );
}
