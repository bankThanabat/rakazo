import type { CustomerConversation } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";
import { rpc, selectedSpaceId } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useFocusedPolling } from "../lib/use-focused-polling";
import { ProfileAvatar } from "./profile-avatar";

export function CustomerInbox({ query }: { query: string }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const spaceId = selectedSpaceId();
  const { data, error } = useFocusedPolling(
    () => rpc<CustomerConversation[]>("customers/list"),
    spaceId ?? "",
    3000,
  );
  const rows = data ?? [];
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={rows.filter((row) =>
          `${row.name} ${row.preview} ${row.channelName}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )}
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
                style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}
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
    </View>
  );
}
