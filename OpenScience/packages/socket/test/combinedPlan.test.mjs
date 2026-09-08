/**
 * The combined plan: one request, two capabilities, one delivery.
 *
 * Hidden knowledge: every other test in this suite drives one capability per
 * run, and the product's central promise is the other shape — a plan whose
 * deliverables come from different capabilities, delegated to different
 * children, graded under different contracts, and delivered together. The
 * composition of the run-policy plugin has exactly four places where that
 * shape can break and a single-capability run cannot notice:
 *
 * 1. **Binding.** A child is bound to the one plan item that created it. With
 *    one item in the plan, a broken binding is invisible: every submission
 *    names the only item there is. With two, a child submitting the other
 *    capability's item is the failure — and it is the one that loses a
 *    finished package, because the wrong contract's validator runs over it.
 * 2. **Sequencing.** `dependsOn` is computed by the tool, not asked of the
 *    model, and a one-item plan has nothing to depend on.
 * 3. **Independence.** One capability's rejection must not touch the other's
 *    acceptance, and the run must still be able to finish partially while
 *    saying which item is unfinished.
 * 4. **The tool filter.** Each child is handed its own capability's tools. A
 *    single-capability run is handed the union of one set, so a filter that
 *    ignored the capability would look identical.
 * 5. **The projection.** None of the four is worth anything if the artifact the
 *    control plane reads cannot tell the two children apart. `run_mirror`,
 *    `plan_index` and the `subagents` medium never leave the container: what
 *    leaves is `.evimed-run/runs/<id>/state.json`, written by
 *    `plugins/evidence-store.mjs` from those tables. Assertions that stop at
 *    the in-memory Map miss the projection entirely, and two one-line changes
 *    at that seam — projecting only the first child, or projecting children
 *    without their `capability` — turn a combined run into a run with one
 *    child or with none, silently. `apps/server/src/agentRuns.mjs`'s
 *    `scopeNativeProjection` admits a child only when a plan item of the same
 *    id names the same capability, so a `capability`-less row is dropped by the
 *    consumer rather than merely displayed oddly. The last test in this file
 *    composes the real store with the real policy and asserts on that file.
 *
 * What this file cannot prove about (4): enforcement. `toolFilter.allow` is
 * what the kernel restricts a child to, and `src/runPolicy.mjs`'s tool policy
 * has gate-source, frozen-deliverable, protected-path and bash rules but no
 * capability rule at all. So the strongest offline statement is "the allow-list
 * handed to `ctx.subagents.start` excludes the other capability's tool" — not
 * "a child calling it is refused". Refusing the call is the kernel's, and
 * proving it needs a live one; the spec files that under V41 (tool rows
 * composing cleanly under our preset scope), which stays open.
 *
 * The harness is the same stand-in for the real Loader that `consistency.test.mjs`
 * uses — the registry preconditions copied from `@deepseek-ai/dsh-tools`, the
 * waterfall policy seam, the monotonic guards — because those are the seam
 * contracts a plugin can get wrong. It is duplicated rather than imported
 * because that file exports nothing.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SEAMS, __setHarnessModule } from "@evimed/harness-port";
import { DELEGATION_BASE_TOOLS, runStateFileFor, workspaceLayout } from "@evimed/domain";
import { RUN_DOMAIN_NAME } from "../src/runMirror.mjs";

__setHarnessModule("@deepseek-ai/dsh-tools", {
  defineTool: (/** @type {any} */ options) => ({ ...options }),
});

const schema = Object.assign(
  (/** @type {any} */ shape) => ({ shape, __schema: "object" }),
  {
    object: (/** @type {any} */ shape) => ({ shape, __schema: "object" }),
    string: () => chainable("string"),
    number: () => chainable("number"),
    boolean: () => chainable("boolean"),
    array: (/** @type {any} */ item) => chainable("array", { item }),
    union: (/** @type {any} */ options) => chainable("union", { options }),
    const: (/** @type {any} */ value) => chainable("const", { value }),
    dict: (/** @type {any} */ value) => chainable("dict", { value }),
  },
);

function chainable(/** @type {any} */ kind, extra = {}) {
  /** @type {Record<string, any>} */
  const node = { __schema: kind, ...extra };
  for (const method of ["default", "description", "required", "min", "max", "role", "hidden", "comment", "deprecated"]) {
    node[method] = (/** @type {any} */ value) => Object.assign(node, { [method]: value });
  }
  return node;
}

__setHarnessModule("@deepseek-ai/schemastery", { default: schema });

/**
 * The preconditions the real registry checks, in the order it checks them.
 *
 * All four clauses, as `consistency.test.mjs` copies them from
 * `@deepseek-ai/dsh-tools`'s `register()`. Two of them have nothing to catch in
 * this file today — nothing here registers a tool carrying a `timeoutMs` or the
 * reserved name — and dropping them for that reason is precisely the mistake
 * the original comment records: the fake's leniency is what let a real defect
 * ship, when the plugins registered un-awaited `defineTool` Promises and a
 * permissive `tools.set(tool.name, tool)` stored one happily under the key
 * `undefined` while the real registry throws on the next line. A lenient
 * duplicate passes against a composition that cannot start.
 *
 * Duplicated rather than imported because `consistency.test.mjs` exports
 * nothing. Two guards need two guarantees, and the two tests directly below
 * are them: one pins every clause of this copy, so it cannot quietly lose one;
 * the other holds this copy byte-identical to the one in `consistency.test.mjs`,
 * so a fifth precondition added there cannot leave this file lenient. That is
 * the same discipline `apps/server/test/capabilityPreflightCopiesAgree.test.mjs`
 * applies to the four copies of a capability's `preflight.py`.
 */
function assertRegistrable(/** @type {any} */ definition) {
  const name = definition?.name;
  if (typeof name !== "string" || !name) {
    throw new TypeError(`tool "${String(name)}" must declare a name (a Promise from defineTool is not a definition)`);
  }
  const output = definition.output;
  if (output === undefined || typeof output !== "object" || typeof output.render !== "function") {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
  }
  if (name === "run_code") {
    throw new Error('tool name "run_code" is reserved for the Code Mode presentation transport');
  }
}

