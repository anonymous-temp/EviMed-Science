// A deployment knob that cannot reach the process it configures.
//
// The web service passes environment item by item — there is no env_file on it
// — so a variable absent from that list is absent from the container no matter
// what .env says. Two load-bearing ones were missing, and both fail in the
// shape this codebase keeps meeting: nothing happens, and nothing says so.
//
//   OPEN_SCIENCE_RUNTIME_KERNEL was the kernel rollback lever, and it is the
//   reason this file exists: with the shipped default `dsh`, setting it back in
//   .env and restarting would have left the deployment on DSH, reported
//   success, and told the operator that rolling back did not help — the worst
//   possible answer to get mid-incident. The lever is gone with the kernel it
//   led to, and the variable is refused by name; the property outlived both.
//
//   OPEN_SCIENCE_SAAS_PROFILE_UNCONFIGURED declares, one at a time, the
//   surfaces this deployment has chosen not to configure. Undeliverable, it
//   leaves readiness red with exactly the same four items it was red with
//   before, so the declaration reads as having been rejected.
//
// The value-less form (`KEY:`) is deliberate and was verified against the
// deployment host's own Compose: set in .env it passes the value through, and
// unset it is absent from the container rather than empty. `${KEY:-}` would
// deliver an empty string, which `Number("")` turns into 0 and a validating
// parser turns into a startup failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const deployDir = path.join(repoRoot, "deploy/web");

/** Variables the deployment sets for a host-side ops script, which never enters
 *  a container. The exemption names the script, and the test reads that script:
 *  an entry that stops being true stops protecting anything. */
const hostSideOnly = {
  OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PREFLIGHT_MIN_FREE_BYTES: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PREFLIGHT_MONITORING: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PRODUCTION_STATE_SECRETS_DIR: "scripts/ops/configure-production-state.mjs",
  // Read on the host before anything starts: it is written into
  // monitoring/targets/tls.json, which Prometheus then discovers by file. The
  // value never enters a container, so passing it through compose would be the
  // pretence this test exists to refuse.
  OPEN_SCIENCE_PUBLIC_HEALTH_URL: "scripts/ops/configure-monitoring.mjs",
};

/** The levers whose whole purpose is to be set at deploy time, and the services
 *  that have to receive them.
 *
 *  `OPEN_SCIENCE_RUNTIME_KERNEL` used to head this list. It was the kernel
 *  rollback lever, and it is gone with the kernel it rolled back to — the
 *  variable is refused by name now, so a deployment that still set it would be
 *  told so at startup rather than ignored. What stays is the property it was
 *  written to prove: a documented lever that no service receives is a knob that
 *  does nothing and says nothing. */
