// What each file a run left is (2026-09-18, plan §3 #16): the aspirin run
// "produced 41 files", two of which were its product.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { KNOWLEDGE_BASE_DIR } from "../src/researchContext.mjs";
import {
  ARTIFACT_KINDS, ORDINARY_OUTPUT_LIMIT, PLATFORM_ROOT_DIRECTORIES, SCRATCH_DIRECTORIES,
  describeRunArtifactRoles, describeRunArtifacts, isOrdinaryConversation, ordinaryOutputPath, ordinaryRole,
} from "../src/runArtifacts.mjs";

const clinicalOutputs = ["clinical-evidence-report.md", "clinical-evidence-matrix.json", "agenda-delta.json"];
const declaredOutputsOf = (/** @type {string} */ id) => (id === "clinical-evidence-synthesis" ? clinicalOutputs : null);

/** The aspirin run's shape: a plan revision left one directory behind. */
function aspirinRun() {
  const live = "deliverables/clinical-evidence-synthesis";
  const abandoned = "deliverables/clinical-evidence";
  return {
    id: "run_aspirin",
    status: "succeeded",
    effectiveAgentId: "clinical-evidence-synthesis",
    deliverables: [{ id: "clinical-evidence-synthesis", title: "证据综述", capability: "clinical-evidence-synthesis", status: "delivered", attempts: 2 }],
    artifacts: [`${live}/clinical-evidence-report.md`, `${live}/clinical-evidence-matrix.json`],
    unverifiedArtifacts: [
      `${live}/revision-notes.md`,
      `${live}/.evimed-retrieval/pubmed-1.json`,
      `${live}/draft-outline.md`,
      ...Array.from({ length: 19 }, (_, index) => `work/step-${index}.py`),
      ...Array.from({ length: 12 }, (_, index) => `${abandoned}/.evimed-retrieval/hit-${index}.json`),
      `${abandoned}/clinical-evidence-report.md`,
    ],
  };
}

test("a run's files are sorted into its product, its revision notes, its scratch and what a plan revision abandoned", () => {
  const described = describeRunArtifacts(aspirinRun(), declaredOutputsOf);
  assert.ok(described);
  const kinds = described.artifactKinds;
  assert.equal(kinds["deliverables/clinical-evidence-synthesis/clinical-evidence-report.md"], "deliverable");
  assert.equal(kinds["deliverables/clinical-evidence-synthesis/clinical-evidence-matrix.json"], "deliverable");
  assert.equal(kinds["deliverables/clinical-evidence-synthesis/revision-notes.md"], "revision-notes");
  assert.equal(kinds["deliverables/clinical-evidence-synthesis/.evimed-retrieval/pubmed-1.json"], "work");
  assert.equal(kinds["deliverables/clinical-evidence-synthesis/draft-outline.md"], "work", "undeclared is scratch, whatever its name says");
  assert.equal(kinds["work/step-0.py"], "work");
  assert.equal(kinds["deliverables/clinical-evidence/clinical-evidence-report.md"], "superseded", "a declared name in an abandoned directory is still abandoned");
  assert.equal(kinds["deliverables/clinical-evidence/.evimed-retrieval/hit-0.json"], "superseded");
  assert.deepEqual(described.artifactCounts, { deliverable: 2, revisionNotes: 1, work: 21, superseded: 13 });
  assert.equal(Object.keys(kinds).length, 37, "every file on the record has a kind");
  assert.ok(Object.values(kinds).every((kind) => ARTIFACT_KINDS.includes(kind)));
});

