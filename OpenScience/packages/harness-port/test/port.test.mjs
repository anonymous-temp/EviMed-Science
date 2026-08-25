import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  SEAMS,
  __setHarnessModule,
  defineTool,
  loadHarnessModule,
  onToolObserved,
  onToolPolicy,
  onTurnEnd,
  probeSeams,
  renderEnvelope,
  toArgs,
  toSessionRef,
  toStepInfo,
  toSubagentOutcome,
  toToolCall,
  toToolOutcome,
  toTurnEnd,
  toUsage,
} from "../index.mjs";

/** A minimal cordis-shaped context with the seams the probe walks. */
function fakeContext(overrides = {}) {
  const listeners = new Map();
  const services = new Map(Object.entries({
    tools: {}, systemPrompt: {}, agents: {}, sessions: {}, subagents: {}, agentPresets: {}, shell: {},
    storageDomain: {}, skills: {}, fs: {}, jobs: {}, workflowEngine: {},
    ...overrides.services,
  }));
  const registered = new Map();
  const ctx = {
    get: (key) => services.get(key),
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== handler));
    },
    emit: (event, ...args) => (listeners.get(event) ?? []).map((handler) => handler(...args)),
    listeners,
    registered,
  };
  services.set("tools", {
    register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
    guard: () => () => {},
    async execute(input) {
      const chain = listeners.get(SEAMS.events.toolPolicy) ?? [];
      let index = 0;
      const next = async () => (index < chain.length ? chain[index++](input, next) : { kind: "allow" });
      const decision = await next();
      if (decision?.kind === "deny") return { error: { name: "Denied", code: "DENIED" }, content: [] };
      const tool = registered.get(input.name);
      const value = await tool.execute(input.arguments ?? {}, { ...input, concludeTurn() {} });
      const result = { value, content: tool.output?.render?.(input.arguments ?? {}, value) ?? [] };
      for (const handler of listeners.get(SEAMS.events.toolObserved) ?? []) handler(input, result);
      return result;
    },
  });
  // The shape the harness actually returns: `{ mode, denied, enforcement?,
  // runnerFailed? }` under `sandbox`, with `enforcement` optional. The fake used
  // to return it flat, which meant the probe's real read path was never
  // exercised by any test.
  // Two methods, not one, because the executor's contract is two methods:
  // `resolve()` turns a request into a spec — filling `sandboxPolicy` from the
  // deployment's policy service — and `run()` accepts only a resolved spec,
  // destructuring that policy without a default. A double offering just `run`
  // let the probe call it with a raw request and pass, while the real container
  // died on "Cannot destructure property 'mode' of 'policy'". The double now
  // refuses a raw request the same way the real one does.
  services.set("shell", {
    resolve: (request) => ({ ...request, workdir: "/workspace", timeoutMs: 10_000, sandboxPolicy: { mode: "workspace-write" } }),
    run: async (spec) => {
      if (!spec?.sandboxPolicy) throw new TypeError("Cannot destructure property 'mode' of 'policy' as it is undefined.");
      return {
        sandbox: {
          mode: "workspace-write",
          denied: overrides.denied ?? false,
          ...(overrides.enforcement === null ? {} : { enforcement: overrides.enforcement ?? "full" }),
          ...(overrides.runnerFailed == null ? {} : { runnerFailed: overrides.runnerFailed }),
        },
      };
    },
  });
  // A real cordis Context exposes each service as `ctx.<key>` as well as through
  // `ctx.get(key)`; the port uses the property form for required seams and the
  // getter form for optional ones, so the fake must offer both.
  for (const key of [...SEAMS.services.required, ...SEAMS.services.optional]) {
    Object.defineProperty(ctx, key, { get: () => services.get(key), configurable: true });
  }
  return ctx;
}

/** The pieces of `@deepseek-ai/dsh-tools` the port actually calls. */
function fakeDshTools() {
  return {
    defineTool(options) {
      return {
        name: options.name,
        description: options.description,
        parameters: options.parameters,
        output: options.output,
        execute: options.execute,
      };
    },
  };
}

test("the manifest is the single source: services, events and wire methods are disjoint and complete", () => {
  const allMethods = new Set([...SEAMS.wire.unary, ...SEAMS.wire.denied]);
  assert.equal(allMethods.size, SEAMS.wire.unary.length + SEAMS.wire.denied.length, "a method is both allowed and denied");
  assert.equal(allMethods.size, 52, "the apiproxy publishes 52 unary methods; the split must cover all of them");
  assert.ok(!SEAMS.wire.unary.includes("session.status"), "session.status does not exist; running state comes from events.host");
  assert.ok(SEAMS.wire.denied.includes("settings.update"));
  assert.ok(SEAMS.wire.denied.includes("credentials.set"));
  const required = new Set(SEAMS.services.required);
  for (const key of SEAMS.services.optional) assert.ok(!required.has(key), `${key} is both required and optional`);
});

