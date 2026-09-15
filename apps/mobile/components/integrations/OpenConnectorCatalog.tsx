import type {
  Connection,
  ConnectionCatalogItem,
  ConnectorAuthMethod,
  ConnectorCredentialField,
  ConnectorSetup,
  IntegrationSetupState,
} from "@rakazo/contracts";
import { CONNECTION_CATALOG_PAGE_SIZE, waitForConnectionAuthorization } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
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
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { ConnectorIcon } from "../connector-icon";

function Fields({
  fields,
  values,
  onChange,
  disabled,
}: {
  fields: ConnectorCredentialField[];
  values: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  disabled: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <>
      {fields.map((field) => (
        <View key={field.key} style={styles.group}>
          <Text style={styles.text}>{field.label}</Text>
          <TextInput
            accessibilityLabel={field.label}
            style={styles.input}
            value={values[field.key] ?? ""}
            editable={!disabled}
            secureTextEntry={field.secret || field.inputType === "password"}
            multiline={
              !field.secret && (field.inputType === "textarea" || field.inputType === "json")
            }
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={field.placeholder}
            onChangeText={(value) => onChange({ ...values, [field.key]: value })}
          />
          {field.description ? <Text style={styles.secondary}>{field.description}</Text> : null}
        </View>
      ))}
    </>
  );
}

