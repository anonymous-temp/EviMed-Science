// Every web-reading lever reaches the container with the code's own default.
// Compose forwards environment item by item and its `${X:-fallback}` is what
// production actually runs with when `.env` is silent: pids 256 and 4g ran for
// weeks while config.mjs said 1024 and 8g (2026-09-19). So each key here must
// be forwarded, its fallback must equal config.mjs's default, and
// `.env.example` must name it.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { buildRuntimeLaunchPlan, dshProfileInput } from "../src/runtimeManager.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const LEVERS = [
  ["OPEN_SCIENCE_WEB_READ_ENABLED", "webReadEnabled"],
  ["OPEN_SCIENCE_WEB_READ_CONCURRENCY", "webReadConcurrency"],
  ["OPEN_SCIENCE_WEB_READ_RUNTIME_CONCURRENCY", "webReadRuntimeConcurrency"],
  ["OPEN_SCIENCE_WEB_READ_HOST_INTERVAL_MS", "webReadHostIntervalMs"],
  ["OPEN_SCIENCE_WEB_READ_TIMEOUT_MS", "webReadTimeoutMs"],
  ["OPEN_SCIENCE_WEB_READ_EDGE_FALLBACK", "webReadEdgeFallback"],
  ["OPEN_SCIENCE_WEB_READ_DIRECT_TIMEOUT_MS", "webReadDirectTimeoutMs"],
  ["OPEN_SCIENCE_EDGE_PROXY_URL", "edgeProxyUrl"],
  ["OPEN_SCIENCE_EDGE_PROXY_HOSTS", "edgeProxyHosts"],
  ["OPEN_SCIENCE_EDGE_PROXY_CONNECT_TIMEOUT_MS", "edgeProxyConnectTimeoutMs"],
  ["OPEN_SCIENCE_WEB_SEARCH_EDGE_URL", "webSearchEdgeUrl"],
  ["OPEN_SCIENCE_WEB_SEARCH_BAILIAN_ENABLED", "webSearchBailianEnabled"],
  ["OPEN_SCIENCE_WEB_SEARCH_BAILIAN_MODEL", "webSearchBailianModel"],
  ["OPEN_SCIENCE_WEB_RENDER_ENABLED", "webRenderEnabled"],
  ["OPEN_SCIENCE_WEB_RENDER_CONCURRENCY", "webRenderConcurrency"],
  ["OPEN_SCIENCE_WEB_RENDER_TIMEOUT_MS", "webRenderTimeoutMs"],
  ["OPEN_SCIENCE_WEB_RENDER_IDLE_RELEASE_MS", "webRenderIdleReleaseMs"],
  ["OPEN_SCIENCE_SOURCE_UPDATES_ENABLED", "sourceUpdatesEnabled"],
  ["OPEN_SCIENCE_SOURCE_UPDATES_TIMEOUT_MS", "sourceUpdatesTimeoutMs"],
  // The AgentBay keys the render tier shares with the runtime provider are the
  // provider's (value-less in compose, the key file through
  // docker-compose.agentbay.yml) and are held by its own lever tests.
];

async function withoutLevers(run) {
  const saved = Object.fromEntries(LEVERS.map(([name]) => [name, process.env[name]]));
  for (const [name] of LEVERS) delete process.env[name];
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("every web-reading lever is forwarded by compose with the code's default and documented", async () => {
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const config = await withoutLevers(() => loadConfig({ rootDir: repoRoot }));
  for (const [name, key] of LEVERS) {
    const forwarded = new RegExp(`${name}: \\$\\{${name}:-([^}]*)\\}`).exec(compose);
    assert.ok(forwarded, `${name} is not forwarded by docker-compose.yml, so setting it does nothing`);
    assert.equal(forwarded[1], String(config[key]), `${name}: compose falls back to ${JSON.stringify(forwarded[1])}, config.mjs defaults to ${JSON.stringify(config[key])}`);
    assert.match(example, new RegExp(`^${name}=`, "m"), `${name} is missing from .env.example`);
  }
});

test("rendering is off until a key exists, and a read's budget ends before the tool call does", async () => {
  const config = await withoutLevers(() => loadConfig({ rootDir: repoRoot }));
  assert.equal(config.webReadEnabled, true);
  assert.equal(config.webRenderEnabled, false);
  assert.equal(config.agentbayApiKeyFile, "");
  assert.equal(config.agentbayRegion, "cn-hangzhou");
  const clamped = loadConfig({ rootDir: repoRoot, webReadTimeoutMs: 600_000 });
  assert.ok(clamped.webReadTimeoutMs <= 150_000, `a ${clamped.webReadTimeoutMs} ms read would outlive the kernel's 180 s tool call`);
});

test("switching web reading off also stops offering the tool to the runtime", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "web-read-switch-"));
  try {
    const project = { id: "paper1", userId: "alice", rootDir: tmp, workspaceDir: path.join(tmp, "workspace"), runtimeDir: path.join(tmp, "runtime") };
    const base = {
      runtimeSandboxMode: "docker", runtimeContainerBin: "docker", runtimeContainerImage: "evimed-runtime-dsh:test",
      runtimeTransport: "unix", runtimeNetworkMode: "none", runtimeCpuLimit: "1", runtimeMemoryLimit: "1g", runtimePidsLimit: 64,
      allowRuntimeHostNetwork: false, deepseekProviderEnabled: true, deepseekModel: "deepseek-v4-pro",
      modelGatewayInternalUrl: "http://127.0.0.1:8787/internal/model/v1",
      modelGatewaySigningSecret: "model-gateway-signing-secret-with-at-least-32-bytes",
      runtimeSandboxEnforcement: "full",
      evimedDisabledTools: "patent_search",
    };
    const disabledTools = (config) => {
      const plan = buildRuntimeLaunchPlan(config, project, 49152);
      return dshProfileInput(config, project, plan, "deepseek-v4-pro", null).mcpEnvironment.EVIMED_DISABLED_TOOLS;
    };
    // The frontier module is off in this config, so its search tool is not
    // offered either (runtimeManager.mjs, next to the web_read switch).
    assert.equal(disabledTools({ ...base, webReadEnabled: true }), "patent_search,frontier_search");
    assert.equal(disabledTools({ ...base, webReadEnabled: false }), "patent_search,web_read,frontier_search");
    assert.equal(disabledTools({ ...base, evimedDisabledTools: "", webReadEnabled: false }), "web_read,frontier_search");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
