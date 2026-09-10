import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { normalizeTranscript, transcriptToLedgerMessages } from "../src/dshRuntimeAdapter.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/dsh/native-turn-frames.json", import.meta.url), "utf8"));
const question = (event) => event.data.content.map((part) => part.text ?? "").join(" ");
const inputs = fixture.events.filter((event) => event.type === "user/message" && event.data.source.kind === "user");

async function setup(t, initial = fixture.events) {
  const root = await mkdtemp(path.join(tmpdir(), "native-turns-"));
  const project = { id: "p1", userId: "u1", rootDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace") };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  let events = structuredClone(initial);
  const bindings = new Map();
  const routed = [];
  const makeStore = () => {
    const store = new AgentRunStore({ get: async (_project, id) => bindings.get(id) ?? null }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => transcriptToLedgerMessages(normalizeTranscript(fixture.sessionId, events)),
      readSessionStatus: async () => events.at(-1)?.type === "turn/end" ? "idle" : "busy",
    });
    // These tests drive reconciliation explicitly so the assertions have one writer.
    store.scheduleMonitor = () => {};
    return store;
  };
  let store = makeStore();
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    project, bindings, routed,
    get store() { return store; },
    setEvents(value) { events = structuredClone(value); },
    restart() { store = makeStore(); },
    async adopt(routeTurn = async (text) => { routed.push(text); return {}; }) {
      return store.adoptRuntimeSession(project, fixture.sessionId, {
        transcript: normalizeTranscript(fixture.sessionId, events), routeTurn,
      });
    },
    runs: () => store.list(project),
  };
}

test("the captured native conversation produces two independent runs and replay preserves them", async (t) => {
  const f = await setup(t);
  await f.adopt();
  const first = await f.runs();
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((run) => run.question).sort(), inputs.map(question).sort());
  assert.ok(first.every((run) => run.status === "succeeded"));
  assert.equal(first.find((run) => run.question === question(inputs[0])).startedAt, new Date(fixture.events[0].time).toISOString());
  assert.equal(first.find((run) => run.question === question(inputs[1])).finishedAt, new Date(fixture.events.at(-1).time).toISOString());
  assert.deepEqual(f.routed, inputs.map(question));
  await Promise.all([f.adopt(), f.adopt()]);
  f.restart();
  await f.adopt();
  assert.deepEqual((await f.runs()).map((run) => run.id).sort(), first.map((run) => run.id).sort());
});

test("session migration rebinds request identities when new sequences collide with old turns", async (t) => {
  const f = await setup(t);
  await f.adopt();
  const before = await f.runs();
  const starts = fixture.events.filter((event) => event.type === "turn/start");
  const secondIndex = fixture.events.findIndex((event) => event === starts[1]);
  const migrated = fixture.events.map((event, index) => ({
    ...structuredClone(event),
    seq: index < secondIndex ? index : starts[0].seq + index - secondIndex,
  }));
  f.setEvents(migrated);
  await f.adopt();
  const after = await f.runs();
  assert.deepEqual(after.map((run) => run.id).sort(), before.map((run) => run.id).sort());
  for (const run of after) {
    const input = migrated.find((event) => event.type === "user/message" && run.kernelRequestIds.includes(event.data.source?.rpcId));
    assert.equal(run.nativeTurn.userSeq, input.seq);
    assert.equal(run.question, question(input));
  }
  assert.equal(f.routed.length, 2, "migrated historical requests must not be dispatched as new work");
});

test("the second native input cannot finish from the first answer", async (t) => {
  const f = await setup(t, fixture.events.filter((event) => event.seq <= 140));
  await f.adopt();
  const runs = await f.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.question === question(inputs[0])).status, "succeeded");
  assert.equal(runs.find((run) => run.question === question(inputs[1])).status, "running");
});

test("late adoption keeps the first failure separate from the second success", async (t) => {
  const events = structuredClone(fixture.events);
  events.find((event) => event.seq === 135).data.reason = { kind: "failed", error: { message: "synthetic first-turn failure" } };
  const f = await setup(t, events);
  await f.adopt();
  const runs = await f.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.question === question(inputs[0])).status, "failed");
  assert.equal(runs.find((run) => run.question === question(inputs[1])).status, "succeeded");
});

