#!/usr/bin/env node
/**
 * The tool probe, against the server's own gateways.
 *
 * `run_tool_audit.py` calls the research MCP directly, and the MCP reaches
 * every upstream through the control plane: public sources, open-web search,
 * the GEO probe channel, and the model gateway a managed specialist runs on.
 * Those four handlers live in `apps/server/src` and authenticate against the
 * server's record of live runtimes, so a probe outside a runtime is refused by
 * all four and reports the tools as unavailable — which is what a first attempt
 * from the host recorded, and it says nothing about the tools.
 *
 * So: run the production handlers in this process, with one stub in front of
 * them — `assertActiveModelGatewayToken`, which is the only thing about a live
 * runtime the audit cannot supply. Every upstream, every credential, every
 * allowlist and every response contract is the deployed one. This is the same
 * arrangement `run_connector_gateway_audit.mjs` uses for the connector probe,
 * extended to the four gateways the whole tool registry needs.
 *
 * Configuration is read from the environment rather than written down here,
 * and a missing one is named rather than defaulted: a probe that silently
 * substitutes its own backend certifies a deployment nobody runs.
 *
 *   OPEN_SCIENCE_WEB_SEARCH_URL      the SearXNG the deployment queries
 *   OPEN_SCIENCE_GEO_PROBE_URL       the GEO probe host (five logged-in vendors)
 *   OPEN_SCIENCE_LOCAL_AUTO_CONFIG=1 read credentials from .evimed-local/secrets
 *
 * The full refresh, in order -- the specialists first, because the probe
 * harvests their receipts rather than running them:
 *
 *   OPEN_SCIENCE_LOCAL_AUTO_CONFIG=1 \
 *   OPEN_SCIENCE_WEB_SEARCH_URL=http://127.0.0.1:18080/ \
 *   OPEN_SCIENCE_GEO_PROBE_URL=http://<probe-host>:9999 \
 *   OPEN_SCIENCE_GEO_PROBE_ALLOW_PLAINTEXT=1 \
 *   EVIMED_DISABLED_TOOLS=patent_search \
 *     node evals/capability-audit/run_tool_gateway_audit.mjs --script run_specialist_jobs.py \
 *       --probe-workspace evals/capability-audit/tool-probe-workspace \
 *       --manuscript manuscripts/<a real manuscript>.pdf
 *   # then the same environment, without --script, to record the document.
 *
 * Arguments after the script name are passed through to `run_tool_audit.py`,
 * or to the script named by `--script` -- which is how `run_specialist_jobs.py`
 * runs the managed specialists the probe then harvests receipts from. Only a
 * file in this directory may be named.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../apps/server/src/config.mjs";
import { createPublicSourceGatewayHandler, PUBLIC_SOURCE_GATEWAY_PATH } from "../../apps/server/src/publicSourceGateway.mjs";
import { createWebSearchGatewayHandler, WEB_SEARCH_GATEWAY_PATH } from "../../apps/server/src/webSearchGateway.mjs";
import { createGeoProbeGatewayHandler, GEO_PROBE_GATEWAY_PATH } from "../../apps/server/src/geoProbeGateway.mjs";
import { createModelGatewayHandler, MODEL_GATEWAY_PATH } from "../../apps/server/src/modelGateway.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const auditToken = "evimed-tool-audit-token";
// `MODEL_GATEWAY_PATH` is the full endpoint; what a specialist is handed is the
// OpenAI-compatible *base*, and its client appends `/chat/completions` itself.
// Handing it the endpoint produced `.../chat/completions/chat/completions` and
// a 404 that surfaced inside the agent as "the query-understanding model is
// unavailable".
const modelGatewayBase = MODEL_GATEWAY_PATH.replace(/\/chat\/completions$/, "");

// The same fallback budget the server entrypoints set, for the same reason:
// an upstream whose AAAA records black-hole fails with ETIMEDOUT inside the
// 250 ms default and is recorded as a source that returned an error. NOAA's
// SWPC probe failed exactly that way here and answered on the first retry once
// the IPv4 attempt was allowed to finish.
net.setDefaultAutoSelectFamilyAttemptTimeout(
  Math.max(net.getDefaultAutoSelectFamilyAttemptTimeout(), 1_000),
);

const config = loadConfig();

/**
 * What the audit cannot run without, checked before anything is spawned.
 *
 * Each of these disables a whole tool rather than degrading one, and the
 * probe's verdict is all-or-nothing, so an absent one turns into "9 of 33
 * uncertified" twenty minutes later instead of one line now.
 */
