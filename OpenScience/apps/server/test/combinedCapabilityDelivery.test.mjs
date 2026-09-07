/**
 * The combined delivery, from the control plane's side.
 *
 * Hidden knowledge: what the server has to get right about a run whose plan
 * spans two capabilities, and why none of it is covered by the single-item
 * fixtures the rest of `agentRuns.test.mjs` and `nativeTurns.test.mjs` use.
 *
 * A one-item plan makes four different bugs invisible, because with one item
 * "this item" and "the run" are the same thing:
 *
 * - **The workflow proof.** `nativeWorkflowEvidence` folds every plan, delegate
 *   and submission in the owned turn into one record. With one of each, a fold
 *   that kept only the last would look identical to one that kept them all.
 * - **The projection scope.** `scopeNativeProjection` admits a run-written plan
 *   index only when every definition the turn witnessed is present with the
 *   same contract kind *and the same capability*. The capability half of that
 *   comparison cannot fail when there is only one capability.
 * - **The repair snapshot.** Before the control plane asks a run to repair, it
 *   preserves the accepted bytes and mints a revision authorization. With one
 *   deliverable, "preserve the accepted package" and "unfreeze the package
 *   being repaired" are the same package; with two they must not be, or a
 *   repair of one capability's report reopens another capability's finished
 *   delivery for editing. Partly covered already, and the test below says
 *   exactly which part: `agentRuns.test.mjs`'s "server repair preserves
 *   accepted bytes outside the runtime workspace" drives a two-capability,
 *   two-contract-kind receipt through the same helper and already gates
 *   "only the clinical entry is authorized" plus the consume lifecycle.
 * - **The delivery decision.** Artifacts and receipt notices are collected per
 *   entry. One entry cannot show whether the second is dropped.
 *
 * Everything here runs offline: no Postgres, no Docker, no kernel, no model.
 * The transcript is the captured DSH native-turn fixture with the workflow tool
 * frames this scenario adds, which is the same construction `nativeTurns.test.mjs`
 * uses for its single-capability workflows.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentRunStore,
  consumeRepairAuthorizationForTest,
  scopeNativeProjectionForTest,
  snapshotAcceptedPackageForRepairForTest,
} from "../src/agentRuns.mjs";
import { normalizeTranscript, transcriptToLedgerMessages } from "../src/dshRuntimeAdapter.mjs";
// The runtime's own projector, not a description of it. `evidence-store.mjs`
// calls this to turn the run mirror, the plan index and the subagents medium
// into `.evimed-run/runs/<id>/state.json`, which is the only thing about that
// state the control plane ever opens. A hand-written projection here would let
// the two sides of the seam drift: the socket could stop projecting a field and
// this file would keep proving the scope handles a field nobody sends. Same
// relative-import shape as `citationGateway.test.mjs` and `capsuleMethods.test.mjs`.
import { projectRunState } from "../../../packages/socket/src/runMirror.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/dsh/native-turn-frames.json", import.meta.url), "utf8"));
const secondInput = fixture.events.filter((event) => event.type === "user/message" && event.data.source.kind === "user")[1];

/* ------------------------------------------------ the two capabilities */

// Both are real capability packages, and deliberately not two of a kind: one
// is the clinical synthesis the server-side gate and the repair loop are built
// around, the other is a general capability with its own contract, its own
// required outputs and no repair path of its own. That difference is what the
// scoping assertions below are about.
const EVIDENCE = Object.freeze({
  id: "d-evidence",
  contractKind: "clinical-evidence-report",
  capability: "clinical-evidence-synthesis",
  title: "临床证据综述",
  dependsOn: [],
});
const BIBLIOMETRIC = Object.freeze({
  id: "d-bibliometric",
  contractKind: "bibliometric-analysis-report",
  capability: "bibliometric-analysis",
  title: "文献计量报告",
  dependsOn: [],
});

const EVIDENCE_FILE = "deliverables/d-evidence/clinical-evidence-report.md";
const BIBLIOMETRIC_FILE = "deliverables/d-bibliometric/bibliometric-analysis-report.md";
const EVIDENCE_TEXT = "# 临床证据综述\n\n结论段落。\n";
const BIBLIOMETRIC_TEXT = "# 文献计量报告\n\n发文趋势段落。\n";

const digest = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The turn-2 workflow frames: one plan naming two capabilities, one delegation
 * each, one submission each, and a completion.
 * @param {{ bibliometricAccepted?: boolean, completed?: boolean }} [options]
 */
