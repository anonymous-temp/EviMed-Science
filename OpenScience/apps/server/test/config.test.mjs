import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { loadConfig } from "../src/config.mjs";
import { parseByteSize } from "../src/runtimeManager.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function withoutRuntimeEnvironment(run) {
  const names = ["OPEN_SCIENCE_RUNTIME_MODE", "OPEN_SCIENCE_OPENCODE_BIN"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    await run();
  } finally {
    for (const name of names) {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("the runtime mode defaults to a real kernel rather than a mock", async () => {
  // It used to default to "opencode" and point at a bundled binary. There is
  // one kernel now and it ships inside the runtime image, so what remains
  // worth asserting is that the default is the real thing: a default of "mock"
  // would make a deployment answer every question convincingly without ever
  // running an agent.
  await withoutRuntimeEnvironment(async () => {
    const config = loadConfig({ rootDir: repoRoot });
    assert.equal(config.runtimeMode, "kernel");
    assert.equal(config.modelGatewayTimeoutMs, 300_000);
  });
});

test("memory extraction is given longer than one extraction actually takes", () => {
  // Measured against deepseek-v4-pro, one extraction request takes 40-46s. At
  // the previous 30s budget every request aborted, so the store only ever held
  // raw run summaries and never a single extracted memory. The failure was
  // silent because an aborted extraction and an empty one both reported zero.
  const config = loadConfig({ rootDir: repoRoot });
  assert.ok(
    config.memoryExtractionTimeoutMs >= 60_000,
    `memory extraction budget ${config.memoryExtractionTimeoutMs}ms is below one measured request`,
  );
});

// What the deployment's own files hand the process, held against the code.
//
// A `${VAR:-fallback}` in a compose file and a line in .env.example are second
// copies of a default, and a default raised in config.mjs after an incident
// reads as fixed while the container keeps the old number. Three were found on
// production on one day (2026-09-19): the extraction timeout (30 s against
// 120 s), the runtime pids limit (256 against 1024) and its memory (4g against
// 8g) — each raised in code because runs died at the old value, each still in
// force because the compose copy won.
//
// Every value is evaluated through loadConfig itself, in the environment a
// hosted container has, so what is compared is what the process ends up with:
// an empty `${KEY:-}`, a clamp and a derived default all included. A variable
// with no row must leave the whole configuration exactly as the code's default
// leaves it. A row relaxes that for one variable, one way, and says why:
//   gte         a ceiling on legitimate work: less kills or refuses it, more only waits
//   lte         a lifetime or a staleness bound: shorter is stricter, longer is laxer
//   eq          policy the code owns, where neither direction is safer
//   deployment  the value belongs to the deployment; the word says what it is
const HOSTED_ENV = Object.freeze({ NODE_ENV: "production", OPEN_SCIENCE_AUTH_MODE: "local" });
const UNDER_THE_TOOL_CALL_CEILING = "the kernel abandons an MCP call at 180 s; a longer deadline means the gateway's own error never arrives";
const ON_THE_DISPATCH_PATH = "recall runs before a run starts; longer holds every dispatch while the index is down";
const FALLBACK_RULES = {
  OPEN_SCIENCE_RUNTIME_PIDS_LIMIT: ["gte", "runtimePidsLimit", "256 killed three runs with fork(): EAGAIN"],
  OPEN_SCIENCE_RUNTIME_MEMORY_LIMIT: ["gte", "runtimeMemoryLimit", "4g OOM-killed the kernel on 2026-08-26"],
  OPEN_SCIENCE_MEMORY_EXTRACTION_TIMEOUT_MS: ["gte", "memoryExtractionTimeoutMs", "30 s aborted a deep run's extraction on 2026-09-19"],
  OPEN_SCIENCE_MODEL_GATEWAY_TIMEOUT_MS: ["gte", "modelGatewayTimeoutMs", "an idle deadline per streamed chunk; shorter cut reasoning turns off mid-answer"],
  OPEN_SCIENCE_COMMAND_TIMEOUT_MS: ["gte", "commandTimeoutMs", "a queued command's ceiling"],
  OPEN_SCIENCE_RUNTIME_PROXY_CONNECT_TIMEOUT_MS: ["gte", "runtimeProxyConnectTimeoutMs", "compose waits 90 s: a slow container is waited for, not failed"],
  OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS: ["gte", "runtimeProxyRequestTimeoutMs", "a proxied kernel request's ceiling"],
  OPEN_SCIENCE_RUNTIME_CONTROLLER_TIMEOUT_MS: ["gte", "runtimeControllerTimeoutMs", "compose gives a container start 30 s"],
  OPEN_SCIENCE_RUNTIME_PRE_STOP_TRANSCRIPT_TIMEOUT_MS: ["gte", "runtimePreStopTranscriptTimeoutMs", "shorter loses a stopping run's history"],
  OPEN_SCIENCE_OIDC_TIMEOUT_MS: ["gte", "oidcTimeoutMs", "an identity provider's round trip"],
  OPEN_SCIENCE_DOCUMENT_PARSER_TIMEOUT_MS: ["gte", "documentParserTimeoutMs", "a long document's parse"],
  OPEN_SCIENCE_MODEL_GATEWAY_MAX_RESPONSE_BYTES: ["gte", "modelGatewayMaxResponseBytes", "a smaller cap refuses a finished answer"],
  OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_MAX_RESPONSE_BYTES: ["gte", "publicSourceGatewayMaxResponseBytes", "a smaller cap refuses a full text"],
  OPEN_SCIENCE_OPENLIST_MAX_DOWNLOAD_BYTES: ["gte", "openListMaxDownloadBytes", "a smaller cap refuses a document import"],
  OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_TIMEOUT_MS: ["eq", "publicSourceGatewayTimeoutMs", UNDER_THE_TOOL_CALL_CEILING],
  OPEN_SCIENCE_WEB_SEARCH_TIMEOUT_MS: ["eq", "webSearchTimeoutMs", UNDER_THE_TOOL_CALL_CEILING],
  OPEN_SCIENCE_GEO_PROBE_TIMEOUT_MS: ["eq", "geoProbeTimeoutMs", "clamped under the tool-call ceiling; the 360000 compose said was never honoured"],
  OPEN_SCIENCE_OPENVIKING_REQUEST_TIMEOUT_MS: ["eq", "openVikingRequestTimeoutMs", ON_THE_DISPATCH_PATH],
  OPEN_SCIENCE_MEMORY_RERANK_TIMEOUT_MS: ["eq", "memoryRerankTimeoutMs", ON_THE_DISPATCH_PATH],
  OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS: ["eq", "llmRoutingTimeoutMs", "classification runs before a run starts; longer holds the dispatch while the provider hangs"],
  // Quotas: what one account may store, send or read. Higher is laxer, lower
  // refuses real use; the number is a product decision either way.
  OPEN_SCIENCE_MAX_PROJECT_BYTES: ["eq", "maxProjectBytes", "quota"],
  OPEN_SCIENCE_MAX_FILE_BYTES: ["eq", "maxFileBytes", "quota"],
  OPEN_SCIENCE_MAX_JSON_BYTES: ["eq", "maxJsonBytes", "quota, and the controller must agree with the web API"],
  OPEN_SCIENCE_MAX_ARCHIVE_BYTES: ["eq", "maxArchiveBytes", "quota"],
  OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES: ["eq", "maxArchiveEntries", "quota"],
  OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES: ["eq", "maxWorkspaceScanEntries", "scan bound"],
  OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES: ["eq", "maxProjectUsageScanEntries", "scan bound"],
  OPEN_SCIENCE_MAX_LOG_READ_BYTES: ["eq", "maxLogReadBytes", "read bound"],
  OPEN_SCIENCE_MAX_LOG_FILE_BYTES: ["eq", "maxLogFileBytes", "rotation bound"],
  OPEN_SCIENCE_MAX_PROJECTS_PER_USER: ["eq", "maxProjectsPerUser", "quota"],
  OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES: ["eq", "modelGatewayMaxBodyBytes", "the compaction guard is a share of it, in both containers"],
  OPEN_SCIENCE_RATE_LIMIT_WINDOW_MS: ["eq", "rateLimitWindowMs", "rate limit"],
  OPEN_SCIENCE_RATE_LIMIT_MAX_REQUESTS: ["eq", "rateLimitMaxRequests", "rate limit"],
  OPEN_SCIENCE_AUTH_RATE_LIMIT_WINDOW_MS: ["eq", "authRateLimitWindowMs", "rate limit"],
  OPEN_SCIENCE_AUTH_RATE_LIMIT_MAX_REQUESTS: ["eq", "authRateLimitMaxRequests", "rate limit"],
  OPEN_SCIENCE_COMMAND_RATE_LIMIT_WINDOW_MS: ["eq", "commandRateLimitWindowMs", "rate limit"],
  OPEN_SCIENCE_COMMAND_RATE_LIMIT_MAX_REQUESTS: ["eq", "commandRateLimitMaxRequests", "rate limit"],
  // sec2 (2026-09-20): IM inbound fairness.
  OPEN_SCIENCE_IM_INBOUND_PER_MINUTE: ["eq", "imInboundPerMinute", "rate limit"],
  // Capacity on a host shared with other products: more for one tenant is
  // less for the rest, so neither direction is the safe one.
  OPEN_SCIENCE_RUNTIME_CPU_LIMIT: ["eq", "runtimeCpuLimit", "capacity"],
  OPEN_SCIENCE_RUNTIME_TMPFS: ["eq", "runtimeTmpfs", "mount options, compared whole"],
  OPEN_SCIENCE_MAX_CONCURRENT_COMMANDS: ["eq", "maxConcurrentCommands", "capacity"],
  OPEN_SCIENCE_MAX_CONCURRENT_TASKS: ["eq", "maxConcurrentTasks", "capacity"],
  OPEN_SCIENCE_MAX_CONCURRENT_TASKS_PER_PROJECT: ["eq", "maxConcurrentTasksPerProject", "capacity"],
  OPEN_SCIENCE_MAX_QUEUED_TASKS: ["eq", "maxQueuedTasks", "capacity"],
  OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT: ["eq", "maxQueuedTasksPerProject", "capacity"],
  OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS: ["eq", "maxRuntimeProxyConnections", "capacity"],
  OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT: ["eq", "maxRuntimeProxyConnectionsPerProject", "capacity"],
  OPEN_SCIENCE_MAX_RUNNING_RUNTIMES: ["eq", "maxRunningRuntimes", "capacity; the web API and the controller compare it"],
  OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER: ["eq", "maxRunningRuntimesPerUser", "capacity; the web API and the controller compare it"],
  OPEN_SCIENCE_LEARNING_CONCURRENCY: ["eq", "learningConcurrency", "capacity"],
  // Budgets: money and prompt space. A limit nobody chose fires at the worst moment.
  OPEN_SCIENCE_USER_DAILY_SPEND_LIMIT: ["eq", "userDailySpendLimit", "budget"],
  OPEN_SCIENCE_USER_WEEKLY_SPEND_LIMIT: ["eq", "userWeeklySpendLimit", "budget"],
  OPEN_SCIENCE_USER_RUN_SPEND_LIMIT: ["eq", "userRunSpendLimit", "budget"],
  OPEN_SCIENCE_MEMORY_CONTEXT_LIMIT: ["eq", "memoryContextLimit", "prompt budget"],
  OPEN_SCIENCE_MEMORY_CONTEXT_MAX_CHARS: ["eq", "memoryContextMaxChars", "prompt budget"],
  OPEN_SCIENCE_GATE_REPAIR_ROUNDS: ["eq", "gateRepairRounds", "0 since the 2026-09-17 ruling"],
  OPEN_SCIENCE_LLM_ROUTING_CONFIDENCE_THRESHOLD: ["eq", "llmRoutingConfidenceThreshold", "classifier policy"],
  // Cadences: how often and how long a worker holds work.
  OPEN_SCIENCE_AUTOPILOT_POLL_MS: ["eq", "autopilotPollMs", "cadence"],
  OPEN_SCIENCE_AUTOPILOT_LEASE_MS: ["eq", "autopilotLeaseMs", "lease"],
  OPEN_SCIENCE_RUNTIME_CONTROLLER_POLL_MS: ["eq", "runtimeControllerPollMs", "cadence"],
  OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS: ["eq", "runtimeQuotaCheckIntervalMs", "cadence"],
  OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS: ["eq", "runtimeIdleTimeoutMs", "the idle reaper; thirty minutes is product policy"],
  OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS: ["eq", "backupIntervalSeconds", "cadence"],
  OPEN_SCIENCE_BACKUP_HEALTH_GRACE_SECONDS: ["eq", "backupHealthGraceSeconds", "alert grace"],
  OPEN_SCIENCE_SESSION_TTL_MS: ["lte", "sessionTtlMs", "a login's lifetime"],
  OPEN_SCIENCE_OIDC_FLOW_TTL_MS: ["lte", "oidcFlowTtlMs", "a sign-in flow's lifetime"],
  OPEN_SCIENCE_RUNTIME_UI_FRAME_TTL_MS: ["lte", "runtimeUiFrameTtlMs", "compose makes a frame ticket thirty minutes; the frame renews it at half of what is left"],
  OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_MAX_AGE_MS: ["lte", "deepseekReleaseReceiptMaxAgeMs", "staleness bound"],
  OPEN_SCIENCE_POSTGRES_BACKUP_MAX_AGE_SECONDS: ["lte", "postgresBackupMaxAgeSeconds", "staleness bound"],
  // A feature module the hosted deployment turns on (the IM module, 2026-09-20):
  // off is the code's default because it needs a public URL and PostgreSQL.
  OPEN_SCIENCE_IM_ENABLED: ["deployment", "switch"],
  OPEN_SCIENCE_PUBLIC_URL: ["deployment", "url"],
  OPEN_SCIENCE_OPENVIKING_URL: ["deployment", "url"],
  OPEN_SCIENCE_DOCUMENT_PARSER_URL: ["deployment", "url"],
  EVIMED_PHARMACY_REFERENCE_SEARCH_URL: ["deployment", "url"],
  EVIMED_ADR_CASE_QUERY_URL: ["deployment", "url"],
  EVIMED_ADR_SIGNAL_ANALYSIS_URL: ["deployment", "url"],
  EVIMED_OFFLABEL_EVIDENCE_PACKET_URL: ["deployment", "url"],
  EVIMED_COMPREHENSIVE_DRUG_EVALUATION_URL: ["deployment", "url"],
  EVIMED_DRUG_SELECTION_EVALUATION_URL: ["deployment", "url"],
  EVIMED_META_ANALYSIS_URL: ["deployment", "url"],
  EVIMED_MR_ANALYSIS_URL: ["deployment", "url"],
  EVIMED_BIBLIOMETRIC_ANALYSIS_URL: ["deployment", "url"],
  EVIMED_RESEARCH_TOPIC_SELECTION_URL: ["deployment", "url"],
  EVIMED_PEER_REVIEW_URL: ["deployment", "url"],
  EVIMED_DRUG_SAFETY_ANALYSIS_URL: ["deployment", "url"],
  OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: ["deployment", "provider"],
  OPEN_SCIENCE_DEEPSEEK_PROVIDER_ENABLED: ["deployment", "provider"],
  OPEN_SCIENCE_RUNTIME_SANDBOX_MODE: ["deployment", "sandbox"],
  OPEN_SCIENCE_RUNTIME_DATA_VOLUME: ["deployment", "volume"],
  OPEN_SCIENCE_RUNTIME_NETWORK_MODE: ["deployment", "network"],
  OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME: ["deployment", "network"],
  OPEN_SCIENCE_RUNTIME_UI_PORT: ["deployment", "port"],
  OPEN_SCIENCE_TRUST_PROXY: ["deployment", "proxy"],
  OPEN_SCIENCE_REQUIRE_ALL_SPECIALIST_ADAPTERS: ["deployment", "requirement"],
  OPEN_SCIENCE_BACKUP_MODE: ["deployment", "mode"],
  OPEN_SCIENCE_BACKUP_RETENTION_DAYS: ["deployment", "retention"],
  OPEN_SCIENCE_BACKUP_DIR: ["deployment", "path"],
  OPEN_SCIENCE_BACKUP_STATE_FILE: ["deployment", "path"],
  OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_FILE: ["deployment", "path"],
  OPEN_SCIENCE_BOOTSTRAP_USER: ["deployment", "identity"],
  OPEN_SCIENCE_RELEASE_ID: ["deployment", "release"],
  OPEN_SCIENCE_SOURCE_REVISION: ["deployment", "release"],
  OPEN_SCIENCE_BUILD_CREATED: ["deployment", "release"],
  OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_ID: ["deployment", "release"],
  OPEN_SCIENCE_DEEPSEEK_CONFIG_REVISION: ["deployment", "release"],
  OPEN_SCIENCE_LEARNING_EVALUATION_COMMAND: ["deployment", "command"],
  OPEN_SCIENCE_OPERATOR_METRICS_TOKEN: ["deployment", "credential"],
  OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE: ["deployment", "credential"],
  OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: ["deployment", "credential"],
  OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE: ["deployment", "credential"],
  OPEN_SCIENCE_EVIMED_API_KEY_FILE: ["deployment", "credential"],
  OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_FILE: ["deployment", "credential"],
  OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE: ["deployment", "credential"],
  OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE: ["deployment", "credential"],
};

/** loadConfig under exactly `env` — nothing from the shell that runs the test. */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try {
    return loadConfig({ rootDir: repoRoot });
  } finally {
    process.env = saved;
  }
}

/** Every variable loadConfig reads, observed rather than grepped: a name built
 *  at run time (`${valueEnv}_FILE`, the specialist roots) is read all the same. */
function variablesLoadConfigReads() {
  const read = new Set();
  const saved = process.env;
  process.env = new Proxy({ ...HOSTED_ENV }, {
    get(target, name) {
      if (typeof name === "string") read.add(name);
      return target[name];
    },
  });
  try {
    loadConfig({ rootDir: repoRoot });
  } finally {
    process.env = saved;
  }
  return read;
}

/** `${A:-${B:-x}}` resolves to `x` when neither is set; `${A:?msg}` has no fallback. */
function composeFallback(value) {
  let text = String(value);
  let fallback = null;
  for (let match; (match = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-(.*)\}$/s.exec(text));) fallback = text = match[1];
  return fallback;
}

