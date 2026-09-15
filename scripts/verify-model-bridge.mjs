// Live smoke check: sends one synthetic completion through an existing bridge grant.
const [baseUrl, expectedModel] = process.argv.slice(2);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone live check, never a cached Turbo task.
const apiKey = process.env.MODEL_BRIDGE_API_KEY;
if (!baseUrl || !expectedModel || !apiKey) {
  throw new Error(
    "Usage: MODEL_BRIDGE_API_KEY=… node scripts/verify-model-bridge.mjs <base-url> <expected-model>",
  );
}
const base = new URL(`${baseUrl.replace(/\/$/, "")}/`);
if (
  base.protocol !== "https:" &&
  !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
) {
  throw new Error("Use HTTPS or a loopback endpoint.");
}
async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Bridge ${path} failed: HTTP ${response.status}`);
  return response.json();
}
const catalog = await request("models");
if (catalog.data?.length !== 1) throw new Error("Expected one granted model.");
const result = await request("chat/completions", {
  model: catalog.data[0].id,
  messages: [{ role: "user", content: "Reply with OK." }],
  max_tokens: 32,
  stream: false,
});
if (result.model !== expectedModel || !result.choices?.[0]?.message?.content?.trim()) {
  throw new Error("Completion did not use the expected model or returned no text.");
}
console.log(`Bridge verified: ${catalog.data[0].id} → ${result.model}`);