function combinedWorkflowEvents({ bibliometricAccepted = true, completed = true } = {}) {
  const events = structuredClone(fixture.events.filter((event) => event.seq >= 137));
  const start = secondInput.time;
  const pairs = [];
  const add = (seq, name, args, result, at) => {
    const callId = `call_${seq}`;
    pairs.push({ type: "tool/call", seq, time: at, data: { turn: 2, step: 1, callId, name, arguments: args } });
    pairs.push({
      type: "tool/result",
      seq: seq + 1,
      time: at + 5,
      data: { turn: 2, step: 1, message: { source: { callId }, content: [{ type: "tool-result", content: [{ type: "text", text: JSON.stringify(result) }] }] } },
    });
  };
  const items = [EVIDENCE, BIBLIOMETRIC];
  add(145, "evimed_plan", { action: "write", clarifications: ["一次请求，两件交付物，分属两项能力。"], deliverables: items },
    { ok: true, data: { runId: "combined_kernel_owner", revision: 2, deliverables: items.map((item) => ({ ...item, status: "planned", attempts: 0 })) } }, start + 10);
  add(150, "evimed_delegate", { deliverableId: EVIDENCE.id },
    { ok: true, data: { deliverableId: EVIDENCE.id, childSessionId: "child-evidence", status: "delegated" } }, start + 20);
  add(152, "evimed_delegate", { deliverableId: BIBLIOMETRIC.id },
    { ok: true, data: { deliverableId: BIBLIOMETRIC.id, childSessionId: "child-bibliometric", status: "delegated" } }, start + 22);
  add(154, "evimed_submit_deliverable", { deliverableId: EVIDENCE.id },
    { ok: true, data: { deliverableId: EVIDENCE.id, contractKind: EVIDENCE.contractKind, notices: ["证据综述接受时的提示"] } }, start + 30);
  add(156, "evimed_submit_deliverable", { deliverableId: BIBLIOMETRIC.id }, bibliometricAccepted
    ? { ok: true, data: { deliverableId: BIBLIOMETRIC.id, contractKind: BIBLIOMETRIC.contractKind, notices: ["文献计量接受时的提示"] } }
    : { ok: false, code: "deliverable_rejected", issues: [{ code: "required_output_missing", severity: "required", message: "文献计量报告缺少必需文件" }] }, start + 40);
  add(158, "evimed_complete_run", { partial: !bibliometricAccepted },
    { ok: true, data: { partial: !bibliometricAccepted, issues: [] } }, start + 50);
  const all = [...events, ...pairs].sort((left, right) => left.seq - right.seq);
  return {
    events: completed ? all : all.filter((event) => event.type !== "turn/end"),
    acceptedAt: { evidence: start + 35, bibliometric: start + 45 },
  };
}

/** The receipt the run-side gate leaves behind for whichever items it accepted. */
function combinedReceipt({ bibliometricAccepted = true, acceptedAt }) {
  const entry = (item, file, text, at, notice) => ({
    deliverableId: item.id,
    contractKind: item.contractKind,
    capability: item.capability,
    files: [{ path: file, sha256: digest(text), bytes: Buffer.byteLength(text) }],
    acceptedAt: new Date(at).toISOString(),
    attempt: 1,
    notices: [notice],
  });
  return {
    formatVersion: 1,
    runId: "combined_kernel_owner",
    bundleVersion: "0.1.0",
    domainVersion: "0.1.0",
    entries: [
      entry(EVIDENCE, EVIDENCE_FILE, EVIDENCE_TEXT, acceptedAt.evidence, "证据综述接受时的提示"),
      ...(bibliometricAccepted ? [entry(BIBLIOMETRIC, BIBLIOMETRIC_FILE, BIBLIOMETRIC_TEXT, acceptedAt.bibliometric, "文献计量接受时的提示")] : []),
    ],
  };
}

/**
 * The run-state file the control plane reads, built by the runtime's own
 * projector from the tables a real run would have written.
 *
 * The inputs are what the socket's run-policy plugin puts in those tables — one
 * plan-index row and one `subagents` row per delegated child, each stamped with
 * its run — and the output is exactly the bytes the container leaves in the
 * workspace. `packages/socket/test/combinedPlan.test.mjs` asserts the producer
 * side of this same file for two children of two capabilities; this is the
 * consumer side, and both now speak about the artifact rather than about a
 * shape each assumed independently.
 */
function combinedProjection({ bibliometricAccepted = true, sessionId }) {
  const child = (item, childSessionId) => ({
    runId: "combined_kernel_owner",
    deliverableId: item.id,
    capability: item.capability,
    childSessionId,
    status: "completed",
    skills: [item.capability],
  });
  return projectRunState({
    run: { runId: "combined_kernel_owner", sessionId, cwd: "/workspace", startedAt: new Date(secondInput.time).toISOString(), children: 2 },
    planIndex: {
      runId: "combined_kernel_owner",
      revision: 2,
      items: [
        { ...EVIDENCE, status: "accepted", attempts: 1, childSessionId: "child-evidence", lastIssues: [] },
        {
          ...BIBLIOMETRIC,
          status: bibliometricAccepted ? "accepted" : "rejected",
          attempts: 1,
          childSessionId: "child-bibliometric",
          lastIssues: bibliometricAccepted ? [] : [{ code: "required_output_missing", severity: "required", message: "文献计量报告缺少必需文件" }],
        },
      ],
    },
    evidence: [],
    gateRuns: [],
    subagents: [child(EVIDENCE, "child-evidence"), child(BIBLIOMETRIC, "child-bibliometric")],
    qualityNotices: [],
    degraded: [],
    now: new Date(secondInput.time + 60).toISOString(),
  });
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ bibliometricAccepted?: boolean, completed?: boolean }} [options]
 */