/** A context that models the seam contracts a plugin can get wrong. */
function harness() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  /** @type {Map<string, any>} */
  const tools = new Map();
  /** @type {Function[]} */
  const guards = [];
  /** @type {Function[]} */
  const disposers = [];
  /** @type {Map<string, any>} */
  const services = new Map();
  const registry = {
    register(/** @type {any} */ tool) {
      assertRegistrable(tool);
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
    guard(/** @type {any} */ fn) {
      guards.push(fn);
      return () => guards.splice(guards.indexOf(fn), 1);
    },
    /** @param {any} input
     *  @returns {Promise<{ value?: any, error?: { name: string, code: string }, content: any, concluded?: boolean }>} */
    async execute(input) {
      for (const guard of guards) {
        const reason = guard(input);
        if (reason !== undefined) return { error: { name: "Guarded", code: "GUARDED" }, content: [{ type: "text", text: reason }] };
      }
      const chain = listeners.get(SEAMS.events.toolPolicy) ?? [];
      let index = 0;
      const next = async () => (index < chain.length ? chain[index++](input, next) : { kind: "allow" });
      const decision = await next();
      if (decision?.kind === "deny") return { error: { name: "Denied", code: "DENIED" }, content: [{ type: "text", text: decision.reason }] };
      const tool = tools.get(input.name);
      if (!tool) return { error: { name: "Unknown", code: "UNKNOWN_TOOL" }, content: [] };
      let concluded = false;
      const value = await tool.execute(input.arguments ?? {}, { ...input, concludeTurn: () => { concluded = true; } });
      const result = { value, content: tool.output?.render?.(input.arguments ?? {}, value) ?? [], concluded };
      for (const handler of listeners.get(SEAMS.events.toolObserved) ?? []) handler(input, result);
      return result;
    },
  };
  const ctx = {
    get: (/** @type {any} */ key) => (key === "tools" ? registry : services.get(key)),
    on(/** @type {any} */ event, /** @type {any} */ handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((/** @type {any} */ item) => item !== handler));
    },
    emit: (/** @type {any} */ event, /** @type {any[]} */ ...args) => (listeners.get(event) ?? []).map((/** @type {any} */ handler) => handler(...args)),
    effect(/** @type {any} */ fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    provide(/** @type {any} */ key, /** @type {any} */ value) {
      services.set(key, value);
    },
    unmount() {
      for (const dispose of disposers.reverse()) dispose();
      disposers.length = 0;
    },
    listeners,
    tools: registry,
    toolNames: () => [...tools.keys()],
  };
  return ctx;
}

/* --------------------------------------------------- the two capabilities */

// Both are real manifests from `capabilities/`, trimmed to the fields the
// plugin reads. Two capabilities, two contract kinds, two disjoint tool sets
// and two different validator families — the JSON-and-prose appraisal table
// and the report-shaped bibliometric report — so nothing in the assertions
// below can pass by both items happening to be the same thing twice.
const BIBLIOMETRIC = Object.freeze({
  id: "bibliometric-analysis",
  persona: "你是文献计量分析师。",
  skills: ["bibliometric-analysis"],
  tools: ["mcp__evimed__bibliometric_analysis", "mcp__evimed__evidence_deduplicate"],
  produces: [{
    contractKind: "bibliometric-analysis-report",
    outputs: [
      { path: "bibliometric-analysis-report.md", required: true },
      { path: "bibliometric-analysis-run.json", required: true },
    ],
  }],
});

const APPRAISAL = Object.freeze({
  id: "evidence-appraisal",
  persona: "你是证据质量评价员。",
  skills: ["evidence-appraisal"],
  tools: ["mcp__evimed__drug_label_search", "mcp__evimed__term_normalize"],
  produces: [{
    contractKind: "appraisal-table",
    outputs: [
      { path: "appraisal-table.json", required: true },
      { path: "appraisal-table.md", required: true },
      { path: "appraisal-table.csv", required: true },
      { path: "citation-ledger.csv", required: true },
      { path: "delivery-summary.md", required: true },
    ],
  }],
});

/** The tool each capability alone declares — the filter's whole subject. */
const BIBLIOMETRIC_ONLY_TOOL = "mcp__evimed__bibliometric_analysis";
const APPRAISAL_ONLY_TOOL = "mcp__evimed__drug_label_search";

const SKILL_BODIES = Object.freeze({
  "bibliometric-analysis": "## 文献计量步骤\n1. 固定检索式\n",
  "evidence-appraisal": "## 证据评价步骤\n1. 逐篇判设计\n",
});

const PLAN_ITEMS = Object.freeze({
  bibliometric: { id: "d-bib", contractKind: "bibliometric-analysis-report", capability: "bibliometric-analysis", title: "文献计量报告", dependsOn: [] },
  appraisal: { id: "d-appraise", contractKind: "appraisal-table", capability: "evidence-appraisal", title: "证据评价表", dependsOn: [] },
});

/** Content that satisfies each capability's required outputs. */
function bibliometricFiles(prefix = "/workspace/deliverables/d-bib") {
  return new Map([
    [`${prefix}/bibliometric-analysis-report.md`, "# 文献计量报告\n\n## 发文趋势\n\n近十年发文量稳步上升。\n"],
    [`${prefix}/bibliometric-analysis-run.json`, JSON.stringify({ status: "succeeded", queries: ["topic[tiab]"] })],
  ]);
}

/** @param {{ complete?: boolean }} [options] */
function appraisalFiles({ complete = true } = {}, prefix = "/workspace/deliverables/d-appraise") {
  const files = new Map([
    [`${prefix}/appraisal-table.json`, JSON.stringify({ studies: [], bodies: [] })],
    [`${prefix}/appraisal-table.md`, "# 证据评价表\n\n## 汇总\n\n纳入研究的确定性为中等。\n"],
    [`${prefix}/appraisal-table.csv`, "study,design,rob\nS1,RCT,low\n"],
    [`${prefix}/citation-ledger.csv`, "id,title\nS1,A trial\n"],
  ]);
  // `delivery-summary.md` is the one required output withheld to produce a
  // rejection: `required_output_missing` is decided by the manifest, so the
  // rejection is the contract's own and not a sentence this test invented.
  if (complete) files.set(`${prefix}/delivery-summary.md`, "# 交付摘要\n\n本次评价覆盖一项研究。\n");
  return files;
}

/* ------------------------------------------------------------- the fixture */

/**
 * `projected` swaps the hand-written `evimedRun` stub for the real
 * `evidence-store` plugin, so the run's durable rows are projected into the
 * workspace file the control plane reads instead of stopping in memory. It is
 * off by default because it costs a debounce wait per assertion point, and the
 * tests that are about binding, sequencing and contracts do not need the file.
 *
 * @param {{
 *   subagentStart?: ((provider: any, options: any) => any) | null,
 *   deliveryAttemptLimit?: number,
 *   structuralAttemptAllowance?: number,
 *   projected?: boolean,
 * }} [options]
 */
