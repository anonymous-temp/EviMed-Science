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
 *   maxConcurrentChildren?: number,
 *   skillBodies?: Readonly<Record<string, string>>,
 *   capabilities?: readonly Record<string, any>[],
 *   evidenceRecords?: readonly Record<string, any>[],
 * }} [options]
 */
async function combinedFixture({ subagentStart = null, deliveryAttemptLimit = 3, structuralAttemptAllowance = 2, projected = false, maxConcurrentChildren = 3, skillBodies = SKILL_BODIES, capabilities = [BIBLIOMETRIC, APPRAISAL], evidenceRecords = [] } = {}) {
  const { apply: applyRunPolicy } = await import("../plugins/run-policy.mjs");
  const ctx = harness();
  const rows = new Map();
  const childRows = new Map();
  const sessionRuns = new Map();
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {any[]} */
  const gateRuns = [];
  /** @type {any[]} */
  const steered = [];
  const agent = { id: "root-agent", session: { id: "root-session", header: { cwd: "/workspace" } }, inject: () => {}, steer: (/** @type {any} */ message) => steered.push(message) };
  ctx.provide("agents", { get: () => agent });
  ctx.provide("fs", {
    resolve: async (/** @type {string} */ relative, /** @type {{ cwd: string }} */ { cwd }) => `${cwd}/${relative}`,
    readText: async (/** @type {string} */ target) => {
      if (target.endsWith(workspaceLayout.briefIndexFile)) return JSON.stringify({ runId: "combined_run" });
      for (const [skill, body] of Object.entries(skillBodies)) {
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
      evidence: { entries: () => evidenceRecords.map((record, index) => [String(index), record]) },
      subagents: childRows,
      sessionRuns,
      runIdForSession: (/** @type {string} */ sessionId) => sessionRuns.get(sessionId) ?? "",
    });
    ctx.provide("evimedDiagnostics", { degrade() {}, notice() {} });
  }
  ctx.provide("evimedCapabilities", capabilities);
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
    maxChildrenTotal: 3, maxConcurrentChildren,
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
    steered,
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

/**
 * Waits until the delegate tool has actually started `count` children.
 *
 * This was one `setTimeout(0)`, which is a bet on how many turns the delegate
 * path takes before it calls `startSubagent`. The self-evolution work added two
 * awaited WebCrypto digests ahead of that call — the skill and method digests a
 * receipt of names could not supply — and the bet stopped paying: `starts` was
 * still empty one macrotask later, the assertion read `0 !== 2`, and the test
 * that awaits both children afterwards hung until the runner's deadline.
 *
 * A count is the condition the tests actually mean, so waiting for it survives
 * any number of awaits the production path acquires later.
 *
 * @param {{starts: readonly unknown[]}} fixture @param {number} count
 * @returns {Promise<void>}
 */
async function startedChildren(fixture, count) {
  for (let turn = 0; turn < 500 && fixture.starts.length < count; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (fixture.starts.length < count) {
    throw new Error(`delegation started ${fixture.starts.length} of ${count} children within the deadline`);
  }
}

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
  await startedChildren(f, 2);
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
  // Both delegate calls returned the moment their children started; the
  // settlements are what the parent collects, in one call for both.
  const started = await Promise.all([bibDelegation, appraisalDelegation]);
  assert.deepEqual(started.map((result) => result.value.data.status), ["started", "started"]);
  const collected = await f.execute("evimed_await", {});
  assert.deepEqual(
    collected.value.data.results.map((/** @type {any} */ result) => [result.deliverableId, result.status, result.submission?.verdict]).sort(),
    [["d-appraise", "completed", "pass"], ["d-bib", "completed", "pass"]],
  );

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
  await startedChildren(f, 2);

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

test("two unreadable submissions in a row are two gate records, not one overwriting the other", async () => {
  // Inside the structural allowance a submission is not charged, so the
  // attempt number stands still; the record's key used to be that number, and
  // the second unreadable package's issues replaced the first's (E §9.5).
  const f = await combinedFixture({ structuralAttemptAllowance: 2 });
  await f.step(1);
  await f.plan();
  f.writeFiles(appraisalFiles({ complete: false }));
  await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  const rows = f.gateRuns.filter((/** @type {any} */ row) => row.deliverableId === "d-appraise");
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((/** @type {any} */ row) => row.key)).size, 2, `two submissions collided onto one key: ${JSON.stringify(rows.map((/** @type {any} */ row) => row.key))}`);
  assert.deepEqual(rows.map((/** @type {any} */ row) => row.attempt), [0, 0], "neither was charged to the content budget");
  assert.deepEqual(rows.map((/** @type {any} */ row) => row.sequence), [1, 2]);
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
  await startedChildren(f, 2);
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

/* --------------------------------------------------- the package check */

test("a package check answers with the submission's own verdict and spends nothing", async () => {
  // The check exists because the only way to learn what the gate thought was
  // to spend a submission finding out. It is worth something only if it says
  // exactly what the submission would say: a check with its own reading of the
  // files would teach the run to satisfy a second opinion that decides nothing.
  const f = await combinedFixture({ deliveryAttemptLimit: 3, structuralAttemptAllowance: 0 });
  await f.step(1);
  await f.plan();
  f.writeFiles(appraisalFiles({ complete: false }));

  const checked = await f.execute("evimed_package_check", { deliverableId: "d-appraise" });
  assert.equal(checked.value.ok, false, JSON.stringify(checked.value));
  assert.ok(
    checked.value.issues.some((/** @type {any} */ issue) => issue.code === "required_output_missing" && issue.path === "delivery-summary.md"),
    `the check must name the file to fix: ${JSON.stringify(checked.value.issues)}`,
  );
  assert.deepEqual(checked.value.data, { deliverableId: "d-appraise", attempts: { used: 0, limit: 3, remaining: 3 } });

  // Nothing was charged and nothing was recorded: the gate ledger holds what
  // was submitted, and a look is not a submission.
  assert.equal(f.gateRuns.length, 0, `a check wrote a gate run: ${JSON.stringify(f.gateRuns)}`);
  assert.equal((await f.status())["d-appraise"].attempts, 0);
  assert.equal((await f.status())["d-appraise"].status, "planned", "a check must not move the item");
  assert.equal(f.receipt(), null, "a check must not write a receipt");

  // The submission of the same bytes answers with the same code and the same
  // issues, in the same order.
  const submitted = await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  assert.equal(submitted.value.ok, false);
  assert.equal(submitted.value.code, checked.value.code);
  assert.deepEqual(submitted.value.issues, checked.value.issues);
  assert.equal(f.gateRuns.length, 1);
  assert.equal((await f.status())["d-appraise"].attempts, 1);

  // And on a package that passes, the check says ok with the same contract and
  // metrics the acceptance reports — without accepting it.
  f.writeFiles(bibliometricFiles());
  const passing = await f.execute("evimed_package_check", { deliverableId: "d-bib" });
  assert.equal(passing.value.ok, true, JSON.stringify(passing.value));
  assert.equal((await f.status())["d-bib"].status, "planned", "an ok from a check is not an acceptance");
  const accepted = await f.execute("evimed_submit_deliverable", { deliverableId: "d-bib" });
  assert.equal(accepted.value.ok, true);
  assert.deepEqual(
    [passing.value.data.contractKind, passing.value.data.label, passing.value.data.metrics],
    [accepted.value.data.contractKind, accepted.value.data.label, accepted.value.data.metrics],
  );
});

test("a package check still answers once the submissions are spent, and says there are none left", async () => {
  // The guard refuses the fourth submission, and that is right; it is also the
  // moment a run most needs to know what is still wrong, because what it wrote
  // is delivered marked either way.
  const f = await combinedFixture({ deliveryAttemptLimit: 1, structuralAttemptAllowance: 0 });
  await f.step(1);
  await f.plan();
  f.writeFiles(appraisalFiles({ complete: false }));
  assert.equal((await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" })).value.ok, false);
  const guarded = await f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" });
  assert.equal(guarded.error?.code, "GUARDED", "the ceiling still holds for submissions");

  const checked = await f.execute("evimed_package_check", { deliverableId: "d-appraise" });
  assert.equal(checked.error, undefined, "the ceiling is a ceiling on submissions, not on looking");
  assert.equal(checked.value.ok, false);
  assert.deepEqual(checked.value.data.attempts, { used: 1, limit: 1, remaining: 0 });
  assert.equal(f.gateRuns.length, 1, "the check after the ceiling recorded nothing either");
});

test("a child may check only the deliverable it owns, as it may submit only that one", async () => {
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
  const delegations = [
    f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} }),
    f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} }),
  ];
  await startedChildren(f, 2);
  // Every child is handed the check, because every child submits.
  for (const start of f.starts) {
    assert.ok(start.options.toolFilter.allow.includes("evimed_package_check"), "a child that submits must be able to check first");
  }
  f.writeFiles(bibliometricFiles());
  const own = await f.asChild("child-bib")("evimed_package_check", { deliverableId: "d-bib" });
  assert.equal(own.value.ok, true, JSON.stringify(own.value));
  const across = await f.asChild("child-bib")("evimed_package_check", { deliverableId: "d-appraise" });
  assert.equal(across.value.ok, false);
  assert.equal(across.value.code, "deliverable_not_owned");
  for (const [, settle] of settlers) settle({ stopReason: "completed", output: "done" });
  await Promise.all(delegations);
});