async function setupCombined(t, { bibliometricAccepted = true, completed = true } = {}) {
  const workflow = combinedWorkflowEvents({ bibliometricAccepted, completed });
  const root = await mkdtemp(path.join(tmpdir(), "combined-capability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p1", userId: "u1", rootDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace") };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  const bindings = new Map();
  let events = workflow.events;
  /** @type {{ type: string, data: any }[]} */
  const frames = [];
  const makeStore = () => {
    const store = new AgentRunStore({ get: async (_project, id) => bindings.get(id) ?? null }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => transcriptToLedgerMessages(normalizeTranscript(fixture.sessionId, events)),
      readSessionStatus: async () => (events.at(-1)?.type === "turn/end" ? "idle" : "busy"),
      onRunProjection: (_project, _run, type, data) => frames.push({ type, data }),
    });
    // Reconciliation is driven explicitly so the assertions have one writer.
    store.scheduleMonitor = () => {};
    store.agentRegistry = Promise.resolve(new Map([
      ["clinical-evidence-synthesis", {
        id: "clinical-evidence-synthesis", version: "1.0.0", runtimeAgent: "evimed-clinical-evidence-synthesis",
        completionChecks: ["requiredOutputsExist"], outputs: [{ path: EVIDENCE_FILE, required: true }],
      }],
      ["bibliometric-analysis", {
        id: "bibliometric-analysis", version: "1.0.1", runtimeAgent: "evimed-bibliometric-analysis",
        completionChecks: ["requiredOutputsExist"], outputs: [{ path: BIBLIOMETRIC_FILE, required: true }],
      }],
    ]));
    return store;
  };
  let store = makeStore();

  // Both capabilities' files, timestamped inside the owned turn so the
  // artifact scan attributes them to it.
  const written = new Map([[EVIDENCE_FILE, EVIDENCE_TEXT], [BIBLIOMETRIC_FILE, BIBLIOMETRIC_TEXT]]);
  for (const [relative, text] of written) {
    await mkdir(path.join(project.workspaceDir, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relative), text);
    const at = new Date(secondInput.time + 50);
    await utimes(path.join(project.workspaceDir, relative), at, at);
  }
  const receipt = combinedReceipt({ bibliometricAccepted, acceptedAt: workflow.acceptedAt });
  await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify(receipt));
  await mkdir(path.join(project.workspaceDir, ".evimed-run"), { recursive: true });
  const projection = combinedProjection({ bibliometricAccepted, sessionId: fixture.sessionId });
  await writeFile(path.join(project.workspaceDir, ".evimed-run", "state.json"), JSON.stringify(projection));

  return {
    project,
    projection,
    receipt,
    frames,
    get store() { return store; },
    restart() { store = makeStore(); },
    setEvents(value) { events = value; },
    async adopt() {
      return store.adoptRuntimeSession(project, fixture.sessionId, {
        transcript: normalizeTranscript(fixture.sessionId, events),
        routeTurn: async () => ({
          effectiveAgentId: "clinical-evidence-synthesis",
          effectiveAgentVersion: "1.0.0",
          effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
        }),
      });
    },
    runs: () => store.list(project),
  };
}

/* --------------------------------------------------------------- the tests */

test("the run ledger records both capabilities' children distinctly, not one collapsed workflow", async (t) => {
  const f = await setupCombined(t, { completed: false });
  await f.adopt();
  // Read back from the ledger rather than from the return value: what is under
  // test is what survives being written down and folded again.
  f.restart();
  const run = (await f.runs()).find((item) => item.nativeWorkflow);
  assert.ok(run, "the combined turn must leave a workflow proof on the ledger");
  const proof = run.nativeWorkflow;

  assert.deepEqual(proof.plan.items.map((item) => [item.id, item.contractKind, item.capability]), [
    [EVIDENCE.id, EVIDENCE.contractKind, EVIDENCE.capability],
    [BIBLIOMETRIC.id, BIBLIOMETRIC.contractKind, BIBLIOMETRIC.capability],
  ], "a plan naming two capabilities must be recorded as two items, each with its own capability");
  assert.deepEqual([...proof.delegates].sort(), [BIBLIOMETRIC.id, EVIDENCE.id], "both delegations must be recorded");
  assert.deepEqual(proof.submissions.map((item) => item.id).sort(), [BIBLIOMETRIC.id, EVIDENCE.id]);
  const byId = new Map(proof.submissions.map((item) => [item.id, item]));
  assert.equal(byId.get(EVIDENCE.id).accepted.contractKind, EVIDENCE.contractKind);
  assert.equal(byId.get(BIBLIOMETRIC.id).accepted.contractKind, BIBLIOMETRIC.contractKind);
  assert.notEqual(
    byId.get(EVIDENCE.id).accepted.contractKind,
    byId.get(BIBLIOMETRIC.id).accepted.contractKind,
    "two acceptances recorded under one contract kind is one delivery pretending to be two",
  );
  // Each acceptance is witnessed in its own tool call, so a later gate cannot
  // attribute one item's acceptance interval to the other.
  assert.notEqual(byId.get(EVIDENCE.id).accepted.callId, byId.get(BIBLIOMETRIC.id).accepted.callId);
});