test("a run laid out before deliverable directories, or with a capability this build does not know, is still described", () => {
  // Pre-directory layout: the run's own capability's outputs at the root.
  const legacy = describeRunArtifacts({
    effectiveAgentId: "clinical-evidence-synthesis",
    artifacts: ["clinical-evidence-report.md", "clinical-evidence-matrix.json"],
    unverifiedArtifacts: ["notes.md", ".evimed-run/state.json"],
  }, declaredOutputsOf);
  assert.deepEqual(legacy?.artifactKinds, {
    "clinical-evidence-report.md": "deliverable",
    "clinical-evidence-matrix.json": "deliverable",
    "notes.md": "work",
    ".evimed-run/state.json": "work",
  });
  // No plan: no directory can be called abandoned.
  const unplanned = describeRunArtifacts({ effectiveAgentId: "clinical-evidence-synthesis", artifacts: ["deliverables/review/clinical-evidence-report.md"] }, declaredOutputsOf);
  assert.equal(unplanned?.artifactKinds["deliverables/review/clinical-evidence-report.md"], "deliverable");
  // A capability the registry cannot name: a file in a live directory is shown, scratch stays scratch.
  const unknown = describeRunArtifacts({
    deliverables: [{ id: "x", title: "x", capability: "from-the-future", status: "delivered", attempts: 1 }],
    artifacts: ["deliverables/x/result.csv", "deliverables/x/work/tmp.py", "deliverables/x/.cache/a"],
  }, declaredOutputsOf);
  assert.deepEqual(unknown?.artifactKinds, { "deliverables/x/result.csv": "deliverable", "deliverables/x/work/tmp.py": "work", "deliverables/x/.cache/a": "work" });
  // The answer line declares no files, and that no longer makes what it wrote scratch: an ordinary conversation's file is
  // what it was asked for (`outputFiles`), unless it sits where scratch goes (the next test).
  const answer = describeRunArtifacts({ effectiveAgentId: "open-domain-answer", artifacts: ["summary.md"] }, () => []);
  assert.deepEqual(answer?.artifactCounts, { deliverable: 1, revisionNotes: 0, work: 0, superseded: 0 });
  assert.deepEqual(answer?.outputFiles, ["summary.md"]);
  assert.equal(describeRunArtifacts({ artifacts: [], unverifiedArtifacts: [] }, declaredOutputsOf), null);
});

