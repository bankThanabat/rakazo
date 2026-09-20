import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { LangflowCustomerRuntime } from "../packages/adapters/src/customer-runtime.js";

const [mode, container, statePath, fixture] = process.argv.slice(2);
assert(mode === "seed" || mode === "check");
assert(container && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container));
assert(statePath);
assert(fixture && /^deskazo-langflow-recovery-[a-f0-9]{32}$/.test(fixture));
const [details] = JSON.parse(
  execFileSync("docker", ["inspect", container], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1_000_000,
  }),
);
assert.equal(
  details.Config.Labels?.["deskazo.langflow-recovery"],
  fixture,
  "Fixture ownership required",
);
assert.equal(details.HostConfig.NetworkMode, "none", "Fixture network isolation required");
assert.equal(
  Object.keys(details.HostConfig.PortBindings ?? {}).length,
  0,
  "Fixture must not publish ports",
);
const baseUrl = "http://127.0.0.1:7860/api/v1";
const instructions = "Reply with the synthetic recovery result. Never contact a real provider.";
const proxy = `
import gzip, json, sys, urllib.request, urllib.error
def failure(kind, value, traceback):
    print(kind.__name__, file=sys.stderr)
sys.excepthook = failure
value = json.load(sys.stdin)
assert value['url'].startswith('http://127.0.0.1:7860/api/v1/')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None
request = urllib.request.Request(value['url'], data=value['body'].encode() if value['body'] is not None else None, headers=value['headers'], method=value['method'])
try:
    response = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=90)
except urllib.error.HTTPError as error:
    response = error
encoding = response.headers.get('Content-Encoding', '').lower()
assert encoding in ('', 'identity', 'gzip')
body = gzip.GzipFile(fileobj=response) if encoding == 'gzip' else response
print(json.dumps({'status': response.status, 'body': body.read(16000001).decode('utf-8', errors='replace')}))
`;

const request: typeof fetch = async (input, init) => {
  const url = String(input);
  assert(url.startsWith(`${baseUrl}/`));
  const route = new URL(url).pathname.split("/")[3];
  const operation = `${init?.method ?? "GET"} ${route}`;
  console.log(`Langflow request: ${operation}`);
  const value = await new Promise<string>((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "python", "-c", proxy], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: init?.signal ?? undefined,
      timeout: 100_000,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let diagnostic = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32_000_000) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostic.length < 256) diagnostic += chunk.toString().slice(0, 256);
    });
    child.stdin.on("error", () => {});
    child.on("error", () =>
      reject(new Error(`Disposable Langflow request failed: ${operation}, process error`)),
    );
    child.on("close", (code, signal) => {
      const kind = /^[A-Za-z]+\n?$/.test(diagnostic) ? diagnostic.trim() : "unavailable";
      if (code !== 0 || size > 32_000_000)
        reject(
          new Error(
            `Disposable Langflow request failed: ${operation}, exit=${code}, signal=${signal}, bytes=${size}, exception=${kind}`,
          ),
        );
      else resolve(Buffer.concat(chunks).toString());
    });
    child.stdin.end(
      JSON.stringify({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body === undefined ? null : String(init.body),
      }),
    );
  });
  const response = JSON.parse(value) as { status: number; body: string };
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};

const api = async (route: string, headers: Record<string, string>, body?: unknown) => {
  const response = await request(`${baseUrl}/${route}`, {
    headers: { "content-type": "application/json", ...headers },
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(100_000),
  });
  assert(response.ok, `Disposable Langflow API failed (${response.status})`);
  return response.json();
};

type State = {
  fixture: string;
  apiKey: string;
  identity: string;
  publicationId: string;
  flowId: string;
  flow: unknown;
};
let state: State;
if (mode === "seed") {
  const login = (await api("auto_login", {})) as { access_token: string };
  const key = (await api(
    "api_key/",
    { authorization: `Bearer ${login.access_token}` },
    {
      name: "Synthetic recovery key",
    },
  )) as { api_key: string };
  const runtime = new LangflowCustomerRuntime({ baseUrl, apiKey: key.api_key }, request);
  const publicationId = randomUUID();
  state = {
    fixture,
    apiKey: key.api_key,
    identity: await runtime.identity(AbortSignal.timeout(100_000)),
    publicationId,
    flowId: await runtime.publish({
      publicationId,
      staffId: "synthetic-recovery-staff",
      instructions,
      signal: AbortSignal.timeout(100_000),
    }),
    flow: null,
  };
} else {
  state = JSON.parse(await readFile(statePath, "utf8")) as State;
  assert.equal(state.fixture, fixture);
  const restoredFlow = await api(`flows/${state.publicationId}`, { "x-api-key": state.apiKey });
  assert.deepEqual(restoredFlow, state.flow);
}
const runtime = new LangflowCustomerRuntime({ baseUrl, apiKey: state.apiKey }, request);
assert.equal(await runtime.identity(AbortSignal.timeout(100_000)), state.identity);
const reply = await runtime.reply({
  flowId: state.flowId,
  conversationId: "synthetic-recovery-conversation",
  instructions,
  messages: [{ role: "user", content: "Verify the restored customer runtime." }],
  executionContext: { endpoint: "http://127.0.0.1:8787/tools", token: "synthetic-execution-token" },
  model: {
    baseUrl: "http://127.0.0.1:8787/v1",
    apiKey: "synthetic-model-key",
    id: "recovery-model",
  },
  signal: AbortSignal.timeout(100_000),
});
assert.equal(reply, "Synthetic recovered customer reply.");
if (mode === "seed") {
  state.flow = await api(`flows/${state.publicationId}`, { "x-api-key": state.apiKey });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
console.log(
  mode === "seed"
    ? "Real Langflow customer flow published and executed with synthetic loopback services."
    : "Restored API key, account identity, saved flow and customer execution verified.",
);