export function OpenConnectorCatalog({
  connections,
  onRefresh,
}: {
  connections: Connection[];
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [onlyConnected, setOnlyConnected] = useState(false);
  const [count, setCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [selected, setSelected] = useState<ConnectionCatalogItem | null>(null);
  const [setup, setSetup] = useState<ConnectorSetup | null>(null);
  const [settings, setSettings] = useState<IntegrationSetupState | null>(null);
  const [method, setMethod] = useState<ConnectorAuthMethod | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [oauthValues, setOauthValues] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [form, setForm] = useState(false);
  const [reconnect, setReconnect] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ id: string; url: string } | null>(null);
  const [incoming, setIncoming] = useState<{
    connectionId: string;
    botId: string;
    secrets: Record<string, string>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<Array<{ name: string; description: string }> | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const accounts = connections.filter(
    (row) => row.connectorId === "open-connector" && row.status !== "revoked",
  );
  const selectedAccounts = accounts.filter((row) => row.provider === selected?.slug);
  async function setupIncoming(connectionId: string) {
    await run(async () => {
      const bots = await rpc<Array<{ id: string; name: string }>>("bots/list");
      if (!bots.length) throw new Error(t("Create an assistant first."));
      presentMessageActionSheet({
        title: t("Choose an assistant"),
        cancel: t("Cancel"),
        more: t("More"),
        colorScheme,
        actions: bots.map((bot) => ({
          text: bot.name,
          onPress: () => setIncoming({ connectionId, botId: bot.id, secrets: {} }),
        })),
      });
    });
  }
  function choose(auth: ConnectorAuthMethod) {
    setMethod(auth);
    setValues({});
    setScopes(
      auth.authorizationOptions
        ?.filter((option) => option.required || option.defaultSelected)
        .map((option) => option.id) ?? [],
    );
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError(null);
    try {
      await action(current.signal);
    } catch (cause) {
      if (controller.current === current && !current?.signal.aborted)
        setError(cause instanceof Error ? cause.message : t("Could not complete the request"));
    } finally {
      if (controller.current === current && !current?.signal.aborted) setBusy(false);
    }
  }
  async function browse() {
    setOpen(true);
    await run(async () => {
      const [items, state] = await Promise.all([
        rpc<ConnectionCatalogItem[]>("connections/catalog", { connectorId: "open-connector" }),
        rpc<IntegrationSetupState>("integrationSetup/get"),
      ]);
      setCatalog(items);
      setSettings(state);
      await onRefresh();
    });
  }
  async function detail(item: ConnectionCatalogItem) {
    controller.current?.abort();
    setAttempt(null);
    setSelected(item);
    setSetup(null);
    setForm(false);
    setValues({});
    setOauthValues({});
    setTools(null);
    setLabel(item.name);
    await run(async (signal) => {
      const result = await rpc<ConnectorSetup>("connections/setup", {
        connectorId: "open-connector",
        provider: item.slug,
      });
      if (signal.aborted) return;
      setSetup(result);
      if (result.methods[0]) choose(result.methods[0]);
      const pendingAccount = accounts.find(
        (row) => row.provider === item.slug && row.status === "pending" && row.canManage !== false,
      );
      if (pendingAccount) void poll(pendingAccount.id, pendingAccount.authorizationUrl ?? "");
    });
  }
  function back() {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setSelected(null);
    setValues({});
    setOauthValues({});
    setAttempt(null);
    setForm(false);
    setError(null);
  }
  async function poll(id: string, url: string) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setAttempt({ id, url });
    setBusy(true);
    setError(null);
    const result = await waitForConnectionAuthorization(
      (signal) =>
        rpc<Connection>("connections/complete", { connectionId: id }, { signal, timeoutMs: 60000 }),
      current.signal,
    );
    if (result.status === "cancelled") return;
    setBusy(false);
    if (result.status === "connected") {
      setAttempt(null);
      setForm(false);
      await onRefresh().catch(() => {
        if (!current.signal.aborted) setError(t("Could not refresh accounts. Try again."));
      });
    } else {
      setError(
        result.status === "pending"
          ? t("Authorization is still pending. Check again or cancel.")
          : (result.message ?? t("Authorization failed.")),
      );
    }
  }
  async function connect() {
    if (!selected || !method) return;
    await run(async (signal) => {
      const auth = { type: method.type, values, authorizationOptionIds: scopes };
      const result = reconnect
        ? {
            ...(await rpc<{ authorizationUrl: string | null }>(
              "connections/reconnect",
              { connectionId: reconnect, auth },
              { timeoutMs: 60000 },
            )),
            connectionId: reconnect,
          }
        : await rpc<{ connectionId: string; authorizationUrl: string | null }>(
            "connections/begin",
            {
              connectorId: "open-connector",
              provider: selected.slug,
              displayName: label.trim() || selected.name,
              auth,
            },
            { timeoutMs: 60000 },
          );
      if (signal.aborted) return;
      setValues({});
      await onRefresh();
      if (signal.aborted) return;
      if (result.authorizationUrl) {
        setAttempt({ id: result.connectionId, url: result.authorizationUrl });
        await Linking.openURL(result.authorizationUrl);
        void poll(result.connectionId, result.authorizationUrl);
      } else setForm(false);
    });
    setValues({});
  }
  function disconnect(row: Connection) {
    Alert.alert(t("Disconnect account"), t("Disconnect this account for everyone in the team?"), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Disconnect"),
        style: "destructive",
        onPress: () =>
          void run(async () => {
            await rpc("connections/revoke", { connectionId: row.id }, { timeoutMs: 60000 });
            setAttempt(null);
            await onRefresh();
          }),
      },
    ]);
  }
  function button(text: string, onPress: () => void, disabled = busy) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={[styles.button, disabled && styles.disabled]}
      >
        <Text style={styles.text}>{text}</Text>
      </Pressable>
    );
  }
  const visible = catalog.filter(
    (item) =>
      (!onlyConnected ||
        accounts.some((row) => row.provider === item.slug && row.status === "connected")) &&
      `${item.name} ${item.description ?? ""} ${item.categories?.join(" ") ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.heading}>OpenConnector</Text>
        {button(
          open ? t("Close catalog") : t("Browse apps"),
          () => {
            if (open) {
              back();
              setOpen(false);
            } else void browse();
          },
          false,
        )}
      </View>
      {!open
        ? accounts.map((row) => (
            <Text key={row.id} style={styles.text}>
              {row.displayName}
            </Text>
          ))
        : null}
      {open && !selected ? (
        <>
          <TextInput
            accessibilityLabel={t("Search OpenConnector apps")}
            placeholder={t("Search apps…")}
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setCount(CONNECTION_CATALOG_PAGE_SIZE);
            }}
            style={styles.input}
          />
          <View style={styles.row}>
            <Text style={styles.text}>{t("Connected only")}</Text>
            <Switch
              accessibilityLabel={t("Connected only")}
              value={onlyConnected}
              onValueChange={(value) => {
                setOnlyConnected(value);
                setCount(CONNECTION_CATALOG_PAGE_SIZE);
              }}
            />
          </View>
          {visible.slice(0, count).map((item) => (
            <Pressable
              key={item.slug}
              accessibilityRole="button"
              onPress={() => void detail(item)}
              style={styles.item}
            >
              <View style={styles.appName}>
                <ConnectorIcon name={item.name} logo={item.logo} />
                <Text style={styles.text}>{item.name}</Text>
              </View>
              <Text style={styles.secondary}>
                {item.availability === "unavailable"
                  ? t("Unavailable")
                  : accounts.some((row) => row.provider === item.slug && row.status === "connected")
                    ? t("Connected")
                    : "›"}
              </Text>
            </Pressable>
          ))}
          {!busy && !visible.length && !error ? (
            <Text style={styles.secondary}>{t("No apps match your search.")}</Text>
          ) : null}
          {visible.length > count
            ? button(t("Show more"), () => setCount(count + CONNECTION_CATALOG_PAGE_SIZE))
            : null}
          {!catalog.length && settings?.canConfigure
            ? button(t("Set up OpenConnector"), () => void Linking.openURL(settings.webUrl))
            : null}
        </>
      ) : null}
      {open && selected ? (
        <>
          {button(t("Back to apps"), back, false)}
          <View style={styles.appName}>
            <ConnectorIcon name={selected.name} logo={selected.logo} />
            <Text style={styles.heading}>{selected.name}</Text>
          </View>
          {selected.description ? (
            <Text style={styles.secondary}>{selected.description}</Text>
          ) : null}
          {selectedAccounts.map((row) => (
            <View key={row.id} style={styles.group}>
              <TextInput
                accessibilityLabel={t("Account label")}
                style={styles.input}
                defaultValue={row.displayName}
                editable={row.canManage !== false}
                onEndEditing={(event) => {
                  const displayName = event.nativeEvent.text.trim();
                  if (row.canManage !== false && displayName && displayName !== row.displayName)
                    void run(async () => {
                      await rpc("connections/rename", { connectionId: row.id, displayName });
                      await onRefresh();
                    });
                }}
              />
              <Text style={styles.secondary}>
                {row.reconnectRequired
                  ? t("Reconnect required")
                  : row.status === "connected"
                    ? t("Connected")
                    : t("Pending")}
              </Text>
              {row.canManage !== false ? (
                <View style={styles.row}>
                  {button(t("Reconnect"), () => {
                    setReconnect(row.id);
                    setValues({});
                    setForm(true);
                  })}
                  {button(t("Disconnect"), () => disconnect(row))}
                </View>
              ) : null}
              {row.automaticReplies !== undefined ? (
                <Text style={styles.text}>
                  {row.automaticReplies ? t("Automatic replies on") : t("Automatic replies off")}
                </Text>
              ) : null}
              {row.webhookUrl ? (
                <View style={styles.group}>
                  <Text style={styles.text}>{t("Webhook URL")}</Text>
                  <Text selectable style={styles.secondary}>
                    {row.webhookUrl}
                  </Text>
                  {button(t("Copy webhook URL"), () => {
                    void run(async () => {
                      await Clipboard.setStringAsync(row.webhookUrl!);
                    });
                  })}
                </View>
              ) : row.status === "connected" ? (
                row.incomingSecrets?.length && row.canManage !== false ? (
                  incoming?.connectionId === row.id ? (
                    <View style={styles.group}>
                      {row.incomingSecrets.map((secret) => (
                        <TextInput
                          key={secret.key}
                          accessibilityLabel={secret.label}
                          placeholder={secret.label}
                          secureTextEntry
                          autoCapitalize="none"
                          autoCorrect={false}
                          value={incoming.secrets[secret.key] ?? ""}
                          style={styles.input}
                          onChangeText={(value) =>
                            setIncoming({
                              ...incoming,
                              secrets: { ...incoming.secrets, [secret.key]: value },
                            })
                          }
                        />
                      ))}
                      {button(
                        t("Enable incoming messages"),
                        () =>
                          void run(async () => {
                            await rpc("connections/setupIncoming", incoming);
                            setIncoming(null);
                            await onRefresh();
                          }),
                        busy ||
                          row.incomingSecrets.some(
                            (secret) => !incoming.secrets[secret.key]?.trim(),
                          ),
                      )}
                      {button(t("Cancel"), () => setIncoming(null))}
                    </View>
                  ) : (
                    button(t("Set up incoming messages"), () => void setupIncoming(row.id))
                  )
                ) : null
              ) : null}
            </View>
          ))}
          {setup && !form && selected.availability !== "unavailable"
            ? button(selectedAccounts.length ? t("Add account") : t("Connect"), () => {
                setReconnect(null);
                setValues({});
                setForm(true);
              })
            : null}
          {form && setup && method && !attempt ? (
            <View style={styles.group}>
              {setup.methods.length > 1
                ? button(`${t("Authentication method")}: ${method.type}`, () =>
                    Alert.alert(
                      t("Authentication method"),
                      undefined,
                      setup.methods.map((auth) => ({
                        text: auth.type,
                        onPress: () => choose(auth),
                      })),
                    ),
                  )
                : null}
              {!reconnect ? (
                <TextInput
                  accessibilityLabel={t("Account name")}
                  style={styles.input}
                  value={label}
                  onChangeText={setLabel}
                  editable={!busy}
                />
              ) : null}
              {method.type === "oauth2" && !setup.oauthConfigured ? (
                <>
                  <Text style={styles.text}>{t("Admin setup required")}</Text>
                  {settings?.canConfigure && !setup.oauthManaged ? (
                    <>
                      <Fields
                        fields={[
                          {
                            key: "clientId",
                            label: t("Client ID"),
                            inputType: "text",
                            required: true,
                            secret: false,
                          },
                          {
                            key: "clientSecret",
                            label: t("Client secret"),
                            inputType: "password",
                            required: false,
                            secret: true,
                          },
                          ...(setup.oauthFields ?? []),
                        ]}
                        values={oauthValues}
                        onChange={setOauthValues}
                        disabled={busy}
                      />
                      {setup.oauthCallbackUrl ? (
                        <Text selectable style={styles.secondary}>
                          {setup.oauthCallbackUrl}
                        </Text>
                      ) : null}
                      {setup.oauthSetupUrl
                        ? button(
                            t("OAuth setup instructions"),
                            () => void Linking.openURL(setup.oauthSetupUrl!),
                          )
                        : null}
                      {button(
                        t("Save OAuth setup"),
                        () =>
                          void run(async () => {
                            await rpc(
                              "connections/configureOAuth",
                              {
                                connectorId: "open-connector",
                                provider: selected.slug,
                                values: oauthValues,
                              },
                              { timeoutMs: 60000 },
                            );
                            setOauthValues({});
                            setSetup(
                              await rpc<ConnectorSetup>("connections/setup", {
                                connectorId: "open-connector",
                                provider: selected.slug,
                              }),
                            );
                          }),
                      )}
                    </>
                  ) : (
                    <Text style={styles.secondary}>
                      {t("A deployment administrator must configure this app’s OAuth client.")}
                    </Text>
                  )}
                </>
              ) : (
                <>
                  <Fields
                    fields={method.fields}
                    values={values}
                    onChange={setValues}
                    disabled={busy}
                  />
                  {method.authorizationOptions?.map((option) => (
                    <View key={option.id} style={styles.row}>
                      <Text style={styles.text}>{option.label}</Text>
                      <Switch
                        accessibilityLabel={option.label}
                        value={scopes.includes(option.id)}
                        disabled={busy || option.required}
                        onValueChange={(checked) =>
                          setScopes((current) =>
                            checked
                              ? [...current, option.id]
                              : current.filter((id) => id !== option.id),
                          )
                        }
                      />
                    </View>
                  ))}
                  <Text style={styles.secondary}>{t("Available to everyone in this team.")}</Text>
                  {button(
                    method.type === "oauth2" ? t("Continue") : t("Connect account"),
                    () => void connect(),
                  )}
                </>
              )}
              {button(t("Cancel"), () => {
                setForm(false);
                setValues({});
                setOauthValues({});
              })}
            </View>
          ) : null}
          {attempt ? (
            <View style={styles.group}>
              <Text style={styles.text}>{t("Waiting for authorization")}</Text>
              {button(
                t("Open authorization"),
                () => void Linking.openURL(attempt.url),
                !attempt.url,
              )}
              {button(t("Check again"), () => void poll(attempt.id, attempt.url), false)}
              {button(
                t("Cancel authorization"),
                () =>
                  void run(async () => {
                    await rpc(
                      "connections/cancel",
                      { connectionId: attempt.id },
                      { timeoutMs: 60000 },
                    );
                    setAttempt(null);
                    setForm(false);
                    await onRefresh();
                  }),
                false,
              )}
            </View>
          ) : null}
          {selectedAccounts.some((row) => row.status === "connected")
            ? button(
                t("Available actions"),
                () =>
                  void run(async () =>
                    setTools(
                      await rpc("connections/tools", {
                        connectorId: "open-connector",
                        provider: selected.slug,
                      }),
                    ),
                  ),
              )
            : null}
          {tools ? (
            <>
              <TextInput
                accessibilityLabel={t("Search actions")}
                placeholder={t("Search actions")}
                style={styles.input}
                value={toolQuery}
                onChangeText={setToolQuery}
              />
              {tools
                .filter((tool) =>
                  `${tool.name} ${tool.description}`
                    .toLowerCase()
                    .includes(toolQuery.toLowerCase()),
                )
                .map((tool) => (
                  <View key={tool.name} style={styles.group}>
                    <Text style={styles.text}>{tool.name}</Text>
                    <Text style={styles.secondary}>{tool.description}</Text>
                  </View>
                ))}
            </>
          ) : null}
        </>
      ) : null}
      {busy ? <ActivityIndicator /> : null}
      {error ? (
        <View style={styles.group}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {button(t("Retry"), () => void (selected ? detail(selected) : browse()), false)}
        </View>
      ) : null}
    </View>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    section: {
      gap: 12,
      paddingVertical: 20,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: tokens.border,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      flexWrap: "wrap",
    },
    appName: { flexDirection: "row", alignItems: "center", gap: 12, flexShrink: 1 },
    heading: { color: native.label, fontSize: 17, fontWeight: "600" },
    text: { color: native.label, fontSize: 15, flexShrink: 1 },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    input: {
      backgroundColor: native.fill,
      color: native.label,
      borderRadius: 10,
      padding: 12,
      minHeight: 44,
    },
    button: {
      minHeight: 44,
      padding: 12,
      justifyContent: "center",
      borderRadius: 10,
      backgroundColor: native.fill,
    },
    disabled: { opacity: 0.5 },
    group: { gap: 8 },
    item: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.border,
    },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