test("the adapter preserves actual user request identities and per-turn endings", () => {
  const transcript = normalizeTranscript(fixture.sessionId, fixture.events);
  const users = transcript.messages.filter((message) => message.source === "user");
  assert.deepEqual(users.map((message) => message.turn), [1, 2]);
  assert.deepEqual(users.map((message) => message.sourceRequestId), inputs.map((event) => event.data.source.rpcId));
  const history = transcriptToLedgerMessages(transcript);
  assert.equal(history.find((message) => message.info.id === "seq_133").info.turnEnd.kind, "completed");
  assert.equal(history.find((message) => message.info.id === "seq_226").info.turnEnd.kind, "completed");
});

test("steering within one actual turn stays one run and injected messages create none", async (t) => {
  const events = structuredClone(fixture.events.filter((event) => event.seq <= 135));
  const steer = structuredClone(inputs[1]);
  steer.seq = 100;
  events.splice(events.findIndex((event) => event.seq === 133), 0, steer);
  const f = await setup(t, events);
  await f.adopt();
  assert.equal((await f.runs()).length, 1);
  f.setEvents(fixture.events.filter((event) => event.type !== "user/message" || event.data.source.kind !== "user"));
  const before = (await f.runs()).length;
  await f.adopt();
  assert.equal((await f.runs()).length, before);
});

test("an old first-turn adoption is bound rather than duplicated", async (t) => {
  const f = await setup(t);
  const legacy = await f.store.adoptRuntimeSession(f.project, fixture.sessionId, { question: question(inputs[0]) });
  await f.store.finishInternal(f.project, legacy.id, { status: "succeeded", artifacts: [] });
  await f.adopt();
  const runs = await f.runs();
  assert.equal(runs.length, 2);
  assert.ok(runs.some((run) => run.id === legacy.id));
});

test("the previous turn's receipt cannot deliver a new native run after runtime exit", async (t) => {
  const f = await setup(t, fixture.events.filter((event) => event.seq <= 140));
  await f.adopt();
  const run = (await f.runs()).find((item) => item.question === question(inputs[1]));
  assert.ok(run);
  await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1, runId: "some-previous-run", bundleVersion: "test", domainVersion: "1", entries: [],
  }));
  const finished = await f.store.finishFromDurableRecord(f.project, run);
  assert.equal(finished.status, "failed");
});

