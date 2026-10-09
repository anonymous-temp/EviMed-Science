// `deploymentComposition.mjs` restates, as a pure function of the configuration and an account, which tools a
// runtime is NOT given. A restatement can drift from what it restates, so this runs the real launch rules
// (`dshProfileInput` -> `EVIMED_DISABLED_TOOLS`) over a matrix of configurations and requires the two to agree.
// It is why the availability labels may be trusted: a change to the launch rules that the composition does not
// follow fails here, by name, rather than as a catalogue that says "offered" for a tool no runtime has.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MCP_MANAGED_JOB_BASE_NAMES, MCP_TOOL_BASE_NAMES, VCR_CAPABILITIES } from "@evimed/domain";
import { ENGINE_TOOL_ADAPTER_KEYS, GEO_CAPABILITY_IDS, declinedTools, engineHealthUrl, moduleOfCapability, moduleState } from "../src/deploymentComposition.mjs";
import { buildRuntimeLaunchPlan, dshProfileInput } from "../src/runtimeManager.mjs";

const base = {
  runtimeSandboxMode: "docker", runtimeContainerBin: "docker", runtimeContainerImage: "evimed-runtime-dsh:test",
  runtimeTransport: "unix", runtimeNetworkMode: "none", runtimeCpuLimit: "1", runtimeMemoryLimit: "1g", runtimePidsLimit: 64,
  allowRuntimeHostNetwork: false, deepseekProviderEnabled: true, deepseekModel: "deepseek-v4-pro",
  modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
  modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes",
  runtimeSandboxEnforcement: "full", evimedDisabledTools: "",
  publicSourceGatewayInternalUrl: "http://127.0.0.1:8787/internal/sources/v1/fetch",
  operatorUsers: [], frontierPreviewUsers: [], geoPreviewUsers: [], vcrPreviewUsers: [],
};

/** Each row is one deployment; the matrix crosses the switches the launch reads. */
const matrix = [
  ["nothing configured", {}],
  ["operator-disabled tools", { evimedDisabledTools: "patent_search,web_search" }],
  ["web reading off", { webReadEnabled: false }],
  ["a patent adapter", { evimedAdapterUrls: { patentSearch: "https://patents.internal/search" } }],
  ["no public-source gateway", { publicSourceGatewayInternalUrl: "" }],
  ["frontier on for everyone", { frontierEnabled: true, frontierAudience: "all" }],
  ["frontier on, operators only", { frontierEnabled: true, frontierAudience: "operators" }],
  ["geo on for everyone, with a social channel", { geoEnabled: true, geoAudience: "all", geoSocialUrl: "http://social.internal:9966" }],
  ["geo on for everyone, no social channel", { geoEnabled: true, geoAudience: "all", geoSocialUrl: "" }],
  ["geo on, operators only", { geoEnabled: true, geoAudience: "operators", geoSocialUrl: "http://social.internal:9966" }],
  ["geo on, operators only, the account is one", { geoEnabled: true, geoAudience: "operators", operatorUsers: ["user-1"], geoSocialUrl: "http://s:1" }],
  ["vcr on for everyone, engine composed", { vcrEnabled: true, vcrAudience: "all", vcrEngineConfigured: true, vcrEngineUrl: "http://vcr-engine:8080" }],
  ["vcr on for everyone, no engine", { vcrEnabled: true, vcrAudience: "all", vcrEngineConfigured: false, vcrEngineUrl: "http://vcr-engine:8080" }],
  ["vcr on, operators only", { vcrEnabled: true, vcrAudience: "operators", vcrEngineConfigured: true }],
  ["results on with an engine url and postgres", { resultsEnabled: true, stateStore: "postgres", resultEngineUrl: "http://result-replay:8031" }],
  ["results on, postgres, vcr engine instead of a result engine", { resultsEnabled: true, stateStore: "postgres", resultEngineUrl: "", vcrEnabled: true, vcrAudience: "all", vcrEngineConfigured: true }],
  ["scheduled tasks on, with the product ledger", { taskToolsEnabled: true, stateStore: "postgres" }],
  ["scheduled tasks on but no product ledger", { taskToolsEnabled: true, stateStore: "file" }],
  ["scheduled tasks off", { taskToolsEnabled: false, stateStore: "postgres" }],
  ["scheduled tasks on, with the ledger, but no public-source gateway", { taskToolsEnabled: true, stateStore: "postgres", publicSourceGatewayInternalUrl: "" }],
  ["results on but no postgres", { resultsEnabled: true, stateStore: "file", resultEngineUrl: "http://result-replay:8031" }],
  ["everything on", { webReadEnabled: true, frontierEnabled: true, frontierAudience: "all", geoEnabled: true, geoAudience: "all", geoSocialUrl: "http://s:1",
    vcrEnabled: true, vcrAudience: "all", vcrEngineConfigured: true, resultsEnabled: true, stateStore: "postgres", resultEngineUrl: "http://r:1",
    taskToolsEnabled: true, evimedAdapterUrls: { patentSearch: "https://p.internal/s" } }],
];

