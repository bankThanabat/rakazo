import { isIP } from "node:net";
import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

const ICON_CATALOG = "https://oomol.com/en/apps/catalog.json";
const Entry = z.object({ service: z.string(), iconUrl: z.string() });

function imageUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Optional public artwork, separate from authenticated OpenConnector requests. */
export class OpenConnectorIcons {
  private icons = new Map<string, string>();
  private until = 0;
  private loading?: Promise<void>;
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch) {}

  async refresh() {
    if (Date.now() < this.until) return;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
  }

  private async load() {
    try {
      const signal = AbortSignal.timeout(3000);
      const response = await this.fetcher(ICON_CATALOG, {
        signal,
        redirect: "error",
        credentials: "omit",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("Icon catalog unavailable");
      const payload = z
        .object({ items: z.array(z.unknown()) })
        .parse(
          JSON.parse(
            new TextDecoder().decode(await readBodyCapped(response, 2 * 1024 * 1024, signal)),
          ),
        );
      const icons = new Map<string, string>();
      for (const item of payload.items) {
        const entry = Entry.safeParse(item);
        const url = entry.success ? imageUrl(entry.data.iconUrl) : null;
        if (entry.success && url) icons.set(entry.data.service, url);
      }
      this.icons = icons;
      this.until = Date.now() + 60 * 60 * 1000;
    } catch {
      // Keep any last-known artwork and back off. Icons never gate connection setup.
      this.until = Date.now() + 5 * 60 * 1000;
    }
  }

  resolve(provider: { service: string; iconUrl?: string | null; homepageUrl?: string }) {
    const direct = imageUrl(provider.iconUrl ?? undefined) ?? this.icons.get(provider.service);
    if (direct) return direct;
    try {
      const homepage = new URL(provider.homepageUrl ?? "");
      const host = homepage.hostname;
      if (
        !["http:", "https:"].includes(homepage.protocol) ||
        homepage.username ||
        homepage.password ||
        !host.includes(".") ||
        isIP(host) ||
        host.endsWith(".local") ||
        host.endsWith(".localhost")
      )
        return null;
      return `https://a.favicon.im/${encodeURIComponent(host)}?larger=true&throw-error-on-404=true`;
    } catch {
      return null;
    }
  }
}
