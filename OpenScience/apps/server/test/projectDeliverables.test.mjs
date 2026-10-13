// The knowledge base page's 「对话产出」: the files a project's conversations delivered, as the run ledger says it
// (2026-10-12, knowledge base P0).
import assert from "node:assert/strict";
import test from "node:test";
import { describeRunArtifactRoles, describeRunArtifacts } from "../src/runArtifacts.mjs";
import { projectDeliverables } from "../src/projectDeliverables.mjs";

const outputs = {
  "clinical-evidence-synthesis": [{ path: "clinical-evidence-report.md", role: "report" }, { path: "clinical-evidence-matrix.json", role: "matrix" }, { path: "agenda-delta.json", role: "data" }],
  "deep-research": [{ path: "report.md", role: "report" }],
};
/** What `AgentRunStore.withArtifactKinds` says about a run, with this file's registry. */
const describe = (run) => ({
  ...describeRunArtifacts(run, (id) => outputs[id]?.map((output) => output.path) ?? null),
  artifactRoles: describeRunArtifactRoles(run, (id) => outputs[id]),
});

const run = (id, over = {}) => ({
  id, status: "succeeded", effectiveAgentId: "clinical-evidence-synthesis", title: "房颤抗凝综述", finishedAt: "2026-10-10T08:00:00Z",
  deliverables: [{ id: "clinical-evidence-synthesis", title: "证据综述", capability: "clinical-evidence-synthesis", status: "delivered", attempts: 1 }],
  artifacts: ["deliverables/clinical-evidence-synthesis/clinical-evidence-report.md", "deliverables/clinical-evidence-synthesis/clinical-evidence-matrix.json"],
  unverifiedArtifacts: ["deliverables/clinical-evidence-synthesis/revision-notes.md", "work/step-1.py", "deliverables/clinical-evidence-synthesis/draft-outline.md"],
  ...over,
});
const list = (runs, options = {}) => projectDeliverables(runs, { describe, ...options });

test("a package is one line: the report a reader opens first, named by the conversation, not its matrix, notes or scratch", () => {
  assert.deepEqual(list([run("run_1")]), [{ runId: "run_1", title: "房颤抗凝综述", path: "deliverables/clinical-evidence-synthesis/clinical-evidence-report.md", at: "2026-10-10T08:00:00.000Z" }]);
});

test("two deliverables of one run are two lines, and the newest conversation is first", () => {
  const two = run("run_2", {
    finishedAt: "2026-10-11T08:00:00Z", effectiveAgentId: "deep-research", title: null, question: "  请比较 DOAC 与\n华法林  ",
    deliverables: [{ id: "a", capability: "deep-research" }, { id: "b", capability: "deep-research" }],
    artifacts: ["deliverables/a/report.md", "deliverables/b/report.md"], unverifiedArtifacts: [],
  });
  const lines = list([run("run_1"), two]);
  assert.deepEqual(lines.map((line) => [line.runId, line.path, line.title]), [
    ["run_2", "deliverables/a/report.md", "请比较 DOAC 与 华法林"],
    ["run_2", "deliverables/b/report.md", "请比较 DOAC 与 华法林"],
    ["run_1", "deliverables/clinical-evidence-synthesis/clinical-evidence-report.md", "房颤抗凝综述"],
  ]);
});

test("only the researcher's own finished work is listed: not a failed run, a deleted one, a machine's, or a capability that is the platform's", () => {
  const runs = [
    run("failed", { status: "failed" }), run("deleted", { deleted: true }), run("automated", { automated: true }),
    run("episode", { effectiveRouteReason: "autopilot:episode" }), run("internal", { effectiveAgentId: "method-distillation" }),
    run("undated", { finishedAt: undefined }), run("kept"),
  ];
  assert.deepEqual(list(runs, { isInternal: (agent) => agent === "method-distillation" }).map((line) => line.runId), ["kept"]);
  // A run that left nothing a reader opens is not a line.
  assert.deepEqual(list([run("bare", { artifacts: [], unverifiedArtifacts: [] }), run("data-only", { artifacts: ["deliverables/clinical-evidence-synthesis/agenda-delta.json"], unverifiedArtifacts: [] })]), []);
  assert.deepEqual(list([]), []);
  assert.deepEqual(projectDeliverables(undefined), []);
});

test("the list is bounded and says nothing about how many it left out", () => {
  const many = Array.from({ length: 12 }, (_, index) => run(`run_${index}`, { finishedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z` }));
  const lines = list(many, { limit: 5 });
  assert.deepEqual(lines.map((line) => line.runId), ["run_11", "run_10", "run_9", "run_8", "run_7"]);
});

test("an ordinary conversation's files are each a line: the workbook and the script, not only the document", () => {
  const ordinary = (id, over = {}) => ({
    id, status: "succeeded", effectiveAgentId: "open-domain-answer", title: "月度预算", finishedAt: "2026-10-12T08:00:00Z",
    artifacts: ["预算表.xlsx", "rename.py", "会议纪要.docx", "tmp/scratch.py", "work/notes.md"], ...over,
  });
  const describeOrdinary = (current) => ({
    ...describeRunArtifacts(current, () => []),
    artifactRoles: describeRunArtifactRoles(current, () => undefined, describeRunArtifacts(current, () => [])?.outputFiles ?? null),
  });
  const lines = projectDeliverables([ordinary("run_a")], { describe: describeOrdinary });
  assert.deepEqual(lines.map((line) => line.path).sort(), ["rename.py", "预算表.xlsx", "会议纪要.docx"].sort());
  assert.ok(lines.every((line) => line.runId === "run_a" && line.title === "月度预算"));
  // A typed-in turn that no capability took is an ordinary conversation too — and without files it is not a line.
  const unrouted = ordinary("run_b", { effectiveAgentId: undefined, artifacts: ["summary.md"] });
  assert.deepEqual(projectDeliverables([unrouted], { describe: describeOrdinary }).map((line) => line.path), ["summary.md"]);
  assert.deepEqual(projectDeliverables([ordinary("run_c", { effectiveAgentId: undefined, artifacts: [] })], { describe: describeOrdinary }), []);
  // The rest of the rules are unchanged: a failed run, a machine's and an internal capability's files are not listed.
  assert.deepEqual(projectDeliverables([ordinary("failed", { status: "failed" }), ordinary("auto", { automated: true })], { describe: describeOrdinary }), []);
  // And a professional package beside it is still one line.
  const both = projectDeliverables([ordinary("run_a", { finishedAt: "2026-10-09T00:00:00Z" }), run("run_1")], { describe });
  assert.equal(both.filter((line) => line.runId === "run_1").length, 1);
});