const operatorLevers = {
  OPEN_SCIENCE_RUNTIME_UI_PROXY_ENABLED: ["open-science-web", "open-science-runtime-controller"],
  // Both launch paths must install the optional MCP; its private token stays on web.
  OPEN_SCIENCE_TOOLUNIVERSE_MCP_URL: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_TOOLUNIVERSE_GATEWAY_INTERNAL_URL: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_SAAS_PROFILE_UNCONFIGURED: ["open-science-web"],
  // The way back to server-side repair rounds, off by default since
  // 2026-09-17. A lever that does not arrive leaves an operator believing the
  // gate sends packages back when it attaches its findings instead.
  OPEN_SCIENCE_GATE_REPAIR_ROUNDS: ["open-science-web"],
  // Declared `true` in .env.example and read by config.mjs, and for a while
  // passed by neither compose service: an operator turning the LLM fallback
  // classifier off got the shipped default and no indication their setting had
  // been dropped on the floor.
  OPEN_SCIENCE_LLM_ROUTING_ENABLED: ["open-science-web"],
  // The learning loop defaults on since 2026-09-08, which is what makes the
  // off switch load-bearing: a deployment that decides not to spend on
  // distillation edits `.env`, and if the variable never reaches the service
  // the loop keeps running and nothing says so. The window and the concurrency
  // are the other two knobs that bound what "on" costs.
  OPEN_SCIENCE_LEARNING_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_WINDOW: ["open-science-web"],
  // The zone the window is written in. Read by config.mjs since 2026-09-15 and
  // passed by no compose file until 2026-09-20, so the window ran on UTC.
  OPEN_SCIENCE_LEARNING_WINDOW_TIMEZONE: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_CONCURRENCY: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_RUN_LIMIT_CNY: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_DAILY_LIMIT_CNY: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_WEEKLY_LIMIT_CNY: ["open-science-web"],
  // The thinking budget was a literal `high` in the gateway until 2026-09-09,
  // so the lever is new and this is what makes it real.
  OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT: ["open-science-web"],
  // Selecting a recall index is a deployment decision, and the failure mode of
  // a missing lever here is the quiet one: the deployment keeps whichever
  // provider the compose default names — `openviking` since 2026-09-11, so an
  // operator who chose `builtin` keeps paying for embeddings — and every recall
  // still returns memories, which is why nothing ever reports the setting was
  // dropped.
  OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: ["open-science-web"],
  OPEN_SCIENCE_MEMORY_INDEX_STRICT: ["open-science-web"],
  OPEN_SCIENCE_OPENVIKING_URL: ["open-science-web"],
  OPEN_SCIENCE_OPENVIKING_ACCOUNT: ["open-science-web"],
  // Read by config.mjs and passed by no compose file until 2026-09-16: turning
  // memory off, opening the agent memory API, or excluding an evaluation's
  // projects from extraction all did nothing from .env. The last one reached
  // production only through a private override's environment map.
  OPEN_SCIENCE_MEMORY_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_MEMORY_EXTRACTION_EXCLUDED_PROJECT_PREFIXES: ["open-science-web"],
  // The two delegation limits that replaced `maxParallelChildren` (2026-09-18).
  // The controller builds the hosted launch plan and so is the service that
  // actually writes them into a runtime container; the web API builds it when
  // it launches directly. The old variable reached neither.
  OPEN_SCIENCE_MAX_CHILDREN_TOTAL: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_MAX_CONCURRENT_CHILDREN: ["open-science-web", "open-science-runtime-controller"],
  // Read by harness-port's compactionConfigFromEnv in both services and passed
  // by no compose file until 2026-09-18: the threshold lever the review's
  // cheapest experiment (0.8 -> 0.5) needs did nothing from .env, and the
  // controller, which writes it into every runtime, never saw it. The gateway
  // body limit reaches the controller because the request-size guard is a
  // share of it.
  OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_THRESHOLD_RATIO: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_RATIO: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_TOKENS: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_TOKENS: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_REQUEST_BYTES: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES: ["open-science-web", "open-science-runtime-controller"],
  // The socket plugins' off switches (2026-09-27): the controller writes them
  // into every runtime, so a list that reached only the web API would measure
  // a plugin "off" that every runtime still ran.
  OPEN_SCIENCE_RUNTIME_DISABLED_SOCKET_PLUGINS: ["open-science-web", "open-science-runtime-controller"],
  // How long an idle runtime stays warm and when it gives way (2026-09-22):
  // the web API's runtime manager keeps and reaps them.
  OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS: ["open-science-web"],
  OPEN_SCIENCE_RUNTIME_IDLE_YIELD_AFTER_MS: ["open-science-web"],
  // The frame layer's per-body off switches: the control every body is
  // measured against has to be reachable from .env.
  OPEN_SCIENCE_RUNTIME_UI_FRAME_OFF: ["open-science-web"],
  // Automatic run titles default on and spend a model call per run; the off
  // switch has to arrive (2026-09-18).
  OPEN_SCIENCE_RUN_TITLES_ENABLED: ["open-science-web"],
  // The memory evaluation's control arm is this switch; an ablation whose
  // "off" arm silently recalled would measure nothing (2026-09-18).
  OPEN_SCIENCE_MEMORY_RECALL_ENABLED: ["open-science-web"],
  // The IM module and its reservations (2026-09-20). The module switch is how a
  // deployment turns Feishu on; each channel switch and device sign-in is a
  // lever that must be able to stay off, and a lever that never arrives cannot.
  OPEN_SCIENCE_IM_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_IM_PROGRESS_INTERVAL_MS: ["open-science-web"],
  OPEN_SCIENCE_IM_CONVERSATION_IDLE_MINUTES: ["open-science-web"],
  // sec2 (2026-09-20): the per-chat inbound limit is a lever a deployment tunes.
  OPEN_SCIENCE_IM_INBOUND_PER_MINUTE: ["open-science-web"],
  OPEN_SCIENCE_CHANNEL_WECHAT_SERVICE_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_CHANNEL_WECHAT_CLAWBOT_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_CHANNEL_EMAIL_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_CHANNEL_APP_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_CHANNEL_DINGTALK_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_CHANNEL_WECOM_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_APP_API_ENABLED: ["open-science-web"],
  // Knowledge-base search's off switch, which also stops indexing and
  // embedding spend; one that never arrived would keep paying (2026-09-20).
  OPEN_SCIENCE_KB_SEARCH_ENABLED: ["open-science-web"],
  // mem stream (2026-09-20): with no confirmation step, how long an unrepeated
  // inference stays in force is the lever that bounds what automatic memory
  // keeps.
  OPEN_SCIENCE_MEMORY_INFERRED_TTL_DAYS: ["open-science-web"],
  // rt (2026-09-20): the sign-in warm start's off switch. It starts a runtime
  // per sign-in, which is exactly why a deployment must be able to stop it.
  OPEN_SCIENCE_RUNTIME_WARM_ON_SIGN_IN: ["open-science-web"],
  // rt (2026-09-20): the runtime provider switch and what an AgentBay
  // deployment cannot run without. A provider that does not arrive leaves the
  // deployment on Docker while the operator believes it moved.
  OPEN_SCIENCE_RUNTIME_PROVIDER: ["open-science-web"],
  OPEN_SCIENCE_AGENTBAY_IMAGE_ID: ["open-science-web"],
  OPEN_SCIENCE_AGENTBAY_SANDBOX_ENFORCEMENT: ["open-science-web"],
  OPEN_SCIENCE_AGENTBAY_BRIDGE_SECRET_MODE: ["open-science-web"],
  OPEN_SCIENCE_RUNTIME_GATEWAY_PUBLIC_URL: ["open-science-web"],
  // rt (2026-09-20): the two community client bundles' off switches. A switch
  // that does not arrive leaves a broken bundle in every runtime.
  OPEN_SCIENCE_RUNTIME_ANNOTATION_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_RUNTIME_MERMAID_ENABLED: ["open-science-web"],
  // 「前沿动态」 and the knowledge-source plugin (2026-09-22). The module
  // switch, its audience and preview list are how the one-week dry run is run
  // and ended; the budget, the model and the cadences bound what "on" costs;
  // the plugin's address, token file and contract floor are what makes it read
  // anything. A lever that does not arrive leaves the feed on, or off, or
  // paying, with the operator believing otherwise.
  OPEN_SCIENCE_FRONTIER_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_AUDIENCE: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_PREVIEW_USERS: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_POLL_MS: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_LEASE_MS: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_MODEL: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_DAILY_TIME: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_TIMEZONE: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_PROCESS_CONCURRENCY: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_OFFPEAK: ["open-science-web"],
  OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD: ["open-science-web"],
  OPEN_SCIENCE_KNOWLEDGE_PLUGIN_URL: ["open-science-web"],
  OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE: ["open-science-web"],
  OPEN_SCIENCE_KNOWLEDGE_PLUGIN_POLL_MS: ["open-science-web"],
  OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TIMEOUT_MS: ["open-science-web"],
  OPEN_SCIENCE_KNOWLEDGE_PLUGIN_MIN_CONTRACT: ["open-science-web"],
  // The independent reviewer (2026-09-23): the module switch, the model and
  // endpoint it calls, and the bounds on what one review may cost and take. A
  // lever that does not arrive leaves the reviewer off while the operator
  // believes it is on — or on, and paying, while they believe it is off.
  // The controller writes EVIMED_REVIEW_ENABLED into every runtime it
  // launches; without the switch there, no submission ever asked (2026-09-23).
  OPEN_SCIENCE_REVIEW_ENABLED: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_REVIEW_MODEL: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_API_BASE: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_EDITOR_TIMEOUT_MS: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_THINKING_BUDGET: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_MAX_OUTPUT_TOKENS: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_EDITOR_PASSES: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_REPLIES_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_REPLY_TIMEOUT_MS: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_REPLY_CONCURRENCY: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_POLL_MS: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_REFERENCE_TIMEOUT_MS: ["open-science-web"],
  // TypeSafe's Jev, the reply check's first pass (2026-09-24): on wherever its
  // key is mounted, so the off switch is what keeps a key in place and stops
  // paying; the timeout decides when the reviewer takes every sentence. The
  // web API is the only caller — no runtime ever talks to Jev.
  OPEN_SCIENCE_REVIEW_JEV_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_REVIEW_JEV_TIMEOUT_MS: ["open-science-web"],
  // The `evimed` login mode (fusion plan 2026-09-26 §9.2): the switch is how a
  // deployment lets the EviMed shell sign its researchers in, and the
  // introspection URL is the one setting the mode cannot default. A lever that
  // never arrives leaves the mode off while the operator believes it is on —
  // and, worse, leaves `OPEN_SCIENCE_AUTH_MODE=evimed` with nowhere to ask.
  OPEN_SCIENCE_EVIMED_AUTH_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_EVIMED_USER_INTROSPECT_URL: ["open-science-web"],
  OPEN_SCIENCE_EVIMED_INTROSPECT_TIMEOUT_MS: ["open-science-web"],
  OPEN_SCIENCE_EVIMED_INTROSPECT_CACHE_TTL_MS: ["open-science-web"],
  // 「转为深度研究」 (fusion plan §9.5): read by config.mjs since 2026-09-26 and
  // passed by no compose file until 2026-09-28, so the handoff answered
  // "off" in every deployment however .env was set.
  OPEN_SCIENCE_RESEARCH_HANDOFF_ENABLED: ["open-science-web"],
  // The specialist engines' model calls through the gateway (gap E4,
  // 2026-09-29). The adapters receive it as EVIMED_ENGINE_MODEL_GATEWAY; the
  // web API must receive it too, or it refuses every credential the adapters
  // ask for and every job is turned away.
  OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_ENGINE_MODEL_TOKEN_TTL_SECONDS: ["open-science-web"],
};