test("the ledger's runs carry their artifact kinds, old runs included, and the artifact list keeps its shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-artifacts-"));
  try {
    const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const registry = { get: (/** @type {string} */ id) => (id === "clinical-evidence-synthesis" ? { outputs: clinicalOutputs.map((file) => ({ path: file, required: true })) } : null) };
    const states = [];
    const store = new AgentRunStore({ get: async () => null }, { model: "deepseek/deepseek-flash", agentRegistry: registry, onRunStateChanged: (_project, run) => states.push(run) });
    store.scheduleMonitor = () => {};
    // A run written by an older build: nothing about kinds in the ledger.
    const run = aspirinRun();
    const at = "2026-09-18T01:00:00.000Z";
    await appendFile(path.join(project.metaDir, "runs.jsonl"), [
      { event: "started", id: run.id, dispatchId: null, dispatchStatus: "accepted", kernelRequestIds: [], sessionId: "ses_aspirin", mode: "open-domain",
        agentId: null, agentVersion: null, runtimeAgent: null, effectiveAgentId: run.effectiveAgentId, effectiveAgentVersion: "2.13.0",
        effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis", effectiveRouteReason: "llm:0.9", model: "deepseek/deepseek-flash",
        question: "阿司匹林一级预防", createdAt: at, startedAt: at, baselineCursor: null },
      { event: "finished", id: run.id, status: "succeeded", errorCode: null, artifacts: run.artifacts, unverifiedArtifacts: run.unverifiedArtifacts,
        verification: "unverified", qualityNotices: [], finishedAt: "2026-09-18T01:40:00.000Z", durationMs: 2_400_000, deliverables: run.deliverables },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    const [listed] = await store.withPlanProgress(project, await store.list(project));
    assert.deepEqual(listed.artifacts, run.artifacts, "`artifacts` is still the list of paths older readers expect");
    assert.deepEqual(listed.artifactCounts, { deliverable: 2, revisionNotes: 1, work: 21, superseded: 13 });
    assert.equal(listed.artifactKinds["work/step-3.py"], "work");
    // A pushed state describes its files the same way.
    store.notifyState(project, (await store.list(project))[0]);
    assert.deepEqual(states.at(-1)?.artifactCounts, listed.artifactCounts);
    await store.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ordinary conversation's files are its outputs unless they sit where scratch goes", () => {
  const run = {
    id: "run_ordinary", status: "succeeded", effectiveAgentId: "open-domain-answer",
    artifacts: ["道歉邮件.docx", "rename.py", "output/sales-summary.xlsx", "chart.png", "tmp/a.py", "work/b.md", "__pycache__/c.pyc", "node_modules/x/y.js", "data/in.csv", "knowledge-base/doc.md", "task-plan.json", "delivery-receipt.json", ".evimed-run/state.json", "deliverables/deck/商业计划.pptx", "deliverables/deck/work/tmp.py"],
  };
  const described = describeRunArtifacts(run, () => []);
  const kinds = described?.artifactKinds ?? {};
  for (const path of ["道歉邮件.docx", "rename.py", "output/sales-summary.xlsx", "chart.png", "deliverables/deck/商业计划.pptx"]) assert.equal(kinds[path], "deliverable", path);
  for (const path of ["tmp/a.py", "work/b.md", "__pycache__/c.pyc", "node_modules/x/y.js", "data/in.csv", "knowledge-base/doc.md", "task-plan.json", "delivery-receipt.json", ".evimed-run/state.json", "deliverables/deck/work/tmp.py"]) assert.equal(kinds[path], "work", path);
  assert.equal(described?.outputFiles?.length, 5);
  assert.deepEqual(described?.artifactCounts, { deliverable: 5, revisionNotes: 0, work: 10, superseded: 0 });
  // The reading order puts what a person opens first: documents, then data, then pictures — and the script that may have built
  // them last, because the helper that wrote a workbook is not what the person opens first.
  assert.deepEqual(described?.outputFiles, ["deliverables/deck/商业计划.pptx", "道歉邮件.docx", "output/sales-summary.xlsx", "chart.png", "rename.py"]);
  assert.equal(described?.outputFiles?.at(-1), "rename.py");
  // The roles: a script the person asked for is a draft they open; nothing else changes.
  const roles = describeRunArtifactRoles(run, () => undefined, described?.outputFiles);
  assert.equal(roles["rename.py"], "draft");
  assert.equal(roles["output/sales-summary.xlsx"], "data");
  assert.equal(roles["tmp/a.py"], "work", "a script that is not an output stays work");
  assert.equal(roles["work/b.md"], "document", "a path that is not an output keeps the role its name gave it");
  assert.equal(ordinaryRole("revision-notes.md"), "work");
  assert.equal(ordinaryRole("setup.exe"), "work");
});

test("a conversation with a capability behind it is judged by that capability, and a plan of ordinary files is the same conversation", () => {
  const outputs = (id) => (id === "clinical-evidence-synthesis" ? ["clinical-evidence-report.md"] : null);
  const clinical = describeRunArtifacts({ effectiveAgentId: "clinical-evidence-synthesis", artifacts: ["notes.md", "rename.py"] }, outputs);
  assert.equal(clinical?.outputFiles, undefined);
  assert.deepEqual(clinical?.artifactCounts, { deliverable: 0, revisionNotes: 0, work: 2, superseded: 0 });
  // An answer-line turn whose plan names a capability is not ordinary: its files are the plan's.
  assert.equal(isOrdinaryConversation({ effectiveAgentId: "open-domain-answer" }, new Set(), [{ id: "r", capability: "clinical-evidence-synthesis", contractKind: "clinical-evidence-report" }]), false);
  // One of ordinary files only is.
  const planned = describeRunArtifacts({
    effectiveAgentId: "open-domain-answer",
    deliverables: [{ id: "rename-script", capability: "", contractKind: "file-deliverable" }],
    artifacts: ["deliverables/rename-script/rename.py", "deliverables/old-plan/x.py"],
  }, () => []);
  assert.equal(planned?.artifactKinds["deliverables/rename-script/rename.py"], "deliverable");
  assert.equal(planned?.artifactKinds["deliverables/old-plan/x.py"], "superseded", "what a plan revision abandoned is still abandoned");
  assert.deepEqual(planned?.outputFiles, ["deliverables/rename-script/rename.py"]);
  // No capability at all (a turn typed into the page that nothing routed) is an ordinary conversation.
  assert.equal(isOrdinaryConversation({}, null, []), true);
  // A capability this build does not know is left as it was recorded.
  assert.equal(isOrdinaryConversation({ effectiveAgentId: "from-the-future" }, null, []), false);
});

test("the list of a script's hundred pictures is bounded, and the closed lists agree with the code that owns them", () => {
  const artifacts = Array.from({ length: 60 }, (_, index) => `plots/p-${String(index).padStart(2, "0")}.png`);
  assert.equal(describeRunArtifacts({ effectiveAgentId: "open-domain-answer", artifacts }, () => [])?.outputFiles?.length, ORDINARY_OUTPUT_LIMIT);
  // `researchContext.mjs` owns the constant and sits in an import cycle with this module, which is why it is spelled out here.
  assert.ok(PLATFORM_ROOT_DIRECTORIES.has(KNOWLEDGE_BASE_DIR));
  assert.ok(PLATFORM_ROOT_DIRECTORIES.has("data"));
  assert.ok(SCRATCH_DIRECTORIES.has("node_modules") && SCRATCH_DIRECTORIES.has("__pycache__"));
  assert.equal(ordinaryOutputPath("a/../../etc/passwd"), false);
  assert.equal(ordinaryOutputPath(""), false);
});
