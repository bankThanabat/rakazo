import { useAsyncAction } from "@rakazo/chat-ui/async-state";
import type { CustomerChannel, CustomerProviderDefinition } from "@rakazo/contracts";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MobileBot } from "../lib/api";
import { currentApiBase, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";

export default function CustomerChannels() {
  const [channels, setChannels] = useState<CustomerChannel[]>([]);
  const [providers, setProviders] = useState<CustomerProviderDefinition[]>([]);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [provider, setProvider] = useState("line");
  const [botId, setBotId] = useState("");
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const { busy, error, setError, act } = useAsyncAction(load);
  const styles = useThemedStyles(createStyles);
  const colorScheme = useResolvedAppearance();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const definition = providers.find((item) => item.id === provider);
  async function load() {
    const [next, catalog, agents] = await Promise.all([
      rpc<CustomerChannel[]>("customers/channels"),
      rpc<CustomerProviderDefinition[]>("customers/providers"),
      rpc<MobileBot[]>("bots/list"),
    ]);
    setChannels(next);
    setProviders(catalog);
    setBots(agents.filter((bot) => !bot.archivedAt));
  }
  useEffect(() => {
    void load().catch(() => setError(true));
  }, []);
  function pick(kind: "provider" | "bot") {
    presentMessageActionSheet({
      title: t(kind === "provider" ? "Channel" : "Agent"),
      cancel: t("Cancel"),
      more: t("More"),
      colorScheme,
      actions: (kind === "provider" ? providers : bots).map((item) => ({
        text: item.name,
        onPress: () => {
          if (kind === "provider") {
            setProvider(item.id);
            setCredentials({});
            setAccountId("");
          } else setBotId(item.id);
        },
      })),
    });
  }
  function input(
    label: string,
    value: string,
    onChangeText: (text: string) => void,
    secret = false,
    multiline = false,
  ) {
    return (
      <View key={label} style={styles.field}>
        <Text style={styles.text}>{t(label)}</Text>
        <TextInput
          accessibilityLabel={t(label)}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secret}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={multiline}
          style={styles.input}
        />
      </View>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: t("Channels"), headerBackTitle: t("Integrations") }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={styles.screen}
        contentContainerStyle={styles.content}
      >
        {channels.map((channel) => (
          <View key={channel.id} style={styles.channel}>
            <View style={styles.row}>
              <Text style={styles.name}>{channel.name}</Text>
              <Switch
                accessibilityLabel={channel.name}
                disabled={busy}
                value={channel.enabled}
                onValueChange={(enabled) =>
                  void act(() => rpc("customers/setChannelEnabled", { id: channel.id, enabled }))
                }
                trackColor={{ true: tokens.primary, false: tokens.border }}
              />
            </View>
            <Text style={styles.muted}>{t("Webhook URL")}</Text>
            <Text selectable style={styles.text}>
              {channel.webhookUrl ?? `${currentApiBase()}${channel.webhookPath}`}
            </Text>
            <Pressable
              accessibilityRole="link"
              style={styles.guideButton}
              onPress={() => {
                const url = providers.find((item) => item.id === channel.provider)?.setupUrl;
                if (url) void Linking.openURL(url);
              }}
            >
              <Text style={styles.link}>{t("Setup guide")}</Text>
            </Pressable>
          </View>
        ))}
        {adding ? (
          <>
            <Pressable
              accessibilityRole="button"
              style={styles.pickerButton}
              onPress={() => pick("provider")}
            >
              <Text style={styles.text}>
                {t("Channel")}: {definition?.name}
              </Text>
            </Pressable>
            {input("Name", name, setName)}
            {input(definition?.accountLabel ?? "Account ID", accountId, setAccountId)}
            <Pressable
              accessibilityRole="button"
              style={styles.pickerButton}
              onPress={() => pick("bot")}
            >
              <Text style={styles.text}>
                {t("Agent")}: {bots.find((bot) => bot.id === botId)?.name ?? bots[0]?.name}
              </Text>
            </Pressable>
            {input("Customer instructions", instructions, setInstructions, false, true)}
            {definition?.fields.map((field) =>
              input(
                field.label,
                credentials[field.key] ?? "",
                (value) => setCredentials((current) => ({ ...current, [field.key]: value })),
                field.secret,
              ),
            )}
            <Pressable
              accessibilityRole="button"
              disabled={busy || !name.trim() || !accountId.trim() || !bots.length}
              style={styles.connectButton}
              onPress={() =>
                void act(async () => {
                  await rpc("customers/connect", {
                    provider,
                    botId: botId || bots[0]?.id,
                    name,
                    accountId,
                    instructions,
                    credentials,
                  });
                  setCredentials({});
                  setAdding(false);
                  setName("");
                  setAccountId("");
                })
              }
            >
              <Text style={styles.connectText}>{t("Connect")}</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            accessibilityRole="button"
            style={styles.addButton}
            onPress={() => setAdding(true)}
          >
            <Text style={styles.text}>{t("Connect channel")}</Text>
          </Pressable>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t("Could not save channel settings")}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    content: { padding: 20, gap: 20 },
    field: { gap: 6 },
    text: { color: tokens.foreground },
    input: {
      color: tokens.foreground,
      backgroundColor: tokens.muted,
      borderRadius: 10,
      minHeight: 44,
      padding: 12,
    },
    screen: { flex: 1, backgroundColor: tokens.background },
    channel: { gap: 10 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    name: { color: tokens.foreground, flex: 1 },
    muted: { color: tokens.mutedForeground },
    guideButton: { paddingVertical: 10 },
    link: { color: tokens.foreground, textDecorationLine: "underline" },
    pickerButton: { minHeight: 44, justifyContent: "center" },
    connectButton: { padding: 14, borderRadius: 12, backgroundColor: tokens.primary },
    connectText: { color: tokens.primaryForeground, textAlign: "center" },
    addButton: { paddingVertical: 12 },
    error: { color: tokens.destructive },
  });
}