/* ------------------------------------------- delegation that does not wait */

/**
 * Children whose start and settlement the test controls, keyed by the
 * capability each was handed. Records the signal every child was started
 * with, because cancelling a child is aborting that signal.
 */
function controllableChildren() {
  /** @type {Map<string, (value: any) => void>} */
  const settlers = new Map();
  /** @type {Map<string, AbortSignal>} */
  const signals = new Map();
  let serial = 0;
  const subagentStart = (/** @type {any} */ _provider, /** @type {any} */ options) => {
    serial += 1;
    const id = `${options.toolFilter.allow.includes(BIBLIOMETRIC_ONLY_TOOL) ? "child-bib" : "child-appraise"}-${serial}`;
    signals.set(id, options.signal);
    return { id, result: new Promise((resolve) => settlers.set(id, resolve)) };
  };
  /** @param {string} prefix */
  const idFor = (prefix) => [...settlers.keys()].filter((id) => id.startsWith(prefix)).at(-1) ?? "";
  return { settlers, signals, subagentStart, idFor };
}

test("independent deliverables delegate in one step and work at the same time; the parent collects any or all", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart });
  await f.step(1);
  await f.plan();

  // Both calls return before either child has done anything: a handle and a
  // child session id, the moment the child exists.
  const [bib, appraise] = await Promise.all([
    f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} }),
    f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} }),
  ]);
  assert.equal(f.starts.length, 2, "two independent deliverables must both be started");
  assert.deepEqual(bib.value.data, { handle: "d-bib#1", deliverableId: "d-bib", childSessionId: children.idFor("child-bib"), status: "started" });
  assert.deepEqual(appraise.value.data, { handle: "d-appraise#1", deliverableId: "d-appraise", childSessionId: children.idFor("child-appraise"), status: "started" });
  // The child is on the plan index the control plane reads before it settles.
  const items = await f.status();
  assert.equal(items["d-bib"].status, "delegated");
  assert.equal(items["d-bib"].childSessionId, children.idFor("child-bib"));

  // One finishes: `any` returns with it and reports the other as running.
  f.writeFiles(bibliometricFiles());
  assert.equal((await f.asChild(children.idFor("child-bib"))("evimed_submit_deliverable", { deliverableId: "d-bib" })).value.ok, true);
  children.settlers.get(children.idFor("child-bib"))?.({ stopReason: "completed", structured: { deliverableId: "d-bib", submitted: true, summary: "计量报告已提交并通过。", unresolved: ["2025 年数据未收录"] } });
  const first = await f.execute("evimed_await", { mode: "any" });
  const byDeliverable = (/** @type {any} */ reply) => Object.fromEntries(reply.value.data.results.map((/** @type {any} */ result) => [result.deliverableId, result]));
  const firstResults = byDeliverable(first);
  assert.equal(firstResults["d-bib"].status, "completed");
  assert.equal(firstResults["d-bib"].summary, "计量报告已提交并通过。");
  assert.deepEqual(firstResults["d-bib"].unresolved, ["2025 年数据未收录"]);
  assert.deepEqual(firstResults["d-bib"].submission, { attempts: 1, verdict: "pass" });
  assert.equal(firstResults["d-appraise"].status, "running", "the one still working is reported as running, not waited for");

  // With no handles the next await is about what is still outstanding: the
  // reported child does not satisfy it again.
  const second = f.execute("evimed_await", {});
  let secondSettled = false;
  void second.then(() => { secondSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondSettled, false, "an await for what is outstanding must wait while the child works");
  children.settlers.get(children.idFor("child-appraise"))?.({ stopReason: "completed", output: "done" });
  const secondResults = byDeliverable(await second);
  assert.deepEqual(Object.keys(secondResults), ["d-appraise"], "the child already reported is not reported again");
  assert.equal(secondResults["d-appraise"].status, "completed");
  assert.equal(secondResults["d-appraise"].submission, undefined, "a child that never submitted has no submission to report");

  // Once everything is reported, an await answers with the whole picture at once.
  const third = await f.execute("evimed_await", {});
  assert.deepEqual(Object.keys(byDeliverable(third)).sort(), ["d-appraise", "d-bib"]);
  // And a handle the run never issued is refused with the ones it did.
  const unknown = await f.execute("evimed_await", { handles: ["d-bib#9"] });
  assert.equal(unknown.value.code, "delegation_handle_unknown");
  assert.match(unknown.value.issues[0].message, /d-bib#1/);
});