/** Every value a deployment's files hand a process when .env says nothing about
 *  it: compose fallbacks per service (merge keys resolved, so the shared
 *  `x-runtime-caps` block counts once per service that merges it), and every
 *  uncommented line of .env.example, which is what an operator copies. */
async function deploymentValues() {
  const deployDir = path.join(repoRoot, "deploy/web");
  const names = (await readdir(deployDir)).filter((name) => /^docker-compose.*\.yml$/.test(name)).sort();
  const values = [];
  for (const name of names) {
    const document = YAML.parse(await readFile(path.join(deployDir, name), "utf8"), { merge: true });
    for (const [service, definition] of Object.entries(document?.services ?? {})) {
      const environment = Array.isArray(definition?.environment)
        ? Object.fromEntries(definition.environment.map((entry) => String(entry).split(/=(.*)/s, 2)))
        : definition?.environment ?? {};
      const command = [definition?.command ?? []].flat().join(" ");
      for (const [variable, value] of Object.entries(environment)) {
        const fallback = value == null ? null : composeFallback(value);
        if (fallback != null) values.push({ where: `${name} ${service}`, file: name, service, command, variable, value: fallback });
      }
    }
  }
  const example = await readFile(path.join(deployDir, ".env.example"), "utf8");
  for (const [, variable, raw] of example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    // Compose's own .env reading strips one pair of matching quotes.
    const value = /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
    values.push({ where: ".env.example", file: ".env.example", service: "", command: "", variable, value });
  }
  return { composeFiles: names, values };
}

