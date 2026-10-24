// What the control plane concludes about the OpenViking engine, replayed from what running engines answered.
//
// Every scenario under packages/contracts/openviking/fixtures/engine/ is the check itself run against a real server and
// recorded exchange by exchange (`packages/contracts/openviking/record.mjs`): on v0.5.1.1 (2026-10-23) an account the
// server had never seen and then the same account once registered; and, recorded on v0.5.0 (2026-10-13) because it needs
// a server that mounts no template directory, which the lab of this recording does not have, the template routes'
// answers of such a server (`engine-check-no-templates`). The replay answers each request with the next recorded
// response for that method, path and query, so a check that asked something else, or in another order, reads nothing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { READINESS_ERROR_CODES, knownErrorCodeMessage } from "@evimed/domain";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import {
  OPENVIKING_ENGINE_FACTS, OPENVIKING_ENGINE_FEATURES, OPENVIKING_ENGINE_USER, OpenVikingEngine, readPinnedSkill,
} from "../src/openVikingEngine.mjs";
import { OPENVIKING_MEMORY_TYPES, OPENVIKING_SKILL_NAMES, OPENVIKING_SKILLS_ROOT, openVikingUserId } from "../src/openVikingLayout.mjs";

const fixtures = new URL("../../../packages/contracts/openviking/fixtures/engine/", import.meta.url);
const versions = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));
const pin = { version: versions.openviking.version, skills: versions.openviking.skills };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The recorded exchanges as a fetch: the next recorded answer per (method, path, query), the last one repeating. */
async function replay(name, { transform = (exchange) => exchange } = {}) {
  const recording = JSON.parse(await readFile(new URL(`${name}.json`, fixtures), "utf8"));
  /** @type {Map<string, any[]>} */
  const queues = new Map();
  const keyOf = (method, path, query) => `${method} ${path.replace(/\/tasks\/cmp_[0-9a-f]+/, "/tasks/<probe>")} ${JSON.stringify(Object.entries(query).sort())}`;
  for (const exchange of recording.exchanges.map(transform)) {
    const key = keyOf(exchange.method, exchange.path, exchange.query ?? {});
    queues.set(key, [...(queues.get(key) ?? []), exchange]);
  }
  const seen = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    const key = keyOf(init.method, target.pathname, Object.fromEntries(target.searchParams));
    seen.push({ method: init.method, path: target.pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const queue = queues.get(key);
    assert.ok(queue, `the check asked ${key}, which no running engine was recorded answering`);
    const exchange = queue.length > 1 ? queue.shift() : queue[0];
    const bytes = exchange.bodyFile ? await readFile(new URL(exchange.bodyFile, fixtures)) : Buffer.from(JSON.stringify(exchange.response));
    return new Response(bytes, { status: exchange.status, headers: { "content-type": exchange.contentType || "application/json" } });
  };
  return { recording, fetchImpl, seen };
}

function engineFor(fetchImpl, { config = { openVikingModelKey: "a-service-key-of-credential-length-0123" }, readSkill = readPinnedSkill, account = "evimed", pinned = pin } = {}) {
  const client = new OpenVikingClient({ openVikingUrl: "http://engine.recorded", openVikingApiKey: "root-key-stand-in", openVikingAccount: account, openVikingRequestTimeoutMs: 5_000 }, { fetchImpl });
  const lines = [];
  return { engine: new OpenVikingEngine({ client, config, pin: pinned, readSkill, wait: async () => {}, report: (line) => lines.push(line), now: () => new Date("2026-10-13T02:00:00.000Z") }), lines };
}

const verdictOf = (status) => Object.fromEntries(Object.entries(status.facts).map(([name, fact]) => [name, fact.ok ? "ok" : fact.code]));

test("before anything was read every fact is unchecked, and no feature is said to be ready", () => {
  const { engine } = engineFor(async () => { throw new Error("not asked"); });
  const status = engine.status();
  assert.equal(status.checkedAt, null);
  assert.equal(status.ok, false);
  assert.deepEqual(Object.keys(status.facts), [...OPENVIKING_ENGINE_FACTS]);
  for (const fact of Object.values(status.facts)) assert.deepEqual(fact, { ok: false, code: "openviking_engine_unchecked" });
  assert.deepEqual(status.degraded.sort(), Object.keys(OPENVIKING_ENGINE_FEATURES).sort());
  assert.deepEqual(engine.ready("knowledge"), { ok: false, code: "openviking_engine_unchecked", fact: "version" });
  assert.deepEqual(engine.ready("somethingElse"), { ok: false, code: "openviking_feature_unknown", fact: null });
  // Each feature names facts that exist.
  for (const facts of Object.values(OPENVIKING_ENGINE_FEATURES)) for (const fact of facts) assert.ok(OPENVIKING_ENGINE_FACTS.includes(fact));
});

test("the engine started from this repository's configuration and compose definition: every fact holds", async () => {
  const { recording, fetchImpl, seen } = await replay("engine-check-ready");
  assert.equal(recording.recordedFrom, `${versions.openviking.image}:${versions.openviking.imageTag}`);
  const { engine, lines } = engineFor(fetchImpl);
  const status = await engine.check();
  assert.equal(status.ok, true);
  assert.deepEqual(status.degraded, []);
  assert.deepEqual(verdictOf(status), verdictOf(recording.verdict), "the verdict on the recording is not the one recorded with it");
  assert.equal(status.checkedAt, "2026-10-13T02:00:00.000Z");
  assert.equal(status.facts.version.version, `v${pin.version}`);
  // What a registered user's settings read back: exactly the eight types of the mounted template directory.
  assert.deepEqual(status.facts.memoryTemplates.types, [...OPENVIKING_MEMORY_TYPES].sort());
  for (const name of OPENVIKING_SKILL_NAMES) {
    assert.deepEqual(status.facts.skills.skills[name], { state: "installed", sha256: pin.skills[name].installedSha256 });
  }
  assert.deepEqual(engine.ready("knowledge"), { ok: true, code: null, fact: null });
  assert.deepEqual(engine.ready("nativeMemory"), { ok: true, code: null, fact: null });
  assert.deepEqual(lines, [], "a passing check reported a failure");

  // Nothing was written but the probe's empty directory: the skills were there, so nothing was installed, and the probe
  // reads an empty directory of the engine identity's own and writes nowhere (the compile fails on "no files" before a
  // model is called).
  assert.equal(engine.counters.skillInstalls, 0);
  assert.equal(engine.counters.compileProbes, 1);
  assert.ok(!seen.some((request) => request.method === "POST" && request.path === "/api/v1/skills"));
  const capabilities = seen.findIndex((request) => request.path === "/api/v1/compile/capabilities");
  const submission = seen.findIndex((request) => request.path === "/api/v1/compile");
  assert.ok(capabilities >= 0 && submission > capabilities, "the probe submits without asking whether Compile is configured");
  const probe = seen[submission];
  assert.equal(probe.body.from.length, 1);
  assert.match(probe.body.from[0], new RegExp(`^viking://user/${OPENVIKING_ENGINE_USER}/resources/evimed-compile-probe/sources$`));
  assert.match(probe.body.to, new RegExp(`^viking://user/${OPENVIKING_ENGINE_USER}/resources/evimed-compile-probe/`));
  assert.equal(probe.body.skill, `${OPENVIKING_SKILLS_ROOT}/llm-wiki`);
  assert.match(probe.headers["Idempotency-Key"], /^evimed-compile-probe-[0-9a-f]{24}$/);
  assert.ok(!seen.some((request) => request.path.includes("/cancel")), "a probe that failed on its own was cancelled");
  // Every request ran as the engine's own identity, which no account's hashed id can equal, and none carried a role.
  for (const request of seen.filter((entry) => entry.path !== "/health")) {
    assert.equal(request.headers["X-OpenViking-User"], OPENVIKING_ENGINE_USER);
    assert.equal(request.headers["X-OpenViking-Account"], "evimed");
    assert.ok(!Object.keys(request.headers).some((header) => header.toLowerCase() === "x-openviking-role"));
  }
  assert.doesNotMatch(OPENVIKING_ENGINE_USER, /^u-[0-9a-f]{24}$/);
  assert.notEqual(openVikingUserId(OPENVIKING_ENGINE_USER), OPENVIKING_ENGINE_USER);
});

/**
 * The ready recording with the template routes' answers replaced by those of a server that mounted no template directory
 * (`engine-check-no-templates`, recorded on v0.5.0 on the knowledge lab, which had none: the pinned release's lab mounts
 * them). The template loader is byte-identical at the two releases (upstream source diff), and everything after the
 * template routes is the pinned release's own recording.
 */
async function readyWithoutTemplates() {
  const old = JSON.parse(await readFile(new URL("engine-check-no-templates.json", fixtures), "utf8"));
  const answers = new Map(old.exchanges.filter((exchange) => /\/memory-templates\//.test(exchange.path)).map((exchange) => [exchange.path.split("/").pop(), exchange]));
  return replay("engine-check-ready", {
    transform: (exchange) => {
      const type = /\/memory-templates\/([^/]+)$/.exec(exchange.path)?.[1];
      return type && answers.has(type) ? { ...answers.get(type), path: exchange.path } : exchange;
    },
  });
}

test("a template directory that is not mounted is named, and only native memory is degraded", async () => {
  // Upstream says nothing: the server falls back to its built-in types. The types this deployment adds are then absent
  // from its registry, and the route for one answers 404 where a loaded directory answers 400 `not editable`.
  const { fetchImpl } = await readyWithoutTemplates();
  const { engine, lines } = engineFor(fetchImpl);
  const status = await engine.check();
  assert.equal(status.facts.memoryTemplates.code, "openviking_memory_templates_missing");
  assert.deepEqual(status.facts.memoryTemplates.missing, ["corrections", "project_context", "decisions", "follow_ups", "project_facts"]);
  assert.deepEqual(verdictOf(status), { version: "ok", modelKey: "ok", memoryTemplates: "openviking_memory_templates_missing", skills: "ok", compileIdentity: "ok" });
  assert.deepEqual(status.degraded, ["nativeMemory"]);
  assert.deepEqual(engine.ready("nativeMemory"), { ok: false, code: "openviking_memory_templates_missing", fact: "memoryTemplates" });
  assert.equal(engine.ready("knowledge").ok, true, "a memory fact took knowledge compile down with it");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /memoryTemplates=openviking_memory_templates_missing/);
  assert.equal(engine.counters.failedChecks, 1);
});

test("a server that has never seen the account installs the two skills from the pinned bytes, and native memory waits for the registration", async () => {
  const { recording, fetchImpl, seen } = await replay("engine-check-new-volume");
  assert.equal(recording.recordedFrom, `${versions.openviking.image}:${versions.openviking.imageTag}`);
  const { engine } = engineFor(fetchImpl, { account: "evimed-fresh" });
  const status = await engine.check();
  assert.deepEqual(verdictOf(status), verdictOf(recording.verdict));
  assert.deepEqual(status.facts.memoryTemplates, { ok: false, code: "openviking_registration_pending" });
  // The two skills were missing and were installed from the pinned bytes this repository ships, into the shared root;
  // what the server then stored is the second pinned digest (it re-wraps the frontmatter and drops the final newline).
  const installs = seen.filter((request) => request.method === "POST" && request.path === "/api/v1/skills");
  assert.equal(installs.length, 2);
  assert.equal(engine.counters.skillInstalls, 2);
  for (const [index, name] of OPENVIKING_SKILL_NAMES.entries()) {
    assert.equal(installs[index].body.target_uri, OPENVIKING_SKILLS_ROOT);
    assert.equal(installs[index].body.wait, true);
    assert.equal(sha256(installs[index].body.data), pin.skills[name].upstreamSha256, `${name} was installed from other bytes than the pinned ones`);
    assert.deepEqual(status.facts.skills.skills[name], { state: "installed-now", sha256: pin.skills[name].installedSha256 });
    const stored = await readFile(new URL(`installed-${name}.skill.md`, fixtures));
    assert.equal(sha256(stored), pin.skills[name].installedSha256);
    assert.notEqual(sha256(stored), pin.skills[name].upstreamSha256);
  }
  // The Compile half does not wait for the registration.
  assert.equal(engine.ready("knowledge").ok, true);
});

/**
 * The ready recording with ONE answer of the Compile probe changed, for the ways the probe can fail that the lab could not be
 * made to show (it has one Compile runtime, and it is configured). The changed answer is the only thing in these scenarios that
 * was not recorded, and each test says which. `change` returns the replacement exchange, or nothing to keep the recorded one.
 * @param {(exchange: any) => any} change
 */
const readyWith = (change) => replay("engine-check-ready", { transform: (exchange) => change(exchange) ?? exchange });
const isPoll = (/** @type {any} */ exchange) => exchange.method === "GET" && /\/tasks\/cmp_/.test(exchange.path);
const withTask = (/** @type {any} */ exchange, /** @type {any} */ result) => ({ ...exchange, response: { ...exchange.response, result: { ...exchange.response.result, ...result } } });

test("a Compile runtime the server says it does not have, or that is not configured, is named and degrades knowledge only", async () => {
  // Authored: `configured: false` in the capabilities answer (the recorded one says true), and the 503 UNAVAILABLE the v0.5.0
  // server gave at submission when it had no Compile runtime (`engine-check-no-compile` of that release).
  const scenarios = [
    (/** @type {any} */ exchange) => (exchange.path === "/api/v1/compile/capabilities" ? withTask(exchange, { configured: false, can_create: false, reason_code: "bot_not_configured" }) : null),
    (/** @type {any} */ exchange) => (exchange.method === "POST" && exchange.path === "/api/v1/compile"
      ? { ...exchange, status: 503, response: { status: "error", result: null, error: { code: "UNAVAILABLE", message: "Compile api unavailable", details: {} } } } : null),
  ];
  for (const change of scenarios) {
    const { fetchImpl, seen } = await readyWith(change);
    const { engine } = engineFor(fetchImpl);
    const status = await engine.check();
    assert.equal(status.facts.compileIdentity.code, "openviking_compile_unconfigured");
    assert.deepEqual(status.degraded, ["knowledge"]);
    assert.equal(engine.ready("nativeMemory").ok, true);
    assert.ok(!seen.some((request) => /\/tasks\/cmp_/.test(request.path)), "a probe that was never accepted polled a task");
  }
});

test("a probe that ends any way but \"no files\" says what the engine said, and is stopped if it ran", async () => {
  // Authored: the task's `error` text. A runtime that did not receive the caller's identity ends the probe with a refusal of its own
  // (what v0.5.0 did without its shim: 401 "Trusted OpenViking chat requires X-OpenViking-Account and X-OpenViking-User").
  {
    const { fetchImpl } = await readyWith((exchange) => (isPoll(exchange) && exchange.response.result.status === "failed"
      ? withTask(exchange, { error: "UNAUTHENTICATED: Trusted OpenViking chat requires X-OpenViking-Account and X-OpenViking-User" }) : null));
    const { engine } = engineFor(fetchImpl);
    const status = await engine.check();
    assert.equal(status.facts.compileIdentity.code, "openviking_compile_probe_unexpected");
    assert.match(String(status.facts.compileIdentity.reason), /Trusted OpenViking chat requires/);
    assert.deepEqual(status.degraded, ["knowledge"]);
  }
  // Authored: a task that completes (an empty source no longer ends the compile at once) is cancelled and reported.
  {
    const { fetchImpl, seen } = await readyWith((exchange) => (isPoll(exchange) && exchange.response.result.status === "failed"
      ? withTask(exchange, { status: "completed", stage: "completed", error: null }) : null));
    const { engine } = engineFor(fetchImpl);
    const status = await engine.check();
    assert.equal(status.facts.compileIdentity.code, "openviking_compile_probe_unexpected");
    assert.ok(seen.some((request) => request.method === "POST" && /\/tasks\/cmp_[0-9a-f]+\/cancel$/.test(request.path)), "a probe that ran was not cancelled");
  }
});

test("a probe that never ends is said not to have ended, after the wait and without waiting for ever", async () => {
  // Authored: every poll answers `running` (the recorded answers are `running` and then `failed`).
  const { fetchImpl, seen } = await readyWith((exchange) => (isPoll(exchange) ? withTask(exchange, { status: "running", stage: "compile: collecting_context", error: null }) : null));
  const { engine } = engineFor(fetchImpl);
  const status = await engine.check();
  assert.deepEqual(status.facts.compileIdentity, { ok: false, code: "openviking_compile_probe_unexpected", reason: "the probe did not end" });
  assert.deepEqual(engine.ready("knowledge"), { ok: false, code: "openviking_compile_probe_unexpected", fact: "compileIdentity" });
  assert.equal(engine.counters.compileProbes, 1);
  const polls = seen.filter((request) => /\/tasks\/cmp_/.test(request.path)).length;
  assert.ok(polls > 10 && polls < 200, `the probe polled ${polls} times`);
});

test("a submission that names no task is unreadable", async () => {
  // Authored: the 202 answer without a task id.
  const { fetchImpl } = await readyWith((exchange) => (exchange.method === "POST" && exchange.path === "/api/v1/compile" ? { ...exchange, response: { status: "ok", result: {} } } : null));
  const { engine } = engineFor(fetchImpl);
  const status = await engine.check();
  assert.deepEqual(status.facts.compileIdentity, { ok: false, code: "openviking_compile_probe_unreadable" });
});

test("a new volume's first minutes read as registration pending, never as missing templates", async () => {
  // In trusted mode identities are registered in batches; until the first batch every admin route answers 404 about
  // the account. Read as a 404 about the template, that was "all eight missing" on the first start of a new volume.
  const { recording, fetchImpl, seen } = await replay("engine-check-new-volume");
  const { engine } = engineFor(fetchImpl, { account: "evimed-fresh" });
  const status = await engine.check();
  assert.deepEqual(verdictOf(status), verdictOf(recording.verdict));
  assert.deepEqual(status.facts.memoryTemplates, { ok: false, code: "openviking_registration_pending" });
  assert.equal(seen.filter((request) => request.path.includes("/memory-templates/")).length, 1, "the check kept asking an account that is not registered");
  // The Compile half does not wait for it.
  assert.equal(engine.ready("knowledge").ok, true);
  assert.equal(engine.ready("nativeMemory").code, "openviking_registration_pending");
});

test("a skill whose stored bytes are not the pinned ones is reported and left alone", async () => {
  // Somebody put it there. Replacing it is an operator's decision; compiling with it is nobody's.
  let served = 0;
  const { fetchImpl, seen } = await replay("engine-check-ready", {
    transform: (exchange) => (exchange.bodyFile === "installed-llm-wiki.skill.md" ? { ...exchange, bodyFile: "installed-knowledge-graph.skill.md" } : exchange),
  });
  const counting = async (url, init) => { served += 1; return fetchImpl(url, init); };
  const { engine } = engineFor(counting);
  const status = await engine.check();
  assert.ok(served > 0);
  assert.equal(status.facts.skills.code, "openviking_skill_drifted");
  assert.equal(status.facts.skills.skills["llm-wiki"].state, "drifted");
  assert.equal(status.facts.skills.skills["knowledge-graph"].state, "installed");
  assert.ok(!seen.some((request) => request.method === "POST" && request.path === "/api/v1/skills"), "a drifted skill was overwritten");
  // The probe names an installed skill, so it is not run on skills that are not the pinned ones.
  assert.deepEqual(status.facts.compileIdentity, { ok: false, code: "openviking_compile_unprobed" });
  assert.ok(!seen.some((request) => request.path === "/api/v1/compile"));
  assert.deepEqual(status.degraded, ["knowledge"]);
});

test("a shipped skill file that is not the pinned upstream bytes is never installed", async () => {
  const { fetchImpl, seen } = await replay("engine-check-new-volume");
  const { engine } = engineFor(fetchImpl, { account: "evimed-fresh", readSkill: async (name) => `${await readPinnedSkill(name)}\nan edit nobody reviewed\n` });
  const status = await engine.check();
  assert.equal(status.facts.skills.code, "openviking_skill_source_drifted");
  assert.ok(!seen.some((request) => request.method === "POST" && request.path === "/api/v1/skills"));
  assert.equal(engine.counters.skillInstalls, 0);
});

test("another release answering on the same configuration is a version mismatch, whatever else is true", async () => {
  const { fetchImpl } = await replay("engine-check-ready");
  const { engine } = engineFor(fetchImpl, { pinned: { ...pin, version: "0.5.1" } });
  const status = await engine.check();
  assert.deepEqual(status.facts.version, { ok: false, code: "openviking_version_mismatch", expected: "v0.5.1", version: "v0.5.1.1" });
  assert.deepEqual(status.degraded.sort(), ["knowledge", "nativeMemory"]);
  assert.equal(engine.ready("nativeMemory").fact, "version");
});

test("a deployment without the service key degrades both features and names the key", async () => {
  const { fetchImpl } = await replay("engine-check-ready");
  for (const [config, code] of [[{}, "openviking_model_key_missing"], [{ openVikingModelKey: "", openVikingModelKeyError: "openviking_model_key_file_unavailable" }, "openviking_model_key_file_unavailable"]]) {
    const { engine } = engineFor(fetchImpl, { config });
    const status = await engine.check();
    assert.deepEqual(status.facts.modelKey, { ok: false, code });
    assert.deepEqual(status.degraded.sort(), ["knowledge", "nativeMemory"]);
  }
});

test("an engine that does not answer fails every fact with the client's own code, in one request and without throwing", async () => {
  let requests = 0;
  const { engine } = engineFor(async () => { requests += 1; throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); });
  const status = await engine.check();
  assert.equal(requests, 1, "the check went on asking an engine that is not there");
  assert.equal(status.facts.version.code, "memory_index_unavailable");
  for (const name of ["memoryTemplates", "skills", "compileIdentity"]) assert.deepEqual(status.facts[name], { ok: false, code: "memory_index_unavailable" });
  assert.equal(status.facts.modelKey.ok, true, "a fact that needs no request was failed by one");
  assert.equal(status.ok, false);
});

test("two checks asked for at once are one check, and the timer neither keeps a process alive nor starts without an engine", async () => {
  const { fetchImpl, seen } = await replay("engine-check-ready");
  const { engine } = engineFor(fetchImpl);
  const [first, second] = await Promise.all([engine.check(), engine.check()]);
  assert.deepEqual(first, second);
  assert.equal(seen.filter((request) => request.path === "/health").length, 1);
  assert.equal(engine.counters.checks, 1);
  engine.start();
  assert.ok(engine.timer);
  assert.equal(engine.timer.hasRef(), false, "the check's timer would hold a finished test or a draining process open");
  await engine.running;
  engine.close();
  assert.equal(engine.timer, null);
  // No engine configured: nothing to ask, nothing started.
  const unconfigured = new OpenVikingEngine({ client: new OpenVikingClient({ openVikingUrl: "" }), config: {}, pin });
  unconfigured.start();
  assert.equal(unconfigured.timer, null);
});

test("every code the check can say has a sentence for the operator console", () => {
  const codes = [
    "openviking_engine_unchecked", "openviking_registration_pending", "openviking_version_mismatch", "openviking_model_key_missing",
    "openviking_memory_templates_missing", "openviking_memory_types_mismatch", "openviking_skill_missing", "openviking_skill_drifted",
    "openviking_skill_source_drifted", "openviking_compile_unconfigured", "openviking_compile_unprobed",
    "openviking_compile_probe_unexpected", "openviking_compile_probe_unreadable", "openviking_model_budget_exhausted", "openviking_model_owner_unavailable",
  ];
  for (const code of codes) {
    assert.ok(READINESS_ERROR_CODES.includes(code), `${code} is not in the readiness registry`);
    assert.match(knownErrorCodeMessage(code) ?? "", /[一-鿿]/, code);
  }
});

test("the engine's source says every one of those codes and no other of its family", async () => {
  // A walk, so a code added to the check without a sentence fails here; the count is asserted because a walk that
  // matches nothing passes forever.
  const text = `${await readFile(new URL("../src/openVikingEngine.mjs", import.meta.url), "utf8")}\n${await readFile(new URL("../src/openVikingModelCaller.mjs", import.meta.url), "utf8")}`;
  const said = new Set([...text.matchAll(/"(openviking_[a-z_]+)"/g)].map((match) => match[1]).filter((code) => code !== "openviking_feature_unknown"));
  assert.ok(said.size >= 14, `the walk found only ${said.size} codes`);
  for (const code of said) assert.ok(READINESS_ERROR_CODES.includes(code), `${code} has no sentence in the registry`);
});