test("an await with a time bound returns when it runs out, saying what is still running", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart });
  await f.step(1);
  await f.plan();
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  const began = Date.now();
  const waited = await f.execute("evimed_await", { timeoutSeconds: 1 });
  assert.ok(Date.now() - began >= 900, "the bound is honoured, not skipped");
  assert.equal(waited.value.data.timedOut, true);
  assert.deepEqual(waited.value.data.results.map((/** @type {any} */ result) => [result.handle, result.status]), [["d-bib#1", "running"]]);
  children.settlers.get(children.idFor("child-bib"))?.({ stopReason: "completed", output: "done" });
  const collected = await f.execute("evimed_await", { handles: ["d-bib#1"] });
  assert.equal(collected.value.data.timedOut, undefined);
  assert.equal(collected.value.data.results[0].status, "completed");
});

test("a dependent deliverable is refused while its dependency works, the refusal names it and its handle, and a spent dependency releases it", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart, deliveryAttemptLimit: 1, structuralAttemptAllowance: 0 });
  await f.step(1);
  const written = await f.execute("evimed_plan", {
    action: "write",
    clarifications: ["评价表建立在文献计量结果之上。"],
    deliverables: [PLAN_ITEMS.bibliometric, { ...PLAN_ITEMS.appraisal, dependsOn: ["d-bib"] }],
  });
  assert.equal(written.value.ok, true, JSON.stringify(written.value));
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  const early = await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  assert.equal(early.value.code, "deliverable_dependency_pending");
  assert.match(early.value.issues[0].message, /d-bib（子代理正在做，句柄 d-bib#1）/, "the refusal names what it waits for and how to wait for it");
  assert.equal(f.starts.length, 1, "a refused delegation starts nothing");
  // Nothing was queued: the description says refused, and refused is what happens.
  const twice = await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  assert.equal(twice.value.code, "deliverable_already_delegated", "a deliverable with a working child is not delegated a second time");

  // The dependency's only submission is rejected and its budget is spent: it
  // is delivered as it stands, unverified, so the item that builds on it may start.
  f.files.set("/workspace/deliverables/d-bib/bibliometric-analysis-report.md", "# 文献计量报告\n\n只写了一半。\n");
  const rejected = await f.asChild(children.idFor("child-bib"))("evimed_submit_deliverable", { deliverableId: "d-bib" });
  assert.equal(rejected.value.ok, false);
  children.settlers.get(children.idFor("child-bib"))?.({ stopReason: "completed", output: "done" });
  const collected = await f.execute("evimed_await", {});
  assert.deepEqual(collected.value.data.results[0].submission, { attempts: 1, verdict: "unverified" });
  const released = await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  assert.equal(released.value.ok, true, JSON.stringify(released.value));
  children.settlers.get(children.idFor("child-appraise"))?.({ stopReason: "completed", output: "done" });
  await f.execute("evimed_await", {});
});

test("at the concurrency ceiling a delegation is refused with the way to wait, and admitted once a child finishes", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart, maxConcurrentChildren: 1 });
  await f.step(1);
  await f.plan();
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  const refused = await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  assert.equal(refused.value.code, "delegation_concurrency_limit");
  assert.match(refused.value.issues[0].message, /evimed_await\{mode:"any"\}/);
  children.settlers.get(children.idFor("child-bib"))?.({ stopReason: "completed", output: "done" });
  await f.execute("evimed_await", { mode: "any" });
  const admitted = await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  assert.equal(admitted.value.ok, true, JSON.stringify(admitted.value));
  children.settlers.get(children.idFor("child-appraise"))?.({ stopReason: "completed", output: "done" });
  await f.execute("evimed_await", {});
});

test("concurrent submissions of one deliverable are charged one after the other, never over each other", async () => {
  // `attempts` was read before two awaits and written after them. Two
  // submissions interleaving there each read 0, each wrote 1, and both gate
  // runs were filed under the same key — one charge and one verdict lost.
  const f = await combinedFixture({ structuralAttemptAllowance: 0 });
  await f.step(1);
  await f.plan();
  f.writeFiles(appraisalFiles({ complete: false }));
  // Slow reads, so the two submissions really do overlap at the awaits.
  const fs = f.ctx.get("fs");
  const read = fs.readText;
  fs.readText = async (/** @type {string} */ target) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return read(target);
  };
  const [first, second] = await Promise.all([
    f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" }),
    f.execute("evimed_submit_deliverable", { deliverableId: "d-appraise" }),
  ]);
  assert.equal(first.value.ok, false);
  assert.equal(second.value.ok, false);
  assert.equal((await f.status())["d-appraise"].attempts, 2, "two submissions are two attempts");
  assert.deepEqual(f.gateRuns.map((row) => row.attempt).sort(), [1, 2]);
  assert.equal(new Set(f.gateRuns.map((row) => row.key)).size, 2, `two verdicts collided on one key: ${JSON.stringify(f.gateRuns.map((row) => row.key))}`);
});

test("a plan naming a capability the catalogue does not have is refused when it is written, with the ones it has", async () => {
  const f = await combinedFixture();
  await f.step(1);
  const typo = await f.execute("evimed_plan", {
    action: "write",
    clarifications: ["假设成人。"],
    deliverables: [{ ...PLAN_ITEMS.bibliometric, capability: "bibliometrics" }],
  });
  assert.equal(typo.value.ok, false);
  assert.equal(typo.value.code, "plan_invalid");
  assert.equal(typo.value.issues[0].code, "capability_unknown");
  assert.match(typo.value.issues[0].message, /bibliometric-analysis、evidence-appraisal/, "the refusal lists what the catalogue does offer");
  const wrongKind = await f.execute("evimed_plan", {
    action: "write",
    clarifications: ["假设成人。"],
    deliverables: [{ ...PLAN_ITEMS.bibliometric, contractKind: "appraisal-table" }],
  });
  assert.equal(wrongKind.value.issues[0].code, "contract_kind_unknown");
  assert.match(wrongKind.value.issues[0].message, /bibliometric-analysis-report/);
  // Nothing was written: the plan on disk and the index are what they were.
  assert.equal(f.files.get(`/workspace/${workspaceLayout.planFile}`), undefined);
  assert.deepEqual(Object.keys(await f.status()), []);
});