/** Numbers, and docker sizes as bytes; anything else compares as text. */
function magnitude(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  return /^\d+(?:\.\d+)?\s*[kmgt]?b?$/i.test(text) ? (Number(text) || parseByteSize(text)) : text;
}

test("no deployment file hands the process a default the code does not have", async () => {
  const read = variablesLoadConfigReads();
  const { composeFiles, values } = await deploymentValues();
  const configured = values.filter(({ variable }) => read.has(variable));

  // The walk must prove it walked: a parse that silently finds nothing passes
  // every rule below.
  assert.ok(read.size >= 200, `loadConfig was seen reading ${read.size} variables; the observation is broken`);
  assert.ok(composeFiles.length >= 8, `found ${composeFiles.length} compose files; the scan is wrong, not the directory`);
  assert.ok(configured.length >= 250, `found ${configured.length} deployment values loadConfig reads; the parse is wrong`);
  const carriers = (variable) => configured.filter((entry) => entry.variable === variable).map((entry) => entry.where);
  for (const [variable, expected] of [
    ["OPEN_SCIENCE_RUNTIME_PIDS_LIMIT", ["docker-compose.yml open-science-web", "docker-compose.yml open-science-runtime-controller", ".env.example"]],
    ["OPEN_SCIENCE_RUNTIME_MEMORY_LIMIT", ["docker-compose.yml open-science-web", "docker-compose.yml open-science-runtime-controller", ".env.example"]],
    ["OPEN_SCIENCE_MEMORY_EXTRACTION_TIMEOUT_MS", ["docker-compose.yml open-science-web", ".env.example"]],
    // Only reachable through the `<<: *runtime-caps` merge.
    ["OPEN_SCIENCE_MAX_RUNNING_RUNTIMES", ["docker-compose.yml open-science-web", "docker-compose.yml open-science-runtime-controller"]],
  ]) {
    for (const where of expected) {
      assert.ok(carriers(variable).includes(where), `the walk did not find ${variable} in ${where}; it walked past the value this test exists for`);
    }
  }
  const limitRows = Object.values(FALLBACK_RULES).filter(([rule]) => rule !== "deployment");
  assert.ok(limitRows.length >= 60, `the table decides ${limitRows.length} limits; rows were lost`);

  const defaults = configUnder(HOSTED_ENV);
  const problems = [];
  for (const { where, variable, value } of configured) {
    const [rule, key, why] = FALLBACK_RULES[variable] ?? ["same"];
    if (rule === "deployment") continue;
    let config;
    try {
      config = configUnder({ ...HOSTED_ENV, [variable]: value });
    } catch (error) {
      problems.push(`${where}: ${variable}=${JSON.stringify(value)} makes loadConfig throw: ${error.message}`);
      continue;
    }
    if (rule === "same") {
      const changed = Object.keys(defaults).filter((name) => !isDeepStrictEqual(config[name], defaults[name]));
      if (changed.length > 0) {
        problems.push(`${where}: ${variable}=${JSON.stringify(value)} changes ${changed.map((name) => `${name} from ${JSON.stringify(defaults[name])} to ${JSON.stringify(config[name])}`).join(", ")}; use the code's default, or give it a row in FALLBACK_RULES`);
      }
      continue;
    }
    assert.ok(Object.hasOwn(defaults, key), `FALLBACK_RULES names ${key} for ${variable}, which loadConfig does not return`);
    const code = magnitude(defaults[key]);
    // Both the number as written and the number the process keeps: a clamp
    // makes the second agree while the first tells the operator something false.
    const failing = [magnitude(config[key]), ...(String(value).trim() === "" ? [] : [magnitude(value)])]
      .find((given) => !(rule === "gte" ? given >= code : rule === "lte" ? given <= code : given === code));
    if (failing !== undefined) {
      problems.push(`${where}: ${variable}=${JSON.stringify(value)} gives ${key} ${JSON.stringify(failing)} against the code's ${JSON.stringify(code)} (${rule}: ${why})`);
    }
  }
  assert.deepEqual(problems, []);

  // A row for a variable no deployment file sets any more protects nothing.
  const seen = new Set(configured.map(({ variable }) => variable));
  assert.deepEqual(Object.keys(FALLBACK_RULES).filter((variable) => !seen.has(variable)), [], "rows for variables no deployment file sets; drop them");
});

