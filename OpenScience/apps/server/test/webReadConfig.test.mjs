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
import { createConfiguredWebRenderer, webRenderProvider } from "../src/webRender.mjs";

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
  ["OPEN_SCIENCE_WEB_RENDER_CDP_URL", "webRenderCdpUrl"],
  ["OPEN_SCIENCE_WEB_RENDER_MAX_BYTES", "webRenderMaxBytes"],
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

test("rendering is off until switched on with a browser, and a read's budget ends before the tool call does", async () => {
  const config = await withoutLevers(() => loadConfig({ rootDir: repoRoot }));
  assert.equal(config.webReadEnabled, true);
  assert.equal(config.webRenderEnabled, false);
  assert.equal(config.webRenderCdpUrl, "");
  assert.equal(config.agentbayApiKeyFile, "");
  assert.equal(config.agentbayRegion, "cn-hangzhou");
  assert.equal(webRenderProvider(config), null);
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
    // So are 循证 GEO's three tools: the module is off in this config too.
    const geo = "geo_read,geo_write,social_posts_search";
    assert.equal(disabledTools({ ...base, webReadEnabled: true }), `patent_search,frontier_search,${geo}`);
    assert.equal(disabledTools({ ...base, webReadEnabled: false }), `patent_search,web_read,frontier_search,${geo}`);
    // Patent search is offered only where a patent adapter is configured
    // (2026-09-03 ruling), so an empty deployment list still leaves it out.
    assert.equal(disabledTools({ ...base, evimedDisabledTools: "", webReadEnabled: false }), `web_read,frontier_search,${geo},patent_search`);
    assert.equal(disabledTools({ ...base, evimedDisabledTools: "", webReadEnabled: false, evimedAdapterUrls: { patentSearch: "https://patents.internal/search" } }), `web_read,frontier_search,${geo}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("the render provider is the deployment's own browser when one is named, else AgentBay when keyed, else none", async () => {
  const base = { webRenderEnabled: true, webRenderCdpUrl: "", agentbayApiKeyFile: "" };
  assert.equal(webRenderProvider(base), null);
  assert.equal(webRenderProvider({ ...base, agentbayApiKeyFile: "/run/secrets/agentbay-api-key" }), "agentbay");
  assert.equal(webRenderProvider({ ...base, webRenderCdpUrl: "http://frontier-browser:9222" }), "local");
  assert.equal(webRenderProvider({ ...base, webRenderCdpUrl: "http://frontier-browser:9222", agentbayApiKeyFile: "/k" }), "local");
  assert.equal(webRenderProvider({ ...base, webRenderEnabled: false, webRenderCdpUrl: "http://frontier-browser:9222" }), null, "the switch decides first");
  assert.equal(webRenderProvider({ ...base, webRenderCdpUrl: "ftp://frontier-browser:9222" }), null, "a DevTools address is http(s)");

  const off = createConfiguredWebRenderer({ ...base, webRenderEnabled: false });
  assert.equal(off.enabled, false);
  await assert.rejects(off.render({ url: new URL("https://www.nmpa.gov.cn/") }), (error) => error.code === "web_render_disabled");
  const local = createConfiguredWebRenderer({ ...base, webRenderCdpUrl: "http://frontier-browser:9222" });
  assert.equal(local.enabled, true);
  assert.equal(local.provider, "local");
  await local.close?.();
});

test("the knowledge overlay points web reading at its browser over a network the two share alone", async () => {
  const overlay = await readFile(path.join(repoRoot, "deploy/web/docker-compose.knowledge.yml"), "utf8");
  assert.match(overlay, /OPEN_SCIENCE_WEB_RENDER_CDP_URL: \$\{OPEN_SCIENCE_WEB_RENDER_CDP_URL:-http:\/\/frontier-browser:9222\}/);
  // Each service block, and whether it joins the network.
  const services = overlay.split(/^networks:$/m)[0].split(/^ {2}(?=[a-z0-9-]+:$)/m).slice(1);
  const members = services.filter((block) => /^ {6}- web-render-internal$/m.test(block)).map((block) => block.split(":", 1)[0]);
  assert.deepEqual(members.sort(), ["frontier-browser", "open-science-web"]);
  assert.match(overlay, /^ {2}web-render-internal:\n {4}internal: true$/m, "no route out: a render's egress is the control plane's proxy");
});
