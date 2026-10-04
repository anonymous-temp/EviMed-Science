// The runtime's door and the files page's routes to what a project's datasets mean: the token alone names
// the account and the project, the runtime can only ever speak as the conversation, a module that is off
// answers by name, and no failure is anything but a code the run reads and goes on from.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { createDataSemanticsGateway, DATA_SEMANTICS_GATEWAY_PATH } from "../src/dataSemanticsGateway.mjs";
import { createDataSemanticsRoutes } from "../src/dataSemanticsRoutes.mjs";
import { DataSemanticsService } from "../src/dataSemanticsService.mjs";
import { HttpError } from "../src/security.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const inferred = { basis: "model_inferred", inferredFrom: ["the header"] };
const TOKEN = "runtime-token-for-tests";

async function gatewayFixture(t, { enabled = true, service = undefined, projectId = "p1" } = {}) {
  const documents = productDocumentsDouble();
  const real = new DataSemanticsService({ documents });
  const failures = [];
  const handler = createDataSemanticsGateway({
    config: { dataSemanticsEnabled: enabled },
    runtimeManager: { assertActiveModelGatewayToken: (token) => { if (token !== TOKEN) throw new Error("no"); return { userId: "owner", projectId }; } },
    store: { userById: async (id) => (id === "owner" ? { id } : null), requireProject: async (_user, id) => ({ id, userId: "owner" }) },
    service: service === undefined ? real : service,
  });
  const server = createServer((req, res) => { void handler(req, res, (failure) => failures.push(failure)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}${DATA_SEMANTICS_GATEWAY_PATH}`;
  const call = async (operation, body, { token = TOKEN, method = "POST", raw = undefined } = {}) => {
    const response = await fetch(`${base}/${operation}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(method === "POST" ? { body: raw ?? JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { call, real, documents, failures };
}

test("the runtime writes, reads, records a check and a transformation, all in the project its token names", async (t) => {
  const { call, real } = await gatewayFixture(t);
  const written = await call("write", { patch: { datasetId: "visits", ...inferred, variables: [{ table: "v.csv", name: "sbp", unit: "mmHg" }] } });
  assert.equal(written.status, 200);
  assert.equal(written.body.data.revision, 1);
  assert.equal(written.body.data.summary.modelInferred, 1);
  const listed = await call("read", {});
  assert.deepEqual(listed.body.data.datasets.map((dataset) => dataset.datasetId), ["visits"]);
  const one = await call("read", { datasetId: "visits" });
  assert.equal(one.body.data.dataset.asset.tables[0].variables[0].facts.unit.value, "mmHg");
  assert.match(one.body.data.dataset.interpretation, /^[a-f0-9]{64}$/);
  const report = { checkedAt: "2026-10-04T09:00:00.000Z", bindings: [], findings: [{ outcome: "temporal_leakage", subject: { predictor: "sbp" }, count: 60 }], notChecked: [], clean: [] };
  assert.equal((await call("report", { datasetId: "visits", report, denominators: { cohort: { rows: 10 } } })).body.data.recorded, true);
  const transform = await call("transform", { datasetId: "visits", transformation: { name: "egfr", kind: "derive", inputs: [{ table: "v.csv", columns: ["creatinine"] }] } });
  assert.deepEqual([transform.body.data.status, transform.body.data.version], ["new", 1]);
  // It is the project's own: another project of the same account sees nothing.
  assert.equal((await real.get("owner", "p2", "visits")), null);
  assert.equal((await real.get("owner", "p1", "visits")).asset.lastCheck.summary.attention, 1);
});

test("the runtime can only speak as the conversation: a confirmation needs the researcher's words", async (t) => {
  const { call } = await gatewayFixture(t);
  const refused = await call("write", { patch: { datasetId: "d", basis: "researcher_confirmed", variables: [{ table: "t.csv", name: "c", unit: "mg" }] } });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.data.issues[0].code, "provenance_invalid");
  assert.equal(refused.body.data.summary.facts, 0);
  const said = await call("write", { patch: { datasetId: "d", basis: "researcher_confirmed", statement: "单位是 mg", variables: [{ table: "t.csv", name: "c", unit: "mg" }] } });
  assert.equal(said.body.data.summary.researcherConfirmed, 1);
  const stored = (await call("read", { datasetId: "d" })).body.data.dataset.asset.tables[0].variables[0].facts.unit;
  assert.equal(stored.via, "conversation");
  // A body cannot claim to be the page, and cannot name another project.
  const claim = await call("write", { patch: { datasetId: "d", via: "page", basis: "researcher_confirmed" } });
  assert.equal(claim.body.data.issues[0].code, "field_unknown");
  const elsewhere = await call("read", { datasetId: "d", projectId: "p2" });
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.body.code, "semantics_request_invalid");
});

test("a missing dataset, a bad credential, a switched-off module and a bad request each answer by name", async (t) => {
  const { call, failures } = await gatewayFixture(t);
  assert.deepEqual([(await call("read", { datasetId: "nope" })).status, (await call("read", { datasetId: "nope" })).body.code], [404, "semantics_asset_not_found"]);
  assert.equal((await call("report", { datasetId: "nope", report: {} })).body.code, "semantics_asset_not_found");
  assert.equal((await call("read", {}, { token: null })).body.code, "semantics_gateway_token_missing");
  assert.equal((await call("read", {}, { token: "forged" })).body.code, "semantics_gateway_token_invalid");
  assert.equal((await call("read", { datasetId: "Not Valid" })).body.code, "semantics_dataset_invalid");
  assert.equal((await call("write", { patch: "x" })).body.code, "semantics_request_invalid");
  assert.equal((await call("write", { patch: {}, extra: 1 })).body.code, "semantics_request_invalid");
  assert.equal((await call("write", null, { raw: "not json" })).body.code, "semantics_request_invalid");
  const huge = await call("write", { patch: { datasetId: "d", title: "x".repeat(1_100_000) } });
  assert.deepEqual([huge.status, huge.body.code], [413, "semantics_request_too_large"]);
  for (const missing of [{ operation: "nothing", method: "POST" }, { operation: "read", method: "GET" }]) {
    const answer = await call(missing.operation, {}, { method: missing.method });
    assert.equal(answer.status, 404, missing.operation);
  }
  assert.ok(failures.some((failure) => failure.code === "semantics_gateway_token_invalid" && failure.status === 401));

  const off = await gatewayFixture(t, { enabled: false });
  const answer = await off.call("read", {});
  assert.deepEqual([answer.status, answer.body.code], [503, "semantics_disabled"]);
  const nowhere = await gatewayFixture(t, { service: null });
  assert.equal((await nowhere.call("read", {})).body.code, "semantics_disabled");
});

test("an unexpected failure is a coded outage the run goes on from, never the stack", async (t) => {
  const { call } = await gatewayFixture(t, { service: { list: async () => { throw new Error("connection reset by 10.0.0.7:5432"); } } });
  const answer = await call("read", {});
  assert.deepEqual([answer.status, answer.body.code], [503, "semantics_unavailable"]);
  assert.doesNotMatch(JSON.stringify(answer.body), /10\.0\.0\.7|connection reset/);
});

test("a loop is stopped at the per-project rate and nothing else is", async (t) => {
  const { call } = await gatewayFixture(t);
  let last;
  for (let index = 0; index < 121; index += 1) last = await call("read", {});
  assert.deepEqual([last.status, last.body.code], [429, "semantics_rate_limited"]);
});

// ---- the files page's routes --------------------------------------------------------------------

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}
function response() {
  return { status: 0, body: "", writeHead(status) { this.status = status; return this; }, end(chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}

test("the files page lists a project's datasets, reads one, and confirms facts as the researcher — with the session and the token behind it", async () => {
  const documents = productDocumentsDouble();
  const service = new DataSemanticsService({ documents });
  await service.write("owner", "p1", { datasetId: "visits", ...inferred, variables: [{ table: "v.csv", name: "sbp", unit: "mmHg" }] }, { via: "conversation" });
  const csrf = [];
  const store = {
    ensureSessionUser: async () => ({ user: { id: "owner" } }),
    assertCsrf: async (_req, path) => { csrf.push(path); },
    requireProject: async (_user, id) => { if (id !== "p1") throw new HttpError(404, "project_not_found", "No project."); return { id }; },
  };
  const routes = createDataSemanticsRoutes({ store, service, maxJsonBytes: 65_536 });
  const run = async (method, url, body) => { const res = response(); const handled = await routes(request(method, url, body), res); return { handled, res }; };

  assert.equal((await run("GET", "/api/projects/p1/other")).handled, false);
  const list = await run("GET", "/api/projects/p1/data-semantics");
  assert.equal(list.res.json().data.items[0].datasetId, "visits");
  const one = await run("GET", "/api/projects/p1/data-semantics/visits");
  assert.equal(one.res.json().data.asset.tables[0].variables[0].facts.unit.basis, "model_inferred");
  assert.equal((await run("GET", "/api/projects/p1/data-semantics/missing").catch((error) => error)).code, "semantics_asset_not_found");
  assert.equal((await run("GET", "/api/projects/other/data-semantics").catch((error) => error)).code, "project_not_found");

  const confirmed = await run("POST", "/api/projects/p1/data-semantics/visits/confirm", { targets: ["variable:v.csv/sbp:unit"] });
  assert.equal(confirmed.res.json().data.summary.researcherConfirmed, 1);
  assert.equal((await service.get("owner", "p1", "visits")).asset.tables[0].variables[0].facts.unit.via, "page");
  assert.ok(csrf.length >= 5);
  // The page confirms; it does not write values or versions.
  assert.equal((await run("POST", "/api/projects/p1/data-semantics/visits/confirm", { targets: ["x"], patch: {} }).catch((error) => error)).code, "semantics_request_invalid");
  assert.equal((await run("PUT", "/api/projects/p1/data-semantics/visits").catch((error) => error)).code, "method_not_allowed");
  const unavailable = createDataSemanticsRoutes({ store, service: null, maxJsonBytes: 65_536 });
  await assert.rejects(() => unavailable(request("GET", "/api/projects/p1/data-semantics"), response()), (error) => error.code === "product_state_unavailable");
});

// ---- how a runtime is given the address -----------------------------------------------------------

test("a runtime is given the gateway where the module is on and the ledger exists, and a remote one through the public prefix", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { buildRuntimeLaunchPlan, dshProfileInput, dataSemanticsGatewayProviderUrl } = await import("../src/runtimeManager.mjs");
  const { publicRuntimeGatewayUrls, resolveRuntimeGatewayPath, RUNTIME_GATEWAY_NAMES } = await import("../src/runtimeGatewayEntry.mjs");

  const base = { modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1", stateStore: "postgres", dataSemanticsEnabled: true };
  assert.equal(dataSemanticsGatewayProviderUrl(base), "http://127.0.0.1:8787/internal/semantics/v1");
  assert.equal(dataSemanticsGatewayProviderUrl({ ...base, dataSemanticsEnabled: false }), "");
  assert.equal(dataSemanticsGatewayProviderUrl({ ...base, stateStore: "file" }), "");

  // The public prefix: offered exactly where the internal address is, and mapped to the internal path by name.
  assert.ok(RUNTIME_GATEWAY_NAMES.includes("semantics"));
  assert.equal(publicRuntimeGatewayUrls({ ...base, runtimeGatewayPublicUrl: "https://example.test/runtime-gateway" }).semantics, "https://example.test/runtime-gateway/semantics/v1");
  assert.equal(publicRuntimeGatewayUrls({ ...base, dataSemanticsEnabled: false, runtimeGatewayPublicUrl: "https://example.test/runtime-gateway" }).semantics, "");
  assert.deepEqual(resolveRuntimeGatewayPath("/runtime-gateway/semantics/v1/read"), { kind: "internal", url: "/internal/semantics/v1/read" });

  // The launch: the tool finds the address in its own environment, or none.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "semantics-launch-"));
  try {
    const project = { id: "paper1", userId: "user-1", rootDir: tmp, workspaceDir: path.join(tmp, "workspace"), runtimeDir: path.join(tmp, "runtime") };
    const launch = {
      runtimeSandboxMode: "docker", runtimeContainerBin: "docker", runtimeContainerImage: "evimed-runtime-dsh:test", runtimeTransport: "unix", runtimeNetworkMode: "none",
      runtimeCpuLimit: "1", runtimeMemoryLimit: "1g", runtimePidsLimit: 64, allowRuntimeHostNetwork: false, deepseekProviderEnabled: true, deepseekModel: "deepseek-v4-pro",
      modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes", runtimeSandboxEnforcement: "full", evimedDisabledTools: "",
      publicSourceGatewayInternalUrl: "http://127.0.0.1:8787/internal/sources/v1/fetch", ...base,
    };
    const environment = (config) => dshProfileInput(config, project, buildRuntimeLaunchPlan(config, project, 49152), "deepseek-v4-pro", null).mcpEnvironment;
    assert.equal(environment(launch).EVIMED_SEMANTICS_GATEWAY_URL, "http://127.0.0.1:8787/internal/semantics/v1");
    assert.equal(environment({ ...launch, dataSemanticsEnabled: false }).EVIMED_SEMANTICS_GATEWAY_URL, undefined);
    assert.equal(environment({ ...launch, stateStore: "file" }).EVIMED_SEMANTICS_GATEWAY_URL, undefined);
    // The tool is never withheld: with no address it answers `semantics_disabled` itself (it is not an optional tool).
    assert.doesNotMatch(environment({ ...launch, dataSemanticsEnabled: false }).EVIMED_DISABLED_TOOLS, /dataset_semantics/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
