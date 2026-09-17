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
import { NativeSymbol } from "../native-symbol";

export function ConnectionActions({ account }: { account: Connection }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [actions, setActions] = useState<ConnectionAction[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const sharedDefaults = actions?.filter((action) => !action.defaultInternal) ?? [];
  useEffect(() => {
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
  }, [account.id, revision]);
  async function configure(change?: { action: string; internal: boolean }) {
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
      <View style={styles.header}>
        <Text accessibilityRole="header" style={[styles.title, styles.heading]}>
          {t("Available actions")} · {account.displayName}
        </Text>
        {account.canManage !== false ? (
          <Pressable
            accessibilityRole="button"
            disabled={pending || !actions?.length}
            style={styles.button}
            onPress={() =>
              Alert.alert(
                t("Reset to default"),
                sharedDefaults.length
                  ? `${t("Customer agents will have access to these actions. All other actions will be internal.")}\n\n${sharedDefaults.map((action) => connectorActionLabel(action.name)).join("\n")}`
                  : t("All actions will be internal."),
                [
                  { text: t("Cancel"), style: "cancel" },
                  { text: t("Reset to default"), onPress: () => void configure() },
                ],
              )
            }
          >
            <Text style={styles.text}>{t("Reset to default")}</Text>
          </Pressable>
        ) : null}
      </View>
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
      {actions?.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("What is Internal?")}
          style={[styles.button, styles.controlHeading]}
          onPress={() =>
            Alert.alert(
              t("Internal"),
              t("Internal is for staff only. Turn it off to also allow customer agents."),
            )
          }
        >
          <Text style={styles.secondary}>{t("Internal")}</Text>
          <NativeSymbol
            ios="questionmark.circle"
            android="help-circle-outline"
            size={16}
            color={native.secondaryLabel}
          />
        </Pressable>
      ) : null}
      {searchConnectorActions(actions ?? [], query).map((action) => {
        const name = connectorActionLabel(action.name);
        return (
          <View key={action.name} style={styles.row}>
            <View style={styles.description}>
              <Text style={styles.text}>{name}</Text>
              <Text style={styles.secondary}>{action.description}</Text>
            </View>
            <View style={styles.control}>
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
    </View>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    group: { gap: 8 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    heading: { flex: 1 },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.border,
    },
    description: { flex: 1, gap: 4 },
    control: { minWidth: 64, alignItems: "center" },
    controlHeading: {
      minWidth: 64,
      alignSelf: "flex-end",
      flexDirection: "row",
      gap: 4,
      alignItems: "center",
    },
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