const required = [
  ["OPEN_SCIENCE_WEB_SEARCH_URL", config.webSearchUrl, "web_search reaches no backend"],
  ["OPEN_SCIENCE_GEO_PROBE_URL", config.geoProbeUrl, "geo_visibility_probe reaches no probe host"],
  ["a DeepSeek API key", config.deepseekApiKey, "the managed specialists have no model"],
  ["the EviMed evidence credential", config.publicSourceCredentials?.evimedEvidence, "the EviMed guideline and pharmacy connectors are unauthenticated"],
];
const missing = required.filter(([, value]) => !String(value ?? "").trim());
if (missing.length > 0) {
  for (const [name, , consequence] of missing) console.error(`missing ${name}: ${consequence}`);
  process.exit(2);
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-tool-gateway-"));
// A bare one-line token: the only thing `public_sources._read_bare_token`
// accepts, and the same file the runtime launcher writes.
const gatewayTokenFile = path.join(temporary, "gateway-token");
await fs.writeFile(gatewayTokenFile, auditToken, { mode: 0o600 });

/** The one stub. A live runtime is the single fact this process cannot hold. */
const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (token !== auditToken) throw new Error("inactive audit runtime");
    return { userId: "capability-audit", projectId: "tool-probe" };
  },
};

const routes = new Map([
  [PUBLIC_SOURCE_GATEWAY_PATH, createPublicSourceGatewayHandler(config, runtimeManager)],
  [WEB_SEARCH_GATEWAY_PATH, createWebSearchGatewayHandler(config, runtimeManager)],
  [GEO_PROBE_GATEWAY_PATH, createGeoProbeGatewayHandler(config, runtimeManager)],
  [MODEL_GATEWAY_PATH, createModelGatewayHandler(config, runtimeManager)],
]);

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const route = routes.get(pathname);
  if (!route) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
    return;
  }
  void route(req, res);
});

function listen() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close() {
  return new Promise((resolve) => {
    server.close(resolve);
    // The MCP leaves keep-alive sockets open after its last call; a completed
    // audit must not hang on them.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

/**
 * The managed specialists, as this checkout installs them.
 *
 * Hosted deployments reach each one over its own adapter URL and never see the
 * package; the audit's specialist criterion is a completed *managed job*, which
 * is the locally installed path, so the roots are named here and an absent one
 * is left unset rather than pointed somewhere hopeful.
 */
async function specialistEnvironment() {
  const agents = [
    ["EVIMED_META_AGENT", "meta"],
    ["EVIMED_MR_AGENT", "孟德尔随机化"],
    ["EVIMED_BIBLIOMETRIC_AGENT", "文献剂量分析"],
    ["EVIMED_RESEARCH_TOPIC_AGENT", "科研选题"],
    ["EVIMED_PEER_REVIEW_AGENT", "论文审稿"],
    ["EVIMED_DRUG_SAFETY_AGENT", "药物安全分析agent"],
  ];
  const environment = {};
  for (const [prefix, directory] of agents) {
    const root = path.resolve(repo, "..", "项目代码", directory);
    const python = path.join(root, ".venv", "bin", "python");
    try {
      await fs.access(python);
    } catch {
      console.error(`${directory} has no .venv: its specialist tool cannot be certified here`);
      continue;
    }
    environment[`${prefix}_ROOT`] = root;
    environment[`${prefix}_PYTHON`] = python;
  }
  return environment;
}

function auditScript(argv) {
  const index = argv.indexOf("--script");
  if (index < 0) return { script: "run_tool_audit.py", passthrough: argv };
  const name = argv[index + 1] ?? "";
  if (!/^[a-z0-9_]+\.py$/.test(name)) throw new Error(`--script must name a python file in ${here}`);
  return { script: name, passthrough: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

function runPython(gatewayUrl, specialists) {
  const { script, passthrough } = auditScript(process.argv.slice(2));
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [path.join(here, script), ...passthrough], {
      cwd: repo,
      env: {
        ...process.env,
        ...specialists,
        EVIMED_PUBLIC_SOURCE_GATEWAY_URL: `${gatewayUrl}${PUBLIC_SOURCE_GATEWAY_PATH}`,
        EVIMED_WEB_SEARCH_GATEWAY_URL: `${gatewayUrl}${WEB_SEARCH_GATEWAY_PATH}`,
        EVIMED_GEO_PROBE_GATEWAY_URL: `${gatewayUrl}${GEO_PROBE_GATEWAY_PATH}`,
        EVIMED_MODEL_GATEWAY_URL: `${gatewayUrl}${modelGatewayBase}`,
        EVIMED_MODEL_GATEWAY_MODEL: "deepseek-v4-pro",
        EVIMED_MODEL_GATEWAY_TOKEN_FILE: gatewayTokenFile,
        EVIMED_PUBLIC_CONNECTORS_ENABLED: "1",
        EVIMED_UNPAYWALL_EMAIL: String(config.publicSourceCredentials?.unpaywall ?? ""),
        // A local file, not a gateway hop: the private pharmacy reference is a
        // SQLite the runtime reads directly, and a hosted deployment reaches
        // the same data through its adapter instead.
        EVIMED_PHARMACY_REFERENCE_DB: String(config.pharmacyReferenceDb ?? ""),
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`tool audit terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

let exitCode = 1;
try {
  await listen();
  const { port } = server.address();
  exitCode = await runPython(`http://127.0.0.1:${port}`, await specialistEnvironment());
} finally {
  if (server.listening) await close();
  await fs.rm(temporary, { recursive: true, force: true });
}
process.exitCode = exitCode;