test("the projection scope keeps each capability's child and refuses one the plan never named", async (t) => {
  const f = await setupCombined(t, { completed: false });
  await f.adopt();
  f.restart();
  const run = (await f.runs()).find((item) => item.nativeWorkflow);
  assert.ok(run);

  // What the runtime's projector actually hands over, before this side scopes
  // it. Asserted here and not only in the socket suite because the consequence
  // is the control plane's: the filter below joins a child to a plan item by
  // id *and* capability, so a projection that carried the children without
  // their capability would be scoped down to no children at all — a combined
  // run displaying nothing, with no error anywhere.
  assert.deepEqual(
    f.projection.subagents.map((child) => [child.deliverableId, child.capability, child.childSessionId]),
    [[EVIDENCE.id, EVIDENCE.capability, "child-evidence"], [BIBLIOMETRIC.id, BIBLIOMETRIC.capability, "child-bibliometric"]],
    "the runtime projector must publish both children with the two fields the scope below joins on",
  );

  const scoped = scopeNativeProjectionForTest(f.projection, run);
  assert.ok(scoped, "a projection matching the witnessed plan must be admitted");
  assert.deepEqual(scoped.plan.items.map((item) => [item.id, item.capability, item.status]), [
    [EVIDENCE.id, EVIDENCE.capability, "accepted"],
    [BIBLIOMETRIC.id, BIBLIOMETRIC.capability, "accepted"],
  ]);
  assert.deepEqual(scoped.subagents.map((child) => [child.deliverableId, child.capability, child.childSessionId]), [
    [EVIDENCE.id, EVIDENCE.capability, "child-evidence"],
    [BIBLIOMETRIC.id, BIBLIOMETRIC.capability, "child-bibliometric"],
  ], "each capability's child must survive the scope under its own identity");

  // A child row claiming a capability the plan did not give that deliverable is
  // dropped. With one capability in the plan this filter has nothing to reject.
  const forged = {
    ...f.projection,
    subagents: [...f.projection.subagents, { deliverableId: BIBLIOMETRIC.id, capability: "off-label-analysis", childSessionId: "child-forged", status: "completed" }],
  };
  const scopedForged = scopeNativeProjectionForTest(forged, run);
  assert.deepEqual(
    scopedForged.subagents.map((child) => child.childSessionId),
    ["child-evidence", "child-bibliometric"],
    "a child naming a capability the plan never bound to that deliverable must not be admitted",
  );

  // And a plan index whose second item claims the other capability's contract
  // is not this run's plan at all.
  const swapped = {
    ...f.projection,
    plan: { ...f.projection.plan, items: [f.projection.plan.items[0], { ...f.projection.plan.items[1], capability: EVIDENCE.capability }] },
  };
  assert.equal(scopeNativeProjectionForTest(swapped, run), null, "a plan index that renames one item's capability must be refused");
});

test("a combined delivery ships both capabilities' packages, with both capabilities' acceptance notices", async (t) => {
  const f = await setupCombined(t, { completed: false });
  await f.adopt();
  f.restart();
  const run = (await f.runs()).find((item) => item.nativeWorkflow);
  assert.ok(run);

  const finished = await f.store.finishFromDurableRecord(f.project, run);

  assert.equal(finished.status, "succeeded");
  assert.equal(finished.errorCode, null);
  assert.deepEqual(finished.artifacts, [BIBLIOMETRIC_FILE, EVIDENCE_FILE].sort(),
    "a combined delivery that ships one capability's files is half a delivery");
  assert.deepEqual(finished.qualityNotices.sort(), ["文献计量接受时的提示", "证据综述接受时的提示"].sort(),
    "each capability's acceptance notices must reach the reader");
});

test("a receipt entry naming a capability the plan never gave that deliverable is not shipped", async (t) => {
  // The receipt-side twin of the projection scope above, on the artifact that
  // outlives the container: once the runtime is gone the receipt is what the
  // control plane trusts to say what was graded, and `scopeNativeReceipt`
  // admits an entry only if the plan item of that id names the same capability.
  // Nothing exercised that clause before this test. Measured by deleting it and
  // running every other suite that builds a delivery receipt — `agentRuns`,
  // `nativeTurns`, `sourceUnderstandingRuntime`,
  // `sourceUnderstandingRuntime.integration`, 186 tests, the four that
  // `grep -l delivery-receipt test/*.test.mjs` returns beside this file
  // (`deepseekReceiptSecurity` builds a DeepSeek *release* receipt and is not
  // one of them) — all still green, and a forged entry's files ship as
  // delivered. What a
  // two-capability plan adds is a forgery worth refusing: the capability the
  // entry claims is one this very plan named, so every other field corroborates
  // it and the capability comparison is the only thing that can say no.
  //
  // Forged by rewriting one entry's capability and nothing else: the id, the
  // contract kind, the digests and the acceptance timestamp are exactly what
  // the run wrote, so the capability comparison is the only thing that can
  // refuse it.
  const f = await setupCombined(t, { completed: false });
  await f.adopt();
  f.restart();
  const run = (await f.runs()).find((item) => item.nativeWorkflow);
  assert.ok(run);

  const forged = structuredClone(f.receipt);
  forged.entries.find((entry) => entry.deliverableId === BIBLIOMETRIC.id).capability = EVIDENCE.capability;
  await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify(forged));

  const finished = await f.store.finishFromDurableRecord(f.project, run);

  assert.deepEqual(finished.artifacts, [EVIDENCE_FILE],
    "an entry whose capability the plan never bound to that deliverable must not have its files claimed as delivered");
  // Nor may its notices be read as an acceptance that happened: the honest
  // entry still ships, so this is scoping the receipt, not discarding it.
  assert.deepEqual(finished.qualityNotices, ["证据综述接受时的提示"]);
  assert.equal(finished.status, "succeeded");
});

