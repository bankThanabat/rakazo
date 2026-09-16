// @vitest-environment jsdom

import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  connections: {
    catalog: vi.fn(),
    list: vi.fn(),
    setup: vi.fn(),
    tools: vi.fn(),
    setupIncoming: vi.fn(),
  },
  integrationSetup: { get: vi.fn() },
  capabilities: { list: vi.fn(), catalogSearch: vi.fn() },
  bots: { list: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({ rpc: api }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", () => {
  type Props = { children?: ReactNode };
  type ButtonProps = ComponentProps<"button"> & Record<"variant" | "size" | "render", unknown>;
  const strip = ({ variant: _v, size: _s, render: _r, ...rest }: Partial<ButtonProps>) => rest;
  const Box = ({ children }: Props) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: Props & { open: boolean }) => (open ? children : null),
    AlertDialogContent: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: Box,
    AlertDialogDescription: Box,
    AlertDialogFooter: Box,
    AlertDialogCancel: (props: ButtonProps) => <button {...strip(props)} />,
    AlertDialogAction: (props: ButtonProps) => <button {...strip(props)} />,
    AppIcon: ({ item }: { item: { name: string } }) => <span>{item.name[0]}</span>,
    Checkbox: (props: ComponentProps<"input">) => <input type="checkbox" {...props} />,
    Button: (props: ButtonProps) => <button {...strip(props)} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Skeleton: () => <div data-skeleton="" />,
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: ComponentProps<"button"> & {
      checked?: boolean;
      onCheckedChange?: (v: boolean) => void;
    }) => (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
        {...props}
      />
    ),
    Dialog: Box,
    DialogContent: ({ children }: Props) => <div role="dialog">{children}</div>,
    DialogHeader: Box,
    DialogTitle: ({ children }: Props) => <h1>{children}</h1>,
    DialogClose: (props: ButtonProps) => <button {...strip(props)} />,
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  };
});

import { PluginsOverlay } from "./PluginsOverlay";

function app(overrides: Partial<ConnectionCatalogItem> & Pick<ConnectionCatalogItem, "slug">) {
  return {
    connectorId: "open-connector",
    name: overrides.slug,
    logo: null,
    connected: false,
    noAuth: false,
    ...overrides,
  } satisfies ConnectionCatalogItem;
}

const gmail = app({ connectorId: "composio", slug: "gmail", name: "Gmail" });
const line = app({ slug: "line", name: "LINE", description: "Chat with customers" });
const future = app({ slug: "future-app", name: "Future app" });
const lineAccount: Connection = {
  id: "c1",
  connectorId: "open-connector",
  provider: "line",
  displayName: "LINE",
  status: "connected",
  canManage: true,
  capabilities: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.connections.catalog.mockImplementation(async (input: { connectorId?: string }) =>
    input.connectorId === "open-connector" ? [line, future] : [gmail],
  );
  api.connections.list.mockResolvedValue([lineAccount]);
  api.connections.setup.mockResolvedValue({
    methods: [{ type: "api_key", fields: [] }],
    oauthConfigured: false,
  });
  api.integrationSetup.get.mockResolvedValue({ canConfigure: false, providers: [] });
  api.capabilities.list.mockResolvedValue([]);
  api.capabilities.catalogSearch.mockResolvedValue({ enabled: false, results: [] });
  api.bots.list.mockResolvedValue([{ id: "bot-1", name: "Chief" }]);
  api.connections.setupIncoming.mockResolvedValue({ id: "ch", webhookUrl: "https://x.test/w" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<PluginsOverlay onClose={() => undefined} />);
  });
  await act(async () => {});
}

function rows() {
  return [...container.querySelectorAll<HTMLButtonElement>("[data-testid^=connection-tile-]")].map(
    (row) => row.dataset.testid,
  );
}

async function click(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => element.click());
  await act(async () => {});
}

async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Search apps']")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("lists connected apps first and searches every catalog at once", async () => {
  await render();
  expect(rows()).toEqual([
    "connection-tile-line",
    "connection-tile-gmail",
    "connection-tile-future-app",
  ]);
  expect(container.textContent).toContain("Connected");
  expect(container.querySelector("[data-testid=connection-detail]")).toBeNull();
  expect(container.querySelector("[data-testid=integrations-advanced]")).toBeNull();
  expect(api.capabilities.list).not.toHaveBeenCalled();

  await search("LiNe");
  expect(rows()).toEqual(["connection-tile-line"]);
  await search("zzz");
  expect(container.querySelector("[role=status]")?.textContent).toBe("No apps match your search.");
});

it("opens a detail pane and loads setup only for OpenConnector apps", async () => {
  await render();
  await click("[data-testid=connection-tile-gmail]");
  const detail = () => container.querySelector("[data-testid=connection-detail]")!;
  expect(detail().textContent).toContain("Gmail");
  expect([...detail().querySelectorAll("button")].map((b) => b.textContent)).toContain("Connect");
  expect(api.connections.setup).not.toHaveBeenCalled();

  await click("[data-testid=connection-tile-line]");
  expect(api.connections.setup).toHaveBeenCalledWith({
    connectorId: "open-connector",
    provider: "line",
  });
  const labels = [...detail().querySelectorAll("button")].map((b) => b.textContent);
  expect(labels).toEqual(expect.arrayContaining(["Disconnect", "Add account"]));
  // API-key accounts cannot reconnect without a new secret, so no Reconnect shortcut is offered.
  expect(labels).not.toContain("Reconnect");
  expect(detail().querySelector<HTMLInputElement>("input[aria-label='Account label']")?.value).toBe(
    "LINE",
  );
});

it("enables incoming messages from the account row once the secret is entered", async () => {
  api.connections.list.mockResolvedValue([
    { ...lineAccount, incomingSecrets: [{ key: "channelSecret", label: "Channel secret" }] },
  ]);
  await render();
  await click("[data-testid=connection-tile-line]");
  expect(container.querySelector("[role=switch]")).toBeNull();
  expect(api.connections.setupIncoming).not.toHaveBeenCalled();
  const secret = container.querySelector<HTMLInputElement>("input[aria-label='Channel secret']")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(secret, "fixture-secret");
    secret.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => secret.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await act(async () => {});
  expect(api.connections.setupIncoming).toHaveBeenCalledWith({
    connectionId: "c1",
    botId: "bot-1",
    secrets: { channelSecret: "fixture-secret" },
  });
});

it("keeps tool sources and MCP paths behind the Advanced row", async () => {
  await render();
  const advanced = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Advanced",
  );
  await act(async () => advanced!.click());
  await act(async () => {});
  const pane = container.querySelector("[data-testid=integrations-advanced]")!;
  expect(api.capabilities.list).toHaveBeenCalledTimes(1);
  expect(
    [...pane.querySelectorAll("[data-testid=integrations-advanced-add] button")].map(
      (b) => b.textContent,
    ),
  ).toEqual(["Add MCP server", "Add OpenAPI", "Add GraphQL", "Add Executor", "Add Treg"]);
  expect(container.querySelector("[data-testid=connection-detail]")).toBeNull();
});