test("a run does not complete while its children work; a partial completion cancels them and says so", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart });
  await f.step(1);
  await f.plan();
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });

  const refused = await f.execute("evimed_complete_run", {});
  assert.equal(refused.value.code, "children_running");
  assert.match(refused.value.issues[0].message, /d-bib（句柄 d-bib#1）/);
  assert.equal(refused.concluded, false, "a refused completion does not end the turn");
  for (const [, signal] of children.signals) assert.equal(signal.aborted, false, "a refusal cancels nothing");

  const partial = await f.execute("evimed_complete_run", { partial: true });
  assert.equal(partial.value.ok, true, JSON.stringify(partial.value));
  assert.equal(partial.concluded, true);
  assert.deepEqual([...partial.value.data.cancelledChildren].sort(), ["d-appraise#1", "d-bib#1"]);
  for (const [id, signal] of children.signals) assert.equal(signal.aborted, true, `${id} was left running after a partial completion`);
  const items = await f.status();
  assert.equal(items["d-bib"].status, "failed");
  assert.match(items["d-bib"].issues[0].message, /已取消/);
  // The kernel ends a cancelled child as aborted; its settlement is recorded
  // as a cancellation and never retried.
  for (const [, settle] of children.settlers) settle({ stopReason: "aborted" });
  const collected = await f.execute("evimed_await", {});
  for (const result of collected.value.data.results) {
    assert.equal(result.status, "failed");
    assert.match(result.summary, /子代理已取消：运行以部分交付结束时它仍在工作/);
  }
  assert.equal(f.starts.length, 2, "a cancelled child is not retried");
});

test("a cancelled root turn cancels the run's children, and a plan revision cancels the child whose deliverable it dropped", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart });
  await f.step(1);
  await f.plan();
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });

  // A revision without d-bib: its child has nowhere to deliver.
  const revised = await f.execute("evimed_plan", {
    action: "write",
    clarifications: ["只保留证据评价表。"],
    deliverables: [PLAN_ITEMS.appraisal],
  });
  assert.equal(revised.value.ok, true, JSON.stringify(revised.value));
  assert.equal(children.signals.get(children.idFor("child-bib"))?.aborted, true, "the dropped deliverable's child must be cancelled");
  assert.equal(children.signals.get(children.idFor("child-appraise"))?.aborted, false, "the kept deliverable's child keeps working");

  // The researcher stops the run in a later turn.
  for (const handler of f.ctx.listeners.get(SEAMS.events.sessionEvent) ?? []) {
    handler(f.agent.session, { type: "turn/end", seq: 9, data: { reason: { kind: "aborted" } } });
  }
  assert.equal(children.signals.get(children.idFor("child-appraise"))?.aborted, true, "a cancelled root turn must reach every running child");
  for (const [, settle] of children.settlers) settle({ stopReason: "aborted" });
  const collected = await f.execute("evimed_await", {});
  assert.deepEqual(collected.value.data.results.map((/** @type {any} */ result) => result.status), ["failed", "failed"]);
  assert.equal(f.starts.length, 2, "cancelled children are not retried");
});

/* ------------------------------------ a root that stops while children work */

/** Emit one root turn end, as the kernel's session event does. @param {any} f @param {string} kind */
function endRootTurn(f, kind) {
  for (const handler of f.ctx.listeners.get(SEAMS.events.sessionEvent) ?? []) {
    handler(f.agent.session, { type: "turn/end", seq: 50, data: { reason: { kind } } });
  }
}

/** Wait until the fixture has recorded `count` steers, or fail naming the count. @param {any} f @param {number} count */
async function steeredAtLeast(f, count) {
  for (let turn = 0; turn < 200 && f.steered.length < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(f.steered.length >= count, `expected ${count} steer(s), saw ${f.steered.length}`);
}

test("a root turn about to close with children outstanding is steered back to collect them, a bounded number of times", async () => {
  // The kernel's contract for objecting to a turn closing is a steer: the turn
  // runs another step with the reminder in it. Its own design also lets a
  // parent end a turn while background children work, so the objection is
  // bounded rather than a wall.
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart });
  await f.step(1);
  await f.plan();
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  const stopping = async () => {
    for (const handler of f.ctx.listeners.get(SEAMS.events.turnStopping) ?? []) await handler({ agent: f.agent, turn: 1 });
  };
  for (let index = 0; index < 5; index += 1) await stopping();
  assert.equal(f.steered.length, 3, "three reminders, then the turn may close");
  const reminder = f.steered[0];
  assert.equal(reminder.role, "user");
  assert.deepEqual(reminder.source, { kind: "plugin", plugin: "evimed-run-policy" }, "machine text is marked as the plugin's, never as the researcher's");
  assert.match(reminder.content[0].text, /d-bib#1/);
  assert.match(reminder.content[0].text, /evimed_await/);
  // A result that settled but was never collected is outstanding too.
  children.settlers.get(children.idFor("child-bib"))?.({ stopReason: "completed", output: "done" });
  const collected = await f.execute("evimed_await", {});
  assert.equal(collected.value.data.results[0].status, "completed");
});

test("a root that ended its turn while its child worked is woken with the child's result when the child settles", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart });
  await f.step(1);
  await f.plan();
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  endRootTurn(f, "completed");
  assert.equal(f.steered.length, 0, "nothing to hand over while the children still work");

  // One settles: the other is still working, so the root is not woken for half
  // the answer.
  children.settlers.get(children.idFor("child-bib"))?.({ stopReason: "completed", structured: { deliverableId: "d-bib", submitted: false, summary: "计量完成。" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.steered.length, 0, "the root is woken once, for the whole set, not once per child");

  children.settlers.get(children.idFor("child-appraise"))?.({ stopReason: "completed", output: "done" });
  await steeredAtLeast(f, 1);
  assert.equal(f.steered.length, 1);
  const wake = f.steered[0];
  assert.deepEqual(wake.source, { kind: "plugin", plugin: "evimed-run-policy" });
  const handed = JSON.parse(/\{[\s\S]*\}/.exec(wake.content[0].text)?.[0] ?? "{}");
  assert.deepEqual(handed.results.map((/** @type {any} */ result) => [result.handle, result.status]).sort(), [["d-appraise#1", "completed"], ["d-bib#1", "completed"]]);
  assert.equal(handed.results.find((/** @type {any} */ result) => result.handle === "d-bib#1").summary, "计量完成。");
  // What was handed over counts as collected: the next stopping turn is not
  // told about it again.
  for (const handler of f.ctx.listeners.get(SEAMS.events.turnStopping) ?? []) await handler({ agent: f.agent, turn: 2 });
  assert.equal(f.steered.length, 1, "results already handed over are not outstanding");
});

