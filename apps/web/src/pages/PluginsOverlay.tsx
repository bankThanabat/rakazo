import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import {
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  EMPTY_PLUGIN_CATALOG_MESSAGE,
  searchConnectionCatalog,
} from "@rakazo/core";
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
} from "@rakazo/ui-web";
import { ChevronRight, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AdvancedSources } from "../components/integrations/AdvancedSources";
import { AppDetail } from "../components/integrations/AppDetail";
import { AppIcon } from "../components/integrations/AppIcon";
import { rpc } from "../lib/rpc";

type Selection = { connectorId: string; slug: string } | "advanced" | null;

function itemKey(item: Pick<ConnectionCatalogItem, "connectorId" | "slug">) {
  return `${item.connectorId}:${item.slug}`;
}

function accountsFor(connections: Connection[], item: ConnectionCatalogItem) {
  return connections.filter(
    (row) =>
      row.connectorId === item.connectorId &&
      row.provider === item.slug &&
      row.status !== "revoked",
  );
}

/** Featured apps first, then the rest of each catalog in server order. */
function orderCatalog(others: ConnectionCatalogItem[], openConnector: ConnectionCatalogItem[]) {
  const featured = buildFeaturedConnectorTiles(others).flatMap((tile) =>
    tile.item ? [tile.item] : [],
  );
  const seen = new Set(featured.map(itemKey));
  return [...featured, ...others.filter((item) => !seen.has(itemKey(item))), ...openConnector];
}

