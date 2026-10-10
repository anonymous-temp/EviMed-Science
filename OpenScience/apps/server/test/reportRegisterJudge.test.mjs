import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { maxQualityNotices } from "../src/runNotices.mjs";
import { reportProseLines, reviewDeliveredRegister } from "../src/reportRegisterJudge.mjs";
import { runGate } from "@evimed/domain";
import { runtimeLeakageLine } from "@evimed/domain/clinical-evidence";

test("the synchronous gate checks identifiers and leaves open language to J4", () => {
  assert.equal(runtimeLeakageLine("本轮检索提示资料有限，样本环境温度较低。"), null);
  assert.ok(runtimeLeakageLine("来源保存在 .evimed-sources/paper.txt"));
  assert.ok(runtimeLeakageLine("mcp__evimed__literature_search"));
  assert.equal(runGate({ contractKind: "research-brief", files: new Map([["brief.md", "本环境下的工件已完成。"]]), expectedOutputs: [] }).issues.some(issue => issue.code === "runtime_leakage"), false);
});

test("report line evidence preserves numbering and excludes code fences", () => {
  assert.deepEqual(reportProseLines("Result\n\n```text\ninternal command\n```\nConclusion"), [
    { line: 1, text: "Result" }, { line: 6, text: "Conclusion" },
  ]);
});

test("delivered reports receive advisory notices; revision notes, outside paths and VCR stay out", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "report.md"), "Research result\nA backstage diary");
  await writeFile(path.join(root, "revision-notes.md"), "Technical changes");
  await symlink("/etc/hosts", path.join(root, "outside.md"));
  const notices = [], calls = [];
  const run = { id: "run_1", status: "succeeded", artifacts: ["report.md", "revision-notes.md", "outside.md"], verification: "verified" };
  const original = structuredClone(run);
  const input = { project: { id: "p", userId: "u", workspaceDir: root }, run,
    judgeService: { judge: async (site, value) => { calls.push({ site, value }); return { outcome: "settled", value: { leakage: value.line === "A backstage diary" } }; } },
    onNotices: async value => notices.push(...value) };
  await reviewDeliveredRegister(input);
  assert.equal(calls.length, 2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].severity, "advice");
  assert.equal(notices[0].file, "report.md");
  assert.equal(notices[0].line, 2);
  assert.deepEqual(run, original);
  await reviewDeliveredRegister({ ...input, run: { ...run, effectiveAgentId: "vcr-analysis" } });
  assert.equal(calls.length, 2);
});

/** A workspace holding the named files, removed with the test.
 * @param {import("node:test").TestContext} t @param {Record<string, string>} files */
async function workspaceOf(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return { id: "p", userId: "u", workspaceDir: root };
}

/** A judge that flags the lines `flag` accepts and records what it was asked and what was skipped. */
function recordingJudge(flag) {
  const calls = [], skips = [];
  return {
    calls, skips,
    judge: async (_site, value) => { calls.push(value.line); return { outcome: "settled", value: { leakage: flag(value.line) } }; },
    skipped: (site, reason, count) => skips.push([site, reason, count]),
  };
}

