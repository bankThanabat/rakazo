import type { Connection, ConnectionAction } from "@rakazo/contracts";
import { connectorActionLabel, searchConnectorActions } from "@rakazo/core";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";

export function ConnectionActions({ account }: { account: Connection }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<ConnectionAction[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const sharedDefaults = actions?.filter((action) => !action.defaultInternal) ?? [];
  useEffect(() => {
    if (!open) return;
    let current = true;
    setActions(null);
    setError(null);
    void rpc<ConnectionAction[]>("connections/actions", { connectionId: account.id })
      .then((rows) => {
        if (current) setActions(rows);
      })
      .catch(() => {
        if (current) setError(t("Could not load actions."));
      });
    return () => {
      current = false;
    };
  }, [open, account.id, revision]);
  async function configure(change?: { action: string; internal: boolean | null }) {
    if (pending || account.canManage === false) return;
    setPending(true);
    setError(null);
    try {
      await rpc(change ? "connections/configureAction" : "connections/applyActionDefaults", {
        connectionId: account.id,
        ...change,
      });
      setRevision((value) => value + 1);
    } catch {
      setError(t("Could not save action settings. Try again."));
    } finally {
      setPending(false);
    }
  }
  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.button}
      >
        <Text style={styles.title}>
          {t("Available actions")} · {account.displayName}
        </Text>
      </Pressable>
      {open ? (
        <>
          <Text style={styles.secondary}>
            {t("Internal is for staff only. Turn it off to also allow customer agents.")}
          </Text>
          {account.canManage !== false ? (
            <Pressable
              accessibilityRole="button"
              disabled={pending || !actions?.length}
              style={styles.button}
              onPress={() =>
                Alert.alert(
                  t("Use defaults"),
                  sharedDefaults.length
                    ? `${t("Customer agents will have access to these actions. All other actions will be internal.")}\n\n${sharedDefaults.map((action) => connectorActionLabel(action.name)).join("\n")}`
                    : t("All actions will be internal."),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    { text: t("Use defaults"), onPress: () => void configure() },
                  ],
                )
              }
            >
              <Text style={styles.text}>{t("Use defaults")}</Text>
            </Pressable>
          ) : null}
          {actions && actions.length > 10 ? (
            <TextInput
              style={styles.input}
              accessibilityLabel={t("Search actions")}
              placeholder={t("Search actions")}
              value={query}
              onChangeText={setQuery}
            />
          ) : null}
          {!actions && !error ? <ActivityIndicator /> : null}
          {searchConnectorActions(actions ?? [], query).map((action) => {
            const name = connectorActionLabel(action.name);
            return (
              <View key={action.name} style={styles.row}>
                <View style={styles.description}>
                  <Text style={styles.text}>{name}</Text>
                  <Text style={styles.secondary}>{action.description}</Text>
                  {action.overridden && account.canManage !== false ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={pending}
                      accessibilityLabel={t("Reset {name} to default", { name })}
                      style={styles.button}
                      onPress={() => void configure({ action: action.name, internal: null })}
                    >
                      <Text style={styles.secondary}>{t("Reset to default")}</Text>
                    </Pressable>
                  ) : null}
                </View>
                <View style={styles.control}>
                  <Text style={styles.secondary}>{t("Internal")}</Text>
                  <Switch
                    accessibilityLabel={t("Internal: {name}", { name })}
                    value={action.internal}
                    disabled={pending || account.canManage === false}
                    onValueChange={(internal) => void configure({ action: action.name, internal })}
                  />
                </View>
              </View>
            );
          })}
          {actions?.length === 0 ? (
            <Text style={styles.secondary}>{t("No actions available.")}</Text>
          ) : null}
          {error ? (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => setRevision((value) => value + 1)}
              >
                <Text style={styles.text}>{t("Retry")}</Text>
              </Pressable>
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    group: { gap: 8 },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.border,
    },
    description: { flex: 1, gap: 4 },
    control: { alignItems: "center", gap: 4 },
    title: { color: native.label, fontSize: 15, fontWeight: "600" },
    text: { color: native.label, fontSize: 15 },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    button: { minHeight: 44, justifyContent: "center", paddingVertical: 8 },
    input: {
      minHeight: 44,
      padding: 12,
      borderRadius: 10,
      color: native.label,
      backgroundColor: native.fill,
    },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
