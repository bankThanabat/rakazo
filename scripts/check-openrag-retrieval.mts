import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { LangflowCustomerRuntime } from "../packages/adapters/src/customer-runtime.js";

const [container, statePath, fixture] = process.argv.slice(2);
assert(container && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container));
assert(statePath && /^deskazo-openrag-recovery-[a-f0-9]{32}$/.test(fixture ?? ""));
const inspect = (args: string[]) =>
  JSON.parse(execFileSync("docker", args, { encoding: "utf8", timeout: 10_000 }))[0];
const details = inspect(["inspect", container]);
assert.equal(details.Config.Labels?.["deskazo.openrag-recovery"], fixture);
assert.equal(Object.keys(details.HostConfig.PortBindings ?? {}).length, 0);
const network = `${fixture}-internal`;
assert.deepEqual(Object.keys(details.NetworkSettings.Networks), [network]);
const networkInfo = inspect(["network", "inspect", network]);
assert.equal(networkInfo.Internal, true);
assert.equal(networkInfo.Labels?.["deskazo.openrag-recovery"], fixture);
const state = JSON.parse(await readFile(statePath, "utf8")) as {
  fixture: string;
  key: string;
  revokedKey: string;
  filterId: string;
  query: string;
  text: string;
};
assert.equal(state.fixture, fixture);
const baseUrl = "http://127.0.0.1:8000/v1";
const proxy = `
import json,sys,urllib.request,urllib.error
value=json.load(sys.stdin)
assert value['url'].startswith('http://127.0.0.1:8000/v1/')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): return None
request=urllib.request.Request(value['url'],method=value['method'],headers=value['headers'],
    data=value['body'].encode() if value['body'] is not None else None)
try:
    response=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(request,timeout=60)
except urllib.error.HTTPError as error:
    response=error
print(json.dumps({'status':response.status,'body':response.read(1000001).decode()}))
`;
const routes: string[] = [];
const request: typeof fetch = async (input, init) => {
  const url = String(input);
  assert(url.startsWith(`${baseUrl}/`));
  routes.push(new URL(url).pathname);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const child = execFile(
      "docker",
      ["exec", "-i", container, "/app/.venv/bin/python", "-c", proxy],
      { timeout: 70_000, maxBuffer: 2_000_000, signal: init?.signal ?? undefined },
      (error, stdout) => {
        if (error) reject(new Error("Disposable knowledge request failed"));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Disposable knowledge response is invalid"));
          }
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body === undefined ? null : String(init.body),
      }),
    );
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};
const runtime = (apiKey: string) =>
  new LangflowCustomerRuntime({ baseUrl, knowledge: { baseUrl, apiKey } }, request);
const search = (apiKey: string, knowledgeFilterId = state.filterId) =>
  runtime(apiKey).search({
    knowledgeFilterId,
    query: state.query,
    signal: AbortSignal.timeout(70_000),
  });
const result = (await search(state.key)) as {
  results: { filename: string; text: string; score: number }[];
};
assert.equal(result.results.length, 1);
const [document] = result.results;
assert(document);
assert.equal(document.filename, "synthetic-policy.txt");
assert.equal(document.text, state.text);
assert(Number.isFinite(document.score) && document.score > 0);
assert.deepEqual(routes, [`/v1/knowledge-filters/${state.filterId}`, "/v1/search"]);
for (const [key, filter] of [
  [state.revokedKey, state.filterId],
  [state.key, "foreign-private"],
] as const) {
  routes.length = 0;
  await assert.rejects(search(key, filter), { message: "Customer reply service is unavailable" });
  assert.deepEqual(routes, [`/v1/knowledge-filters/${filter}`]);
}
console.log(
  "Actual customer adapter retrieves only the authorized selected document; denied filter resolution prevents search and exposes no upstream exception.",
);