test("a root inside its turn collects for itself, and a cancelled run is never woken", async () => {
  const children = controllableChildren();
  const f = await combinedFixture({ subagentStart: children.subagentStart });
  await f.step(1);
  await f.plan();
  await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  // Still inside its turn: the settlement is for evimed_await, not a wake.
  children.settlers.get(children.idFor("child-bib"))?.({ stopReason: "completed", output: "done" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.steered.length, 0, "a root that is mid-turn is not steered a second copy of its results");
  await f.execute("evimed_await", {});

  await f.execute("evimed_delegate", { deliverableId: "d-appraise", inputs: {} });
  endRootTurn(f, "aborted");
  assert.equal(children.signals.get(children.idFor("child-appraise"))?.aborted, true);
  children.settlers.get(children.idFor("child-appraise"))?.({ stopReason: "aborted" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.steered.length, 0, "the researcher stopped the run; nothing may start it again");
});

/* --------------------------------------------- a capped method, loaded later */

test("a method over the cap reaches the child capped, and its deferred sections are registered in that child's scope alone", async () => {
  const section = (/** @type {string} */ title, /** @type {number} */ size) => `## ${title}\n\n${"证".repeat(size)}\n`;
  const bigBody = ["# 文献计量\n", section("检索与去重", 20_000), section("网络分析", 18_000), section("解读", 16_000), section("安全边界", 800)].join("\n");
  /** @type {{ sessionId: string, skill: any }[]} */
  const registered = [];
  /** @type {any} */
  let fixtureCtx = null;
  /** @param {string} sessionId @param {readonly string[]} visible */
  const childAgent = (sessionId, visible) => ({
    id: `agent-${sessionId}`,
    visible,
    session: { id: sessionId, header: { cwd: "/workspace", origin: "subagent", parentSession: "root-session" } },
    ctx: { skills: { register: (/** @type {any} */ skill) => { registered.push({ sessionId, skill }); return () => {}; } } },
  });
  /** @type {Map<string, (value: any) => void>} */
  const settlers = new Map();
  let startOnlyUnrelatedChild = false;
  const subagentStart = (/** @type {any} */ _provider, /** @type {any} */ options) => {
    const starting = (/** @type {any} */ agent) => {
      for (const handler of fixtureCtx.listeners.get(SEAMS.events.sessionStart) ?? []) handler({ agent, source: "startup" });
    };
    // A screening child of the same parent starts first and must not take the
    // sections: it cannot submit a deliverable.
    starting(childAgent(`screen-${settlers.size + 1}`, ["read"]));
    const id = `child-${settlers.size + 1}`;
    if (!startOnlyUnrelatedChild) starting(childAgent(id, options.toolFilter.allow));
    return { id, result: new Promise((resolve) => settlers.set(id, resolve)) };
  };
  const f = await combinedFixture({ subagentStart, skillBodies: { ...SKILL_BODIES, "bibliometric-analysis": bigBody } });
  fixtureCtx = f.ctx;
  /** @type {any} */ (f.ctx.tools).get = (/** @type {string} */ name, /** @type {any} */ scope) => (scope?.visible?.includes(name) ? { name } : undefined);
  /** @type {string[]} */
  const degraded = [];
  f.ctx.provide("evimedDiagnostics", { degrade: (/** @type {string} */ line) => degraded.push(line), notice() {} });
  await f.step(1);
  await f.plan();

  const delegated = await f.execute("evimed_delegate", { deliverableId: "d-bib", inputs: {} });
  assert.equal(delegated.value.ok, true, JSON.stringify(delegated.value));
  const prompt = String(f.starts[0].options.prompt[0].text);
  assert.ok(prompt.length < bigBody.length, "the child's first message is capped");
  assert.ok(prompt.startsWith("## 方法"), "the method opens the message");
  assert.ok(/较长的 2 节没有随任务注入/.test(prompt), "the child is told two sections wait for it");
  assert.ok(prompt.includes(section("解读", 16_000)) && prompt.includes(section("安全边界", 800)), "what fits stays inline");
  assert.deepEqual(
    registered.map((entry) => [entry.sessionId, entry.skill.name]),
    [["child-1", "bibliometric-analysis-section-01"], ["child-1", "bibliometric-analysis-section-02"]],
    "only the child that can submit takes the sections, and only its own",
  );
  assert.ok(registered[0].skill.content === section("检索与去重", 20_000), "the loaded section is the original text");
  assert.deepEqual(registered[0].skill.invocation, { modelInvocable: true, userInvocable: false });
  assert.equal(registered[0].skill.resourceBase.path, "/skills/bibliometric-analysis");
  assert.deepEqual(degraded, []);

  // A child that never showed up to take its sections is said out loud.
  startOnlyUnrelatedChild = true;
  settlers.get("child-1")?.({ stopReason: "error", output: "" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(degraded.some((line) => /method sections for d-bib were not registered/.test(line)), `the retry's missing registration is reported: ${JSON.stringify(degraded)}`);
  assert.equal(registered.length, 2, "the unrelated child took nothing");
});

/* ------------------------------------------------ claim-level evidence tools */

const CLINICAL = Object.freeze({
  id: "clinical-evidence-synthesis",
  persona: "你是临床证据分析师。",
  skills: ["clinical-evidence-synthesis"],
  tools: ["mcp__evimed__literature_search", "mcp__evimed__open_access_full_text"],
  produces: [{
    contractKind: "clinical-evidence-report",
    outputs: [
      { path: "clinical-evidence-report.md", required: true },
      { path: "clinical-evidence-matrix.json", required: true },
    ],
  }],
});

const SOURCE_PATH = ".evimed-sources/aspirin/fulltext.txt";
const SOURCE_TEXT = "Background. In adults aged 70 years or older, daily low-dose aspirin did not reduce cardiovascular events (HR 0.95, 95% CI 0.83-1.08) and increased major hemorrhage (HR 1.38, 95% CI 1.18-1.62). Methods follow.";

/** A claim bound to the preserved source, verbatim unless told otherwise. @param {Record<string, any>} [overrides] */
function clinicalClaim(overrides = {}) {
  return {
    claimId: "CLM-001",
    claim: "70 岁及以上成人每日低剂量阿司匹林使大出血风险升高（HR 1.38）。",
    referenceNumber: 1,
    sourceUrl: "https://www.nejm.org/doi/10.1056/NEJMoa1805819",
    sourceTitle: "Effect of Aspirin on Cardiovascular Events and Bleeding in the Healthy Elderly",
    artifactPath: SOURCE_PATH,
    identifier: "doi:10.1056/NEJMoa1805819",
    accessLevel: "full_text",
    supportQuote: "increased major hemorrhage (HR 1.38, 95% CI 1.18-1.62)",
    applicability: "70 岁及以上、无心血管病史的社区成人",
    uncertainty: "单一大型试验；结果外推到亚洲人群需谨慎",
    ...overrides,
  };
}

/** A root-driven clinical fixture: one planned clinical deliverable, one preserved source. */
async function clinicalFixture() {
  const f = await combinedFixture({
    capabilities: [CLINICAL],
    skillBodies: { ...SKILL_BODIES, "clinical-evidence-synthesis": "## 方法\n写主张。\n" },
    evidenceRecords: [{ runId: "combined_run", artifactPath: SOURCE_PATH, status: "ready" }],
  });
  f.files.set(`/workspace/${SOURCE_PATH}`, SOURCE_TEXT);
  await f.step(1);
  const planned = await f.execute("evimed_plan", {
    action: "write",
    clarifications: ["人群按题面限定为 70 岁及以上。"],
    deliverables: [{ id: "d-clin", contractKind: "clinical-evidence-report", capability: CLINICAL.id, title: "阿司匹林一级预防证据综述", dependsOn: [] }],
  });
  assert.equal(planned.value.ok, true, JSON.stringify(planned.value));
  return f;
}

const MATRIX_FILE = "/workspace/deliverables/d-clin/clinical-evidence-matrix.json";
const REPORT_FILE = "/workspace/deliverables/d-clin/clinical-evidence-report.md";

test("a claim that does not verify is written anyway, judged by the gate's own rules, and fixed by writing it again", async () => {
  const f = await clinicalFixture();

  // The quotation is not in the preserved source: unverified, and on disk.
  const first = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim({ supportQuote: "aspirin eliminated all bleeding events" }) });
  assert.equal(first.value.ok, true, "a verdict about a claim is never a refusal");
  assert.equal(first.value.data.claimId, "CLM-001");
  assert.equal(first.value.data.status, "unverified");
  assert.ok(first.value.data.issues.some((/** @type {any} */ entry) => entry.code === "claim-quote-verbatim" && entry.severity === "required"),
    JSON.stringify(first.value.data.issues));
  assert.deepEqual(first.value.data.totals, { total: 1, verified: 0 });
  const written = JSON.parse(String(f.files.get(MATRIX_FILE)));
  assert.equal(written.claims.length, 1, "the unverified claim is in the matrix");
  assert.equal(written.claims[0].supportQuote, "aspirin eliminated all bleeding events");

  // The same id again, quoted correctly: replaced in place, verified.
  const second = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim() });
  assert.equal(second.value.data.status, "verified", JSON.stringify(second.value.data.issues));
  assert.deepEqual(second.value.data.totals, { total: 1, verified: 1 });
  assert.equal(second.value.data.created, undefined, "a rewrite is not a new claim");
  const rewritten = JSON.parse(String(f.files.get(MATRIX_FILE)));
  assert.equal(rewritten.claims.length, 1, "idempotent by claim id");

  // A claim with no id gets the next one; the progress is on the plan.
  const third = await f.execute("evimed_claim_upsert", {
    deliverableId: "d-clin",
    claim: JSON.stringify(clinicalClaim({ claimId: undefined, claim: "心血管事件未见减少（HR 0.95）。", supportQuote: "did not reduce cardiovascular events (HR 0.95, 95% CI 0.83-1.08)" })),
  });
  assert.equal(third.value.data.claimId, "CLM-002");
  assert.equal(third.value.data.created, true);
  assert.deepEqual(third.value.data.totals, { total: 2, verified: 2 });
  assert.deepEqual((await f.status())["d-clin"].claims, { total: 2, verified: 2 }, "evidence progress the control plane can read");
});

