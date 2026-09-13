import type { CustomerSnapshot } from "@rakazo/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { ProfileAvatar } from "../components/profile-avatar";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useFocusedPolling } from "../lib/use-focused-polling";

export default function CustomerThread() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const polling = useFocusedPolling(
    () => rpc<CustomerSnapshot>("customers/snapshot", { id: conversationId }),
    conversationId,
    1500,
  );
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
      {polling.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, padding: 16 }}>
          {t("Could not update conversation")}
        </Text>
      ) : null}
    </KeyboardAvoidingView>
  );
}