async function combinedFixture({ subagentStart = null, deliveryAttemptLimit = 3, structuralAttemptAllowance = 2, projected = false } = {}) {
  const { apply: applyRunPolicy } = await import("../plugins/run-policy.mjs");
  const ctx = harness();
  const rows = new Map();
  const childRows = new Map();
  const sessionRuns = new Map();
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {any[]} */
  const gateRuns = [];
  const agent = { id: "root-agent", session: { id: "root-session", header: { cwd: "/workspace" } }, inject: () => {} };
  ctx.provide("agents", { get: () => agent });
  ctx.provide("fs", {
    resolve: async (/** @type {string} */ relative, /** @type {{ cwd: string }} */ { cwd }) => `${cwd}/${relative}`,
    readText: async (/** @type {string} */ target) => {
      if (target.endsWith(workspaceLayout.briefIndexFile)) return JSON.stringify({ runId: "combined_run" });
      for (const [skill, body] of Object.entries(SKILL_BODIES)) {
        if (target === `/skills/${skill}/SKILL.md`) return body;
      }
      return files.get(target) ?? null;
    },
    writeText: async (/** @type {string} */ target, /** @type {string} */ text) => { files.set(target, text); },
  });
  if (projected) {
    // The real store, on a storage medium double: the tables are Maps, but
    // `apply()`, `projectRunState` and the workspace write are the shipped
    // ones, which is the point — the projection is the artifact under test,
    // not a shape this file decided on.
    /** @type {Map<string, Map<string, any>>} */
    const tables = new Map();
    const table = (/** @type {string} */ name) => {
      if (!tables.has(name)) tables.set(name, new Map());
      const stored = /** @type {Map<string, any>} */ (tables.get(name));
      return {
        put: async (/** @type {string} */ key, /** @type {any} */ value) => {
          stored.set(key, value);
          if (name === "run_mirror") rows.set(key, value);
          if (name === "gate_runs") gateRuns.push({ key, ...value });
          ctx.emit(SEAMS.events.domainChanged, { domain: RUN_DOMAIN_NAME, table: name, key, operation: "put", value });
        },
        entries: () => [...stored.entries()],
        values: () => [...stored.values()],
      };
    };
    ctx.provide("storageDomain", { open: async () => ({ table, close: async () => {} }) });
    // `openDomain` reaches for `ctx.storageDomain` as a property, not through
    // `ctx.get`, so the double has to offer both — a real cordis Context does.
    Object.defineProperty(ctx, "storageDomain", { get: () => ctx.get("storageDomain"), configurable: true });
    const { apply: applyEvidenceStore } = await import("../plugins/evidence-store.mjs");
    await applyEvidenceStore(ctx, { projectionDebounceMs: 1 });
  } else {
    ctx.provide("evimedRun", {
      runMirror: { put: async (/** @type {string} */ key, /** @type {any} */ value) => rows.set(key, value) },
      planIndex: { put: async () => {} },
      gateRuns: { put: async (/** @type {string} */ key, /** @type {any} */ value) => gateRuns.push({ key, ...value }) },
      evidence: { entries: () => [] },
      subagents: childRows,
      sessionRuns,
      runIdForSession: (/** @type {string} */ sessionId) => sessionRuns.get(sessionId) ?? "",
    });
    ctx.provide("evimedDiagnostics", { degrade() {}, notice() {} });
  }
  ctx.provide("evimedCapabilities", [BIBLIOMETRIC, APPRAISAL]);
  /** @type {{ provider: any, options: any }[]} */
  const starts = [];
  /** @type {any} */ (ctx).subagents = {
    start: (/** @type {any} */ provider, /** @type {any} */ options) => {
      starts.push({ provider, options });
      if (!subagentStart) throw new Error("unexpected subagent start");
      return subagentStart(provider, options);
    },
  };
  await applyRunPolicy(ctx, {
    maxSteps: 100,
    maxTokens: 100000,
    maxParallelChildren: 3,
    deliveryAttemptLimit,
    structuralAttemptAllowance,
    bundleVersion: "0.1.0",
    capabilitiesDir: "",
    skillsDir: "/skills",
    revisionAuthorizeUrl: "",
    tokenFile: "",
    revisionAuthorizeTimeoutMs: 1000,
  });
  const step = async (/** @type {number} */ turn) => {
    for (const handler of ctx.listeners.get(SEAMS.events.preStep) ?? []) {
      await handler({ agent, turn, step: 1, signal: AbortSignal.timeout(2000) }, async () => ({ kind: "allow" }));
    }
  };
  const execute = (/** @type {string} */ name, /** @type {any} */ args) => ctx.tools.execute({
    agent, name, callId: `call-${name}-${Math.random().toString(16).slice(2)}`, arguments: args, signal: AbortSignal.timeout(2000),
  });
  /** A delegated child, calling a tool from its own session. */
  const asChild = (/** @type {string} */ childSessionId) => (/** @type {string} */ name, /** @type {any} */ args) => ctx.tools.execute({
    agent: { id: `agent-${childSessionId}`, session: { id: childSessionId, header: { cwd: "/workspace", origin: "subagent", parentSession: "root-session" } } },
    name,
    callId: `child-${childSessionId}-${name}-${Math.random().toString(16).slice(2)}`,
    arguments: args,
    signal: AbortSignal.timeout(2000),
  });
  const writeFiles = (/** @type {Map<string, string>} */ entries) => {
    for (const [path, text] of entries) files.set(path, text);
  };
  const receipt = () => {
    const raw = files.get(`/workspace/${workspaceLayout.receiptFile}`);
    return raw ? JSON.parse(raw) : null;
  };
  const plan = async () => {
    const written = await execute("evimed_plan", {
      action: "write",
      clarifications: ["两件交付物分属两项能力，按计划分别委派。"],
      deliverables: [PLAN_ITEMS.bibliometric, PLAN_ITEMS.appraisal],
    });
    assert.equal(written.value.ok, true, JSON.stringify(written.value));
    return written;
  };
  const status = async () => {
    const read = await execute("evimed_plan", { action: "status" });
    /** @type {Record<string, any>} */
    const byId = {};
    for (const item of read.value.data.items) byId[item.id] = item;
    return byId;
  };
  /**
   * The artifact the control plane reads, after the store's debounce has run.
   *
   * Required, not tolerated: an absent projection is what the two mutations
   * this exists for would produce degenerate versions of, so "no file" has to
   * be a red test rather than an empty object nothing asserts against.
   * @param {string} runId @returns {Promise<Record<string, any>>}
   */
  const projection = async (runId) => {
    assert.equal(projected, true, "projection() needs combinedFixture({ projected: true })");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const target = `/workspace/${runStateFileFor(runId)}`;
    const text = files.get(target);
    assert.ok(text, `no projection at ${target}; the workspace holds ${JSON.stringify([...files.keys()].filter((key) => key.includes(".evimed-run")))}`);
    return JSON.parse(text);
  };
  return {
    ctx,
    rows,
    // The real store owns its own `subagents` Map, so `childRows` has to be
    // that one under `projected` — handing back the unused stub Map would make
    // every child-row assertion read an empty structure and pass by vacuum.
    childRows: projected ? ctx.get("evimedRun").subagents : childRows,
    gateRuns,
    files,
    starts,
    agent,
    step,
    execute,
    asChild,
    writeFiles,
    receipt,
    plan,
    status,
    projection,
  };
}