test("preparing a repair preserves both capabilities' accepted bytes and unfreezes only the failing contract", async (t) => {
  // The failing item is the clinical one — the only contract the server-side
  // repair loop knows how to send back — while the other capability's package
  // is already accepted and finished. What must not happen is the repair
  // reopening it: an authorization is a licence to overwrite accepted bytes,
  // and a licence minted for the wrong deliverable is how a finished delivery
  // is regenerated by a repair that was never about it.
  //
  // Not all of that is new. `agentRuns.test.mjs`'s "server repair preserves
  // accepted bytes outside the runtime workspace" already builds a receipt
  // with two capabilities and two contract kinds and asserts
  // `authorizations.length === 1` for the clinical entry, the single-use
  // consume, the generation and canceled-run refusals, and the cross-process
  // claim. Those assertions are repeated here rather than dropped because they
  // are reached differently — that test passes `nativeTurn: null`, so its
  // receipt is read whole, while this run carries a workflow proof and its
  // receipt goes through `scopeNativeReceipt` first — but the property itself
  // is not this test's discovery, and this comment is the cross-reference.
  //
  // What is new here: the other capability's bytes are asserted *preserved*
  // (the pre-existing test writes an unrelated accepted file and never checks
  // that the snapshot kept it), the mint site is read from the directory
  // instead of from the return value, and an otherwise valid grant is refused
  // when it names the other capability's deliverable.
  const f = await setupCombined(t, { completed: false });
  await f.adopt();
  f.restart();
  const run = (await f.runs()).find((item) => item.nativeWorkflow);
  assert.ok(run);

  const revision = await snapshotAcceptedPackageForRepairForTest(f.project, run, "generation-1");

  assert.equal(revision.revisionRequired, true);
  assert.deepEqual(revision.authorizations.map((entry) => entry.deliverableId), [EVIDENCE.id],
    "only the contract the repair loop is about may be unfrozen");
  // The other capability's accepted bytes are still preserved — preserving and
  // unfreezing are different acts, and the snapshot has to do the first for
  // every accepted deliverable while doing the second for none of them.
  const snapshot = JSON.parse(await readFile(revision.snapshotPath, "utf8"));
  assert.deepEqual(snapshot.files.map((file) => file.path).sort(), [BIBLIOMETRIC_FILE, EVIDENCE_FILE].sort(),
    "a repair must preserve every accepted package, not only the one being repaired");
  assert.equal(snapshot.files.find((file) => file.path === BIBLIOMETRIC_FILE).text, BIBLIOMETRIC_TEXT);

  // Not "the other capability's grant was not returned" — no grant for it
  // exists on disk at all, so there is no digest under which it could be
  // claimed. Read from the directory rather than from the return value,
  // because the return value is this function's own account of itself.
  const minted = await readdir(path.join(f.project.metaDir, "repair-authorizations"));
  assert.deepEqual(minted.filter((name) => name.endsWith(".json")).length, 1,
    `exactly one authorization may exist: ${JSON.stringify(minted)}`);
  const authorization = JSON.parse(await readFile(path.join(f.project.metaDir, "repair-authorizations", minted[0]), "utf8"));
  assert.equal(authorization.deliverableId, EVIDENCE.id);
  assert.equal(authorization.runId, f.receipt.runId);

  // The run may consume the failing item's authorization exactly once, and the
  // accepted item's identity buys nothing.
  const lifecycle = {
    runtimeGeneration: "generation-1",
    controlRunRepairing: async () => true,
    revalidateRuntimeGeneration: async () => "generation-1",
  };
  const grant = revision.authorizations[0];
  assert.equal((await consumeRepairAuthorizationForTest(f.project, { ...grant, deliverableId: BIBLIOMETRIC.id }, lifecycle)).authorized, false,
    "the other capability's finished delivery must not be reopenable by this repair");
  assert.equal((await consumeRepairAuthorizationForTest(f.project, grant, lifecycle)).authorized, true,
    "the repaired contract must have exactly one authorization to consume");
  assert.equal((await consumeRepairAuthorizationForTest(f.project, grant, lifecycle)).authorized, false,
    "an authorization is consumed once");
});