test("an unknown turn-end kind is preserved rather than guessed", () => {
  assert.deepEqual(toTurnEnd({ type: "turn/end", data: { reason: { kind: "completed" } } }), { kind: "completed" });
  assert.deepEqual(toTurnEnd({ data: { reason: { kind: "aborted", reason: { kind: "user" } } } }), { kind: "aborted" });
  assert.deepEqual(toTurnEnd({ data: { reason: { kind: "error", error: { code: "RATE_LIMIT", message: "x" } } } }), { kind: "error", code: "RATE_LIMIT" });
  assert.deepEqual(toTurnEnd({ data: { reason: { kind: "max-tokens" } } }), { kind: "max-tokens" });
  assert.deepEqual(toTurnEnd({ data: { reason: { kind: "interrupted" } } }), { kind: "interrupted" });
  assert.deepEqual(toTurnEnd({ data: { reason: { kind: "gone-fishing" } } }), { kind: "unknown", rawKind: "gone-fishing" });
  assert.deepEqual(toTurnEnd(null), { kind: "unknown", rawKind: "" });
});

test("malformed model arguments never throw inside a listener", () => {
  assert.deepEqual(toArgs('{"query":"x"}'), { query: "x" });
  assert.deepEqual(toArgs("{not json"), {});
  assert.deepEqual(toArgs("[1,2]"), {});
  assert.deepEqual(toArgs(undefined), {});
  assert.deepEqual(toArgs({ already: true }), { already: true });
});

test("a tool execution converts to the port's own shape", () => {
  const signal = AbortSignal.timeout(1000);
  const call = toToolCall({
    callId: "c1",
    name: "mcp__evimed__literature_search",
    arguments: '{"query":"metformin"}',
    signal,
    parent: undefined,
    agent: { id: "a1", session: { id: "s1", header: { cwd: "/w" } } },
  });
  assert.deepEqual({ ...call, signal: undefined }, {
    callId: "c1", rootCallId: "c1", name: "mcp__evimed__literature_search",
    args: { query: "metformin" }, sessionId: "s1", agentId: "a1", cwd: "/w", nested: false, signal: undefined,
  });
});

test("a tool outcome flattens content and preserves the failure identity", () => {
  const ok = toToolOutcome({ value: { ok: true }, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
  assert.deepEqual(ok, { status: "completed", text: "a\nb", structured: { ok: true }, error: null, meta: undefined });
  const bad = toToolOutcome({ error: { name: "ToolError", code: "full_text_not_available" }, content: [] });
  assert.equal(bad.status, "error");
  assert.equal(bad.error.code, "full_text_not_available");
});

test("usage totals cover a provider that reports only the cache split", () => {
  assert.deepEqual(toUsage({ promptCacheHitTokens: 100, promptCacheMissTokens: 20, completionTokens: 7 }), { input: 120, output: 7, cacheHit: 100, cacheMiss: 20 });
  assert.deepEqual(toUsage({ inputTokens: 5, outputTokens: 6 }), { input: 5, output: 6, cacheHit: 0, cacheMiss: 0 });
  assert.deepEqual(toUsage(undefined), { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 });
});

test("a subagent outcome lands unknown stop reasons explicitly", () => {
  const outcome = toSubagentOutcome({ info: { id: "child-1" }, result: { stopReason: "completed", output: [{ type: "text", text: "done" }], structured: { ok: true } } });
  assert.deepEqual(outcome, { childSessionId: "child-1", stopReason: "completed", output: "done", structured: { ok: true }, diagnostic: "" });
  assert.equal(toSubagentOutcome({ info: { id: "c" }, result: { stopReason: "exploded" } }).stopReason, "unknown");
});

test("a subagent session is recognizable from its header", () => {
  assert.deepEqual(toSessionRef({ id: "s2", header: { cwd: "/w", parentSession: "s1", origin: "subagent" } }), {
    sessionId: "s2", cwd: "/w", parentSessionId: "s1", subagent: true,
  });
  assert.equal(toSessionRef({ id: "s1", header: { cwd: "/w" } }).subagent, false);
});

test("step info carries the root/child verdict the caller computed", () => {
  const info = toStepInfo(
    { agent: { id: "a1", session: { id: "s1", header: { cwd: "/w" } } }, turn: 3, step: 2, signal: AbortSignal.timeout(1000) },
    { first: true, root: false, usageSoFar: { input: 1, output: 2, cacheHit: 0, cacheMiss: 1 } },
  );
  assert.equal(info.turn, 3);
  assert.equal(info.first, true);
  assert.equal(info.root, false);
  assert.equal(info.usageSoFar.output, 2);
});

test("every EviMed tool answers in one envelope, and the object root stays open", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  const tool = await defineTool({
    name: "evimed_demo",
    description: "demo",
    parameters: { id: { type: "string", required: true } },
    execute: async () => ({ ok: false, code: "deliverable_rejected", issues: [{ code: "x", message: "m", severity: "required", path: "a.md", line: 3 }] }),
  });
  assert.equal(tool.output.schema.additionalProperties, true, "a closed object root drops fields silently");
  const value = await tool.execute({ id: "d1" }, { callId: "c", name: "evimed_demo", arguments: { id: "d1" }, signal: AbortSignal.timeout(100), concludeTurn() {} });
  assert.deepEqual(value, { ok: false, code: "deliverable_rejected", issues: [{ code: "x", message: "m", severity: "required", path: "a.md", line: 3 }] });
  assert.match(renderEnvelope(value), /failed: deliverable_rejected/);
  assert.match(renderEnvelope(value), /\[a\.md:3\]/);
});

test("concludeTurn only fires for a successful terminal tool", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  let concluded = 0;
  const tool = await defineTool({
    name: "evimed_complete_run",
    description: "d",
    parameters: {},
    execute: async () => ({ ok: false, code: "run_incomplete", concludeTurn: true }),
  });
  await tool.execute({}, { callId: "c", name: "evimed_complete_run", arguments: {}, signal: AbortSignal.timeout(100), concludeTurn: () => { concluded += 1; } });
  assert.equal(concluded, 0, "a failed completion must not end the turn");
  const good = await defineTool({ name: "t2", description: "d", parameters: {}, execute: async () => ({ ok: true, concludeTurn: true }) });
  await good.execute({}, { callId: "c", name: "t2", arguments: {}, signal: AbortSignal.timeout(100), concludeTurn: () => { concluded += 1; } });
  assert.equal(concluded, 1);
});

