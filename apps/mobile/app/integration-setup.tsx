import type { IntegrationSetupState } from "@rakazo/contracts";
import {
  integrationChoiceProvider,
  integrationCredentialsUrl,
  integrationProviderInput,
} from "@rakazo/core";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";

export default function IntegrationSetup() {
  const router = useRouter();
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<IntegrationSetupState | null>(null);
  const [choice, setChoice] = useState("direct");
  const [key, setKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const credentialsUrl = integrationCredentialsUrl(choice, endpoint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void rpc<IntegrationSetupState>("integrationSetup/get")
      .then((setup) => {
        if (!setup.canConfigure) {
          router.replace("/integrations");
          return;
        }
        setState(setup);
      })
      .catch(() => setError(t("Could not load integrations")));
  }, []);
  const choices = [
    { id: "direct", label: t("Direct MCP") },
    { id: "composio", label: "Composio" },
    { id: "pipedream", label: "Pipedream" },
    { id: "open-connector", label: "OpenConnector" },
    { id: "gateway", label: t("Rakazo gateway") },
    { id: "executor", label: "Executor" },
  ];
  const providerId = integrationChoiceProvider(choice);
  const managed = providerId !== null;
  const configured = state?.providers.find((provider) => provider.id === providerId)?.configured;
  const keyLabel =
    choice === "gateway"
      ? t("Runtime key")
      : choice === "open-connector"
        ? t("Admin token")
        : choice === "composio"
          ? t("API key")
          : t("Client secret");
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await rpc(
        "integrationSetup/save",
        integrationProviderInput(choice, { apiKey: key, endpoint, clientId, projectId }),
      );
      setKey("");
      router.replace("/integrations");
    } catch {
      setError(t("Could not verify or save these credentials"));
    } finally {
      setBusy(false);
    }
  }
  function button(label: string, onPress: () => void, disabled = false) {
    return (
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={[styles.button, disabled && { opacity: 0.5 }]}
      >
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    );
  }
  if (!state) return error ? <Text accessibilityRole="alert">{error}</Text> : <ActivityIndicator />;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.choices}>
        {choices.map(({ id, label }) => (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityState={{ checked: choice === id, disabled: busy }}
            disabled={busy}
            onPress={() => {
              setChoice(id);
              setKey("");
              setError(null);
            }}
            style={[styles.choice, choice === id && styles.selected]}
          >
            <Text style={styles.text}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {managed ? (
        <>
          {configured ? <Text style={styles.text}>{t("Connected")}</Text> : null}
          {state?.canConfigure ? (
            <>
              {choice === "open-connector" || choice === "gateway" ? (
                <>
                  <Text style={styles.text}>{t("Server URL")}</Text>
                  <TextInput
                    accessibilityLabel={t("Server URL")}
                    value={endpoint}
                    onChangeText={setEndpoint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={styles.input}
                  />
                </>
              ) : null}
              {choice === "pipedream" ? (
                <>
                  <Text style={styles.text}>{t("Client ID")}</Text>
                  <TextInput
                    accessibilityLabel={t("Client ID")}
                    value={clientId}
                    onChangeText={setClientId}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  <Text style={styles.text}>{t("Project ID")}</Text>
                  <TextInput
                    accessibilityLabel={t("Project ID")}
                    value={projectId}
                    onChangeText={setProjectId}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                </>
              ) : null}
              <Text style={styles.text}>{keyLabel}</Text>
              <TextInput
                accessibilityLabel={keyLabel}
                value={key}
                onChangeText={setKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              {credentialsUrl
                ? button(t("Get credentials"), () => {
                    void Linking.openURL(credentialsUrl);
                  })
                : null}
            </>
          ) : state && !configured ? (
            <Text style={styles.text}>{t("Ask the server owner to configure this provider.")}</Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.text}>
            {choice === "executor"
              ? t("Set up Executor on your server in the web app.")
              : t("Finish MCP authorization in the web app.")}
          </Text>
          {button(
            t("Open web app"),
            () => {
              const url = new URL(state.webUrl);
              if (choice === "direct") url.searchParams.set("mode", "mcp");
              void Linking.openURL(url.toString());
            },
            !state,
          )}
        </>
      )}
      {busy ? <ActivityIndicator /> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {button(
        t("Continue"),
        () => {
          if (managed && key.trim()) void save();
          else router.replace("/");
        },
        busy ||
          (managed &&
            state?.canConfigure &&
            !configured &&
            (!key.trim() ||
              (choice === "pipedream" && (!clientId.trim() || !projectId.trim())) ||
              (choice === "open-connector" && !endpoint.trim()))),
      )}
      {button(t("Skip"), () => router.replace("/"), busy)}
    </ScrollView>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    content: { padding: 20, gap: 16 },
    choices: { borderWidth: 1, borderColor: tokens.border, borderRadius: 12, overflow: "hidden" },
    choice: { padding: 16 },
    selected: { backgroundColor: tokens.muted },
    text: { color: tokens.foreground, fontSize: 16 },
    input: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 10,
      padding: 12,
      color: tokens.foreground,
    },
    button: { padding: 14, borderRadius: 10, backgroundColor: tokens.muted },
    buttonText: { color: tokens.foreground, textAlign: "center", fontSize: 16 },
    error: { color: tokens.destructive },
  });
}