test("a combined run whose second capability was never accepted still delivers the first, and the reader is told which item is unfinished", async (t) => {
  const f = await setupCombined(t, { bibliometricAccepted: false, completed: false });
  await f.adopt();
  f.restart();
  const run = (await f.runs()).find((item) => item.nativeWorkflow);
  assert.ok(run);

  // The rejected submission is on the ledger under its own item, with the
  // gate's own words — the accepted one is untouched by it.
  const submissions = new Map(run.nativeWorkflow.submissions.map((item) => [item.id, item]));
  assert.equal(submissions.get(EVIDENCE.id).accepted.contractKind, EVIDENCE.contractKind);
  assert.equal(submissions.get(EVIDENCE.id).rejected, null);
  assert.equal(submissions.get(BIBLIOMETRIC.id).accepted, null);
  assert.deepEqual(submissions.get(BIBLIOMETRIC.id).rejected.notices, ["文献计量报告缺少必需文件"]);

  const finished = await f.store.finishFromDurableRecord(f.project, run);

  // The accepted package ships. Discarding a finished capability's work
  // because a second capability failed would help nobody.
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.artifacts, [EVIDENCE_FILE],
    "only the accepted capability's files are in the receipt, so only those may be claimed as delivered");
  assert.equal(finished.artifacts.includes(BIBLIOMETRIC_FILE), false,
    "an unaccepted deliverable's file must never be reported as delivered");

  // The reader is told which item is unfinished through the deliverables
  // channel — one frame per plan item, the unfinished one carrying the gate's
  // own issues. That channel is the designated place for a per-deliverable
  // verdict, and it is the only place a combined run's partial delivery is
  // currently visible: `finished.qualityNotices` carries the accepted entry's
  // notices and nothing about the rejected sibling. The defect that asymmetry
  // is, and the assertion that will hold once it is fixed, is the `test.todo`
  // directly below — not asserted here, so a fix does not have to edit this
  // test, and not left in prose either, so CI shows it.
  const published = f.frames.filter((frame) => frame.type === "deliverable/update");
  assert.deepEqual(published.map((frame) => [frame.data.id, frame.data.capability, frame.data.status]), [
    [EVIDENCE.id, EVIDENCE.capability, "accepted"],
    [BIBLIOMETRIC.id, BIBLIOMETRIC.capability, "submitted"],
  ], "each capability's item must be published under its own identity and its own verdict");
  assert.deepEqual(published[1].data.issues, [
    { code: "required_output_missing", message: "文献计量报告缺少必需文件", severity: "required" },
  ], "the unfinished item must carry the gate's own words, which is what a repair would act on");
  assert.ok(published[0].data.receipt, "the accepted item carries its receipt entry");
  assert.equal(published[1].data.receipt, undefined, "an unaccepted item must not appear to carry a receipt");
});

/*
 * KNOWN DEFECT MARKER — not a regression, not a broken test, and not a gate.
 *
 * What a reader sees when the suite runs: this case is listed as
 * `⚠ ... # TODO`, the summary counts it under `todo 1` and never under `fail`,
 * and node's `✖ failing tests:` epilogue reprints it — still tagged `# TODO` —
 * with the assertion text below. The suite's exit code is 0 with it present
 * (measured: `node --test test/combinedCapabilityDelivery.test.mjs` exits 0,
 * `pass 7 / fail 0 / todo 1`), so it cannot turn CI red for anyone. Node's
 * epilogue header is the confusing part — it says "failing" for a case the
 * summary already counted as todo — which is why the assertion message below
 * opens by naming itself.
 *
 * The defect, in `apps/server/src/agentRuns.mjs` — the file that must change:
 * in `finishFromDurableRecord` the "交付物「X」提交了 N 次，每次都被契约校验拒绝"
 * notice is written only on the `!receipt` branch, while the receipt-bearing
 * branch builds `qualityNotices` from `receipt.entries`, and a rejected
 * deliverable has no entry. The live path's equivalent needs
 * `accepted.length === 0`, which a partial combined delivery is not. So a run
 * that delivered one of two planned capabilities lands as succeeded, one
 * artifact, errorCode null, and nothing on the run row says a planned
 * deliverable was dropped. A single-capability run cannot reach this state:
 * with its one item rejected there is no receipt, and the notice is written.
 *
 * Why it is not fixed here: the repair is a notice added on the receipt-bearing
 * branch of `agentRuns.mjs`, which is production code outside this change's
 * ownership. It is additive — a notice, never a refusal — so it costs no
 * blocking budget when someone takes it.
 *
 * When they do, this goes green: delete `.todo` and the case is the regression
 * guard for it. Left executable rather than written down in prose precisely so
 * that "someone fixed it and nobody noticed" is visible in the suite output.
 */