test("one run's lines are judged up to the cap, the rest are counted, and the notices go in one write", async t => {
  const project = await workspaceOf(t, { "report.md": Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n") });
  const judge = recordingJudge(line => ["Line 2", "Line 3", "Line 9"].includes(line));
  const writes = [];
  await reviewDeliveredRegister({ project, run: { id: "r", artifacts: ["report.md"] }, judgeService: judge, maxLines: 5,
    onNotices: async notices => writes.push(notices) });
  assert.equal(judge.calls.length, 5, "the cap bounds the requests of one run");
  assert.equal(writes.length, 1, "every flagged line of the run is one ledger write");
  assert.deepEqual(writes[0].map(notice => notice.line), [2, 3]);
  assert.deepEqual(judge.skips, [["J4", "lines_over_cap", 7]], "what the cap left unread is counted, not silent");
});

test("the cap is shared by a run's files, in order, and a run that flags nothing writes nothing", async t => {
  const project = await workspaceOf(t, { "a.md": "A1\nA2\nA3", "b.md": "B1\nB2\nB3" });
  const judge = recordingJudge(() => false);
  const writes = [];
  await reviewDeliveredRegister({ project, run: { id: "r", artifacts: ["a.md", "b.md"] }, judgeService: judge, maxLines: 4,
    onNotices: async notices => writes.push(notices) });
  assert.deepEqual(judge.calls, ["A1", "A2", "A3", "B1"]);
  assert.deepEqual(writes, []);
  assert.deepEqual(judge.skips, [["J4", "lines_over_cap", 2]]);
});

test("a ledger holds only so many notices, so judging stops once that many lines are flagged", async t => {
  const project = await workspaceOf(t, { "report.md": Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n") });
  const judge = recordingJudge(() => true);
  const writes = [];
  await reviewDeliveredRegister({ project, run: { id: "r", artifacts: ["report.md"] }, judgeService: judge,
    onNotices: async notices => writes.push(notices) });
  assert.equal(judge.calls.length, maxQualityNotices);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, maxQualityNotices);
  assert.deepEqual(judge.skips, [["J4", "lines_after_notice_limit", 100 - maxQualityNotices]]);
});

test("internal projects, internal capabilities and the platform's own evaluation runs are never read", async t => {
  const project = await workspaceOf(t, { "report.md": "Research result\nA backstage diary" });
  const base = { id: "r", artifacts: ["report.md"] };
  const out = [
    ["an internal project", { run: base, internalProject: true }],
    ["an internal capability", { run: base, internalCapability: true }],
    ["an evaluation harness run", { run: { ...base, automated: true } }],
    ["the learning loop's own run", { run: { ...base, effectiveAgentId: "method-distillation" } }],
    ["a platform evolution run", { run: { ...base, effectiveRouteReason: "platform-evolution" } }],
    ["a 虚拟临研 run", { run: { ...base, effectiveAgentId: "vcr-analysis" } }],
  ];
  for (const [name, extra] of out) {
    const judge = recordingJudge(() => true);
    const writes = [];
    await reviewDeliveredRegister({ project, judgeService: judge, onNotices: async notices => writes.push(notices), ...extra });
    assert.deepEqual(judge.calls, [], `${name} is not sent to Jev`);
    assert.deepEqual(writes, [], name);
    assert.deepEqual(judge.skips, [["J4", "run_out_of_scope", 1]], `${name} is counted as out of scope`);
  }
  // Work done for a researcher stays in scope even when the platform started it:
  // a GEO step, a proactive episode, and a plain researcher run.
  for (const run of [
    { ...base, automated: true, effectiveRouteReason: "geo:geo-content" },
    { ...base, automated: true, effectiveRouteReason: "autopilot:literature-sentinel" },
    { ...base, effectiveAgentId: "clinical-evidence-synthesis", effectiveRouteReason: "llm:0.9" },
  ]) {
    const judge = recordingJudge(() => false);
    await reviewDeliveredRegister({ project, run, judgeService: judge, onNotices: async () => {} });
    assert.deepEqual(judge.calls, ["Research result", "A backstage diary"], run.effectiveRouteReason);
    assert.deepEqual(judge.skips, []);
  }
});

test("the run store applies the scope and the cap it was configured with when a run ends", async t => {
  const reports = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`).join("\n");
  /** @param {string} projectId @param {Record<string, any>} [options] @param {Record<string, any>} [dispatch] */
  const finishWith = async (projectId, options = {}, dispatch = {}) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jev-store-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = { id: projectId, userId: "owner", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const judge = recordingJudge(line => line === "Line 3" || line === "Line 4");
    const binding = { sessionId: `ses-${projectId}`, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-flash", judgeService: judge, ...options });
    store.scheduleMonitor = () => {};
    const started = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: `turn-${projectId}`, ...dispatch }, async () => ({ accepted: true }));
    await mkdir(path.join(project.workspaceDir, "deliverables", "research"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, "deliverables", "research", "report.md"), reports);
    await store.finishInternal(project, started.id, { status: "failed", errorCode: "runtime_not_running", artifacts: [] });
    await Promise.allSettled([...store.backgroundLabels]);
    const run = (await store.list(project)).find(item => item.id === started.id);
    return { judge, run };
  };
  const ordinary = await finishWith("ordinary", { registerJudgeMaxLines: 5, internalProject: () => false });
  assert.equal(ordinary.judge.calls.length, 5, "the configured cap reaches the judge");
  assert.deepEqual(ordinary.run.qualityNotices.filter(notice => notice.code === "runtime_leakage").map(notice => notice.line), [3, 4]);
  const internal = await finishWith("evimed-learning", { internalProject: project => project.id === "evimed-learning" });
  assert.deepEqual(internal.judge.calls, [], "an internal project's run is not read");
  assert.deepEqual(internal.judge.skips, [["J4", "run_out_of_scope", 1]]);
  // A capability the registry marks internal is out of scope whatever its id: the lists of platform
  // agents in the domain are not the only way a capability becomes the platform's own.
  const agentRegistry = { get: id => id === "future-internal-capability" ? { id, visibility: "internal" } : undefined };
  const dispatched = { effectiveAgentId: "future-internal-capability", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "evimed-future-internal-capability", effectiveRouteReason: "choice:future-internal-capability" };
  const capability = await finishWith("capability-run", { agentRegistry }, dispatched);
  assert.deepEqual(capability.judge.calls, [], "an internal capability's run is not read");
  assert.deepEqual(capability.judge.skips, [["J4", "run_out_of_scope", 1]]);
  const control = await finishWith("capability-control", { agentRegistry: { get: () => ({ visibility: "public" }) } }, dispatched);
  assert.equal(control.judge.calls.length, 8, "the same run is read when the registry calls its capability public");
});
