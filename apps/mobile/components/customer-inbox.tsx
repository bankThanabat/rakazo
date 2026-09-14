import type { CustomerConversation } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { rpc, selectedSpaceId } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useFocusedPolling } from "../lib/use-focused-polling";
import { ProfileAvatar } from "./profile-avatar";

export function CustomerInbox({ query }: { query: string }) {
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const router = useRouter();
  const spaceId = selectedSpaceId();
  const [state, setState] = useState("open");
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [query, state, spaceId]);
  const { data, error } = useFocusedPolling(
    () => rpc<CustomerConversation[]>("customers/list", { query, state, offset }),
    `${spaceId}:${query}:${state}:${offset}`,
    3000,
  );
  const rows = data ?? [];
  return (
    <View style={{ flex: 1 }}>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          presentMessageActionSheet({
            title: t("Conversations"),
            actions: [
              { text: t("Open"), onPress: () => setState("open") },
              { text: t("Needs attention"), onPress: () => setState("attention") },
              { text: t("Resolved"), onPress: () => setState("resolved") },
              { text: t("All"), onPress: () => setState("all") },
            ],
            cancel: t("Cancel"),
            more: t("More"),
            colorScheme,
          })
        }
        style={{ padding: 16 }}
      >
        <Text style={{ color: tokens.foreground }}>
          {state === "open"
            ? t("Open")
            : state === "resolved"
              ? t("Resolved")
              : state === "attention"
                ? t("Needs attention")
                : t("All")}
        </Text>
      </Pressable>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        ListEmptyComponent={
          <Text style={{ color: tokens.mutedForeground, padding: 20 }}>
            {error
              ? t("Could not load conversations")
              : query.trim()
                ? t("No results")
                : t("No customer conversations yet")}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: "/customer-thread", params: { conversationId: item.id } })
            }
            style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}
          >
            <ProfileAvatar url={item.avatarUrl} />
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: tokens.foreground,
                  fontSize: 17,
                  fontWeight: item.unread ? "800" : "600",
                }}
              >
                {item.name}
              </Text>
              <Text numberOfLines={1} style={{ color: tokens.mutedForeground, marginTop: 4 }}>
                {item.channelName} · {item.needsHuman ? t("Needs attention") : item.preview}
              </Text>
            </View>
          </Pressable>
        )}
      />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {offset > 0 && (
          <Pressable
            accessibilityRole="button"
            style={{ padding: 16 }}
            onPress={() => setOffset(Math.max(0, offset - 200))}
          >
            <Text style={{ color: tokens.foreground }}>{t("Previous")}</Text>
          </Pressable>
        )}
        {rows.length === 200 && (
          <Pressable
            accessibilityRole="button"
            style={{ padding: 16 }}
            onPress={() => setOffset(offset + 200)}
          >
            <Text style={{ color: tokens.foreground }}>{t("Next")}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