test.todo("KNOWN DEFECT (agentRuns.mjs): a partial combined delivery's run row never names the deliverable it dropped", async (t) => {
  const f = await setupCombined(t, { bibliometricAccepted: false, completed: false });
  await f.adopt();
  f.restart();
  const run = (await f.runs()).find((item) => item.nativeWorkflow);
  assert.ok(run);

  const finished = await f.store.finishFromDurableRecord(f.project, run);

  assert.equal(finished.status, "succeeded");
  assert.ok(
    finished.qualityNotices.some((notice) => notice.includes(BIBLIOMETRIC.id) || notice.includes(BIBLIOMETRIC.title)),
    "KNOWN DEFECT, expected to fail — this is a todo, the suite is green and its exit code is 0. "
    + "apps/server/src/agentRuns.mjs builds a succeeded run's qualityNotices from receipt.entries only, so a "
    + `dropped deliverable leaves no trace on the run row: ${JSON.stringify(finished.qualityNotices)}`,
  );
});

test("the live gate repairs the failing capability's item and leaves the other capability's accepted package alone", async (t) => {
  // The whole loop, on the path a dispatched run actually takes: the plan spans
  // two capabilities, the server-side gate rejects one of them, and the repair
  // it sends back must be about that one. A repair that reopened the other
  // capability's finished delivery for editing would look identical on a
  // single-capability run — there would be nothing else to reopen.
  //
  // This is the live twin of the previous test: there the snapshot helper is
  // called directly, here it is reached through `dispatch` and
  // `reconcileSession`, which is the only place the ordering (snapshot, then
  // freeze, then prompt) and the repair budget are exercised together. What
  // carries the test are the mint-site assertions — exactly one authorization
  // on disk and for which deliverable, the snapshot holding the *other*
  // capability's bytes, one repair round spent, and both capabilities'
  // artifacts in the finished run. Two further assertions cannot fail against
  // today's code and are fenced and labelled `FORWARD GUARD` below so they are
  // not read as coverage: `clinicalEvidenceRepairPrompt` is built from clinical
  // gate issue strings, `shrinkage` and `revisionRequired` alone and never
  // enumerates the plan or the receipt, and the control plane writes only under
  // `metaDir` during a repair. Both are kept because both become falsifiable
  // the moment a repair prompt starts quoting the plan or a repair writes into
  // the workspace, which is the direction this loop is growing.
  const root = await mkdtemp(path.join(tmpdir(), "combined-live-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });

  // The clinical package: written, locally accepted, and not good enough for
  // the server-side gate — an unsupported claim with an empty evidence matrix.
  const clinicalFiles = new Map([
    ["clinical-evidence-report.md", "# 结论\n未获支撑的结论 [claim:CLM-999]\n"],
    ["clinical-evidence-matrix.json", JSON.stringify({ claims: [] })],
    ["clinical-evidence-run.json", JSON.stringify({
      status: "succeeded",
      successfulSourceArtifacts: [],
      qualityChecks: { claimTraceability: true, contradictionAudit: true, arithmeticAudit: true },
    })],
  ]);
  for (const [relative, text] of clinicalFiles) await writeFile(path.join(project.workspaceDir, relative), text);
  await mkdir(path.join(project.workspaceDir, path.dirname(BIBLIOMETRIC_FILE)), { recursive: true });
  await writeFile(path.join(project.workspaceDir, BIBLIOMETRIC_FILE), BIBLIOMETRIC_TEXT);

  const receiptEntry = (item, entries, at) => ({
    deliverableId: item.id,
    contractKind: item.contractKind,
    capability: item.capability,
    files: [...entries].map(([relative, text]) => ({ path: relative, sha256: digest(text), bytes: Buffer.byteLength(text) })),
    acceptedAt: at,
    attempt: 1,
    notices: [],
  });
  await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1,
    runId: "combined_live_owner",
    bundleVersion: "0.1.0",
    domainVersion: "0.1.0",
    entries: [
      receiptEntry(EVIDENCE, clinicalFiles, new Date().toISOString()),
      receiptEntry(BIBLIOMETRIC, new Map([[BIBLIOMETRIC_FILE, BIBLIOMETRIC_TEXT]]), new Date().toISOString()),
    ],
  }));

  const binding = { sessionId: "ses_combined_live", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  let history = [];
  const store = new AgentRunStore({ get: async () => binding }, {
    agentRegistry: {
      get: () => ({
        id: "clinical-evidence-synthesis",
        version: "1.0.0",
        runtimeAgent: "evimed-clinical-evidence-synthesis",
        outputs: [...clinicalFiles.keys()].map((relative) => ({ path: relative, required: true })),
        completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
      }),
    },
    model: "deepseek/deepseek-v4-pro",
    monitorIntervalMs: 60_000,
    monitorMaxPolls: 20,
    readSessionHistory: async () => history,
    readSessionStatus: async () => "idle",
    runtimeGeneration: async () => "generation-live",
    maxClinicalRepairAttempts: 1,
    maxClinicalStructuralRepairAttempts: 0,
  });
  store.scheduleMonitor = () => {};
  /** @type {(string|null)[]} */
  const prompts = [];
  const sendPrompt = async (_session, _run, repairText) => { prompts.push(repairText ?? null); return { accepted: true }; };
  const run = await store.dispatch(project, {
    sessionId: binding.sessionId,
    dispatchId: "turn_combined_live",
    effectiveAgentId: "clinical-evidence-synthesis",
    effectiveAgentVersion: "1.0.0",
    effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
  }, sendPrompt);

  // The run's own plan index, naming both capabilities as accepted locally.
  // Written because a real run writes one and its absence would make the
  // fixture lie about the runtime; with both items accepted the control plane
  // reads no assertion out of it here.
  await mkdir(path.join(project.workspaceDir, ".evimed-run", "runs", run.id), { recursive: true });
  const writeProjection = async () => writeFile(path.join(project.workspaceDir, ".evimed-run", "runs", run.id, "state.json"), JSON.stringify({
    formatVersion: 1,
    runId: run.id,
    sessionId: binding.sessionId,
    plan: {
      revision: 1,
      items: [
        { ...EVIDENCE, status: "accepted", attempts: 1, childSessionId: "child-evidence", lastIssues: [] },
        { ...BIBLIOMETRIC, status: "accepted", attempts: 1, childSessionId: "child-bibliometric", lastIssues: [] },
      ],
    },
    qualityNotices: [], gateRuns: [], subagents: [], degraded: [],
  }));
  await writeProjection();
  const wrote = (id, filePath) => ({
    info: { id, role: "assistant", time: { completed: Date.now() } },
    parts: [
      ...[...clinicalFiles.keys(), filePath].map((relative) => ({ type: "tool", tool: "write", state: { status: "completed", input: { filePath: relative } } })),
      { type: "text", text: "Completed." },
    ],
  });
  history = [wrote("msg_combined_first", BIBLIOMETRIC_FILE)];

  const repairing = await store.reconcileSession(project, binding.sessionId);

  assert.equal(repairing.id, run.id);
  assert.equal(repairing.status, "running", "a repairable combined package must be sent back, not settled");
  assert.equal(prompts.length, 2, "exactly one repair follows the initial dispatch");
  assert.equal(prompts[0], null, "the initial dispatch is not a repair; only the second prompt may carry repair text");
  assert.match(prompts[1], /server-side clinical evidence gate rejected/);
  // FORWARD GUARD (cannot fail today; see this test's header). The repair is
  // about the capability that failed and must not instruct the run to touch the
  // other capability's finished package — but `clinicalEvidenceRepairPrompt`
  // has no access to the plan or the receipt, so nothing in today's control
  // plane can put the accepted deliverable's id or file in that text. This
  // becomes real the day a repair prompt starts quoting either.
  assert.deepEqual(
    [BIBLIOMETRIC.id, BIBLIOMETRIC_FILE].filter((name) => prompts[1].includes(name)),
    [],
    `the repair named the accepted capability's package: ${prompts[1]}`,
  );

  // Only the failing contract was unfrozen; the accepted package was preserved
  // and left frozen, which is what stops it being regenerated.
  const authorizations = (await readdir(path.join(project.metaDir, "repair-authorizations"))).filter((name) => name.endsWith(".json"));
  assert.equal(authorizations.length, 1, `exactly one deliverable may be unfrozen: ${JSON.stringify(authorizations)}`);
  assert.equal(
    JSON.parse(await readFile(path.join(project.metaDir, "repair-authorizations", authorizations[0]), "utf8")).deliverableId,
    EVIDENCE.id,
  );
  const snapshots = await readdir(path.join(project.metaDir, "repair-revisions"));
  const preserved = JSON.parse(await readFile(path.join(project.metaDir, "repair-revisions", snapshots[0]), "utf8"));
  assert.ok(
    preserved.files.some((file) => file.path === BIBLIOMETRIC_FILE && file.text === BIBLIOMETRIC_TEXT),
    "the accepted capability's bytes must be preserved before any repair runs",
  );

  // The repair round changes only the clinical report; the other capability's
  // file is byte-identical afterwards.
  await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 结论\n仍未获支撑的结论 [claim:CLM-999]\n");
  history.push(wrote("msg_combined_repair", BIBLIOMETRIC_FILE));

  const finished = await store.reconcileSession(project, binding.sessionId);

  assert.equal(finished.id, run.id);
  assert.equal(prompts.length, 2, "the repair budget is one round, and it was spent");
  // FORWARD GUARD (cannot fail today; see this test's header): a repair round
  // writes nothing under `workspaceDir`, so this equality cannot fail against
  // today's control plane. It is the assertion that would catch a repair that
  // started editing the workspace.
  assert.equal(await readFile(path.join(project.workspaceDir, BIBLIOMETRIC_FILE), "utf8"), BIBLIOMETRIC_TEXT,
    "the accepted capability's package must be exactly the bytes it was accepted as");
  // Repairs exhausted with findings left: the package ships, marked, rather
  // than being withheld — and the other capability's deliverable ships with it.
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.verification, "unverified");
  assert.ok(finished.artifacts.includes(BIBLIOMETRIC_FILE),
    `the accepted capability's deliverable must reach the reader: ${JSON.stringify(finished.artifacts)}`);
  assert.ok(finished.artifacts.includes("clinical-evidence-report.md"));
  await store.closeProject(project, "canceled");
});