test("a batch of claims is one call, written together and judged claim by claim", async () => {
  // One claim per call lost to a script on the live aspirin run of
  // 2026-09-19 (74 claims = 74 steps through the tool, one through
  // mkmatrix.py). A batch is one step and still says which claim fails.
  const f = await clinicalFixture();
  const reply = await f.execute("evimed_claim_upsert", {
    deliverableId: "d-clin",
    claims: [
      clinicalClaim(),
      clinicalClaim({ claimId: "CLM-002", supportQuote: "aspirin eliminated all bleeding events" }),
      JSON.stringify(clinicalClaim({ claimId: undefined, claim: "心血管事件未见减少（HR 0.95）。", supportQuote: "did not reduce cardiovascular events (HR 0.95, 95% CI 0.83-1.08)" })),
    ],
  });
  assert.equal(reply.value.ok, true, JSON.stringify(reply.value));
  assert.deepEqual(reply.value.data.results.map((/** @type {any} */ result) => [result.claimId, result.status]), [
    ["CLM-001", "verified"],
    ["CLM-002", "unverified"],
    ["CLM-003", "verified"],
  ]);
  assert.ok(reply.value.data.results[1].issues.some((/** @type {any} */ entry) => entry.code === "claim-quote-verbatim"));
  assert.equal(reply.value.data.results[2].created, true);
  assert.deepEqual(reply.value.data.totals, { total: 3, verified: 2 });
  assert.equal(JSON.parse(String(f.files.get(MATRIX_FILE))).claims.length, 3, "all three are on disk, the failing one too");
  assert.deepEqual((await f.status())["d-clin"].claims, { total: 3, verified: 2 });

  const tooMany = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claims: Array.from({ length: 61 }, () => clinicalClaim()) });
  assert.equal(tooMany.value.code, "claim_invalid");
  const oneBad = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claims: [clinicalClaim(), "not json"] });
  assert.equal(oneBad.value.code, "claim_invalid");
  assert.match(oneBad.value.message ?? JSON.stringify(oneBad.value), /claims\[1\]/);
  const neither = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin" });
  assert.equal(neither.value.code, "claim_invalid");
});