test("the composition names exactly the tools the real launch withholds, over a matrix of deployments", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "composition-parity-"));
  try {
    const project = { id: "paper1", userId: "user-1", rootDir: tmp, workspaceDir: path.join(tmp, "workspace"), runtimeDir: path.join(tmp, "runtime") };
    let rows = 0;
    for (const [name, overrides] of matrix) {
      const config = { ...base, ...overrides };
      const plan = buildRuntimeLaunchPlan(config, project, 49152);
      const launched = new Set(String(dshProfileInput(config, project, plan, "deepseek-v4-pro", null).mcpEnvironment.EVIMED_DISABLED_TOOLS).split(",").filter(Boolean));
      // The launch keeps offering a managed-job engine whose adapter was never configured; that is the composition's
      // own `engine` layer, which it names beyond the launch's list.
      const composed = declinedTools(config, { id: "user-1" });
      const runtimeLayer = new Set([...composed].filter(([, row]) => row.layer === "runtime").map(([tool]) => tool));
      assert.deepEqual([...runtimeLayer].sort(), [...launched].sort(), `${name}: the composition and the launch disagree`);
      for (const tool of composed.keys()) assert.ok(MCP_TOOL_BASE_NAMES.includes(tool), `${name}: ${tool} is not a catalogue tool`);
      rows += 1;
    }
    assert.equal(rows, matrix.length);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a managed-job engine with no adapter and no root is declined in its own layer, and one with an adapter is not", () => {
  const none = declinedTools({ ...base, evimedAdapterUrls: {}, specialistAgents: {} }, { id: "u" });
  for (const tool of MCP_MANAGED_JOB_BASE_NAMES) {
    assert.deepEqual(none.get(tool), { why: "engine-not-configured", layer: "engine" }, tool);
  }
  const served = declinedTools({ ...base, evimedAdapterUrls: { metaAnalysis: "http://meta:8024/api/v1/evimed/meta-analysis" }, specialistAgents: {} }, { id: "u" });
  assert.equal(served.has("meta_analysis"), false);
  assert.equal(served.has("peer_review"), true);
  // A checkout that runs a sibling engine in place has a root and no service: configured, nothing to ask.
  const inPlace = declinedTools({ ...base, evimedAdapterUrls: {}, specialistAgents: { peerReview: { root: "/engines/peer" } }, metaAgentRoot: "/engines/meta" }, { id: "u" });
  assert.equal(inPlace.has("peer_review"), false);
  assert.equal(inPlace.has("meta_analysis"), false);
  assert.equal(inPlace.has("drug_safety_analysis"), true);
});

test("the six managed-job tools and their adapters are the domain's, and an engine's /health is its own origin", () => {
  assert.deepEqual(Object.keys(ENGINE_TOOL_ADAPTER_KEYS).sort(), [...MCP_MANAGED_JOB_BASE_NAMES].sort());
  const withCredentials = new URL("http://host/x");
  withCredentials.username = "someone";
  withCredentials.password = "placeholder";
  const config = { evimedAdapterUrls: { metaAnalysis: "http://evimed-meta-agent:8024/api/v1/evimed/meta-analysis", peerReview: withCredentials.href, drugSafetyAnalysis: "ftp://host/x" } };
  assert.equal(engineHealthUrl(config, "meta_analysis"), "http://evimed-meta-agent:8024/health");
  assert.equal(engineHealthUrl(config, "peer_review"), null, "credentials in an address are never followed");
  assert.equal(engineHealthUrl(config, "drug_safety_analysis"), null);
  assert.equal(engineHealthUrl(config, "bibliometric_analysis"), null, "no adapter, no service to ask");
});

test("a module-only capability is attributed to its module, and a module is on, off or not open to this account", () => {
  for (const id of GEO_CAPABILITY_IDS) assert.equal(moduleOfCapability(id), "geo");
  for (const id of VCR_CAPABILITIES) assert.equal(moduleOfCapability(id), "vcr");
  assert.equal(moduleOfCapability("adr-analysis"), null);
  assert.equal(moduleState({ vcrEnabled: false }, { id: "u" }, "vcr"), "off");
  assert.equal(moduleState({ vcrEnabled: true, vcrAudience: "operators", operatorUsers: [] }, { id: "u" }, "vcr"), "not-open");
  assert.equal(moduleState({ vcrEnabled: true, vcrAudience: "operators", operatorUsers: ["u"] }, { id: "u" }, "vcr"), "on");
  assert.equal(moduleState({ geoEnabled: true, geoAudience: "all" }, { id: "u" }, "geo"), "on");
});