async function composeFiles() {
  const names = (await readdir(deployDir)).filter((name) => name.endsWith(".yml")).sort();
  assert.ok(names.length >= 5, `found ${names.length} compose files; the scan is wrong, not the directory`);
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(path.join(deployDir, name), "utf8") })));
}

test("every documented deployment variable is named where something can act on it", async () => {
  const example = await readFile(path.join(deployDir, ".env.example"), "utf8");
  // Commented keys count: a commented example is still an instruction, and it
  // is the form the rollback lever takes.
  const documented = [...example.matchAll(/^#? *(OPEN_SCIENCE_[A-Z0-9_]+)=/gm)].map((match) => match[1]);
  assert.ok(documented.length >= 100, `parsed ${documented.length} keys from .env.example; the parse is wrong`);

  const files = await composeFiles();
  const named = new Set(files.flatMap(({ text }) => [...text.matchAll(/OPEN_SCIENCE_[A-Z0-9_]+/g)].map((m) => m[0])));
  assert.ok(named.size >= 100, `parsed ${named.size} names from the compose files; the parse is wrong`);

  const unreachable = [...new Set(documented)].filter((key) => !named.has(key)).sort();
  const unexplained = unreachable.filter((key) => !Object.hasOwn(hostSideOnly, key));
  assert.deepEqual(
    unexplained,
    [],
    `.env.example documents ${unexplained.join(", ")}, and no compose file passes ${unexplained.length === 1 ? "it" : "them"} anywhere`,
  );

  // An exemption that has become false, or was never true, protects nothing.
  for (const [key, script] of Object.entries(hostSideOnly)) {
    assert.ok(unreachable.includes(key), `${key} no longer needs a host-side exemption; drop it from the list`);
    const source = await readFile(path.join(repoRoot, script), "utf8");
    assert.ok(source.includes(key), `${key} is exempted as host-side for ${script}, which never names it`);
  }
});

test("the operator levers reach the services that read them", async () => {
  const files = await composeFiles();
  for (const [key, services] of Object.entries(operatorLevers)) {
    for (const service of services) {
      const carriers = files.filter(({ text }) => {
        const environment = YAML.parse(text)?.services?.[service]?.environment;
        return environment != null && Object.hasOwn(environment, key);
      });
      assert.ok(
        carriers.length > 0,
        `no compose file passes ${key} to ${service}, so setting it in .env changes nothing there`,
      );
    }
  }
});

/** Variables config.mjs reads that the web container is deliberately never
 *  handed, and why. Two kinds need no row, because the test derives them: a
 *  name loadConfig refuses (a retired variable must fail where it is set, not
 *  travel), and a secret's value form whose `_FILE` form the web API receives
 *  (a secret travels as a mounted file). */
const notForTheContainer = {
  // A checkout's development shortcuts: the sibling 项目代码/ engines run in
  // place, and .evimed-local/ supplies the rest. A hosted deployment reaches
  // each engine through its adapter's URL (EVIMED_*_URL), which is passed.
  OPEN_SCIENCE_LOCAL_AUTO_CONFIG: "development",
  OPEN_SCIENCE_META_AGENT_ROOT: "development",
  OPEN_SCIENCE_META_AGENT_PYTHON: "development",
  OPEN_SCIENCE_MR_AGENT_ROOT: "development",
  OPEN_SCIENCE_MR_AGENT_PYTHON: "development",
  OPEN_SCIENCE_BIBLIOMETRIC_AGENT_ROOT: "development",
  OPEN_SCIENCE_BIBLIOMETRIC_AGENT_PYTHON: "development",
  OPEN_SCIENCE_RESEARCH_TOPIC_AGENT_ROOT: "development",
  OPEN_SCIENCE_RESEARCH_TOPIC_AGENT_PYTHON: "development",
  OPEN_SCIENCE_PEER_REVIEW_AGENT_ROOT: "development",
  OPEN_SCIENCE_PEER_REVIEW_AGENT_PYTHON: "development",
  OPEN_SCIENCE_DRUG_SAFETY_AGENT_ROOT: "development",
  OPEN_SCIENCE_DRUG_SAFETY_AGENT_PYTHON: "development",
  OPEN_SCIENCE_PHARMACY_REFERENCE_DB: "development",
  // The desktop-era file stores, under OPEN_SCIENCE_DATA_DIR (which the image
  // sets); a hosted deployment keeps users and sessions in PostgreSQL.
  OPEN_SCIENCE_USERS_FILE: "development",
  OPEN_SCIENCE_SESSIONS_FILE: "development",
  // The image's own layout: the defaults are the directories it was built with.
  OPEN_SCIENCE_AGENT_PACKAGE_DIRS: "image",
  OPEN_SCIENCE_CAPABILITY_DIRS: "image",
  OPEN_SCIENCE_DSH_BIN: "image",
  // The pins come from the release manifest and deps-version.json; an
  // environment override would name a kernel the image does not contain.
  // (OPEN_SCIENCE_DSH_VERSION is the runtime image's build argument.)
  OPEN_SCIENCE_DSH_VERSION: "pin",
  OPEN_SCIENCE_SOCKET_BUNDLE_VERSION: "pin",
  // The name the two delegation limits replaced on 2026-09-18, read only as
  // their fallback; the two that replaced it are passed.
  OPEN_SCIENCE_MAX_PARALLEL_CHILDREN: "alias",
  // `full` fails hosted readiness (full_approval_enabled), so the only value a
  // hosted container can run with is the code's own.
  OPEN_SCIENCE_APPROVAL_MODE: "hosted policy",
  // The backup container's secret. The web API learns that backups are
  // encrypted from OPEN_SCIENCE_BACKUP_ENCRYPTION_ACK and never holds the key.
  OPEN_SCIENCE_BACKUP_PASSPHRASE: "backup container",
  OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "backup container",
};

test("every variable config.mjs reads reaches the web API, or says why it does not", async () => {
  // The per-lever list above is written by hand, one incident at a time, and
  // it missed OPEN_SCIENCE_RESEARCH_HANDOFF_ENABLED (2026-09-26): the switch
  // for 「转为深度研究」 was read by config.mjs and passed by no compose file,
  // so the feature could not be turned on in any deployment. The class, not
  // the instance: every name config.mjs reads is a lever someone will set.
  const configSource = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");
  const code = configSource.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const read = new Set(code.match(/OPEN_SCIENCE_[A-Z0-9_]+/g) ?? []);
  assert.ok(read.size >= 300 && read.has("OPEN_SCIENCE_RESEARCH_HANDOFF_ENABLED") && read.has("OPEN_SCIENCE_DEEPSEEK_API_KEY"),
    `read ${read.size} names from config.mjs; the scan did not walk`);

  const files = await composeFiles();
  const dockerfile = await readFile(path.join(deployDir, "Dockerfile"), "utf8");
  const received = new Set([
    ...files.flatMap(({ text }) => Object.keys(YAML.parse(text, { merge: true })?.services?.["open-science-web"]?.environment ?? {})),
    ...[...dockerfile.matchAll(/^ENV (OPEN_SCIENCE_[A-Z0-9_]+)=/gm)].map((match) => match[1]),
  ]);
  assert.ok(received.size >= 300 && received.has("OPEN_SCIENCE_DATA_DIR"), `the web API receives ${received.size} names; the compose files were not read`);

  /** @param {string} name */
  const refused = (name) => {
    const saved = process.env[name];
    process.env[name] = "x";
    try {
      loadConfig({ rootDir: repoRoot });
      return false;
    } catch (error) {
      return /is not read any more/.test(String(/** @type {Error} */ (error)?.message));
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  };
  const missing = [...read].filter((name) => !received.has(name)).sort();
  const retired = missing.filter(refused);
  const secretValues = missing.filter((name) => received.has(`${name}_FILE`));
  assert.ok(retired.includes("OPEN_SCIENCE_RUNTIME_KERNEL") && secretValues.includes("OPEN_SCIENCE_DEEPSEEK_API_KEY"),
    `derived ${retired.length} retired names and ${secretValues.length} secret value forms; the derivation is broken`);

  const unexplained = missing.filter((name) => !retired.includes(name) && !secretValues.includes(name) && !Object.hasOwn(notForTheContainer, name));
  assert.deepEqual(unexplained, [],
    `config.mjs reads ${unexplained.join(", ")}, and no compose file passes ${unexplained.length === 1 ? "it" : "them"} to open-science-web: pass it (the value-less \`KEY:\` form) and document it in .env.example, or give it a row in notForTheContainer`);
  for (const name of Object.keys(notForTheContainer)) {
    assert.ok(read.has(name), `${name} is exempted, and config.mjs no longer reads it; drop the row`);
    assert.ok(missing.includes(name) && !retired.includes(name) && !secretValues.includes(name),
      `${name} no longer needs an exemption; drop the row`);
  }
});

test("no compose file pins an operator lever to a literal", async () => {
  // Two overlays once set the same key to two different literals on the same
  // service, and which one won depended on the order of -f flags. The .env
  // value was unreadable from either. A lever must be interpolated or passed
  // through, never written down.
  const files = await composeFiles();
  const levers = Object.keys(operatorLevers);
  for (const { name, text } of files) {
    const document = YAML.parse(text);
    for (const [service, definition] of Object.entries(document?.services ?? {})) {
      for (const [key, value] of Object.entries(definition?.environment ?? {})) {
        if (!levers.includes(key)) continue;
        assert.ok(
          value == null || String(value).includes(`\${${key}`),
          `${name} pins ${key} on ${service} to the literal ${JSON.stringify(value)}; .env can no longer move it`,
        );
      }
    }
  }
});

/** Settings the launch plan reads that the controller does not need, and why.
 *  Each must still be true: read by the plan, received by the web API, absent
 *  from the controller. */
const controllerNeedsNot = {
  // The controller takes the capsule and revision gateway addresses from the
  // web API's request and checks them against its own fixed endpoints
  // (runtimeControllerServer.mjs); the store decides only the default address
  // it never computes.
  OPEN_SCIENCE_STATE_STORE: "the capsule and revision addresses arrive in the request",
  // The port only makes up the web-search gateway address when none is given,
  // and the controller is given one.
  OPEN_SCIENCE_PORT: "the web-search gateway address is passed whole",
  // The API owns token issuance; this privileged process deliberately holds
  // no signing key (runtimeManager.mjs), and the two gateway addresses the key
  // would unlock arrive in the request.
  OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET: "the controller holds no signing key, by design",
};

test("every setting the controller's launch plan reads reaches the controller wherever it reaches the web API", async () => {
  // The controller builds each runtime's launch arguments from its own
  // environment. A setting the web API receives and the controller does not
  // is one the deployment believes it made and no runtime ever sees: until
  // 2026-09-23 every runtime started with EVIMED_REVIEW_ENABLED=0 while
  // readiness and /api/me said the reviewer was on.
  const source = await readFile(path.join(repoRoot, "apps/server/src/runtimeManager.mjs"), "utf8");
  /** @type {Map<string, string>} */
  const bodies = new Map([...source.matchAll(/^(?:export )?(?:async )?function (\w+)\([\s\S]*?^\}\n/gm)].map((match) => [match[1], match[0]]));
  /** @type {Set<string>} */
  const read = new Set();
  const seen = new Set();
  const queue = ["buildRuntimeLaunchPlan"];
  while (queue.length) {
    const name = String(queue.shift());
    if (seen.has(name) || !bodies.has(name)) continue;
    seen.add(name);
    const body = String(bodies.get(name));
    for (const match of body.matchAll(/\bconfig\.(\w+)/g)) read.add(match[1]);
    for (const match of body.matchAll(/\b(\w+)\(config\b/g)) queue.push(match[1]);
  }
  assert.ok(read.has("runtimeReviewEnabled") && read.has("runtimeMemoryLimit") && read.has("webSearchUrl") && read.size >= 25,
    `the walk read ${read.size} settings from the launch plan; it did not walk`);

  // Which variables move each of those settings, asked of loadConfig itself,
  // so an indirection (reviewConfigured, a fallback name) is followed.
  const configSource = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");
  const names = [...new Set(configSource.match(/OPEN_SCIENCE_[A-Z0-9_]+/g) ?? [])];
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OPEN_SCIENCE_")));
  /** @type {Map<string, Set<string>>} */
  const moves = new Map();
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    const base = /** @type {Record<string, unknown>} */ (loadConfig({ rootDir: repoRoot }));
    for (const name of names) {
      for (const value of ["true", "7", "probe-value", "http://probe.invalid/x"]) {
        process.env[name] = value;
        let probed;
        try { probed = /** @type {Record<string, unknown>} */ (loadConfig({ rootDir: repoRoot })); } catch { probed = null; }
        delete process.env[name];
        if (!probed) continue;
        for (const key of read) {
          if (JSON.stringify(probed[key]) !== JSON.stringify(base[key])) moves.set(name, (moves.get(name) ?? new Set()).add(key));
        }
      }
    }
  } finally {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, saved);
  }
  assert.ok(moves.get("OPEN_SCIENCE_REVIEW_ENABLED")?.has("runtimeReviewEnabled"), "loadConfig was not probed; the mapping is empty");

  const files = await composeFiles();
  /** @param {string} service */
  const received = (service) => new Set(files.flatMap(({ text }) => Object.keys(YAML.parse(text, { merge: true })?.services?.[service]?.environment ?? {})));
  const web = received("open-science-web");
  const controller = received("open-science-runtime-controller");
  assert.ok(web.size >= 100 && controller.size >= 20, "the compose files were not read");

  const gaps = [...moves.keys()].filter((name) => web.has(name) && !controller.has(name)).sort();
  const unexplained = gaps.filter((name) => !Object.hasOwn(controllerNeedsNot, name));
  assert.deepEqual(unexplained, [], `the web API receives ${unexplained.join(", ")} and the controller, which launches the runtimes, does not: ${unexplained.map((name) => `${name} → ${[...(moves.get(name) ?? [])].join("/")}`).join("; ")}`);
  for (const name of Object.keys(controllerNeedsNot)) {
    assert.ok(gaps.includes(name), `${name} no longer needs an exemption from the controller's environment; drop it from the list`);
  }
});

test("TypeSafe's key reaches the web API from an optional mount, and nothing else", async () => {
  // The owner approved the key for production on 2026-09-24; a deployment
  // that has not placed it yet must still start. The mount defaults to
  // /dev/null, which config.mjs reads as no key (Jev off, the reviewer judges
  // every sentence) rather than as a broken secret.
  const files = await composeFiles();
  const base = files.find(({ name }) => name === "docker-compose.yml");
  assert.ok(base, "the base compose file was not read");
  const document = YAML.parse(base.text);
  const web = document.services["open-science-web"];
  assert.equal(web.environment.OPEN_SCIENCE_TYPESAFE_API_KEY_FILE, "/run/secrets/typesafe-api-key");
  const mount = web.volumes.find((/** @type {any} */ volume) => volume?.target === "/run/secrets/typesafe-api-key");
  assert.deepEqual(mount, { type: "bind", source: "${OPEN_SCIENCE_TYPESAFE_API_KEY_HOST_FILE:-/dev/null}", target: "/run/secrets/typesafe-api-key", read_only: true });
  // The runtime never holds a provider key; its controller has no use for one.
  for (const { name, text } of files) {
    const services = YAML.parse(text)?.services ?? {};
    for (const [service, definition] of Object.entries(services)) {
      if (service === "open-science-web") continue;
      assert.equal(JSON.stringify(definition ?? {}).includes("TYPESAFE"), false, `${name} hands TypeSafe's key to ${service}`);
    }
  }
  const unset = loadConfig({ rootDir: repoRoot, typesafeApiKeyFile: "/dev/null" });
  assert.equal(unset.typesafeApiKey, "");
  assert.equal(unset.typesafeApiKeyError, null, "/dev/null is no key, not a broken one");
  assert.equal(unset.reviewJevEnabled, false);
});

test("the MR engine reads EBI through the web API's node, with its credentials, and only three services hold them", async () => {
  // The token-free GWAS Catalog path read ftp.ebi.ac.uk at ~19 KB/s from the
  // Beijing host and ~358 KB/s through the Tokyo node (2026-09-28). The engine
  // takes the node from the same host variables as the web API, so setting the
  // node once sets it for both, and a deployment without one binds /dev/null
  // and reads EBI direct.
  const files = await composeFiles();
  const base = files.find(({ name }) => name === "docker-compose.yml");
  assert.ok(base, "the base compose file was not read");
  const services = YAML.parse(base.text).services;
  const web = services["open-science-web"];
  const mr = services["evimed-mr-agent"];
  /** @param {any} definition @param {string} target */
  const mountAt = (definition, target) => definition.volumes.find((/** @type {any} */ volume) => volume?.target === target);

  assert.equal(mr.environment.EVIMED_MR_OPEN_PROXY_URL, "${OPEN_SCIENCE_EDGE_PROXY_URL:-}");
  assert.equal(mr.environment.EVIMED_MR_OPEN_PROXY_URL, web.environment.OPEN_SCIENCE_EDGE_PROXY_URL, "the engine and the web API name different nodes");
  const mrMount = mountAt(mr, mr.environment.EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE);
  assert.deepEqual(mrMount, {
    type: "bind", source: "${OPEN_SCIENCE_EDGE_PROXY_CREDENTIALS_HOST_FILE:-/dev/null}", target: "/run/secrets/edge-proxy-credentials", read_only: true,
  });
  assert.deepEqual(mrMount, mountAt(web, web.environment.OPEN_SCIENCE_EDGE_PROXY_CREDENTIALS_FILE), "the engine binds another host file than the web API");

  // The names compose sets are the names the engine reads.
  const engine = await readFile(path.join(repoRoot, "..", "项目代码", "孟德尔随机化", "mr_agent", "tools", "open_sumstats.py"), "utf8");
  for (const name of ["EVIMED_MR_OPEN_PROXY_URL", "EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE"]) {
    assert.match(engine, new RegExp(`os\\.getenv\\("${name}"`), `open_sumstats.py does not read ${name}`);
  }

  // The host file is root-owned, 0400 or root:10002 0440. The engine reads it
  // as its owner, like the web API: it runs as root with every capability
  // dropped — no `user:` here and no USER in its image.
  assert.equal(mr.user, undefined, "the MR engine runs as a non-root user and cannot read the root-owned credentials");
  assert.deepEqual(mr.cap_drop, ["ALL"]);
  const dockerfile = await readFile(path.join(repoRoot, "deploy", "specialist-adapter", "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /^USER\s/m, "the engine image sets a USER; check it can still read the root-owned credentials");

  // Who holds the node's credentials: the web API, the knowledge plugin, the MR engine.
  const holders = files.flatMap(({ name, text }) => Object.entries(YAML.parse(text)?.services ?? {})
    .filter(([, definition]) => JSON.stringify(definition ?? {}).includes("OPEN_SCIENCE_EDGE_PROXY_CREDENTIALS_HOST_FILE"))
    .map(([service]) => `${name} ${service}`));
  assert.deepEqual(holders.sort(), [
    "docker-compose.knowledge.yml evimed-knowledge-plugin",
    "docker-compose.yml evimed-mr-agent",
    "docker-compose.yml open-science-web",
  ]);
});


test("all six engines use the gateway by default and have a keyless overlay", async () => {
  const base = YAML.parse(await readFile(path.join(deployDir, "docker-compose.yml"), "utf8"));
  const overlay = YAML.parse(await readFile(path.join(deployDir, "docker-compose.engine-keyless.yml"), "utf8"));
  assert.equal(loadConfig({ rootDir: repoRoot }).engineModelGatewayEnabled, true);
  for (const name of ["meta", "mr", "bibliometric", "research-topic", "peer-review", "drug-safety"]) {
    const id = `evimed-${name}-agent`;
    assert.equal(base.services[id].environment.EVIMED_ENGINE_MODEL_GATEWAY, "${OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED:-true}");
    assert.match(base.services[id].environment.EVIMED_ENGINE_MODEL_TOKEN_URL, /internal\/engines\/v1\/model-token/);
    assert.equal(overlay.services[id].volumes[0].source, "/dev/null");
    assert.equal(overlay.services[id].volumes[0].target, "/run/secrets/deepseek-api-key");
  }
});

test("only MR receives the read-only ancestry reference and its actual clumping executable", async () => {
  const base = (await composeFiles()).find(({ name }) => name === "docker-compose.yml");
  const services = YAML.parse(base.text).services;
  const mr = services["evimed-mr-agent"];
  assert.equal(mr.environment.EVIMED_MR_PLINK_BIN, "/usr/bin/plink1.9");
  const target = mr.environment.EVIMED_MR_LD_REFERENCE_DIR;
  assert.equal(target, "/opt/evimed/mr-ld-reference");
  const mount = mr.volumes.find((value) => value.target === target);
  assert.deepEqual(mount, { type: "bind", source: "${OPEN_SCIENCE_MR_LD_REFERENCE_HOST_DIR:-/dev/null}",
    target, read_only: true, bind: { create_host_path: false } });
  for (const [name, service] of Object.entries(services)) {
    if (name !== "evimed-mr-agent") assert.ok(!service.volumes?.some((value) => value.target === target), name);
  }
});

test("ToolUniverse service authentication stays between web and the bounded sidecar", async () => {
  const base = (await composeFiles()).find(({ name }) => name === "docker-compose.yml");
  const services = YAML.parse(base.text).services;
  const sidecar = services.tooluniverse;
  const web = services["open-science-web"];
  assert.deepEqual(sidecar.profiles, ["tooluniverse"]);
  assert.equal(sidecar.mem_limit, "512m");
  assert.equal(sidecar.memswap_limit, "512m");
  assert.equal(sidecar.cpus, 1);
  assert.deepEqual(sidecar.healthcheck.test, ["CMD", "python", "/opt/evimed-tooluniverse/sidecar.py", "check", "--full"]);
  assert.equal(sidecar.environment.TOOLUNIVERSE_API_TOKEN_FILE, web.environment.OPEN_SCIENCE_TOOLUNIVERSE_API_TOKEN_FILE);
  const holders = Object.entries(services).filter(([, service]) => service.volumes?.some(volume => volume.target === "/run/secrets/tooluniverse-api-token")).map(([name]) => name).sort();
  assert.deepEqual(holders, ["open-science-web", "tooluniverse"]);
  for (const holder of holders) assert.equal(services[holder].volumes.find(volume => volume.target === "/run/secrets/tooluniverse-api-token").read_only, true);
});


test("runtime UI proxy settings reach both processes after real Compose base and API-only interpolation", {
  skip: spawnSync("docker",["compose","version"],{stdio:"ignore"}).status !== 0 && "Docker Compose CLI required",
}, async () => {
  const base=path.join(deployDir,"docker-compose.yml"),apiOnly=path.join(deployDir,"docker-compose.api-only.yml");
  const source=await readFile(base,"utf8");
  const env={...process.env};
  // Supply only synthetic required values; never load an operator's .env.
  for(const match of source.matchAll(/\$\{([A-Z0-9_]+):\?/g))
    env[match[1]]=match[1].endsWith("_HOST_FILE") ? "/tmp/evimed-env-forwarding-fixture" : "fixture";
  env.OPEN_SCIENCE_DOCKER_SOCKET_GID="0";
  for(const overlay of [false,true])for(const value of [undefined,"true","false"]){
    if(value===undefined)delete env.OPEN_SCIENCE_RUNTIME_UI_PROXY_ENABLED;
    else env.OPEN_SCIENCE_RUNTIME_UI_PROXY_ENABLED=value;
    const result=spawnSync("docker",["compose","--env-file","/dev/null","--profile","full-product","-f",base,
      ...(overlay ? ["-f",apiOnly] : []),"config","--format","json","--no-env-resolution"],
      {env,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024});
    assert.equal(result.status,0,"Compose configuration must succeed without starting any service");
    const services=JSON.parse(result.stdout).services;
    const expected=value ?? (overlay ? "false" : "");
    for(const name of ["open-science-web","open-science-runtime-controller"])
      assert.equal(services[name].environment.OPEN_SCIENCE_RUNTIME_UI_PROXY_ENABLED,expected,
        `${name} receives ${String(value)} in ${overlay ? "API-only" : "base"}`);
  }
});