/** Lets the awaiting delegate tool observe a child that has started. */
const settleTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* -------------------------------------------------------------- the tests */

test("the registry stand-in refuses every definition the real registry refuses", () => {
  // The guard above is a copy, and a copy that drifts lenient makes every
  // assertion in this file a statement about a composition the kernel would
  // refuse to load. One case per clause, so a dropped clause is a red test
  // rather than a silently wider fake.
  const registry = harness().tools;
  const definition = { name: "evimed_probe", execute: async () => ({}), output: { schema: {}, render: () => [] } };
  assert.doesNotThrow(() => registry.register({ ...definition }));
  assert.throws(() => registry.register(Promise.resolve(definition)), /must declare a name/,
    "an un-awaited defineTool has no name and is not a definition");
  assert.throws(() => registry.register({ ...definition, name: "" }), /must declare a name/);
  assert.throws(() => registry.register({ ...definition, output: undefined }), /must declare output/);
  assert.throws(() => registry.register({ ...definition, output: { schema: {} } }), /must declare output/,
    "an output without a render is not renderable");
  assert.throws(() => registry.register({ ...definition, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => registry.register({ ...definition, timeoutMs: Number.NaN }), /timeoutMs/);
  assert.doesNotThrow(() => registry.register({ ...definition, timeoutMs: 1000 }));
  assert.throws(() => registry.register({ ...definition, name: "run_code" }), /reserved/,
    "the Code Mode transport owns that name");
});

test("the registry stand-in stays byte-identical to consistency.test.mjs's copy of it", async () => {
  // The test above pins this file's clauses against this file's cases. It
  // cannot see the other half of the problem: `consistency.test.mjs` holds the
  // same guard, the real registry is what both transcribe, and if a fifth
  // precondition is transcribed there it will not appear here — this suite then
  // keeps passing against a composition the kernel would refuse to load, which
  // is the exact failure the guard's own comment records, one generation later.
  //
  // Bodies only: the two declarations differ in how the parameter is annotated
  // (a JSDoc tag there, an inline cast here) and that difference decides
  // nothing. Everything between the signature and the closing brace is the
  // rule set, and it must agree byte for byte.
  const bodyOf = (/** @type {string} */ source, /** @type {string} */ file) => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith("function assertRegistrable("));
    assert.notEqual(start, -1, `${file} no longer declares assertRegistrable at the top level`);
    const end = lines.indexOf("}", start);
    assert.ok(end > start, `${file}'s assertRegistrable has no closing brace at column 0`);
    return lines.slice(start + 1, end).join("\n");
  };
  const mine = bodyOf(await readFile(new URL(import.meta.url), "utf8"), "combinedPlan.test.mjs");
  // Proof the extraction found the guard and not an empty slice: without this,
  // a rename on both sides would make two empty strings compare equal forever.
  for (const clause of ["must declare a name", "must declare output", "timeoutMs", "run_code"]) {
    assert.ok(mine.includes(clause), `the extracted body is not the guard; it lacks ${clause}: ${JSON.stringify(mine.slice(0, 200))}`);
  }
  assert.equal(
    mine,
    bodyOf(await readFile(new URL("./consistency.test.mjs", import.meta.url), "utf8"), "consistency.test.mjs"),
    "the two registry stand-ins disagree; copy the stricter body into both, or this file passes against a composition consistency.test.mjs already knows is invalid",
  );
});

