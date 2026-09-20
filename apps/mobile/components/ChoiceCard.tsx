import type { MessageBlock } from "@rakazo/contracts";
import { useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { AskActions } from "./AskActions";

export function ChoiceCard({
  botId,
  block,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [localAnswer, setLocalAnswer] = useState<string>();
  const answerId = block.answerId ?? localAnswer;
  if (answerId === "_dismissed") return null;
  const selected = block.options.find((option) => option.id === answerId);
  return (
    <View style={{ width: "100%", gap: 8 }}>
      <Text style={{ color: tokens.foreground, fontSize: 17 }}>{block.question}</Text>
      {block.subtitle ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>{block.subtitle}</Text>
      ) : null}
      {selected ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 17 }}>{selected.label}</Text>
      ) : (
        <AskActions
          actions={[
            ...block.options.map(({ id, label }) => ({ id, label })),
            { id: "_dismissed", label: t("Dismiss") },
          ]}
          onAnswer={async (optionId) => {
            await rpc(
              optionId === "_dismissed" ? "onboarding/dismissFocus" : "onboarding/choose",
              optionId === "_dismissed" ? { botId } : { botId, optionId },
            );
            setLocalAnswer(optionId);
          }}
        />
      )}
    </View>
  );
}