test("ordinary dispatch and repair requests retain their owner while a native follow-up gets a new run", async (t) => {
  const f = await setup(t, []);
  const binding = { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  f.bindings.set(fixture.sessionId, binding);
  const events = structuredClone(fixture.events);
  let sends = 0;
  const run = await f.store.dispatch(f.project, { sessionId: fixture.sessionId, dispatchId: "ordinary-first", question: question(inputs[0]) }, async (_binding, record, repair) => {
    sends++;
    events.find((event) => event.seq === (repair ? 140 : 7)).data.source.rpcId = record.kernelRequestIds.at(-1);
    f.setEvents(events.filter((event) => event.seq <= (repair ? 228 : 135)));
    return { accepted: true };
  });
  await f.store.clinicalRepairSenders.get(run.id)("synthetic repair input");
  await f.adopt();
  assert.equal((await f.runs()).length, 1);
  assert.equal(sends, 2);
  const third = structuredClone(fixture.events.filter((event) => event.seq >= 137));
  for (const event of third) { event.seq += 300; if (event.data.turn) event.data.turn = 3; }
  third.find((event) => event.type === "user/message").data.source.rpcId = "native-followup";
  f.setEvents([...events, ...third]);
  await f.adopt();
  assert.equal((await f.runs()).length, 2);
  assert.deepEqual(f.routed, [question(inputs[1])]);
});

test("concurrent first scans atomically reserve each actual turn once", async (t) => {
  const f = await setup(t);
  await Promise.all([f.adopt(), f.adopt(), f.adopt()]);
  assert.equal((await f.runs()).length, 2);
});

test("the second native question selects its own capability", async (t) => {
  const f = await setup(t);
  await f.adopt(async (text) => {
    const agent = text === question(inputs[0]) ? "open-domain-answer" : "meta-analysis";
    return { effectiveAgentId: agent, effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: `evimed-${agent}`, effectiveRouteReason: `matched:${agent}` };
  });
  const runs = await f.runs();
  assert.equal(runs.find((run) => run.question === question(inputs[0])).effectiveAgentId, "open-domain-answer");
  assert.equal(runs.find((run) => run.question === question(inputs[1])).effectiveAgentId, "meta-analysis");
});

test("a previous output file is not evidence that this native turn produced a deliverable", async (t) => {
  const f = await setup(t, fixture.events.filter((event) => event.seq >= 137));
  await writeFile(path.join(f.project.workspaceDir, "old-report.md"), "Previous turn's report.");
  f.store.agentRegistry = Promise.resolve(new Map([["meta-analysis", {
    id: "meta-analysis", version: "1.0.0", runtimeAgent: "evimed-meta-analysis",
    completionChecks: ["requiredOutputsExist"], outputs: [{ path: "old-report.md", required: true }],
  }]]));
  await f.adopt(async () => ({ effectiveAgentId: "meta-analysis", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "evimed-meta-analysis" }));
  const run = (await f.runs())[0];
  assert.equal(run.status, "failed");
  assert.deepEqual(run.artifacts, []);
});

test("an unknown ordinary dispatch cannot consume an unrelated native answer", async (t) => {
  const f = await setup(t, []);
  f.bindings.set(fixture.sessionId, { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null });
  await assert.rejects(f.store.dispatch(f.project, { sessionId: fixture.sessionId, dispatchId: "unknown-send" }, async () => { throw new Error("lost acceptance"); }));
  f.setEvents(fixture.events.filter((event) => event.seq <= 135));
  await f.adopt();
  await f.store.reconcileSession(f.project, fixture.sessionId);
  const runs = await f.runs();
  assert.equal(runs.find((run) => run.dispatchId === "unknown-send").status, "running");
  assert.equal(runs.find((run) => run.nativeTurn).status, "succeeded");
});

test("a native turn that fails before an assistant message still gets a terminal run", async (t) => {
  const events = structuredClone(fixture.events.filter((event) => event.seq <= 135 && event.type !== "assistant/message"));
  events.at(-1).data.reason = { kind: "failed", error: { message: "synthetic failure before generation" } };
  const f = await setup(t, events);
  await f.adopt();
  assert.equal((await f.runs())[0].status, "failed");
});

test("native script outputs are graded in the actual turn interval and old root files cannot shadow them", async (t) => {
  const f = await setup(t, fixture.events.filter((event) => event.seq >= 137));
  await mkdir(path.join(f.project.workspaceDir, "deliverables", "current"), { recursive: true });
  const old = path.join(f.project.workspaceDir, "report.md");
  const current = path.join(f.project.workspaceDir, "deliverables", "current", "report.md");
  await writeFile(old, "Older output.");
  await writeFile(current, "Current output from a script.");
  await utimes(old, new Date(inputs[0].time), new Date(inputs[0].time));
  await utimes(current, new Date(inputs[1].time + 100), new Date(inputs[1].time + 100));
  f.store.agentRegistry = Promise.resolve(new Map([["meta-analysis", {
    id: "meta-analysis", version: "1.0.0", runtimeAgent: "evimed-meta-analysis",
    completionChecks: ["requiredOutputsExist"], outputs: [{ path: "report.md", required: true }],
  }]]));
  await f.adopt(async () => ({ effectiveAgentId: "meta-analysis", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "evimed-meta-analysis" }));
  const run = (await f.runs())[0];
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.artifacts, ["deliverables/current/report.md"]);
});