test("a policy listener that denies still delegates the rest of the waterfall", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  const ctx = fakeContext();
  let seen = 0;
  onToolPolicy(ctx, (call) => {
    seen += 1;
    return call.name === "blocked" ? { allow: false, code: "path_guard_denied", reason: "no" } : { allow: true };
  });
  const observed = [];
  onToolObserved(ctx, (call) => observed.push(call.name));
  const tool = await defineTool({ name: "allowed", description: "d", parameters: {}, execute: async () => ({ ok: true }) });
  ctx.get("tools").register(tool);
  await ctx.get("tools").execute({ callId: "1", name: "allowed", arguments: {}, signal: AbortSignal.timeout(100) });
  assert.equal(seen, 1);
  assert.deepEqual(observed, ["allowed"]);
  const denied = await ctx.get("tools").execute({ callId: "2", name: "blocked", arguments: {}, signal: AbortSignal.timeout(100) });
  assert.equal(denied.error.code, "DENIED");
});

test("onTurnEnd fires only for turn/end and classifies it", () => {
  const ctx = fakeContext();
  const seen = [];
  onTurnEnd(ctx, (session, end) => seen.push([session.sessionId, end.kind]));
  const session = { id: "s1", header: { cwd: "/w" } };
  ctx.emit(SEAMS.events.sessionEvent, session, { type: "tool/call", seq: 1, time: 0, data: {} });
  ctx.emit(SEAMS.events.sessionEvent, session, { type: "turn/end", seq: 2, time: 0, data: { reason: { kind: "blocked" } } });
  assert.deepEqual(seen, [["s1", "blocked"]]);
});

test("the startup probe crashes on a missing gate seam and degrades on a missing enhancement", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  const healthy = await probeSeams(fakeContext(), { dshVersion: SEAMS.dsh });
  assert.deepEqual(healthy.fatal, []);
  assert.deepEqual(healthy.degraded, []);
  assert.ok(healthy.checked.includes("pipeline:tools"));

  const noSubagents = fakeContext({ services: { subagents: undefined } });
  const missing = await probeSeams(noSubagents, { dshVersion: SEAMS.dsh });
  assert.ok(missing.fatal.some((line) => line.includes("ctx.subagents")));

  const noStorage = fakeContext({ services: { storageDomain: undefined } });
  const degraded = await probeSeams(noStorage, { dshVersion: SEAMS.dsh });
  assert.deepEqual(degraded.fatal, []);
  assert.ok(degraded.degraded.some((line) => line.includes("ctx.storageDomain")));
});

