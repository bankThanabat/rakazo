import type { ProxyOptions } from "vite";

export function apiProxyOptions(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyRes", (incoming, _request, response) => {
        // A broken upstream SSE response must reach the client as a disconnect.
        incoming.once("error", () => response.destroy());
      });
    },
  };
}