test("a persisted repair awaiting consumption cannot finish on the preceding answer", async (t) => {
  const f = await setup(t, []);
  f.bindings.set(fixture.sessionId, { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null });
  const events = structuredClone(fixture.events.filter((event) => event.seq <= 135));
  const run = await f.store.dispatch(f.project, { sessionId: fixture.sessionId, dispatchId: "repair-pending" }, async (_session, record) => {
    events.find((event) => event.seq === 7).data.source.rpcId = record.kernelRequestIds[0];
    f.setEvents(events);
    return { accepted: true };
  });
  await f.store.recordKernelRequest(f.project, run.id, "req_repair_not_yet_consumed");
  await f.store.reconcileSession(f.project, fixture.sessionId, run.id);
  assert.equal((await f.runs())[0].status, "running");
});

test("the same text submitted in a new native turn is a new run", async (t) => {
  const events = structuredClone(fixture.events);
  events.find((event) => event.seq === 140).data.content = structuredClone(inputs[0].data.content);
  const f = await setup(t, events);
  await f.adopt();
  const runs = await f.runs();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.question === question(inputs[0])));
  assert.deepEqual(runs.map((run) => run.nativeTurn.userSeq).sort((a, b) => a - b), [7, 140]);
});

test("a session containing only injected user-role messages creates no user run", async (t) => {
  const f = await setup(t, fixture.events.filter((event) => event.type !== "user/message" || event.data.source.kind !== "user"));
  await f.adopt();
  assert.deepEqual(await f.runs(), []);
});

test("a file overwritten in the second turn cannot be delivered by the first turn", async (t) => {
  const f = await setup(t);
  const file = path.join(f.project.workspaceDir, "report.md");
  await writeFile(file, "Second turn's output.");
  await utimes(file, new Date(inputs[1].time + 100), new Date(inputs[1].time + 100));
  f.store.agentRegistry = Promise.resolve(new Map([["meta-analysis", {
    id: "meta-analysis", version: "1.0.0", runtimeAgent: "evimed-meta-analysis",
    completionChecks: ["requiredOutputsExist"], outputs: [{ path: "report.md", required: true }],
  }]]));
  await f.adopt(async () => ({ effectiveAgentId: "meta-analysis", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "evimed-meta-analysis" }));
  const runs = await f.runs();
  const first = runs.find((run) => run.nativeTurn.startSeq === 4);
  assert.equal(first.status, "failed");
  assert.deepEqual(first.artifacts, []);
  assert.equal(runs.find((run) => run.nativeTurn.startSeq === 137).status, "succeeded");
});

test("a failed or unknown ending after a late steering input is never a successful answer", async (t) => {
  for (const kind of ["failed", "future-unknown-ending"]) {
    const events = structuredClone(fixture.events.filter((event) => event.seq <= 135));
    const steer = structuredClone(inputs[1]);
    steer.seq = 134;
    events.splice(events.length - 1, 0, steer);
    events.at(-1).data.reason = { kind };
    const f = await setup(t, events);
    await f.adopt();
    assert.equal((await f.runs())[0].status, "failed", kind);
  }
});

