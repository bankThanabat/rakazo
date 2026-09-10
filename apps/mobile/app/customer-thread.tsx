import { useAsyncAction } from "@rakazo/chat-ui/async-state";
import type { CustomerSnapshot } from "@rakazo/contracts";
import { CUSTOMER_REPLY_MAX_LENGTH } from "@rakazo/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import {
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
  const [body, setBody] = useState("");
  const nonce = useRef({ body: "", id: "" });
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const polling = useFocusedPolling(
    () => rpc<CustomerSnapshot>("customers/snapshot", { id: conversationId }),
    conversationId,
    1500,
  );
  const { busy, error: actionError, act } = useAsyncAction(polling.refresh);
  const error = actionError || polling.error;
  const current = polling.data;
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
      {current ? (
        <Pressable
          disabled={busy}
          accessibilityRole="button"
          style={{ padding: 16, alignSelf: "flex-end" }}
          onPress={() =>
            void act(() =>
              rpc("customers/setOwner", {
                id: conversationId,
                owner: current.conversation.owner === "bot" ? "staff" : "bot",
              }),
            )
          }
        >
          <Text style={{ color: tokens.foreground }}>
            {current.conversation.owner === "bot" ? t("Take over") : t("Resume bot")}
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
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, padding: 16 }}>
          {t("Could not update conversation")}
        </Text>
      ) : null}
      {current?.conversation.owner === "staff" ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}>
          <TextInput
            accessibilityLabel={t("Reply to customer")}
            placeholder={t("Reply to customer")}
            placeholderTextColor={tokens.mutedForeground}
            value={body}
            onChangeText={setBody}
            maxLength={CUSTOMER_REPLY_MAX_LENGTH}
            multiline
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 150,
              backgroundColor: tokens.muted,
              borderRadius: 12,
              color: tokens.foreground,
              padding: 12,
            }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !body.trim()}
            style={{ paddingVertical: 12 }}
            onPress={() => {
              if (nonce.current.body !== body) nonce.current = { body, id: newClientNonce() };
              void act(async () => {
                await rpc("customers/reply", {
                  id: conversationId,
                  body,
                  clientNonce: nonce.current.id,
                });
                setBody("");
                nonce.current = { body: "", id: "" };
              });
            }}
          >
            <Text style={{ color: tokens.foreground }}>{t("Send")}</Text>
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