export function PluginsOverlay({
  onClose,
  onOpenMcp,
  onNavigate,
  activeBotId,
}: {
  onClose: () => void;
  onOpenMcp?: () => void;
  onNavigate?: (path: string) => void;
  activeBotId?: string;
}) {
  const { t } = useLingui();
  const headingId = useId();
  const [catalog, setCatalog] = useState<ConnectionCatalogItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [canConfigure, setCanConfigure] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [selection, setSelection] = useState<Selection>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);

  async function refresh() {
    const [others, openConnector, rows, setup] = await Promise.all([
      rpc.connections.catalog({ excludeConnectorIds: ["open-connector"] }),
      rpc.connections.catalog({ connectorId: "open-connector" }),
      rpc.connections.list(),
      rpc.integrationSetup.get().catch(() => null),
    ]);
    setCatalog(orderCatalog(others, openConnector));
    setConnections(rows);
    setCanConfigure(setup?.canConfigure ?? false);
  }

  function load() {
    setLoading(true);
    setError(null);
    void refresh()
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t`Could not load integrations`),
      )
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  useEffect(() => {
    if (selection === null && returnFocus.current) {
      rowRefs.current.get(returnFocus.current)?.focus();
      returnFocus.current = null;
    }
  }, [selection]);

  const selectedItem = useMemo(
    () =>
      selection && selection !== "advanced"
        ? (catalog.find((item) => itemKey(item) === itemKey(selection)) ?? null)
        : null,
    [catalog, selection],
  );
  const visible = searchConnectionCatalog(catalog, query);
  const connected = visible.filter((item) => accountsFor(connections, item).length > 0);
  const available = visible.filter((item) => accountsFor(connections, item).length === 0);
  const rendered = available.slice(0, visibleCount);

  function back() {
    returnFocus.current = selection && selection !== "advanced" ? itemKey(selection) : null;
    setSelection(null);
  }

  function renderRow(item: ConnectionCatalogItem) {
    const key = itemKey(item);
    const accounts = accountsFor(connections, item);
    const active = selectedItem ? itemKey(selectedItem) === key : false;
    const attention = accounts.some((row) => row.reconnectRequired || row.status === "error");
    const connectedCount = accounts.filter((row) => row.status === "connected").length;
    return (
      <li key={key}>
        <button
          type="button"
          ref={(node) => {
            if (node) rowRefs.current.set(key, node);
            else rowRefs.current.delete(key);
          }}
          data-testid={`connection-tile-${item.slug.toLowerCase()}`}
          aria-label={`${item.name}, ${accounts.length ? t`Manage` : t`Connect`}`}
          aria-current={active ? "true" : undefined}
          onClick={() => setSelection({ connectorId: item.connectorId, slug: item.slug })}
          className={cn(
            "group flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
            active && "bg-muted",
          )}
        >
          <AppIcon item={item} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{item.name}</span>
            {attention ? (
              <span className="block truncate text-xs text-warning">
                <Trans>Needs attention</Trans>
              </span>
            ) : connectedCount > 1 ? (
              <span className="block truncate text-xs text-muted-foreground">
                <Plural value={connectedCount} one="# account" other="# accounts" />
              </span>
            ) : accounts.length ? (
              <span className="block truncate text-xs text-muted-foreground">
                {connectedCount ? <Trans>Connected</Trans> : <Trans>Pending</Trans>}
              </span>
            ) : item.availability === "unavailable" ? (
              <span className="block truncate text-xs text-muted-foreground">
                <Trans>Unavailable</Trans>
              </span>
            ) : null}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground sm:hidden"
          />
        </button>
      </li>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-center justify-between border-b border-border px-5 py-4 sm:px-6">
          <DialogTitle className="text-lg text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "min-h-0 w-full flex-col sm:flex sm:w-[320px] sm:shrink-0 sm:border-e sm:border-border",
              selection ? "hidden" : "flex",
            )}
          >
            <div className="relative px-3 pt-3 pb-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-6 top-1/2 size-4 -translate-y-[calc(50%-4px)] text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                }}
                aria-label={t`Search apps`}
                placeholder={t`Search apps`}
                className="h-9 rounded-lg ps-9"
              />
            </div>

            <div
              id="integration-list"
              aria-busy={loading}
              className="rk-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2"
            >
              {loading ? (
                <div className="space-y-1 p-1">
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <Skeleton key={index} className="h-11" />
                  ))}
                </div>
              ) : null}
              {error ? (
                <div className="space-y-2 p-3">
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                  <Button variant="outline" size="sm" onClick={load}>
                    <Trans>Retry</Trans>
                  </Button>
                </div>
              ) : null}
              {!loading && !error && catalog.length === 0 ? (
                <div className="space-y-3 p-3 text-sm text-muted-foreground">
                  <p>{EMPTY_PLUGIN_CATALOG_MESSAGE}</p>
                  {canConfigure && onNavigate ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onNavigate("/integrations/setup")}
                    >
                      <Trans>Set up OpenConnector</Trans>
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {!loading && catalog.length > 0 && visible.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground" role="status">
                  <Trans>No apps match your search.</Trans>
                </p>
              ) : null}
              {connected.length ? (
                <section aria-labelledby={`${headingId}-connected`}>
                  <h3
                    id={`${headingId}-connected`}
                    className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground"
                  >
                    <Trans>Connected</Trans>
                  </h3>
                  <ul>{connected.map(renderRow)}</ul>
                </section>
              ) : null}
              {rendered.length ? (
                <section aria-labelledby={connected.length ? `${headingId}-all` : undefined}>
                  {connected.length ? (
                    <h3
                      id={`${headingId}-all`}
                      className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground"
                    >
                      <Trans>All apps</Trans>
                    </h3>
                  ) : null}
                  <ul className={connected.length ? undefined : "pt-1"}>
                    {rendered.map(renderRow)}
                  </ul>
                  {rendered.length < available.length ? (
                    <div className="p-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-muted-foreground"
                        onClick={() =>
                          setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)
                        }
                      >
                        <Trans>Show more</Trans>
                      </Button>
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>

            <button
              type="button"
              aria-current={selection === "advanced" ? "true" : undefined}
              onClick={() => setSelection("advanced")}
              className={cn(
                "flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                selection === "advanced" && "bg-muted text-foreground",
              )}
            >
              <Trans>Advanced</Trans>
              <ChevronRight aria-hidden="true" className="size-4" />
            </button>
          </div>

          <div
            className={cn(
              "rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto",
              selection ? "block" : "hidden sm:block",
            )}
          >
            {selection === "advanced" ? (
              <AdvancedSources
                canConfigure={canConfigure}
                onOpenMcp={onOpenMcp}
                onNavigate={onNavigate}
                onBack={back}
              />
            ) : selectedItem ? (
              <AppDetail
                key={itemKey(selectedItem)}
                item={selectedItem}
                accounts={accountsFor(connections, selectedItem)}
                canConfigure={canConfigure}
                activeBotId={activeBotId}
                onRefresh={refresh}
                onBack={back}
              />
            ) : (
              <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
                <Trans>Select an app to connect it.</Trans>
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