test("a plugin spoofing a reserved request id cannot consume an ordinary dispatch", async (t) => {
  const f = await setup(t, []);
  const binding = { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  f.bindings.set(fixture.sessionId, binding);
  const events = structuredClone(fixture.events.filter((event) => event.seq <= 135));
  const run = await f.store.dispatch(f.project, { sessionId: fixture.sessionId, dispatchId: "plugin-spoof" }, async (_session, record) => {
    const input = events.find((event) => event.seq === 7);
    input.data.source = { kind: "plugin", rpcId: record.kernelRequestIds[0] };
    f.setEvents(events);
    return { accepted: true };
  });
  await f.adopt();
  await f.store.reconcileSession(f.project, fixture.sessionId, run.id);
  assert.equal((await f.runs()).length, 1);
  assert.equal((await f.runs())[0].status, "running");
});

test("a legacy ordinary first turn without request ids is not replayed as native work", async (t) => {
  const f = await setup(t, fixture.events.filter((event) => event.seq <= 135));
  const binding = { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const { run } = await f.store.reserveRun(f.project, binding, { dispatchId: "legacy-dispatch", baselineCursor: null, kernelRequestIds: [] });
  await f.store.finishInternal(f.project, run.id, { status: "succeeded", artifacts: [] });
  await f.adopt();
  f.restart();
  await f.adopt();
  assert.deepEqual((await f.runs()).map((item) => item.id), [run.id]);
});

test("a legacy numeric cursor missing from the transcript is explicitly unattributed, not guessed", async (t) => {
  const f = await setup(t, fixture.events.filter((event) => event.seq <= 135));
  const binding = { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const { run } = await f.store.reserveRun(f.project, binding, { dispatchId: "legacy-missing-cursor", baselineCursor: "seq_999", kernelRequestIds: [] });
  await f.store.finishInternal(f.project, run.id, { status: "succeeded", artifacts: [] });
  await f.adopt();
  const runs = await f.runs();
  assert.equal(runs.length, 1);
  assert.ok(runs[0].qualityNotices.some((notice) => notice.includes("no unique verifiable input boundary")));
});

function workflowEvents(accepted) {
  const events = structuredClone(fixture.events.filter((event) => event.seq >= 137));
  const start = inputs[1].time;
  const item = { id: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", title: "Current report", dependsOn: [] };
  const pairs = [];
  const add = (seq, name, args, result, at) => {
    const callId = `call_${seq}`;
    pairs.push({ type: "tool/call", seq, time: at, data: { turn: 2, step: 1, callId, name, arguments: args } });
    pairs.push({ type: "tool/result", seq: seq + 1, time: at + 5, data: { turn: 2, step: 1,
      message: { source: { callId }, content: [{ type: "tool-result", content: [{ type: "text", text: JSON.stringify(result) }] }] },
    } });
  };
  add(145, "evimed_plan", { action: "write", clarifications: ["Synthetic current-turn plan"], deliverables: [item] },
    { ok: true, data: { revision: 2, deliverables: [{ ...item, status: "planned", attempts: 0 }] } }, start + 10);
  for (let i = 0; i < (accepted ? 1 : 7); i++) {
    add(150 + i * 2, "evimed_submit_deliverable", { deliverableId: "d1" }, accepted
      ? { ok: true, data: { deliverableId: "d1", contractKind: item.contractKind, notices: ["Current native gate note"] } }
      : { ok: false, code: "clinical_evidence_invalid", issues: [{ code: "synthetic_rejection", severity: "required", message: "Current native gate rejection" }] }, start + 100 + i * 10);
  }
  return { events: [...events, ...pairs].sort((a, b) => a.seq - b.seq), item, acceptedAt: start + 103 };
}

async function setupWorkflow(t, accepted, complete = true) {
  const data = workflowEvents(accepted);
  const f = await setup(t, complete ? data.events : data.events.filter((event) => event.type !== "turn/end"));
  const report = "Current native report generated by Python.\n";
  await writeFile(path.join(f.project.workspaceDir, "report.md"), report);
  await utimes(path.join(f.project.workspaceDir, "report.md"), new Date(inputs[1].time + 50), new Date(inputs[1].time + 50));
  f.store.agentRegistry = Promise.resolve(new Map([["clinical-evidence-synthesis", {
    id: "clinical-evidence-synthesis", version: "1.0.0", runtimeAgent: "evimed-clinical-evidence-synthesis",
    completionChecks: ["requiredOutputsExist"], outputs: [{ path: "report.md", required: true }],
  }]]));
  await mkdir(path.join(f.project.workspaceDir, ".evimed-run"), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, ".evimed-run", "state.json"), JSON.stringify({
    formatVersion: 1, runId: "ordinary_kernel_owner", sessionId: fixture.sessionId,
    plan: { revision: 2, items: [{ ...data.item, status: accepted ? "accepted" : "submitted", attempts: accepted ? 1 : 7 }] },
    qualityNotices: ["Current native gate note"], gateRuns: [], subagents: [],
  }));
  const receipt = { formatVersion: 1, runId: "ordinary_kernel_owner", bundleVersion: "1", domainVersion: "1", entries: [{
    deliverableId: "d1", contractKind: data.item.contractKind, capability: data.item.capability,
    files: [{ path: "report.md", sha256: createHash("sha256").update(report).digest("hex"), bytes: Buffer.byteLength(report) }],
    acceptedAt: new Date(data.acceptedAt).toISOString(), attempt: 1, notices: ["Current native gate note"],
  }] };
  if (accepted) await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify(receipt));
  return { ...f, get store() { return f.store; }, adopt: () => f.adopt(async () => ({
    effectiveAgentId: "clinical-evidence-synthesis", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
  })), receipt };
}

test("a current native plan rejected seven times is not hidden by a different kernel workflow id", async (t) => {
  const f = await setupWorkflow(t, false);
  await f.adopt();
  const run = (await f.runs())[0];
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "specialist_deliverable_not_accepted");
  assert.ok(run.qualityNotices.some((notice) => notice.includes("Current native gate rejection")));
});

test("a witnessed current native receipt survives kernel loss and a control-plane restart", async (t) => {
  const f = await setupWorkflow(t, true, false);
  await f.adopt();
  f.restart();
  const run = (await f.runs())[0];
  const finished = await f.store.finishFromDurableRecord(f.project, run);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.artifacts, ["report.md"]);
  assert.ok(finished.qualityNotices.includes("Current native gate note"));
});

