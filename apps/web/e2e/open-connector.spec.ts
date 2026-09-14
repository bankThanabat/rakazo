import { expect, test } from "@playwright/test";
import type { Connection } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`OpenConnector catalog connects API-key and custom-credential apps at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route("https://assets.example.test/**", async (route) => {
      if (route.request().url().endsWith("missing.svg")) return route.fulfill({ status: 404 });
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v12H9l-5 4z"/></svg>',
      });
    });
    const accounts: Connection[] = [];
    const started: Record<string, unknown>[] = [];
    const incomingRequests: Record<string, unknown>[] = [];
    const catalog = [
      {
        connectorId: "open-connector",
        slug: "sample",
        name: "Sample app",
        logo: "https://assets.example.test/sample.svg",
        connected: false,
        noAuth: false,
        scope: "team",
        categories: ["Messaging"],
        availability: "available",
      },
      {
        connectorId: "open-connector",
        slug: "future-app",
        name: "Future app",
        logo: "https://assets.example.test/missing.svg",
        connected: false,
        noAuth: false,
        scope: "team",
        categories: ["Productivity"],
        availability: "available",
      },
    ];
    await page.route("**/rpc/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace("/rpc/", "");
      const input = route.request().postDataJSON()?.json;
      let result: unknown = [];
      if (path === "connections/catalog") result = input?.excludeConnectorIds ? [] : catalog;
      else if (path === "integrationSetup/get")
        result = {
          canConfigure: true,
          providers: [{ id: "open-connector", configured: true }],
          needsSetup: false,
          webUrl: "https://example.test/integrations/setup",
        };
      else if (path === "connections/setup")
        result = {
          methods:
            input.provider === "sample"
              ? [
                  {
                    type: "api_key",
                    fields: [
                      {
                        key: "apiKey",
                        label: "API key",
                        inputType: "password",
                        required: true,
                        secret: true,
                      },
                    ],
                  },
                ]
              : [
                  {
                    type: "custom_credential",
                    fields: [
                      {
                        key: "workspace",
                        label: "Workspace",
                        inputType: "text",
                        required: true,
                        secret: false,
                      },
                      {
                        key: "secret",
                        label: "Secret",
                        inputType: "textarea",
                        required: true,
                        secret: true,
                      },
                    ],
                  },
                ],
          oauthConfigured: false,
        };
      else if (path === "capabilities/catalogSearch") result = { enabled: false, results: [] };
      else if (path === "connections/list") result = accounts;
      else if (path === "connections/begin") {
        started.push(input);
        const row: Connection = {
          id: `connection-${accounts.length + 1}`,
          connectorId: input.connectorId,
          provider: input.provider,
          displayName: input.displayName,
          status: "connected",
          scope: "team",
          canManage: true,
          capabilities: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        accounts.push(row);
        result = { connectionId: row.id, authorizationUrl: null };
      } else if (path === "connections/complete")
        result = accounts.find((row) => row.id === input.connectionId);
      else if (path === "bots/list")
        result = [{ id: "setup-assistant", name: "Support assistant" }];
      else if (path === "connections/setupIncoming") {
        incomingRequests.push(input);
        result = { botId: "setup-assistant", name: "Support assistant" };
      } else if (path === "connections/revoke") {
        accounts.find((row) => row.id === input.connectionId)!.status = "revoked";
        result = { ok: true };
      } else if (path === "connections/tools")
        result = [{ name: `${input.provider}.send`, description: "Send text" }];
      else if (path !== "capabilities/list") throw new Error(`Unexpected RPC: ${path}`);
      await route.fulfill({ json: { json: result } });
    });
    await page.goto("/e2e/fixtures/open-connector.html");
    await expect(page.getByRole("dialog", { name: "Integrations", exact: true })).not.toContainText(
      "Sample app",
    );
    await page.getByRole("button", { name: "Browse apps", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Future app, Connect", exact: true }),
    ).toBeVisible();
    const sampleCard = page.getByRole("button", {
      name: "Sample app, Connect",
      exact: true,
    });
    await expect
      .poll(() => sampleCard.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    const futureCard = page.getByRole("button", { name: "Future app, Connect", exact: true });
    await expect(futureCard.locator("img")).toHaveCount(0);
    await expect(futureCard.getByText("F", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `openconnector-catalog-${viewport.width}`);
    await page.getByRole("button", { name: "Sample app, Connect", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const token = page.getByLabel("API key", { exact: true });
    await expect(token).toHaveAttribute("type", "password");
    await token.fill("fake-account-token");
    await captureScreenshot(page, testInfo, `openconnector-api-key-auth-${viewport.width}`);
    await page.getByRole("button", { name: "Connect account", exact: true }).click();
    await expect(page.getByLabel("Account label")).toHaveValue("Sample app");
    const webhookUrl = page.getByRole("textbox", { name: "Webhook URL", exact: true });
    await expect(webhookUrl).toHaveCount(0);
    await page.getByRole("button", { name: "Set up incoming messages", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Assistant", exact: true })).toHaveValue(
      "setup-assistant",
    );
    await captureScreenshot(page, testInfo, `openconnector-incoming-setup-${viewport.width}`);
    await page.getByRole("button", { name: "Continue in chat", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Support assistant", exact: true }),
    ).toBeVisible();
    expect(incomingRequests).toEqual([
      {
        connectionId: accounts[0]!.id,
        botId: "setup-assistant",
        clientNonce: expect.any(String),
      },
    ]);
    // Emulate approved customer_connect completion in the assistant chat.
    accounts[0]!.webhookUrl =
      "https://public-api.example.test/api/customer-events/customer-channel-1";
    await page.getByRole("button", { name: "Back to integrations", exact: true }).click();
    await page.getByRole("button", { name: "Browse apps", exact: true }).click();
    await page.getByRole("button", { name: "Sample app, Manage", exact: true }).click();
    await expect(webhookUrl).toHaveValue(accounts[0]!.webhookUrl!);
    await expect(webhookUrl).toHaveAttribute("readonly", "");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(accounts[0]!.webhookUrl);
    await captureScreenshot(page, testInfo, `openconnector-webhook-${viewport.width}`);
    expect(started[0]).toMatchObject({
      connectorId: "open-connector",
      provider: "sample",
      auth: { type: "api_key", values: { apiKey: "fake-account-token" } },
    });
    await captureScreenshot(page, testInfo, `openconnector-connected-${viewport.width}`);
    await page.getByRole("button", { name: "Back to apps", exact: true }).click();
    await page.getByLabel("Search OpenConnector apps").fill("future");
    await page.getByRole("button", { name: "Future app, Connect", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByLabel("Workspace", { exact: true }).fill("example");
    await expect(page.getByLabel("Secret", { exact: true })).toHaveAttribute("type", "password");
    await page.getByLabel("Secret", { exact: true }).fill("fake-custom-secret");
    await page.getByRole("button", { name: "Connect account", exact: true }).click();
    await expect(page.getByLabel("Account label")).toHaveValue("Future app");
    await expect(webhookUrl).toHaveCount(0);
    expect(started[1]).toMatchObject({
      provider: "future-app",
      auth: {
        type: "custom_credential",
        values: { workspace: "example", secret: "fake-custom-secret" },
      },
    });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect account", exact: true }).click();
    await expect(page.getByLabel("Account label")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("server owner configures OpenConnector without exposing server credentials to account forms", async ({
  page,
}, testInfo) => {
  const saved: unknown[] = [];
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: true,
          webUrl: "https://example.test/integrations/setup",
          providers: [{ id: "open-connector", configured: saved.length > 0 }],
        },
      },
    }),
  );
  await page.route("**/rpc/integrationSetup/save", async (route) => {
    saved.push(route.request().postDataJSON().json);
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await page.goto("/e2e/fixtures/open-connector.html?setup");
  await page.getByRole("button", { name: "OpenConnector", exact: true }).click();
  await page.getByLabel("Server URL", { exact: true }).fill("https://connector.example.test");
  await page.getByLabel("Admin token", { exact: true }).fill("fake-admin-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  expect(saved).toEqual([
    {
      provider: "open-connector",
      endpoint: "https://connector.example.test",
      apiKey: "fake-admin-token",
    },
  ]);
  await expect(page.getByLabel("Admin token", { exact: true })).toHaveValue("");
  await captureScreenshot(page, testInfo, "open-connector-configured");
});

test("a teammate can inspect a shared account without management controls", async ({ page }) => {
  const mutations: string[] = [];
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/rpc/", "");
    const input = route.request().postDataJSON()?.json;
    let result: unknown = [];
    if (path === "connections/catalog")
      result = input?.excludeConnectorIds
        ? []
        : [
            {
              connectorId: "open-connector",
              slug: "sample",
              name: "Sample app",
              logo: null,
              connected: false,
              noAuth: false,
              scope: "team",
            },
          ];
    else if (path === "connections/setup")
      result = { methods: [{ type: "api_key", fields: [] }], oauthConfigured: false };
    else if (path === "integrationSetup/get")
      result = {
        canConfigure: false,
        needsSetup: false,
        providers: [],
        webUrl: "https://example.test",
      };
    else if (path === "connections/list")
      result = [
        {
          id: "shared",
          connectorId: "open-connector",
          provider: "sample",
          displayName: "Support",
          status: "connected",
          canManage: false,
          capabilities: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    else if (path === "capabilities/catalogSearch") result = { enabled: false, results: [] };
    else if (path === "connections/tools")
      result = [{ name: "sample.send", description: "Send text" }];
    else if (path !== "capabilities/list") mutations.push(path);
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/e2e/fixtures/open-connector.html");
  await page.getByRole("button", { name: "Browse apps", exact: true }).click();
  await page.getByRole("button", { name: "Sample app, Manage", exact: true }).click();
  const label = page.getByLabel("Account label");
  await expect(label).toHaveValue("Support");
  await expect(label).not.toBeEditable();
  await label.focus();
  await label.blur();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toHaveCount(0);
  await page.getByText("Available actions", { exact: true }).click();
  await expect(page.getByText("Send text", { exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
});

test("large catalogs stay bounded and restore focus after browsing more results", async ({
  page,
}) => {
  const catalog = Array.from({ length: 1500 }, (_, index) => ({
    connectorId: "open-connector",
    slug: `app-${index}`,
    name: `App ${index}`,
    logo: null,
    connected: false,
    noAuth: true,
    categories: ["Utilities"],
    availability: "available",
  }));
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/rpc/", "");
    const input = route.request().postDataJSON()?.json;
    const result =
      path === "connections/catalog"
        ? input?.excludeConnectorIds
          ? []
          : catalog
        : path === "integrationSetup/get"
          ? {
              canConfigure: false,
              needsSetup: false,
              providers: [{ id: "open-connector", configured: true }],
              webUrl: "https://example.test",
            }
          : path === "connections/setup"
            ? { methods: [{ type: "no_auth", fields: [] }], oauthConfigured: false }
            : path === "capabilities/catalogSearch"
              ? { enabled: false, results: [] }
              : [];
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/e2e/fixtures/open-connector.html");
  await page.getByRole("button", { name: "Browse apps", exact: true }).click();
  const entries = page.getByRole("button", { name: /^App \d+, Connect$/ });
  await expect(entries).toHaveCount(60);
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(entries).toHaveCount(120);
  await page.getByRole("button", { name: "App 119, Connect", exact: true }).click();
  await page.getByRole("button", { name: "Back to apps", exact: true }).click();
  await expect(page.getByRole("button", { name: "App 119, Connect", exact: true })).toBeFocused();
  await page.getByLabel("Search OpenConnector apps").fill("App 1499");
  await expect(entries).toHaveCount(1);
  await expect(page.getByRole("button", { name: "App 1499, Connect", exact: true })).toBeVisible();
});

test("OAuth reconnect survives reload and cancellation preserves the existing account", async ({
  page,
}, testInfo) => {
  let status = "connected";
  let cancelled = false;
  const mutations: string[] = [];
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/rpc/", "");
    const input = route.request().postDataJSON()?.json;
    let result: unknown = [];
    if (path === "connections/catalog")
      result = input?.excludeConnectorIds
        ? []
        : [
            {
              connectorId: "open-connector",
              slug: "oauth-app",
              name: "OAuth app",
              logo: null,
              connected: false,
              noAuth: false,
              availability: "available",
            },
          ];
    else if (path === "integrationSetup/get")
      result = {
        canConfigure: false,
        needsSetup: false,
        providers: [],
        webUrl: "https://example.test",
      };
    else if (path === "connections/setup")
      result = { methods: [{ type: "oauth2", fields: [] }], oauthConfigured: true };
    else if (path === "connections/list")
      result = [
        {
          id: "existing",
          connectorId: "open-connector",
          provider: "oauth-app",
          displayName: "Support",
          status,
          authorizationUrl: status === "pending" ? "https://example.test/authorize" : undefined,
          reconnectRequired: status === "connected",
          canManage: true,
          capabilities: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    else if (path === "connections/reconnect") {
      status = "pending";
      result = { authorizationUrl: "https://example.test/authorize" };
    } else if (path === "connections/complete") result = { id: "existing", status };
    else if (path === "connections/cancel") {
      status = "connected";
      cancelled = true;
      result = { ok: true };
    } else if (path === "capabilities/catalogSearch") result = { enabled: false, results: [] };
    else if (path !== "capabilities/list") mutations.push(path);
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/e2e/fixtures/open-connector.html");
  await page.getByRole("button", { name: "Browse apps", exact: true }).click();
  await page.getByRole("button", { name: "OAuth app, Manage", exact: true }).click();
  await expect(page.getByText("Reconnect required", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Waiting for authorization", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to apps", exact: true }).click();
  await expect(page.getByText("Authorization failed.", { exact: true })).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Browse apps", exact: true }).click();
  await page.getByRole("button", { name: "OAuth app, Manage", exact: true }).click();
  await expect(page.getByText("Waiting for authorization", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open authorization", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "openconnector-oauth-pending");
  await page.getByRole("button", { name: "Cancel authorization", exact: true }).click();
  await expect(page.getByLabel("Account label")).toHaveValue("Support");
  await expect(page.getByText("Waiting for authorization", { exact: true })).toBeHidden();
  expect(cancelled).toBe(true);
  expect(mutations).toEqual([]);
});
