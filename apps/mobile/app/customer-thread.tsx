import { useCustomerActions } from "@rakazo/chat-ui/customer-actions";
import type { CustomerSnapshot } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { ProfileAvatar } from "../components/profile-avatar";
import { rpc } from "../lib/api";
import { newClientNonce } from "../lib/client-nonce";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useFocusedPolling } from "../lib/use-focused-polling";

export default function CustomerThread() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const [before, setBefore] = useState<number>();
  const polling = useFocusedPolling(
    () => rpc<CustomerSnapshot>("customers/snapshot", { id: conversationId, before }),
    `${conversationId}:${before}`,
    1500,
  );
  const current = polling.data?.conversation.id === conversationId ? polling.data : undefined;
  async function updateCase(input: object) {
    try {
      await rpc("customers/updateCase", { id: conversationId, ...input });
      polling.refresh();
    } catch {
      Alert.alert(t("Could not update case"));
    }
  }
  useEffect(() => {
    if (current) void updateCase({ read: true });
  }, [conversationId, current?.messages.at(-1)?.id]);
  const actions = useCustomerActions({
    id: conversationId,
    nonce: newClientNonce,
    reply: (input) => rpc("customers/reply", input),
    setOwner: (input) => rpc("customers/setOwner", input),
    refresh: polling.refresh,
  });
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: tokens.background }}
    >
      <Stack.Screen
        options={{
          title: current?.conversation.name ?? t("Customer"),
          headerTitle: current
            ? () => (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
                  <ProfileAvatar url={current.conversation.avatarUrl} size={28} />
                  <Text
                    numberOfLines={1}
                    style={{
                      color: tokens.foreground,
                      fontSize: 17,
                      fontWeight: "600",
                      flexShrink: 1,
                    }}
                  >
                    {current.conversation.name}
                  </Text>
                </View>
              )
            : undefined,
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 8 }}>
        <Pressable
          accessibilityRole="button"
          style={{ padding: 12 }}
          onPress={() =>
            void updateCase({
              state: current?.conversation.state === "resolved" ? "open" : "resolved",
            })
          }
        >
          <Text style={{ color: tokens.foreground }}>
            {current?.conversation.state === "resolved" ? t("Reopen") : t("Resolve")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={{ padding: 12 }}
          onPress={async () => {
            try {
              const me = await rpc<{ userId: string }>("me");
              await updateCase({ assigneeId: me.userId });
            } catch {
              Alert.alert(t("Could not update case"));
            }
          }}
        >
          <Text style={{ color: tokens.foreground }}>{t("Assign to me")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={{ padding: 12 }}
          onPress={async () => {
            try {
              const assistant = await rpc<{ botId: string; name: string }>(
                "customers/investigate",
                {
                  id: conversationId,
                  clientNonce: newClientNonce(),
                },
              );
              router.push({ pathname: "/thread", params: assistant });
            } catch {
              Alert.alert(t("Could not open assistant"));
            }
          }}
        >
          <Text style={{ color: tokens.foreground }}>{t("Ask assistant")}</Text>
        </Pressable>
        {current?.conversation.draft && (
          <Pressable
            accessibilityRole="button"
            style={{ padding: 12 }}
            onPress={() => {
              actions.setBody(current.conversation.draft!);
              void actions.setOwner("staff");
            }}
          >
            <Text style={{ color: tokens.foreground }}>{t("Use draft")}</Text>
          </Pressable>
        )}
      </View>
      {current?.conversation.handoffReason && (
        <Text style={{ color: tokens.mutedForeground, padding: 16 }}>
          {current.conversation.handoffReason}
        </Text>
      )}
      {current?.before && (
        <Pressable
          accessibilityRole="button"
          style={{ padding: 12 }}
          onPress={() => setBefore(current.before!)}
        >
          <Text style={{ color: tokens.foreground }}>{t("Earlier messages")}</Text>
        </Pressable>
      )}
      {before && (
        <Pressable
          accessibilityRole="button"
          style={{ padding: 12 }}
          onPress={() => setBefore(undefined)}
        >
          <Text style={{ color: tokens.foreground }}>{t("Latest messages")}</Text>
        </Pressable>
      )}
      {current?.conversation.canReply ? (
        <Pressable
          accessibilityRole="button"
          disabled={actions.busy}
          onPress={() =>
            void actions.setOwner(current.conversation.owner === "bot" ? "staff" : "bot")
          }
          style={{ padding: 16, alignSelf: "flex-end" }}
        >
          <Text style={{ color: tokens.foreground }}>
            {current.conversation.owner === "bot" ? t("Take over") : t("Resume AI")}
          </Text>
        </Pressable>
      ) : null}
      <FlatList
        inverted
        data={current ? [...current.messages].reverse() : []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        renderItem={({ item }) => (
          <View
            style={{
              alignSelf: item.role === "customer" ? "flex-start" : "flex-end",
              maxWidth: "85%",
              backgroundColor: item.role === "customer" ? tokens.muted : tokens.card,
              borderRadius: 12,
              padding: 12,
            }}
          >
            <Text selectable style={{ color: tokens.foreground, fontSize: 16 }}>
              {item.body}
            </Text>
            {item.mediaUrl ? (
              <Pressable
                accessibilityRole="link"
                onPress={() => void Linking.openURL(item.mediaUrl!)}
              >
                <Text
                  style={{
                    color: tokens.foreground,
                    textDecorationLine: "underline",
                    marginTop: 8,
                  }}
                >
                  {t("Attachment")}
                </Text>
              </Pressable>
            ) : null}
            {item.status === "failed" || item.status === "cancelled" ? (
              <Text
                style={{
                  color: item.status === "failed" ? tokens.destructive : tokens.mutedForeground,
                  marginTop: 4,
                }}
              >
                {item.status === "failed" ? t("Reply failed") : t("Cancelled")}
              </Text>
            ) : null}
          </View>
        )}
      />
      {!!current?.actions?.length && (
        <Pressable
          accessibilityRole="button"
          style={{ padding: 12 }}
          onPress={() =>
            Alert.alert(
              t("Action history"),
              current.actions
                .map(
                  (action) =>
                    `${action.name}: ${action.status}${action.outcome ? `\n${action.outcome}` : ""}`,
                )
                .join("\n"),
            )
          }
        >
          <Text style={{ color: tokens.foreground }}>{t("Action history")}</Text>
        </Pressable>
      )}
      {current?.conversation.canReply && current.conversation.owner === "staff" ? (
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 16 }}>
          <TextInput
            accessibilityLabel={t("Reply to customer")}
            placeholder={t("Reply…")}
            multiline
            value={actions.body}
            onChangeText={actions.setBody}
            editable={!actions.busy}
            maxLength={16000}
            placeholderTextColor={tokens.mutedForeground}
            style={{
              flex: 1,
              maxHeight: 160,
              minHeight: 44,
              padding: 12,
              color: tokens.foreground,
              backgroundColor: tokens.muted,
              borderRadius: 12,
            }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={actions.busy || !actions.body.trim()}
            onPress={() => void actions.send()}
            style={{ padding: 12, opacity: actions.busy || !actions.body.trim() ? 0.5 : 1 }}
          >
            <Text style={{ color: tokens.foreground }}>{t("Send")}</Text>
          </Pressable>
        </View>
      ) : null}
      {actions.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, padding: 16 }}>
          {t("Could not save. Try again.")}
        </Text>
      ) : null}
      {polling.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, padding: 16 }}>
          {t("Could not update conversation")}
        </Text>
      ) : null}
    </KeyboardAvoidingView>
  );
}