test("a legacy basename receipt resolves only within its named deliverable and verifies the digest", async (t) => {
  const f = await setup(t, []);
  const binding = { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const { run } = await f.store.reserveRun(f.project, binding, { dispatchId: "legacy-receipt", baselineCursor: null });
  const report = "A verified nested report.\n";
  await mkdir(path.join(f.project.workspaceDir, "deliverables", "d1"), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, "deliverables", "d1", "report.md"), report);
  await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1, runId: "kernel_owner", bundleVersion: "1", domainVersion: "1", entries: [{
      deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", acceptedAt: new Date().toISOString(), attempt: 1, notices: [],
      files: [{ path: "report.md", sha256: createHash("sha256").update(report).digest("hex"), bytes: Buffer.byteLength(report) }],
    }],
  }));
  const finished = await f.store.finishFromDurableRecord(f.project, run);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.artifacts, ["deliverables/d1/report.md"]);
});

test("a receipt cannot borrow a different deliverable's path even with a matching digest", async (t) => {
  const f = await setup(t, []);
  const binding = { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const { run } = await f.store.reserveRun(f.project, binding, { dispatchId: "cross-receipt", baselineCursor: null });
  const report = "Another deliverable.\n";
  await mkdir(path.join(f.project.workspaceDir, "deliverables", "other"), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, "deliverables", "other", "report.md"), report);
  await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1, runId: "kernel_owner", bundleVersion: "1", domainVersion: "1", entries: [{
      deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", acceptedAt: new Date().toISOString(), attempt: 1, notices: [],
      files: [{ path: "deliverables/other/report.md", sha256: createHash("sha256").update(report).digest("hex"), bytes: Buffer.byteLength(report) }],
    }],
  }));
  const finished = await f.store.finishFromDurableRecord(f.project, run);
  assert.equal(finished.status, "failed");
  assert.deepEqual(finished.artifacts, []);
});

test("a cumulative receipt contributes only entries witnessed in the current native submission", async (t) => {
  const f = await setupWorkflow(t, true, false);
  const previous = { ...f.receipt.entries[0], deliverableId: "old-deliverable", acceptedAt: new Date(inputs[0].time).toISOString(), notices: ["Old unrelated notice"] };
  await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify({ ...f.receipt, entries: [previous, ...f.receipt.entries] }));
  await f.adopt();
  f.restart();
  const finished = await f.store.finishFromDurableRecord(f.project, (await f.runs())[0]);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.artifacts, ["report.md"]);
  assert.ok(!finished.qualityNotices.includes("Old unrelated notice"));
});