test("a renamed event shows up as a silent seam, not as a passing probe", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  const ctx = fakeContext();
  const realOn = ctx.on;
  // Simulate DSH renaming the observation event: registering succeeds, the
  // listener simply never fires. This is the failure mode the probe exists for.
  ctx.on = (event, handler) => (event === SEAMS.events.toolObserved ? () => {} : realOn.call(ctx, event, handler));
  const result = await probeSeams(ctx, { dshVersion: SEAMS.dsh });
  assert.ok(result.fatal.some((line) => line.includes("seam silent")), JSON.stringify(result));
});

test("a version drift between the image and the manifest is fatal", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  const result = await probeSeams(fakeContext(), { dshVersion: "0.9.9" });
  assert.ok(result.fatal.some((line) => line.includes("seam-manifest.dsh")));
});

test("a sandbox that cannot enforce fails a hosted profile closed", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  const partial = await probeSeams(fakeContext({ enforcement: "partial" }), { dshVersion: SEAMS.dsh, requiredEnforcement: "full" });
  assert.ok(partial.fatal.some((line) => line.includes('enforcement is "partial"')));
  const allowed = await probeSeams(fakeContext({ enforcement: "partial" }), { dshVersion: SEAMS.dsh, requiredEnforcement: "partial" });
  assert.deepEqual(allowed.fatal, []);
});

// G2, stated as a test: in a container bwrap is unavailable, so the chain falls
// to Landlock, and if Landlock is unavailable too the bash tool refuses every
// command while every other signal says the runtime is healthy. Each way that
// can present has to be fatal on its own.
test("a runtime that cannot run a command does not pass as healthy", async () => {
  __setHarnessModule("@deepseek-ai/dsh-tools", fakeDshTools());
  const options = { dshVersion: SEAMS.dsh, requiredEnforcement: "full" };

  const failed = await probeSeams(fakeContext({ runnerFailed: true }), options);
  assert.ok(
    failed.fatal.some((line) => line.includes("runner failed to launch")),
    "a backend that never launched reports full enforcement of nothing",
  );

  // `enforcement` is optional in the harness's own type, so a missing field must
  // read as unknown rather than as satisfied.
  const silent = await probeSeams(fakeContext({ enforcement: null }), options);
  assert.ok(silent.fatal.some((line) => line.includes('enforcement is "unknown"')));

  const denied = await probeSeams(fakeContext({ denied: true }), options);
  assert.ok(denied.fatal.some((line) => line.includes("denied a no-op command")));
});

test("a harness package outside the manifest cannot be loaded", async () => {
  await assert.rejects(loadHarnessModule("@deepseek-ai/dsh-experimental-agent-team"), /not listed in seam-manifest/);
});

test("no source file writes an event name as a literal outside the manifest", async () => {
  const files = await readdir(new URL("../src/", import.meta.url));
  const sources = [["index.mjs", await readFile(new URL("../index.mjs", import.meta.url), "utf8")]];
  for (const name of files.filter((file) => file.endsWith(".mjs"))) {
    sources.push([name, await readFile(new URL(`../src/${name}`, import.meta.url), "utf8")]);
  }
  const eventNames = Object.values(SEAMS.events);
  for (const [name, source] of sources) {
    for (const eventName of eventNames) {
      const literal = new RegExp(`\\.on\\(\\s*['"\`]${eventName.replace("/", "\\/")}`);
      assert.ok(!literal.test(source), `${name} subscribes to "${eventName}" as a literal instead of through SEAMS.events`);
    }
  }
});

test("a tool outcome carries its structure whether the tool is native or MCP", () => {
  // The research tools are all MCP tools, and `dsh-mcp-client` answers in the
  // MCP shape — `structuredContent`, never `value`. A converter that read only
  // `value` handed every retrieval to the evidence ledger as structurally
  // empty, so the ledger stayed at zero rows while the workspace filled with
  // preserved sources, and every downstream check that reads the ledger —
  // quote resolution, provenance, the stale sweep — had nothing to work from.
  const native = toToolOutcome({ value: { sources: [{ id: "a" }] }, content: [] });
  assert.deepEqual(native.structured, { sources: [{ id: "a" }] });

  const mcp = toToolOutcome({ structuredContent: { sources: [{ id: "b" }] }, content: [{ type: "text", text: "t" }] });
  assert.deepEqual(mcp.structured, { sources: [{ id: "b" }] }, "an MCP result's structure must survive the conversion");
  assert.equal(mcp.status, "completed");

  // `value` still wins when both are present: a native tool that also carries
  // an MCP-shaped field is answering in its own vocabulary.
  const both = toToolOutcome({ value: { sources: [{ id: "native" }] }, structuredContent: { sources: [{ id: "mcp" }] }, content: [] });
  assert.deepEqual(both.structured, { sources: [{ id: "native" }] });
});