test("a plan spanning two capabilities delegates twice, and each child submits only its own bound item", async () => {
  /** @type {Map<string, (value: any) => void>} */
  const settlers = new Map();
  const f = await combinedFixture({
    subagentStart: (_provider, options) => {
      const id = options.toolFilter.allow.includes(BIBLIOMETRIC_ONLY_TOOL) ? "child-bib" : "child-appraise";
      return { id, result: new Promise((resolve) => settlers.set(id, resolve)) };
    },
  });
  await f.step(1);
  await f.plan();

  // Both children are alive at once, which is the shape the binding has to
  // survive: with one child running there is nobody to confuse it with.
  const bibDelegation = f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  const appraisalDelegation = f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  await settleTick();
  assert.equal(f.starts.length, 2, "a two-item plan must start two children");

  // Both children are on the ledger *while they are still running*, each under
  // its own key. This is the window a researcher watches, and the settled-state
  // assertions at the end of this test cannot see it: a row written only when a
  // child finishes leaves a live combined run reporting no children at all, and
  // `consistency.test.mjs`'s "a running delegation projects its child id before
  // the child settles" proves that for one child, which cannot distinguish "the
  // running rows are per-child" from "there is one running row".
  assert.equal(f.childRows.size, 2, `both children must be followable while they run: ${JSON.stringify([...f.childRows.keys()])}`);
  const runningRows = new Map([...f.childRows].map(([key, row]) => [row.deliverableId, { key, ...row }]));
  assert.deepEqual([...runningRows.keys()].sort(), ["d-appraise", "d-bib"], "each running child must be recorded under its own deliverable");
  for (const [id, row] of runningRows) {
    assert.equal(row.status, "running", `a child that has started but not settled is running: ${JSON.stringify(row)}`);
    assert.ok(row.key.includes(id), `a running child keyed without its deliverable cannot stay distinct: ${row.key}`);
  }
  assert.deepEqual(
    [runningRows.get("d-bib").capability, runningRows.get("d-bib").childSessionId],
    ["bibliometric-analysis", "child-bib"],
  );
  assert.deepEqual(
    [runningRows.get("d-appraise").capability, runningRows.get("d-appraise").childSessionId],
    ["evidence-appraisal", "child-appraise"],
  );

  f.writeFiles(bibliometricFiles());
  f.writeFiles(appraisalFiles());

  // Each child submits its own item and is accepted under its own contract.
  const bibAccepted = await f.asChild("child-bib")("evimed_submit_deliverable", { deliverableId: "d-bib" });
  assert.equal(bibAccepted.value?.ok, true, JSON.stringify(bibAccepted.value));
  assert.equal(bibAccepted.value.data.contractKind, "bibliometric-analysis-report");
  const appraisalAccepted = await f.asChild("child-appraise")("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  assert.equal(appraisalAccepted.value?.ok, true, JSON.stringify(appraisalAccepted.value));
  assert.equal(appraisalAccepted.value.data.contractKind, "appraisal-table");

  // Neither child may submit the other capability's item. Both directions are
  // checked: a binding that leaked in one direction only would still lose a
  // package, and a single-capability run can prove neither.
  //
  // `consistency.test.mjs` already refuses a *foreign* id — its `d2` is not in
  // the plan, and the binding guard runs before the unknown-deliverable check,
  // so that refusal is `deliverable_not_owned` too. What only a two-item plan
  // can catch is a child bound to the wrong *in-plan* item: every submission
  // then names a real, planned deliverable, the wrong contract's validator runs
  // over a real package, and these four assertions are the only thing that
  // notices.
  const bibReachingAcross = await f.asChild("child-bib")("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  assert.equal(bibReachingAcross.value?.ok, false);
  assert.equal(bibReachingAcross.value?.code, "deliverable_not_owned");
  const appraisalReachingAcross = await f.asChild("child-appraise")("evimed_submit_deliverable", { deliverableId: "d-bib" });
  assert.equal(appraisalReachingAcross.value?.ok, false);
  assert.equal(appraisalReachingAcross.value?.code, "deliverable_not_owned");

  for (const [id, settle] of settlers) settle({ stopReason: "completed", output: { deliverableId: id, submitted: true, summary: "done" } });
  await Promise.all([bibDelegation, appraisalDelegation]);

  const items = await f.status();
  assert.equal(items["d-bib"].status, "accepted");
  assert.equal(items["d-appraise"].status, "accepted");

  // The ledger's child rows: two of them, each under its own key, each naming
  // its own capability and its own kernel session. The key is the property —
  // it is `${runId}:${deliverableId}`, and a row keyed by the run alone lets
  // the second child overwrite the first, so a two-capability run reports one
  // child and the other delegation leaves no trace at all. With one item in
  // the plan the two keyings produce the same string, which is why nothing
  // else in this suite can see the difference.
  //
  // This is the medium, not the artifact: `store.subagents` never leaves the
  // container, and everything below asserts what the run-policy plugin wrote
  // into it. What the control plane reads is the projection built from it, one
  // layer further out, and the last test in this file is the one that asserts
  // there — because a projection that drops a child, or drops a child's
  // `capability`, leaves every assertion in this test green.
  assert.equal(f.childRows.size, 2, `both children must survive as their own rows: ${JSON.stringify([...f.childRows.keys()])}`);
  for (const [key, row] of f.childRows) {
    assert.ok(key.includes(row.deliverableId), `a child row keyed without its deliverable cannot stay distinct: ${key}`);
  }
  const childByDeliverable = new Map([...f.childRows.values()].map((row) => [row.deliverableId, row]));
  assert.deepEqual([...childByDeliverable.keys()].sort(), ["d-appraise", "d-bib"]);
  const childFacts = (/** @type {string} */ id) => {
    const row = childByDeliverable.get(id);
    return [row.capability, row.childSessionId, row.skills, row.status];
  };
  assert.deepEqual(childFacts("d-bib"), ["bibliometric-analysis", "child-bib", ["bibliometric-analysis"], "completed"]);
  assert.deepEqual(childFacts("d-appraise"), ["evidence-appraisal", "child-appraise", ["evidence-appraisal"], "completed"]);

  // And the run mirror — one durable row per run, projected into the file the
  // control plane reads — counts both delegations rather than the one that
  // settled last. The row itself stays in the container; the count reaching
  // the reader is asserted on the projection in the last test.
  assert.equal(f.rows.size, 1, `one run, one mirror row: ${JSON.stringify([...f.rows.keys()])}`);
  assert.equal([...f.rows.values()][0].children, 2, "a combined run that reports one child is a run nobody can follow");

  // One receipt, two entries, each naming its own capability and contract.
  // Accumulated rather than replaced: the second acceptance overwriting the
  // first is the shape that ships half a combined delivery.
  const receipt = f.receipt();
  assert.equal(receipt.entries.length, 2, `both acceptances must survive in one receipt: ${JSON.stringify(receipt)}`);
  assert.deepEqual(
    receipt.entries.map((/** @type {any} */ entry) => [entry.deliverableId, entry.capability, entry.contractKind]).sort(),
    [["d-appraise", "evidence-appraisal", "appraisal-table"], ["d-bib", "bibliometric-analysis", "bibliometric-analysis-report"]],
  );
  assert.deepEqual(
    receipt.entries.find((/** @type {any} */ entry) => entry.deliverableId === "d-bib").files.map((/** @type {any} */ file) => file.path).sort(),
    ["deliverables/d-bib/bibliometric-analysis-report.md", "deliverables/d-bib/bibliometric-analysis-run.json"],
  );

  // And the run may finish, because nothing is outstanding.
  const completed = await f.execute("evimed_complete_run", {});
  assert.equal(completed.value.ok, true, JSON.stringify(completed.value));
  assert.equal(completed.concluded, true);
});

test("a delegated child is handed its own capability's tools and skills, never the other's", async () => {
  /** @type {Map<string, (value: any) => void>} */
  const settlers = new Map();
  const f = await combinedFixture({
    subagentStart: (_provider, options) => {
      const id = options.toolFilter.allow.includes(BIBLIOMETRIC_ONLY_TOOL) ? "child-bib" : "child-appraise";
      return { id, result: new Promise((resolve) => settlers.set(id, resolve)) };
    },
  });
  await f.step(1);
  await f.plan();
  const bibDelegation = f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  const appraisalDelegation = f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  await settleTick();

  assert.equal(f.starts.length, 2, "there must be two spawns to compare");
  // Selected by what each spawn was handed, not by which one was recorded
  // first: the two delegations are awaited concurrently, so a positional
  // fixture would report a scheduling change as a filter defect.
  const startFor = (/** @type {string} */ tool) => {
    const matched = f.starts.filter((start) => start.options.toolFilter.allow.includes(tool));
    assert.equal(matched.length, 1, `exactly one child may be handed ${tool}: ${matched.length} were`);
    return matched[0];
  };
  const bibStart = startFor(BIBLIOMETRIC_ONLY_TOOL);
  const appraisalStart = startFor(APPRAISAL_ONLY_TOOL);
  const bibAllow = bibStart.options.toolFilter.allow;
  const appraisalAllow = appraisalStart.options.toolFilter.allow;

  // The allow-list is what the kernel restricts the child to, so this is the
  // filter itself and not a description of it.
  assert.ok(bibAllow.includes(BIBLIOMETRIC_ONLY_TOOL), `the bibliometric child must keep its own tool: ${JSON.stringify(bibAllow)}`);
  assert.equal(bibAllow.includes(APPRAISAL_ONLY_TOOL), false, "a child delegated to one capability must not be handed the other's tool");
  assert.ok(appraisalAllow.includes(APPRAISAL_ONLY_TOOL), `the appraisal child must keep its own tool: ${JSON.stringify(appraisalAllow)}`);
  assert.equal(appraisalAllow.includes(BIBLIOMETRIC_ONLY_TOOL), false, "a child delegated to one capability must not be handed the other's tool");
  // Neither child is handed the union: that is the shape a filter which
  // ignored the bound capability would produce, and it is indistinguishable
  // from a correct one on a single-capability run.
  assert.notDeepEqual(bibAllow, appraisalAllow, "two capabilities were delegated with one tool set");
  for (const base of DELEGATION_BASE_TOOLS) {
    assert.ok(bibAllow.includes(base), `every child needs ${base} to deliver at all`);
    assert.ok(appraisalAllow.includes(base), `every child needs ${base} to deliver at all`);
  }

  // The same property one layer up: the method text injected into the child is
  // its own capability's, so `skillsLoaded` is true of the right capability.
  assert.equal(bibStart.options.persona, BIBLIOMETRIC.persona);
  assert.equal(appraisalStart.options.persona, APPRAISAL.persona);
  const bibPrompt = bibStart.options.prompt.map((/** @type {any} */ part) => part.text).join("\n");
  const appraisalPrompt = appraisalStart.options.prompt.map((/** @type {any} */ part) => part.text).join("\n");
  assert.ok(bibPrompt.includes(SKILL_BODIES["bibliometric-analysis"]), "the bibliometric child must carry its own method text");
  assert.equal(bibPrompt.includes(SKILL_BODIES["evidence-appraisal"]), false, "one capability's method text reached the other's child");
  assert.ok(appraisalPrompt.includes(SKILL_BODIES["evidence-appraisal"]), "the appraisal child must carry its own method text");
  assert.equal(appraisalPrompt.includes(SKILL_BODIES["bibliometric-analysis"]), false, "one capability's method text reached the other's child");
  // And each is told to write under its own deliverable id.
  assert.ok(bibPrompt.includes("deliverables/d-bib/"), "the child is told where to write, it does not choose");
  assert.ok(appraisalPrompt.includes("deliverables/d-appraise/"), "the child is told where to write, it does not choose");

  for (const [, settle] of settlers) settle({ stopReason: "completed", output: "done" });
  await Promise.all([bibDelegation, appraisalDelegation]);
});

test("a deliverable that depends on another cannot be delegated before that one is accepted, and can be after", async () => {
  // Every child settles at once here, so a delegation this test expects to be
  // refused fails as a wrong answer rather than as a hang: a run-policy that
  // stopped sequencing would otherwise leave `evimed_delegate` awaiting a
  // child nobody in the test intends to settle, and a suite that hangs reports
  // neither pass nor fail.
  const f = await combinedFixture({
    subagentStart: () => ({ id: "child", result: Promise.resolve({ stopReason: "completed", output: "done" }) }),
  });
  await f.step(1);
  const written = await f.execute("evimed_plan", {
    action: "write",
    clarifications: ["评价表建立在文献计量结果之上，必须排在其后。"],
    deliverables: [
      PLAN_ITEMS.bibliometric,
      { ...PLAN_ITEMS.appraisal, dependsOn: ["d-bib"] },
    ],
  });
  assert.equal(written.value.ok, true, JSON.stringify(written.value));

  // The dependent item is refused, and the refusal names what it is waiting
  // for — the sequencing is computed by the tool, so the model is never asked
  // to order the plan by hand.
  const early = await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  assert.equal(early.value.ok, false);
  assert.equal(early.value.code, "deliverable_dependency_pending");
  assert.match(early.value.issues[0].message, /d-bib/, "a refusal that does not name the blocker cannot be acted on");
  assert.equal(f.starts.length, 0, "a blocked delegation must not start a child");

  // Its blocker runs, is accepted, and only then does the dependent one start.
  const bibDelegation = await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  assert.equal(bibDelegation.value.ok, true, JSON.stringify(bibDelegation.value));
  assert.equal(f.starts.length, 1);
  f.writeFiles(bibliometricFiles());
  const submitted = await f.execute("evimed_submit_deliverable", { deliverableId: "d-bib" });
  assert.equal(submitted.value?.ok, true, JSON.stringify(submitted.value));
  assert.equal((await f.status())["d-bib"].status, "accepted");

  const later = await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  assert.equal(later.value.ok, true, JSON.stringify(later.value));
  assert.equal(f.starts.length, 2, "an accepted dependency must release the item that waited on it");
  assert.equal(f.starts[1].options.toolFilter.allow.includes(APPRAISAL_ONLY_TOOL), true, "the released item still delegates to its own capability");
});

test("one capability's rejection leaves the other's acceptance standing, and partial delivery names the unfinished item", async () => {
  const f = await combinedFixture({ deliveryAttemptLimit: 3, structuralAttemptAllowance: 1 });
  await f.step(1);
  await f.plan();

  // Delivered by the root rather than by children: what is under test is the
  // independence of two contracts inside one plan, and delegation has its own
  // tests above.
  f.writeFiles(bibliometricFiles());
  f.writeFiles(appraisalFiles({ complete: false }));
  assert.equal((await f.execute("evimed_submit_deliverable", { deliverableId: "d-bib" })).value.ok, true);

  const rejected = await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  assert.equal(rejected.value.ok, false);
  assert.ok(
    rejected.value.issues.some((/** @type {any} */ issue) => issue.code === "required_output_missing" && issue.path === "delivery-summary.md"),
    `the verdict must name the file to fix: ${JSON.stringify(rejected.value.issues)}`,
  );

  // The accepted item is untouched: its status, and the receipt entry that is
  // the only durable proof of it, both survive the other contract's rejection.
  const afterRejection = await f.status();
  assert.equal(afterRejection["d-bib"].status, "accepted");
  assert.equal(afterRejection["d-appraise"].status, "rejected");
  assert.deepEqual(f.receipt().entries.map((/** @type {any} */ entry) => entry.deliverableId), ["d-bib"]);

  // A full completion is refused, and the refusal names the unfinished item —
  // by id and by title — and says nothing about the accepted one.
  const refused = await f.execute("evimed_complete_run", {});
  assert.equal(refused.value.ok, false);
  assert.equal(refused.value.code, "run_incomplete");
  const blocking = refused.value.issues.filter((/** @type {any} */ issue) => issue.severity === "required");
  assert.deepEqual(blocking.map((/** @type {any} */ issue) => [issue.code, issue.path]), [["deliverable_not_accepted", "d-appraise"]]);
  assert.match(blocking[0].message, /证据评价表/, "the unfinished item is named as the researcher asked for it");
  assert.equal(
    refused.value.issues.some((/** @type {any} */ issue) => issue.path === "d-bib"),
    false,
    "an accepted deliverable must not appear in the reasons a run cannot finish",
  );

  // Partial delivery goes through, still saying which item is unfinished —
  // downgraded to advisory, because that is what partial IS.
  const partial = await f.execute("evimed_complete_run", { partial: true });
  assert.equal(partial.value.ok, true, JSON.stringify(partial.value));
  assert.equal(partial.concluded, true);
  const carried = partial.value.data.issues.find((/** @type {any} */ issue) => issue.path === "d-appraise");
  assert.ok(carried, `partial delivery must still report the unfinished item: ${JSON.stringify(partial.value.data.issues)}`);
  assert.equal(carried.code, "deliverable_not_accepted");
  assert.equal(carried.severity, "advisory");

  // And the summary the researcher reads distinguishes the two capabilities.
  const summary = f.files.get(`/workspace/${workspaceLayout.deliverySummaryFile}`);
  assert.ok(summary, "the delivery summary is written whatever happened");
  assert.match(summary, /部分交付/);
  assert.match(summary, /文献计量报告 \| bibliometric-analysis-report \| bibliometric-analysis \| accepted/);
  assert.match(summary, /证据评价表 \| appraisal-table \| evidence-appraisal \| rejected/);

  // The rejected item can still be repaired in place afterwards, and repairing
  // it must not disturb the package that already passed.
  f.writeFiles(appraisalFiles({ complete: true }));
  const repaired = await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  assert.equal(repaired.value.ok, true, JSON.stringify(repaired.value));
  assert.deepEqual(
    f.receipt().entries.map((/** @type {any} */ entry) => entry.deliverableId).sort(),
    ["d-appraise", "d-bib"],
    "repairing one item must add to the receipt, not replace it",
  );
  assert.equal((await f.execute("evimed_complete_run", {})).value.ok, true);
});

test("an accepted item's files are frozen while the other capability's item is still being repaired", async () => {
  const f = await combinedFixture();
  // A real `write` in the registry, so the allowed case is a call that actually
  // ran rather than one the registry happened not to know about — those two
  // are indistinguishable from the error code alone.
  /** @type {string[]} */
  const written = [];
  f.ctx.tools.register({
    name: "write",
    execute: async (/** @type {any} */ args) => { written.push(String(args.path)); return { ok: true }; },
    output: { schema: { type: "object", additionalProperties: true }, render: () => [] },
  });
  await f.step(1);
  await f.plan();
  f.writeFiles(bibliometricFiles());
  f.writeFiles(appraisalFiles({ complete: false }));
  assert.equal((await f.execute("evimed_submit_deliverable", { deliverableId: "d-bib" })).value.ok, true);
  assert.equal((await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" })).value.ok, false);

  // The still-unaccepted item stays writable, which is what a repair needs.
  const repairWrite = await f.execute("write", { path: "deliverables/d-appraise/delivery-summary.md", content: "# 交付摘要\n" });
  assert.equal(repairWrite.error, undefined, "an item under repair must remain writable");
  assert.deepEqual(written, ["deliverables/d-appraise/delivery-summary.md"]);

  // The accepted one does not: its bytes are what the receipt names by sha256.
  const frozenWrite = await f.execute("write", { path: "deliverables/d-bib/bibliometric-analysis-report.md", content: "# 改动\n" });
  assert.equal(frozenWrite.error?.code, "DENIED");
  assert.match(frozenWrite.content[0].text, /accepted_deliverable_frozen/);
  assert.match(frozenWrite.content[0].text, /d-bib/, "the refusal must name which deliverable is frozen");
  assert.deepEqual(written, ["deliverables/d-appraise/delivery-summary.md"], "the frozen write must never reach the tool");
});

test("the gate ledger records each capability's verdicts under its own deliverable", async () => {
  // No structural allowance, so both submissions are charged as attempt 1.
  // With different attempt numbers the row keys differ whether or not they
  // name the deliverable, and the collision this asserts against could not
  // happen — the two items have to compete for the same key to prove anything.
  const f = await combinedFixture({ structuralAttemptAllowance: 0 });
  await f.step(1);
  await f.plan();
  f.writeFiles(bibliometricFiles());
  f.writeFiles(appraisalFiles({ complete: false }));
  await f.execute("evimed_submit_deliverable", { deliverableId: "d-bib" });
  await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" });

  assert.equal(f.gateRuns.length, 2, `each submission must be recorded: ${JSON.stringify(f.gateRuns.map((row) => row.key))}`);
  const byDeliverable = new Map(f.gateRuns.map((row) => [row.deliverableId, row]));
  assert.equal(byDeliverable.get("d-bib").contractKind, "bibliometric-analysis-report");
  assert.equal(byDeliverable.get("d-bib").ok, true);
  assert.equal(byDeliverable.get("d-appraise").contractKind, "appraisal-table");
  assert.equal(byDeliverable.get("d-appraise").ok, false);
  assert.equal(byDeliverable.get("d-bib").attempt, 1);
  assert.equal(byDeliverable.get("d-appraise").attempt, 1);
  // Distinct keys, each naming its own deliverable, so one capability's verdict
  // cannot overwrite the other's in the table the control plane reads.
  assert.equal(new Set(f.gateRuns.map((row) => row.key)).size, 2, `two verdicts collided onto one key: ${JSON.stringify(f.gateRuns.map((row) => row.key))}`);
  for (const row of f.gateRuns) {
    assert.ok(row.key.includes(row.deliverableId), `a gate row keyed without its deliverable cannot stay distinct: ${row.key}`);
  }
});

test("the projection the control plane reads keeps both children, each separable by the join the server performs", async () => {
  // The layer every other test in this file stops short of. `store.subagents`,
  // `run_mirror` and `plan_index` are container-local: DSH's storage format
  // carries no compatibility promise, so nobody outside this process may open
  // them. What the control plane actually opens is
  // `.evimed-run/runs/<runId>/state.json`, written by `plugins/evidence-store.mjs`
  // from those tables, and `apps/server/src/agentRuns.mjs`'s
  // `readRunStateProjection` is the reader.
  //
  // Two one-line changes at that seam are invisible to assertions on the Map:
  // projecting `[...store.subagents.values()].filter(...).slice(0, 1)` — a
  // combined run reports one child — and projecting the rows without their
  // `capability`, which is worse, because `scopeNativeProjection` admits a
  // child only when a plan item of the same id names the same capability, so
  // every child is dropped by the consumer and the run shows none. Both are
  // asserted against here, on the file rather than on the medium: the real
  // store plugin, the real projector, the real workspace write.
  /** @type {Map<string, (value: any) => void>} */
  const settlers = new Map();
  const f = await combinedFixture({
    projected: true,
    subagentStart: (_provider, options) => {
      const id = options.toolFilter.allow.includes(BIBLIOMETRIC_ONLY_TOOL) ? "child-bib" : "child-appraise";
      return { id, result: new Promise((resolve) => settlers.set(id, resolve)) };
    },
  });
  await f.step(1);
  await f.plan();
  const bibDelegation = f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  const appraisalDelegation = f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  await settleTick();
  for (const [id, settle] of settlers) settle({ stopReason: "completed", output: { deliverableId: id, submitted: true, summary: "done" } });
  await Promise.all([bibDelegation, appraisalDelegation]);

  // Both sides of the seam in one test, in order. The medium holds two rows —
  // that much the first test in this file already proves — and the file has to
  // hold two as well. Reading both here is what makes a red assertion below
  // legible as "the projection lost a child" rather than "the producer never
  // wrote one".
  assert.equal(f.childRows.size, 2, `the producer must have written two rows to project: ${JSON.stringify([...f.childRows.keys()])}`);

  const projection = await f.projection("combined_run");
  assert.equal(projection.runId, "combined_run");
  assert.equal(projection.budget.children, 2, `the projected budget must count both delegations: ${JSON.stringify(projection.budget)}`);

  // Two child rows in the file, each carrying its own identity. `.slice(0, 1)`
  // at the projection seam fails here and nowhere else in this suite.
  assert.equal(projection.subagents.length, 2,
    `a combined run must reach the control plane with both children: ${JSON.stringify(projection.subagents)}`);
  const projectedChild = new Map(projection.subagents.map((/** @type {any} */ child) => [child.deliverableId, child]));
  assert.deepEqual([...projectedChild.keys()].sort(), ["d-appraise", "d-bib"],
    "two children projected under one deliverable id is one child the reader can never open");
  assert.deepEqual(
    [projectedChild.get("d-bib").capability, projectedChild.get("d-bib").childSessionId, projectedChild.get("d-bib").skills],
    ["bibliometric-analysis", "child-bib", ["bibliometric-analysis"]],
  );
  assert.deepEqual(
    [projectedChild.get("d-appraise").capability, projectedChild.get("d-appraise").childSessionId, projectedChild.get("d-appraise").skills],
    ["evidence-appraisal", "child-appraise", ["evidence-appraisal"]],
  );

  // And the plan index in the same file names both items with their
  // capabilities, because the consumer's filter joins the two sections.
  assert.deepEqual(
    projection.plan.items.map((/** @type {any} */ item) => [item.id, item.capability, item.contractKind]),
    [["d-bib", "bibliometric-analysis", "bibliometric-analysis-report"], ["d-appraise", "evidence-appraisal", "appraisal-table"]],
  );

  // The consumer's join, run here on the artifact the consumer is given. This
  // is `scopeNativeProjection`'s subagent clause transcribed
  // (`apps/server/src/agentRuns.mjs`): a child survives only if a plan item of
  // the same id names the same capability. Dropping `capability` from the
  // projected rows leaves the two assertions above on `capability` red, and
  // this one red as well with the message that says what the server does about
  // it — which is what makes "the field is missing" readable as "the reader
  // sees no children at all".
  const admitted = projection.subagents.filter((/** @type {any} */ child) => projection.plan.items.some(
    (/** @type {any} */ item) => item.id === child.deliverableId && item.capability === child.capability,
  ));
  assert.deepEqual(admitted.map((/** @type {any} */ child) => child.deliverableId).sort(), ["d-appraise", "d-bib"],
    "a child the plan does not corroborate by id and capability is dropped by the control plane, so a projection that loses either field shows a combined run with no children");

  // The shared legacy path is written too, for this run. `readRunStateProjection`
  // falls back to `.evimed-run/state.json` when the per-run file is absent — a
  // runtime image from before per-run projections — and the store selects which
  // run gets that path (`native` runs first, otherwise the latest active one).
  // A selection that offered it to native turns only would leave a
  // control-plane combined run with nothing at the fallback path, and the
  // per-run assertions above would not notice.
  const sharedText = f.files.get(`/workspace/${workspaceLayout.runStateFile}`);
  assert.ok(sharedText, `the fallback projection was never written: ${JSON.stringify([...f.files.keys()].filter((key) => key.includes(".evimed-run")))}`);
  const shared = JSON.parse(String(sharedText));
  assert.equal(shared.runId, "combined_run", "the fallback path must carry this run, not another one's projection");
  assert.deepEqual(
    shared.subagents.map((/** @type {any} */ child) => [child.deliverableId, child.capability]),
    projection.subagents.map((/** @type {any} */ child) => [child.deliverableId, child.capability]),
    "the shared projection and the run-scoped one must tell the same story about who the children are",
  );
});