test("fresh files without witnessed workflow tools cannot silently bypass an unattributed rejection", async (t) => {
  const f = await setupWorkflow(t, false);
  f.setEvents(fixture.events.filter((event) => event.seq >= 137));
  await f.adopt();
  const run = (await f.runs())[0];
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "specialist_deliverable_not_accepted");
  assert.ok(run.qualityNotices.some((notice) => notice.includes("could not be attributed")));
});

test("a current native receipt with a legacy basename survives offline recovery from the actual nested path", async (t) => {
  const f = await setupWorkflow(t, true, false);
  const rootFile = path.join(f.project.workspaceDir, "report.md");
  const nested = path.join(f.project.workspaceDir, "deliverables", "d1", "report.md");
  await mkdir(path.dirname(nested), { recursive: true });
  await writeFile(nested, await readFile(rootFile));
  await utimes(nested, new Date(inputs[1].time + 50), new Date(inputs[1].time + 50));
  await rm(rootFile);
  await f.adopt();
  f.restart();
  const finished = await f.store.finishFromDurableRecord(f.project, (await f.runs())[0]);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.artifacts, ["deliverables/d1/report.md"]);
});

test("an old acceptance is not reused after the current native submissions are rejected", async (t) => {
  const f = await setupWorkflow(t, false);
  const oldReceipt = { ...f.receipt, entries: f.receipt.entries.map((entry) => ({ ...entry, acceptedAt: new Date(inputs[0].time).toISOString(), notices: ["Old acceptance"] })) };
  await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify(oldReceipt));
  await f.adopt();
  const run = (await f.runs())[0];
  assert.equal(run.status, "failed");
  assert.ok(!run.qualityNotices.includes("Old acceptance"));
});

test("a late older native snapshot cannot erase a persisted acceptance", async (t) => {
  const f = await setupWorkflow(t, true, false);
  await f.adopt();
  f.setEvents(workflowEvents(true).events.filter((event) => event.seq <= 146));
  await f.adopt();
  f.restart();
  const run = (await f.runs())[0];
  assert.equal(run.nativeWorkflow.submissions.length, 1);
  const finished = await f.store.finishFromDurableRecord(f.project, run);
  assert.equal(finished.status, "succeeded");
});

function completeFrames(seq, ok) {
  const at = fixture.events.at(-1).time + seq;
  const callId = `complete_${seq}`;
  return [
    { type: "tool/call", seq, time: at, data: { turn: 2, step: 2, callId, name: "evimed_complete_run", arguments: {} } },
    { type: "tool/result", seq: seq + 1, time: at + 1, data: { turn: 2, step: 2, message: { source: { callId }, content: [{ type: "tool-result", content: [{ type: "text", text: JSON.stringify(ok
      ? { ok: true, data: { partial: false, issues: [] } }
      : { ok: false, code: "run_incomplete", issues: [{ severity: "required", code: "unsafe_final_reply", message: "Current completion safety rejection" }] }) }] }] } } },
  ];
}

test("durable native completion respects the current complete_run rejection despite an accepted receipt", async (t) => {
  const f = await setupWorkflow(t, true, false);
  f.setEvents([...workflowEvents(true).events.filter((event) => event.type !== "turn/end"), ...completeFrames(240, false)]);
  await f.adopt();
  f.restart();
  const finished = await f.store.finishFromDurableRecord(f.project, (await f.runs())[0]);
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "specialist_deliverable_not_accepted");
  assert.ok(finished.qualityNotices.includes("Current completion safety rejection"));
});

test("a genuinely later successful complete_run replaces an earlier rejection in the same native turn", async (t) => {
  const f = await setupWorkflow(t, true, false);
  const earlier = [...workflowEvents(true).events.filter((event) => event.type !== "turn/end"), ...completeFrames(240, false)];
  f.setEvents(earlier);
  await f.adopt();
  f.setEvents([...earlier, ...completeFrames(250, true)]);
  await f.adopt();
  f.restart();
  const finished = await f.store.finishFromDurableRecord(f.project, (await f.runs())[0]);
  assert.equal(finished.status, "succeeded");
});
