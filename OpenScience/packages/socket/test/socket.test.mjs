import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { SEAMS } from "@evimed/harness-port";
import { CONTRACT_KINDS, workspaceLayout } from "@evimed/domain";

import {
  AGENT_PLUGIN_IDS,
  HOST_PLUGIN_IDS,
  PLUGIN_SPECIFIERS,
  PRESET_NAME,
  RUN_DOMAIN_SPEC,
  accumulateBudget,
  buildDelegation,
  buildGuidanceText,
  completionCheck,
  delegatableItems,
  evidenceFromOutcome,
  evidenceSourceErrorCode,
  gateDeliverable,
  guardedBashTarget,
  indexPlan,
  mergeEvidence,
  projectRunState,
  rejectionEnvelope,
  renderDeliverySummary,
  settleDelegation,
  staleEvidence,
  stepPolicy,
  toolPolicy,
} from "../index.mjs";

const limits = { maxSteps: 100, maxTokens: 1_000_000, maxChildren: 30 };
const zeroBudget = { steps: 0, tokens: 0, children: 0 };
const policyState = { budget: zeroBudget, limits, submitAttempts: 0, deliveryAttemptLimit: 3 };

test("the bundle patch carries no deployment path and no address", async () => {
  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  const body = patch.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.ok(!/\/opt\//.test(body), "a bundle row names an image path");
  assert.ok(!/\/runtime\//.test(body), "a bundle row names a container path");
  assert.ok(!/https?:\/\//.test(body), "a bundle row names an address");
  assert.match(body, /id: evimed-seam-probe/);
  assert.match(body, /id: hmr\n\s+disabled: true/);
  assert.match(body, /id: session-telemetry-otel\n\s+disabled: true/);
});

test("every patch row carries an explicit id", async () => {
  for (const file of ["../cordis.patch.yml", "../presets/evimed-universal/agent.cordis.yml"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    const rows = text.split("\n").filter((line) => /^\s*-\s+name:/.test(line));
    assert.deepEqual(rows, [], `${file} has a row without an id: ${rows.join(" | ")}`);
  }
});

test("the composition mounts our five agent plugins and nothing we ruled out", async () => {
  const preset = await readFile(new URL("../presets/evimed-universal/agent.cordis.yml", import.meta.url), "utf8");
  for (const id of AGENT_PLUGIN_IDS) assert.match(preset, new RegExp(`id: ${id}\\b`), id);
  for (const banned of ["tool-todo", "agent-instructions", "str_replace_editor", "tool-web", "plan-mode", "tool-ralph", "tool-lsp", "tool-goal"]) {
    const mounted = new RegExp(`^\\s*-?\\s*id: ${banned}\\s*$`, "m");
    assert.ok(!mounted.test(preset), `${banned} is mounted; it was ruled out on purpose`);
  }
  assert.match(preset, /includeDefaultRoots: false/, "workspace skill discovery would make an uploaded file an instruction");
  assert.match(preset, /reportDelivery: quiet/);
  assert.match(preset, /thresholdChars: 8192/);
  assert.equal(HOST_PLUGIN_IDS.length + AGENT_PLUGIN_IDS.length, Object.keys(PLUGIN_SPECIFIERS).length);
  assert.equal(PRESET_NAME, "evimed-universal");
});

test("every plugin exports only the four named members and no default", async () => {
  const files = (await readdir(new URL("../plugins/", import.meta.url))).filter((name) => name.endsWith(".mjs"));
  assert.equal(files.length, 8);
  for (const file of files) {
    const source = await readFile(new URL(`../plugins/${file}`, import.meta.url), "utf8");
    assert.ok(!/export\s+default/.test(source), `${file} has a default export (DSH postmortem 0001)`);
    assert.match(source, /export const name = /, `${file} declares no name`);
    assert.match(source, /export const inject = /, `${file} declares no inject`);
    assert.match(source, /export const Config = /, `${file} declares no Config`);
    assert.match(source, /export (async )?function apply\(/, `${file} declares no apply`);
  }
});

test("plugin inject sets stay inside the manifest's services", async () => {
  const known = new Set([...SEAMS.services.required, ...SEAMS.services.optional]);
  const files = (await readdir(new URL("../plugins/", import.meta.url))).filter((name) => name.endsWith(".mjs"));
  for (const file of files) {
    const source = await readFile(new URL(`../plugins/${file}`, import.meta.url), "utf8");
    const match = /export const inject = (\[[^\]]*\]|\[\.\.\.SEAMS\.services\.required\])/.exec(source);
    assert.ok(match, `${file} has no readable inject`);
    if (match[1].includes("SEAMS")) continue;
    for (const [, key] of match[1].matchAll(/'([a-zA-Z]+)'/g)) {
      assert.ok(known.has(key), `${file} injects "${key}", which is not in the seam manifest`);
    }
  }
});

test("no plugin imports a harness package or a node builtin directly", async () => {
  const files = (await readdir(new URL("../plugins/", import.meta.url))).filter((name) => name.endsWith(".mjs"));
  const srcFiles = (await readdir(new URL("../src/", import.meta.url))).filter((name) => name.endsWith(".mjs"));
  for (const [dir, list] of [["plugins", files], ["src", srcFiles]]) {
    for (const file of list) {
      const source = await readFile(new URL(`../${dir}/${file}`, import.meta.url), "utf8");
      assert.ok(!/from\s+['"]@deepseek-ai\//.test(source), `${dir}/${file} imports a harness package directly`);
      assert.ok(!/import\(['"]@deepseek-ai\//.test(source), `${dir}/${file} names a harness package in a JSDoc import`);
      assert.ok(!/from\s+['"]node:/.test(source), `${dir}/${file} imports a node builtin`);
    }
  }
});

test("no plugin subscribes to an event as a literal", async () => {
  const files = (await readdir(new URL("../plugins/", import.meta.url))).filter((name) => name.endsWith(".mjs"));
  for (const file of files) {
    const source = await readFile(new URL(`../plugins/${file}`, import.meta.url), "utf8");
    for (const eventName of Object.values(SEAMS.events)) {
      assert.ok(!source.includes(`'${eventName}'`), `plugins/${file} writes "${eventName}" as a literal`);
    }
  }
});

test("no plugin holds a regular expression or a threshold of its own", async () => {
  const files = (await readdir(new URL("../plugins/", import.meta.url))).filter((name) => name.endsWith(".mjs"));
  for (const file of files) {
    const source = await readFile(new URL(`../plugins/${file}`, import.meta.url), "utf8");
    const body = source.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
    assert.ok(!/new RegExp\(/.test(body), `plugins/${file} builds a regular expression; rules live in the domain`);
  }
});

test("the run domain declares four tables and no claims table", () => {
  assert.deepEqual(Object.keys(RUN_DOMAIN_SPEC.tables).sort(), ["evidence", "gate_runs", "plan_index", "run_mirror"]);
  // The medium's own rule, asserted here rather than discovered at boot: the
  // harness validates the domain name and every table name against this
  // pattern and refuses to open a domain that breaks it. A camelCase table name
  // shipped once and took the whole plugin tree down with it.
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
  assert.match(RUN_DOMAIN_SPEC.name, UNIT_NAME_RE, "the domain name must satisfy the harness's identifier rule");
  for (const table of Object.keys(RUN_DOMAIN_SPEC.tables)) {
    assert.match(table, UNIT_NAME_RE, `table ${table} must satisfy the harness's identifier rule`);
  }
  assert.ok(!("claims" in RUN_DOMAIN_SPEC.tables), "the matrix already binds claims to sources; a copy is a second truth");
  assert.equal(RUN_DOMAIN_SPEC.version, 1);
});

test("the path guard refuses the question, the receipt and the state projection", () => {
  for (const path of [workspaceLayout.briefFile, workspaceLayout.runStateFile, workspaceLayout.receiptFile, "data/cohort/rows.csv"]) {
    const decision = toolPolicy({ name: "write", args: { path } }, policyState);
    assert.equal(decision.allow, false, path);
    assert.equal(decision.code, "path_guard_denied");
  }
  assert.equal(toolPolicy({ name: "write", args: { path: "deliverables/d1/report.md" } }, policyState).allow, true);
  assert.equal(toolPolicy({ name: "write", args: { path: workspaceLayout.planFile } }, policyState).allow, true);
});

test("the path guard reaches through bash without refusing ordinary reads", () => {
  assert.equal(guardedBashTarget("rm -rf .evimed-brief/"), ".evimed-brief/");
  assert.equal(guardedBashTarget("echo x > .evimed-run/state.json"), ".evimed-run/state.json");
  assert.equal(guardedBashTarget("sed -i s/a/b/ delivery-receipt.json"), "delivery-receipt.json");
  assert.equal(guardedBashTarget("cat .evimed-brief/research-brief.md"), null);
  assert.equal(guardedBashTarget("grep -r foo deliverables/"), null);
  assert.equal(guardedBashTarget("python3 analyze.py > deliverables/d1/out.txt"), null);
});

test("the budget refuses a step and the refusal names what to do next", () => {
  assert.equal(stepPolicy({ steps: 5, tokens: 10, children: 0 }, { maxSteps: 10, maxTokens: 100, maxChildren: 5 }).allow, true);
  const exhausted = stepPolicy({ steps: 10, tokens: 10, children: 0 }, { maxSteps: 10, maxTokens: 100, maxChildren: 5 });
  assert.equal(exhausted.allow, false);
  assert.equal(exhausted.code, "budget_exhausted");
  assert.match(exhausted.reason, /partial/);
  assert.deepEqual(accumulateBudget(zeroBudget, { input: 10, output: 5, cacheHit: 8, cacheMiss: 2 }), { steps: 1, tokens: 15, children: 0 });
});

test("a delegation is queued until its dependencies are accepted", () => {
  const { plan, items } = indexPlan({
    revision: 1,
    clarifications: ["assumed adults"],
    deliverables: [
      { id: "a", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", title: "A", dependsOn: [] },
      { id: "b", contractKind: "research-brief", capability: "research-brief", title: "B", dependsOn: ["a"] },
    ],
  });
  assert.deepEqual(delegatableItems(plan, items).map((item) => item.id), ["a"]);
  const accepted = items.map((item) => (item.id === "a" ? { ...item, status: "accepted" } : item));
  assert.deepEqual(delegatableItems(plan, accepted).map((item) => item.id), ["b"]);
});

test("a delegated child gets a writable tool set and its own deliverable directory", () => {
  const manifest = {
    id: "clinical-evidence-synthesis",
    persona: "You are a clinical evidence analyst.",
    tools: ["mcp__evimed__literature_search"],
    produces: [{ contractKind: "clinical-evidence-report", outputs: [{ path: "clinical-evidence-report.md", required: true }] }],
  };
  const request = buildDelegation({
    manifest,
    item: { id: "d1", title: "证据综述", contractKind: "clinical-evidence-report" },
    briefExcerpt: "题面",
    skillBodies: [{ name: "clinical-evidence-synthesis", body: "步骤…" }],
    inputs: { question: "x" },
    toolFilter: ["read", "write", "edit", "evimed_submit_deliverable", "mcp__evimed__literature_search"],
  });
  assert.ok(request.tools.includes("write"), "a child that cannot write cannot deliver (G3)");
  assert.match(request.prompt, /deliverables\/d1\//);
  assert.match(request.prompt, /步骤…/, "the skill body must be pre-injected, not merely named");
  assert.equal(request.maxDepth, 1);
  assert.equal(request.persona, manifest.persona);
});

test("a child that did not complete is retried once and then reported, never dropped", () => {
  assert.deepEqual(settleDelegation({ item: {}, outcome: { stopReason: "completed", diagnostic: "" }, alreadyRetried: false }), { action: "settled", reason: "" });
  assert.equal(settleDelegation({ item: {}, outcome: { stopReason: "error", diagnostic: "boom" }, alreadyRetried: false }).action, "redelegate");
  assert.equal(settleDelegation({ item: {}, outcome: { stopReason: "error", diagnostic: "boom" }, alreadyRetried: true }).action, "fail");
});

test("a recoverable source failure is recognized from where its code actually survives", () => {
  // Our MCP server JSON-encodes the whole `failure()` object into the text
  // block; the kernel's bridge throws `new Error(text)` before it reads
  // `structuredContent`; and `ToolFailure.info` is populated only for
  // `HarnessError` subclasses, which an MCP failure never is. So this is the
  // one surviving copy.
  const payload = {
    status: "error",
    summary: "Public source returned HTTP 502.",
    next_actions: ["retry"],
    error: { code: "public_source_http_error", message: "Public source returned HTTP 502.", retryable: true, stopReason: null },
  };
  const failure = { isError: true, content: [], error: { message: JSON.stringify(payload) } };
  assert.equal(evidenceSourceErrorCode(failure), "public_source_http_error");

  // A `HarnessError`-shaped failure still reports through the declared field.
  assert.equal(evidenceSourceErrorCode({ isError: true, error: { message: "x", info: { name: "ToolError", code: "full_text_not_available" } } }), "full_text_not_available");

  // Negative controls. Each of these is a shape the pre-fix reading treated as
  // equivalent to "no failure", and each must stay distinguishable from a real
  // code rather than throwing or inventing one.
  assert.equal(evidenceSourceErrorCode({ isError: false, value: {}, content: [] }), "", "a success has no code");
  assert.equal(evidenceSourceErrorCode({ isError: true, error: { message: "plain text, not JSON" } }), "");
  assert.equal(evidenceSourceErrorCode({ isError: true, error: { message: "{not valid json" } }), "");
  assert.equal(evidenceSourceErrorCode({ isError: true, error: { message: JSON.stringify({ status: "error" }) } }), "");
  assert.equal(evidenceSourceErrorCode(undefined), "");
  // The reading the code used to do, and the reading the declarations suggest,
  // both return nothing on the real shape — which is why the retry was dead.
  assert.equal(failure.error.code, undefined);
  assert.equal(failure.error.info, undefined);
});

test("the gate answers with a value and the rejection is layered", () => {
  const verdict = gateDeliverable({
    contractKind: "research-brief",
    files: new Map([["brief.md", "# 标题\n结论。"]]),
    expectedOutputs: [{ path: "brief.md", required: true }, { path: "sources.csv", required: true }],
  });
  assert.equal(verdict.ok, false);
  const envelope = rejectionEnvelope(verdict);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, "deliverable_rejected");
  assert.equal(envelope.issues[0].severity, "required");
});

test("completion refuses while a deliverable is unaccepted and allows a partial delivery", () => {
  const plan = { clarifications: ["假设成人人群"] };
  const items = [{ id: "d1", title: "A", contractKind: "research-brief", capability: "research-brief", status: "rejected" }];
  const strict = completionCheck({ plan, items, producedTexts: [], finalReplyText: "", partial: false });
  assert.equal(strict.ok, false);
  assert.ok(strict.issues.some((issue) => issue.code === "deliverable_not_accepted"));
  const partial = completionCheck({ plan, items, producedTexts: [], finalReplyText: "", partial: true });
  assert.equal(partial.ok, true, "a partial delivery still delivers");
});

test("completion refuses a plan with no clarifications written down", () => {
  const check = completionCheck({ plan: { clarifications: [] }, items: [], producedTexts: [], finalReplyText: "", partial: false });
  assert.ok(check.issues.some((issue) => issue.code === "plan_missing_clarifications"));
});

test("clinical content under a non-clinical contract is caught by scanning the output", () => {
  const items = [{ id: "d1", contractKind: "research-brief", capability: "research-brief", status: "accepted" }];
  const check = completionCheck({
    plan: { clarifications: ["x"] },
    items,
    producedTexts: [{ path: "deliverables/d1/brief.md", text: "速效救心丸的推荐用法。" }],
    finalReplyText: "",
    partial: false,
  });
  assert.ok(check.issues.some((issue) => issue.code === "clinical_content_without_clinical_contract"));
});

test("a direct reply is scanned too, because it still said something about a medicine", () => {
  const check = completionCheck({ plan: null, items: [], producedTexts: [], finalReplyText: "速效救心丸可以这样用。", partial: false });
  assert.ok(check.issues.some((issue) => issue.code === "clinical_content_in_reply"));
});

test("the delivery summary is written even when the run gave up", () => {
  const summary = renderDeliverySummary({
    plan: { clarifications: ["假设成人人群"] },
    items: [{ id: "d1", title: "A", contractKind: "research-brief", capability: "research-brief", status: "rejected", attempts: 3 }],
    issues: [{ code: "deliverable_not_accepted", severity: "required", message: "未通过" }],
    partial: true,
    runId: "run_1",
    at: "2026-08-23T00:00:00Z",
  });
  assert.match(summary, /部分交付/);
  assert.match(summary, /假设成人人群/);
  assert.match(summary, /deliverable_not_accepted/);
  assert.match(summary, /\| A \| research-brief \|/);
});

test("evidence records how far a source actually got", () => {
  const context = { runId: "r1", now: "2026-08-23T00:00:00Z", digest: (value) => String(value.length) };
  const searched = evidenceFromOutcome(
    { name: "mcp__evimed__literature_search", args: { query: "metformin" } },
    { status: "completed", structured: { results: [{ pmid: "1" }, { pmid: "2" }] }, text: "" },
    context,
  );
  assert.equal(searched.length, 2);
  assert.equal(searched[0].status, "queued", "a search result is a lead, not readable text");
  const fetched = evidenceFromOutcome(
    { name: "mcp__evimed__open_access_full_text", args: { identifier: "10.1/x" } },
    { status: "completed", structured: { doi: "10.1/x", artifactPath: ".evimed-sources/a.md" }, text: "" },
    context,
  );
  assert.equal(fetched[0].status, "ready");
  assert.deepEqual(evidenceFromOutcome({ name: "bash", args: {} }, { status: "completed", structured: {}, text: "" }, context), []);
  assert.deepEqual(evidenceFromOutcome({ name: "mcp__evimed__literature_search", args: {} }, { status: "error", structured: null, text: "" }, context), []);
});

test("merging evidence never walks a source backwards", () => {
  const ready = { evidenceId: "e1", status: "ready" };
  const queued = { evidenceId: "e1", status: "queued" };
  assert.equal(mergeEvidence([ready], [queued])[0].status, "ready");
  assert.equal(mergeEvidence([queued], [ready])[0].status, "ready");
  assert.equal(mergeEvidence([ready], [{ evidenceId: "e1", status: "verified" }])[0].status, "verified");
});

test("a source that was asked for and never arrived becomes visibly unresolved", () => {
  const now = Date.parse("2026-08-23T01:00:00Z");
  const records = [
    { evidenceId: "a", status: "queued", recordedAt: "2026-08-23T00:00:00Z" },
    { evidenceId: "b", status: "queued", recordedAt: "2026-08-23T00:58:00Z" },
    { evidenceId: "c", status: "ready", recordedAt: "2026-08-23T00:00:00Z" },
  ];
  assert.deepEqual(staleEvidence(records, 10, now).map((item) => item.evidenceId), ["a"]);
});

test("the run-state projection is total and orders gate runs by attempt", () => {
  const projection = projectRunState({
    run: { runId: "r1", sessionId: "s1", budget: { maxSteps: 100, maxTokens: 10, maxChildren: 3 }, steps: 4, tokens: 9, children: 1 },
    planIndex: { revision: 2, items: [{ id: "d1", status: "accepted" }] },
    evidence: [{ status: "ready" }, { status: "queued" }, { status: "queued" }],
    gateRuns: [{ attempt: 3 }, { attempt: 1 }, { attempt: 2 }],
    now: "2026-08-23T00:00:00Z",
  });
  assert.deepEqual(projection.gateRuns.map((run) => run.attempt), [1, 2, 3]);
  assert.deepEqual(projection.evidence, { total: 3, byStatus: { ready: 1, queued: 2 } });
  assert.equal(projection.budget.limits.maxChildren, 3);
  const empty = projectRunState({ run: undefined, planIndex: undefined, evidence: [], gateRuns: [], now: "t" });
  assert.equal(empty.runId, "");
  assert.deepEqual(empty.plan.items, []);
});

test("the guidance names the capability catalogue as the edge of what we can do", () => {
  const text = buildGuidanceText(
    [{ id: "clinical-evidence-synthesis", description: "把临床问题变成可追溯的证据包。", whenToUse: "需要证据综述时。", produces: [{ contractKind: "clinical-evidence-report" }] }],
    { askUserEnabled: false, capsuleActive: true, reviewEnabled: false },
  );
  assert.match(text, /clinical-evidence-synthesis/);
  assert.match(text, /目录里没有的能力，如实说明/);
  assert.match(text, /把你所做的假设写进/, "an unattended deployment must be told to write the assumption down");
  assert.ok(!/evimed_review_run/.test(text), "a disabled capability must not be advertised");
  assert.ok(CONTRACT_KINDS.includes("clinical-evidence-report"));
});

test("an empty or unconfigured capability catalogue says so instead of disabling delegation quietly", async () => {
  // Delegation is refused for every capability when the catalogue is empty, and
  // the refusal names the request ("not in the catalogue") rather than the
  // deployment. The same silence cost a whole real run when the skill roots
  // resolved to `undefined/…`: nothing loaded, nothing complained, and the model
  // did not know what it was supposed to do.
  const { loadCapabilities } = await import("../plugins/guidance.mjs");
  const said = [];
  const ctx = {
    get: (key) => (key === "evimedDiagnostics" ? { degrade: (line) => said.push(line) } : undefined),
  };
  Object.defineProperty(ctx, "fs", { get: () => undefined, configurable: true });

  assert.deepEqual(await loadCapabilities(ctx, ""), []);
  assert.ok(said.some((line) => /no capabilities directory is configured/.test(line)), `unset directory said: ${said}`);

  said.length = 0;
  const empty = {
    get: (key) => (key === "evimedDiagnostics" ? { degrade: (line) => said.push(line) } : undefined),
    // `listDirAt` calls `fs.listDir`, not `fs.list` — the double has to offer
    // the method the port actually uses.
    fs: { resolve: async (relative, options) => `${options?.cwd ?? ""}/${relative}`, listDir: async () => [] },
  };
  Object.defineProperty(empty, "fs", { get: () => empty._fs, configurable: true });
  empty._fs = { resolve: async (relative, options) => `${options?.cwd ?? ""}/${relative}`, listDir: async () => [] };
  assert.deepEqual(await loadCapabilities(empty, "/opt/evimed/capabilities"), []);
  assert.ok(said.some((line) => /catalogue is empty/.test(line)), `empty directory said: ${said}`);
});