test("the claim tools refuse what they cannot write safely, and never overwrite a matrix they cannot read", async () => {
  const f = await clinicalFixture();
  f.files.set(MATRIX_FILE, '{"claims": [ {"claimId": "CLM-001", "claim": "未闭合的"支撑"引号"} ]}');
  const unreadable = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim() });
  assert.equal(unreadable.value.code, "matrix_unreadable");
  assert.match(f.files.get(MATRIX_FILE) ?? "", /未闭合的/, "the run's own file is left as it was");

  const notAClaim = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: "not json" });
  assert.equal(notAClaim.value.code, "claim_invalid");

  const unknown = await f.execute("evimed_claim_upsert", { deliverableId: "d-nope", claim: clinicalClaim() });
  assert.equal(unknown.value.code, "deliverable_unknown");

  const noReport = await f.execute("evimed_render_report", { deliverableId: "d-clin" });
  assert.equal(noReport.value.code, "report_missing");

  // A contract without an evidence matrix is not the claim tools' business.
  const other = await combinedFixture();
  await other.step(1);
  await other.plan();
  const bib = await other.execute("evimed_claim_upsert", { deliverableId: "d-bib", claim: clinicalClaim() });
  assert.equal(bib.value.code, "claim_matrix_unsupported");
});

test("rendering renumbers by first appearance, merges a source listed twice and carries the numbers into the matrix", async () => {
  const f = await clinicalFixture();
  await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim({ referenceNumber: 3 }) });
  f.files.set(REPORT_FILE, [
    "# 阿司匹林一级预防",
    "",
    "## 结果",
    "",
    "大出血风险升高 [3]。<!-- claim:CLM-001 -->",
    "与既往队列一致 [1] [claim:CLM-001]",
    "`[9]` 不是引用。",
    "",
    "## 参考文献",
    "",
    "1. Chan AT. A cohort. BMJ. 2016. doi:10.1136/bmj.i1",
    "3. McNeil JJ. Aspirin in the healthy elderly. N Engl J Med. 2018. doi:10.1056/NEJMoa1805819",
    "[4] McNeil JJ. Same trial, second listing. doi:10.1056/NEJMoa1805819",
    "",
  ].join("\n"));

  const rendered = await f.execute("evimed_render_report", { deliverableId: "d-clin" });
  assert.equal(rendered.value.ok, true, JSON.stringify(rendered.value));
  const data = rendered.value.data;
  assert.equal(data.file, "deliverables/d-clin/clinical-evidence-report.md");
  assert.equal(data.renumbered, true);
  assert.equal(data.references, 2, "one work, one entry");
  assert.deepEqual(data.merged, [{ from: 4, into: 3 }]);
  assert.equal(data.markersSynced, 2, "one visible marker hidden, one claim re-pointed");
  const report = String(f.files.get(REPORT_FILE));
  assert.match(report, /大出血风险升高 \[1\]。<!-- claim:CLM-001 -->/);
  assert.match(report, /与既往队列一致 \[2\] <!-- claim:CLM-001 -->/);
  assert.match(report, /`\[9\]` 不是引用/, "code spans are not citations");
  assert.match(report, /## 参考文献\n\n1\. McNeil JJ\. Aspirin in the healthy elderly[^\n]*\n2\. Chan AT\. A cohort/);
  assert.doesNotMatch(report, /Same trial, second listing/);
  assert.equal(JSON.parse(String(f.files.get(MATRIX_FILE))).claims[0].referenceNumber, 1, "the matrix follows the numbers");

  // Deterministic: a second render changes nothing.
  const again = await f.execute("evimed_render_report", { deliverableId: "d-clin" });
  assert.equal(again.value.data.renumbered, false);
  assert.equal(again.value.data.markersSynced, 0);
  assert.equal(String(f.files.get(REPORT_FILE)), report);
});

test("the check and the submission reach the same verdict on a clinical package, and the check can describe the prose", async () => {
  const f = await clinicalFixture();
  // A quotation absent from its source: the one finding every tier agrees
  // must be fixed, so both verdicts are rejections with something to compare.
  await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim({ supportQuote: "aspirin halved major hemorrhage" }) });
  f.files.set(REPORT_FILE, [
    "# 阿司匹林用于 70 岁及以上人群一级预防的获益与风险",
    "",
    "## 摘要",
    "",
    "此外，70 岁及以上成人每日低剂量阿司匹林使大出血风险升高（HR 1.38）[1]。<!-- claim:CLM-001 -->",
    "",
    "## 参考文献",
    "",
    "1. McNeil JJ. Effect of Aspirin on Cardiovascular Events and Bleeding in the Healthy Elderly. N Engl J Med. 2018. doi:10.1056/NEJMoa1805819",
    "",
  ].join("\n"));
  const check = await f.execute("evimed_package_check", { deliverableId: "d-clin", prose: true, watchPhrases: ["此外", "综上所述"] });
  const submit = await f.execute("evimed_submit_deliverable", { deliverableId: "d-clin" });
  assert.equal(check.value.ok, submit.value.ok);
  assert.equal(check.value.ok, false, "a misquoted source is a must-fix, and both say so");
  /** @param {any} reply @returns {string[]} */
  const texts = (reply) => reply.value.issues.map((/** @type {any} */ entry) => `${entry.severity}|${entry.code}|${entry.message}`).sort();
  assert.deepEqual(texts(check), texts(submit), "one verdict, whichever tool asked");
  assert.ok(texts(check).some((line) => /supportQuote/.test(line)), "the verdict names the quotation");
  assert.equal(check.value.data.attempts.used, 0, "the check spent nothing");

  const prose = check.value.data.prose;
  assert.equal(prose.file, "clinical-evidence-report.md");
  assert.deepEqual(prose.phrases, { 此外: 1 }, "only phrases present are counted");
  assert.ok(prose.paragraphs.some((/** @type {any} */ row) => row.section === "摘要" && row.opening.startsWith("此外")), JSON.stringify(prose.paragraphs));
});

/* ---------------------------------------------- structured appraisal ----- */