test("the schedulers' own defaults agree with the compose files that start them", async () => {
  // The backup and receipt schedulers read their knobs themselves, through
  // `integerEnv(name, default, bounds)`, not through loadConfig. Same class,
  // second copy: the service that runs the script must hand it the script's
  // own number when .env is silent.
  const { values } = await deploymentValues();
  let compared = 0;
  for (const script of ["scripts/ops/backup-scheduler.mjs", "scripts/ops/release-receipt-scheduler.mjs"]) {
    const source = await readFile(path.join(repoRoot, script), "utf8");
    const defaults = new Map([...source.matchAll(/integerEnv\("([A-Z0-9_]+)", ([\d_]+)/g)]
      .map(([, variable, number]) => [variable, Number(number.replaceAll("_", ""))]));
    assert.ok(defaults.size >= 4, `read ${defaults.size} integer defaults from ${script}; the parse is wrong`);
    const services = new Set(values.filter(({ command }) => command.includes(script)).map(({ service }) => service));
    assert.ok(services.size >= 1, `no compose service runs ${script}; the scan is wrong`);
    for (const { where, service, variable, value } of values) {
      if (!defaults.has(variable) || !(services.has(service) || where === ".env.example")) continue;
      compared += 1;
      assert.equal(Number(value), defaults.get(variable), `${where}: ${variable}=${value}, but ${script} defaults it to ${defaults.get(variable)}`);
    }
  }
  assert.ok(compared >= 10, `compared ${compared} scheduler values; the walk found too few`);
});

test("the routing classifier has its own total deadline, not the gateway's streaming idle time", () => {
  // It borrowed modelGatewayTimeoutMs (300 s of streaming idle, clamped to
  // 120 s), so a hung provider held a dispatch for two minutes.
  const saved = process.env.OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS;
  delete process.env.OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS;
  try {
    assert.equal(loadConfig({ rootDir: repoRoot }).llmRoutingTimeoutMs, 20_000);
    assert.equal(loadConfig({ rootDir: repoRoot, llmRoutingTimeoutMs: 5_000 }).llmRoutingTimeoutMs, 5_000);
    process.env.OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS = "8000";
    assert.equal(loadConfig({ rootDir: repoRoot }).llmRoutingTimeoutMs, 8_000);
  } finally {
    if (saved == null) delete process.env.OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS;
    else process.env.OPEN_SCIENCE_LLM_ROUTING_TIMEOUT_MS = saved;
  }
});

test("the retired kernel's runtime mode is refused by name, not ignored", async () => {
  // The value "opencode" meant "a real kernel in a container" back when there
  // was only one. A deployment still setting it is configuring something this
  // build does not contain, and accepting it silently would leave that
  // deployment believing it had chosen something.
  await withoutRuntimeEnvironment(async () => {
    assert.throws(
      () => loadConfig({ rootDir: repoRoot, runtimeMode: "opencode" }),
      /OPEN_SCIENCE_RUNTIME_MODE no longer accepts "opencode"/,
      "the retired value must name its replacement rather than being aliased away",
    );
  });
});

test("the mock runtime must be selected explicitly", async () => {
  const config = loadConfig({ rootDir: repoRoot, runtimeMode: "mock" });
  assert.equal(config.runtimeMode, "mock");
});

test("Materials Project credentials load from a private server-only file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-materials-config-"));
  try {
    const secret = path.join(root, "materials-project-api-key.txt");
    await writeFile(secret, "test-materials-project-key\n", { mode: 0o600 });
    const config = loadConfig({ rootDir: repoRoot, materialsProjectApiKeyFile: secret });
    assert.equal(config.materialsProjectApiKey, "test-materials-project-key");
    assert.equal(config.materialsProjectApiKeySource, "file");
    assert.equal(config.materialsProjectApiKeyError, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file secrets accept 8 KiB content plus one line ending and reject larger content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-secret-limit-"));
  try {
    const secret = path.join(root, "bootstrap-password.txt");
    await writeFile(secret, `${"x".repeat(8192)}\r\n`, { mode: 0o600 });
    const accepted = loadConfig({ rootDir: repoRoot, bootstrapPasswordFile: secret });
    assert.equal(Buffer.byteLength(accepted.bootstrapPassword, "utf8"), 8192);
    assert.equal(accepted.bootstrapPasswordError, null);
    await writeFile(secret, "x".repeat(8193), { mode: 0o600 });
    const rejected = loadConfig({ rootDir: repoRoot, bootstrapPasswordFile: secret });
    assert.equal(rejected.bootstrapPassword, "");
    assert.equal(rejected.bootstrapPasswordError, "bootstrap_password_file_too_large");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credentialed public-source adapters load server-only credentials from private files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-public-source-config-"));
  try {
    const secret = path.join(root, "umls-api-key.txt");
    await writeFile(secret, "test-umls-key\n", { mode: 0o600 });
    const config = loadConfig({ rootDir: repoRoot, umlsApiKeyFile: secret });
    assert.equal(config.publicSourceCredentials.umls, "test-umls-key");
    assert.equal(config.publicSourceCredentialSources.umls, "file");
    assert.equal(config.publicSourceCredentialErrors.umls, null);
    // Named, not counted. A bare count told you a number had changed and
    // nothing about which credential appeared or vanished -- and a rename
    // would have kept it passing.
    assert.deepEqual(Object.keys(config.publicSourceCredentials).sort(), [
      "addgene",
      "core",
      "evimedEvidence",
      "ncbi",      // rate ceiling, not authorization: injected by host
      "omim",
      "openFda",   // same
      "opengwas",
      "semanticScholar",
      "umls",
      "unpaywall",
      "biogrid",
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EviMed evidence credentials load from a private server-only file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-evidence-config-"));
  try {
    const secret = path.join(root, "evimed-api-key.txt");
    await writeFile(secret, "test-evimed-key\n", { mode: 0o600 });
    const config = loadConfig({ rootDir: repoRoot, evimedApiKeyFile: secret });
    assert.equal(config.publicSourceCredentials.evimedEvidence, "test-evimed-key");
    assert.equal(config.publicSourceCredentialSources.evimedEvidence, "file");
    assert.equal(config.publicSourceCredentialErrors.evimedEvidence, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in local auto configuration loads mode-600 EviMed service secrets", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "evimed-local-config-"));
  try {
    const rootDir = path.join(parent, "OpenScience");
    const secretsDir = path.join(parent, ".evimed-local", "secrets");
    await Promise.all([mkdir(rootDir), mkdir(secretsDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(secretsDir, "deepseek.api-key"), "test-deepseek-key\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "evimed.api-key"), "test-evimed-key\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "model-gateway.signing"), "model-signing-secret-with-at-least-32-bytes\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "evimed-workload.signing"), "workload-signing-secret-with-at-least-32-bytes\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "dashscope.api-key"), "test-dashscope-key\n", { mode: 0o600 }),
      writeFile(path.join(secretsDir, "bootstrap-password"), "local-password-with-at-least-16-bytes\n", { mode: 0o600 }),
    ]);

    const disabled = loadConfig({ rootDir, localAutoConfig: false });
    assert.equal(disabled.deepseekProviderEnabled, false);
    assert.equal(disabled.dashscopeApiKey, "");

    const enabled = loadConfig({ rootDir, localAutoConfig: true });
    assert.equal(enabled.deepseekProviderEnabled, true);
    assert.equal(enabled.deepseekApiKeySource, "file");
    assert.equal(enabled.publicSourceCredentialSources.evimedEvidence, "file");
    assert.equal(enabled.modelGatewaySigningSecretSource, "file");
    assert.equal(enabled.evimedWorkloadSigningSecretSource, "file");
    assert.equal(enabled.dashscopeApiKeySource, "file");
    assert.equal(enabled.bootstrapPasswordSource, "file");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the agent run monitor outlasts a systematic review by default", () => {
  assert.equal(loadConfig({ dataDir: "/tmp/os-config-monitor" }).agentRunMonitorTimeoutMs, 4 * 60 * 60_000);
});

test("the agent run monitor timeout is configurable", () => {
  const config = loadConfig({ dataDir: "/tmp/os-config-monitor", agentRunMonitorTimeoutMs: 90 * 60_000 });
  assert.equal(config.agentRunMonitorTimeoutMs, 90 * 60_000);
});

// The shipped default is a posture, not a preference, so it is pinned by a test
// rather than left to whoever edits the file next.
//
// It read `opencode` "until the DSH session view lands", and that condition was
// met on 2026-08-31: the session layer was accepted on a real DSH run — 3981
// frames, terminal `succeeded`, a reconnect at seq 40 that lost and repeated
// nothing. So this now pins the other side.
//
// The environment variable is the rollback lever for the change window, and it
// is the only reason the appendix-B trees still exist. Deleting them in the same
// change as the flip would have removed every way back in the same second the
// switch was thrown; they are frozen instead, and come out in their own change
// after the quiet period. A frozen rollback lever is not a second stack.
test("the kernel is not selectable, and the variable that used to select it is refused", () => {
  // This file used to assert that OPEN_SCIENCE_RUNTIME_KERNEL=opencode still
  // worked, with the note "if this stops working the appendix-B deletion has
  // effectively happened already". It has happened: the product owner dropped
  // the rollback requirement, and the second kernel is gone.
  //
  // So the assertion inverts. A deployment still exporting that variable is
  // reaching for a lever that no longer exists, and it must be told rather than
  // have its setting quietly do nothing -- which is what the whole suite spent
  // this migration learning to detect.
  const saved = process.env.OPEN_SCIENCE_RUNTIME_KERNEL;
  delete process.env.OPEN_SCIENCE_RUNTIME_KERNEL;
  try {
    assert.equal(loadConfig({ dataDir: "/tmp/os-config-kernel" }).runtimeKernel, undefined);
    process.env.OPEN_SCIENCE_RUNTIME_KERNEL = "opencode";
    assert.throws(
      () => loadConfig({ dataDir: "/tmp/os-config-kernel" }),
      /OPEN_SCIENCE_RUNTIME_KERNEL/,
    );
  } finally {
    if (saved == null) delete process.env.OPEN_SCIENCE_RUNTIME_KERNEL;
    else process.env.OPEN_SCIENCE_RUNTIME_KERNEL = saved;
  }
});

// The same property, for the memory service that was retired into a schema of
// the control-plane database. A renamed budget is the dangerous half: an
// operator who had raised OPEN_SCIENCE_MEMOS_CONTEXT_LIMIT would otherwise go
// back to eight memories per prompt and be told nothing at all.
test("the retired memory variables are refused by name, and the budget keeps its meaning under the new one", () => {
  const retired = {
    OPEN_SCIENCE_MEMOS_URL: "http://memos.internal",
    OPEN_SCIENCE_MEMOS_ACCESS_TOKEN: "pat",
    OPEN_SCIENCE_MEMOS_ACCESS_TOKEN_FILE: "/run/secrets/memos-pat",
    OPEN_SCIENCE_MEMOS_REQUEST_TIMEOUT_MS: "8000",
    OPEN_SCIENCE_REQUIRE_MEMOS: "true",
    OPEN_SCIENCE_MEMOS_CONTEXT_LIMIT: "12",
    OPEN_SCIENCE_MEMOS_CONTEXT_MAX_CHARS: "40000",
    OPEN_SCIENCE_MEMOS_ENGINE_URL: "http://memos-engine:8001",
    OPEN_SCIENCE_REQUIRE_MEMORY_INDEX: "true",
  };
  for (const [name, value] of Object.entries(retired)) {
    const saved = process.env[name];
    process.env[name] = value;
    try {
      assert.throws(() => loadConfig({ dataDir: "/tmp/os-config-memory" }), new RegExp(name),
        `${name} is still read, or is ignored in silence`);
    } finally {
      if (saved == null) delete process.env[name];
      else process.env[name] = saved;
    }
  }

  const config = loadConfig({ dataDir: "/tmp/os-config-memory" });
  assert.equal(config.memoryContextLimit, 8);
  assert.equal(config.memoryContextMaxChars, 20_000);
  assert.equal(config.requireMemos, undefined, "the requirement flag is gone: the store exists with the database");
  const raised = loadConfig({ dataDir: "/tmp/os-config-memory", memoryContextLimit: 12, memoryContextMaxChars: 40_000 });
  assert.equal(raised.memoryContextLimit, 12);
  assert.equal(raised.memoryContextMaxChars, 40_000);
});

test("the reranker defaults to the pins the index's own compatibility is recorded under", async () => {
  const pins = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
  const config = loadConfig({ dataDir: "/tmp/os-config-rerank" });
  assert.equal(config.memoryRerankModel, pins.openviking.rerank.model);
  assert.equal(config.memoryRerankApiBase, pins.openviking.rerank.apiBase);
  assert.equal(config.memoryRerankTimeoutMs, pins.openviking.rerank.timeoutMs);
});

test("the thinking effort is a closed vocabulary, refused at load rather than upstream", () => {
  assert.equal(loadConfig({ rootDir: repoRoot }).deepseekReasoningEffort, "high");
  assert.equal(loadConfig({ rootDir: repoRoot, deepseekReasoningEffort: "MAX" }).deepseekReasoningEffort, "max");
  // A typo here used to ride to the provider on every call and be refused
  // there, one run at a time, with a provider error nobody had configured.
  assert.throws(() => loadConfig({ rootDir: repoRoot, deepseekReasoningEffort: "highest" }), /OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT must be one of low, high, max/);
});
