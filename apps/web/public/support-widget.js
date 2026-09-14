(() => {
  const script = document.currentScript;
  const channel = script?.dataset.channel;
  if (!channel || !script.src) return;
  const base = new URL(script.src).origin;
  const frame = document.createElement("iframe");
  frame.src = `${base}/support/${encodeURIComponent(channel)}?origin=${encodeURIComponent(location.origin)}`;
  frame.title = "Customer support";
  frame.referrerPolicy = "origin";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  Object.assign(frame.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    width: "72px",
    height: "72px",
    border: "0",
    zIndex: "2147483000",
    colorScheme: "normal",
  });
  document.body.append(frame);
  const key = `rakazo-support:${base}:${channel}`;
  let pending = false;
  let token;
  try {
    token = sessionStorage.getItem(key);
  } catch {
    /* Storage is optional. */
  }
  window.addEventListener("message", async (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== base ||
      event.data?.channel !== channel
    )
      return;
    if (event.data.type === "support-size") {
      frame.style.width = event.data.open ? "min(400px, calc(100vw - 32px))" : "72px";
      frame.style.height = event.data.open ? "min(600px, calc(100dvh - 32px))" : "72px";
    }
    if (event.data.type === "support-reset") {
      token = undefined;
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* Storage is optional. */
      }
    }
    if (!["support-ready", "support-reset"].includes(event.data.type) || pending) return;
    pending = true;
    try {
      if (!token) {
        const response = await fetch(
          `${base}/api/customer-web/${encodeURIComponent(channel)}/session`,
          {
            method: "POST",
            credentials: "omit",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        );
        if (!response.ok) throw new Error("Support unavailable");
        token = (await response.json()).token;
        try {
          sessionStorage.setItem(key, token);
        } catch {
          /* Storage is optional. */
        }
      }
      frame.contentWindow.postMessage({ type: "support-session", channel, token }, base);
    } catch {
      frame.contentWindow.postMessage({ type: "support-error", channel }, base);
    } finally {
      pending = false;
    }
  });
})();