// A claim may carry its PICO, a GRADE certainty in parts and a risk-of-bias
// record (plan §9.8, P2-22). The tool writes them as given, recomputes what is
// arithmetic, and answers with the stated level beside the computed one; a
// disagreement is advice and never unverifies the claim.
test("a claim's PICO, certainty and risk of bias are written as given, recomputed, and a disagreement is advice", async () => {
  const f = await clinicalFixture();
  // The preserving tool stamped the capture as a randomized trial (C8).
  f.files.set("/workspace/.evimed-sources/aspirin/source.json", '{"schemaVersion":1,"sourceType":"rct","sourceId":"NEJMoa1805819"}\n');
  const appraised = /** @type {Record<string, any>} */ (clinicalClaim({
    pico: {
      population: { text: "≥70 岁社区成人", quote: "In adults aged 70 years or older" },
      intervention: "每日低剂量阿司匹林",
      comparator: "安慰剂",
      outcomes: [{ text: "大出血", quote: "increased major hemorrhage" }],
    },
    certainty: {
      start: "high",
      imprecision: -1,
      upgrades: { largeEffect: 1 },
      rationale: { imprecision: "单一试验，事件数有限", largeEffect: "HR 1.38" },
      label: "high",
    },
    riskOfBias: { tool: "RoB 2", domains: { D1: "low", D2: "low", D3: "low", D4: "low", D5: "some concerns" }, overall: "low" },
  }));
  // The fixture's claim draws one piece of advice of its own (its 70 is not in
  // the quote); only what the appraisal adds is under test here.
  /** @param {any} reply @returns {string[]} */
  const appraisalIssues = (reply) => reply.value.data.issues
    .filter((/** @type {any} */ entry) => /^claim-(?:pico|certainty|rob)-/.test(entry.code))
    .map((/** @type {any} */ entry) => `${entry.code}|${entry.severity}`)
    .sort();
  const baseline = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim() });
  const reply = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: appraised });
  assert.equal(reply.value.ok, true, JSON.stringify(reply.value));
  const data = reply.value.data;
  assert.equal(data.status, "verified", "advice never unverifies a claim");
  assert.deepEqual(appraisalIssues(reply), ["claim-certainty-arithmetic|advisory", "claim-certainty-design|advisory", "claim-rob-overall|advisory"], JSON.stringify(data.issues));
  assert.match(
    data.issues.find((/** @type {any} */ entry) => entry.code === "claim-certainty-design").message,
    /every source it cites is a randomized trial/,
    "the reason is the type stamped beside the capture, not a guess from the instrument",
  );
  assert.deepEqual(
    data.issues.filter((/** @type {any} */ entry) => !/^claim-(?:pico|certainty|rob)-/.test(entry.code)),
    baseline.value.data.issues,
    "the claim's other findings are exactly what they were without the appraisal",
  );
  // The upgrade is not counted for a randomized source: high, one step down,
  // is moderate — beside the label the run wrote.
  assert.deepEqual(data.appraisal, {
    certainty: [{ stated: "high", computed: "moderate", agrees: false }],
    riskOfBias: [{ tool: "RoB 2", stated: "low", computed: "some-concerns", agrees: false }],
  });
  const written = JSON.parse(String(f.files.get(MATRIX_FILE))).claims[0];
  assert.deepEqual([written.pico, written.certainty, written.riskOfBias], [appraised.pico, appraised.certainty, appraised.riskOfBias], "stored exactly as given");

  // Fixed by writing the same claim again: nothing left to say.
  const fixed = await f.execute("evimed_claim_upsert", {
    deliverableId: "d-clin",
    claim: { ...appraised, certainty: { ...appraised.certainty, upgrades: undefined, rationale: { imprecision: "单一试验" }, label: "moderate" }, riskOfBias: { ...appraised.riskOfBias, overall: "some concerns" } },
  });
  assert.deepEqual(appraisalIssues(fixed), []);
  assert.deepEqual(fixed.value.data.issues, baseline.value.data.issues);
  assert.deepEqual(fixed.value.data.appraisal, {
    certainty: [{ stated: "moderate", computed: "moderate", agrees: true }],
    riskOfBias: [{ tool: "RoB 2", stated: "some-concerns", computed: "some-concerns", agrees: true }],
  });

  // A claim with none of the three fields answers exactly as before.
  const plain = await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim() });
  assert.equal(plain.value.data.appraisal, undefined);
  assert.deepEqual(plain.value.data.issues, baseline.value.data.issues);
});

test("the package check reads the same stamped design the claim tool does", async () => {
  const f = await clinicalFixture();
  f.files.set("/workspace/.evimed-sources/aspirin/source.json", '{"schemaVersion":1,"sourceType":"rct"}\n');
  await f.execute("evimed_claim_upsert", { deliverableId: "d-clin", claim: clinicalClaim({ certainty: { start: "low", label: "low" } }) });
  f.files.set(REPORT_FILE, [
    "# 阿司匹林用于 70 岁及以上人群一级预防的获益与风险",
    "",
    "## 摘要",
    "",
    "70 岁及以上成人每日低剂量阿司匹林使大出血风险升高（HR 1.38）[1]。<!-- claim:CLM-001 -->",
    "",
    "## 临床问题与证据",
    "",
    "一级预防的获益需要与出血风险权衡。",
    "",
    "## 检索与方法",
    "",
    "证据来源覆盖随机对照试验与系统评价，按预设资格标准筛选，并逐条核对主张与来源原文。",
    "",
    "## 结果",
    "",
    "纳入的随机对照试验提示出血风险升高。",
    "",
    "## 讨论",
    "",
    "单一大型试验的结果需要结合个体出血风险解读。",
    "",
    "## 局限性",
    "",
    "证据来自单一试验，外推到其他人群存在间接性。",
    "",
    "## 结论与实际处置",
    "",
    "使用阿司匹林做一级预防前应评估出血风险 [1]。<!-- claim:CLM-001 -->",
    "",
    "## 参考文献",
    "",
    "1. McNeil JJ. Effect of Aspirin on Cardiovascular Events and Bleeding in the Healthy Elderly. N Engl J Med. 2018. doi:10.1056/NEJMoa1805819",
    "",
  ].join("\n"));
  const check = await f.execute("evimed_package_check", { deliverableId: "d-clin" });
  /** @type {string[]} */
  const said = check.value.ok
    ? check.value.data.notices
    : check.value.issues.map((/** @type {any} */ entry) => String(entry.message));
  assert.ok(
    said.some((message) => /certainty starts at low, but every source it cites is a randomized trial/.test(message)),
    `the gate read the stamped design: ${JSON.stringify(said)}`,
  );
  // Advice only: whatever else this small report is told, the appraisal is not what holds it.
  const required = check.value.ok ? [] : check.value.issues.filter((/** @type {any} */ entry) => entry.severity === "required");
  assert.equal(required.some((/** @type {any} */ entry) => /certainty|riskOfBias|pico/.test(String(entry.message))), false, JSON.stringify(required));
});
