// A reused conversation (a scheduled task) keeps every execution's instruction as user-role text. The instruction is the
// platform's, sent by the control plane, and never the person's words — in the first execution, in a later one, or after the
// person types into the same conversation (2026-10-14: a daily literature task's template became an active work habit).
import assert from "node:assert/strict";
import test from "node:test";

import { EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX, EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON, evidenceProgrammeRouteReason } from "@evimed/domain";
import { VERIFICATION_ROUTE_REASON } from "../src/autopilotService.mjs";
import { MemoryIntelligence, conversationMemorySources } from "../src/memoryIntelligence.mjs";
import { dispatchedRequestIdsOf, isPlatformStartedRun } from "../src/memoryDispatch.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro", memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 1_000 };

const INSTRUCTION = "每天早上检索新文献，按研究类型整理成简报，每次先列出新增数量。";
const user = (id, text, requestId) => ({ info: { id, role: "user", source: "user", sourceRequestId: requestId, turnStartSeq: Number(id.slice(1)) }, parts: [{ type: "text", text }] });
const assistant = (id, text) => ({ info: { id, role: "assistant", turnStartSeq: Number(id.slice(1)) - 1 }, parts: [{ type: "text", text }] });

class StoreDouble {
  constructor() { this.records = new Map(); this.configured = false; }
  async listRecords() { return [...this.records.values()]; }
  async upsertRecord(_user, input) {
    const stored = { ...input, id: `${input.kind}.${input.key}`, version: 1, revisions: [], evidence: [], evidenceCount: 0 };
    this.records.set(`${input.scope}\u0000${input.kind}\u0000${input.key}`, stored);
    return stored;
  }
  async getRecord() { throw Object.assign(new Error("not found"), { code: "memory_not_found" }); }
}

/** The task's conversation as the kernel keeps it after two executions, and the ledger's runs of it. */
function reusedConversation(reason, { personTypes = false } = {}) {
  const messages = [
    user("m1", INSTRUCTION, "req_first"), assistant("m2", "今天新增 12 篇。"),
    user("m3", INSTRUCTION, "req_second"), assistant("m4", "今天新增 9 篇。"),
    ...(personTypes ? [user("m5", "以后简报里的文献一律按发表日期倒序。", "req_person"), assistant("m6", "好的。")] : []),
  ];
  const runs = [
    { id: "run_first", sessionId: "s", effectiveRouteReason: reason, kernelRequestIds: ["req_first"] },
    { id: "run_second", sessionId: "s", effectiveRouteReason: reason, kernelRequestIds: ["req_second"] },
    ...(personTypes ? [{ id: "run_person", sessionId: "s", effectiveRouteReason: "adopted:runtime-ui", kernelRequestIds: ["req_person"] }] : []),
  ];
  return { messages, runs, current: runs.at(-1) };
}

function extractor(store, { runs, onCall = () => {}, audit = null }) {
  return new MemoryIntelligence(config, store, {
    dispatchedRequests: async () => dispatchedRequestIdsOf(runs),
    ...(audit ? { audit } : {}),
    fetchImpl: async (_input, init) => {
      const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
      onCall(sources);
      const person = sources.find((source) => source.role === "user" && /倒序/.test(source.text));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: person ? [{
        scope: "user", kind: "preference", key: "preference.briefing.order", value: "简报里的文献按发表日期倒序", summary: "简报按发表日期倒序",
        origin: "explicit", importance: 0.7, sensitive: false, sourceRef: person.sourceRef, evidenceQuote: "一律按发表日期倒序" }] : [] }) } }] });
    },
  });
}

const project = { id: "project_1", userId: "user_1" };
const finished = { status: "succeeded", finishedAt: "2026-10-14T00:00:00.000Z" };
const kept = (store) => [...store.records.values()].filter((record) => record.kind !== "run_summary");

test("which runs the platform started: a harness, a scheduled execution and its verification, a module's run, a continuation", () => {
  for (const run of [{ automated: true }, { effectiveRouteReason: "autopilot:routine" }, { effectiveRouteReason: "autopilot:literature-sentinel" },
    { effectiveRouteReason: "autopilot:evidence:evidence-update" }, { effectiveRouteReason: "autopilot-verify" }, { effectiveRouteReason: "autopilot-verify:evidence" },
    { effectiveRouteReason: "geo:probe" }, { effectiveRouteReason: "vcr:analysis" }, { effectiveRouteReason: "platform-evolution" },
    { effectiveRouteReason: "loopx-continuation" }, { effectiveRouteReason: "adopted:runtime-ui:loopx-continuation" }]) {
    assert.equal(isPlatformStartedRun(run), true, JSON.stringify(run));
  }
  for (const run of [null, {}, { effectiveRouteReason: "adopted:runtime-ui" }, { effectiveRouteReason: "matched:safety-medicine" }, { effectiveRouteReason: "choice:vcr-protocol" },
    { effectiveRouteReason: "session-binding" }, { effectiveRouteReason: "llm:literature" }]) {
    assert.equal(isPlatformStartedRun(run), false, JSON.stringify(run));
  }
});

test("the dispatched requests of a conversation are every platform-started execution's, and never a person's", () => {
  const { runs } = reusedConversation("autopilot:routine", { personTypes: true });
  assert.deepEqual([...dispatchedRequestIdsOf(runs)].sort(), ["req_first", "req_second"]);
  assert.deepEqual([...dispatchedRequestIdsOf([])], []);
  assert.deepEqual([...dispatchedRequestIdsOf(null)], []);
});

test("every execution's instruction is refused by its request, not by its words, and a later one no differently from the first", () => {
  const { messages, runs } = reusedConversation("autopilot:routine");
  const dispatched = dispatchedRequestIdsOf(runs);
  const read = conversationMemorySources(messages, "s", { dispatchedRequestIds: dispatched });
  assert.deepEqual(read.sources.map((source) => source.role), ["assistant", "assistant"]);
  assert.deepEqual(read.excluded, [{ reason: "dispatched", count: 2 }]);
  // Before 2026-10-14 only the current run's request was refused, so the first execution's instruction was read as the person's.
  const currentOnly = conversationMemorySources(messages, "s", { dispatchedRequestIds: new Set(["req_second"]) });
  assert.equal(currentOnly.sources.filter((source) => source.role === "user").length, 1);
});

for (const reason of ["autopilot:routine", "autopilot:literature-sentinel", "autopilot:evidence-update", "autopilot:data-prospecting", "autopilot:evidence:evidence-update"]) {
  test(`a ${reason} execution learns nothing from its own instruction, first or later, and asks the model nothing`, async () => {
    const { messages, runs, current } = reusedConversation(reason);
    const store = new StoreDouble();
    let called = 0;
    const result = await extractor(store, { runs, onCall: () => { called += 1; } }).recordRun(project, { ...finished, ...current }, messages);
    assert.equal(called, 0, "no user text is left to extract from");
    assert.equal(result.extracted, 0);
    assert.deepEqual(kept(store), []);
    assert.deepEqual(result.excluded, [{ reason: "dispatched", count: 2 }]);
  });
}

test("what the person types into the task's conversation is theirs and is kept, and the dispatched instruction beside it is not", async () => {
  const { messages, runs, current } = reusedConversation("autopilot:routine", { personTypes: true });
  const store = new StoreDouble();
  let seen = [];
  const result = await extractor(store, { runs, onCall: (sources) => { seen = sources; } }).recordRun(project, { ...finished, ...current }, messages);
  assert.deepEqual(seen.filter((source) => source.role === "user").map((source) => source.text), ["以后简报里的文献一律按发表日期倒序。"]);
  assert.equal(result.extracted, 1, result.rejectionReasons.join(" | "));
  assert.deepEqual(kept(store).map((record) => record.key), ["preference.briefing.order"]);
});

test("a LoopX continuation is refused by the message's own source, and a scheduled execution of any dispatcher by its request", async () => {
  const messages = [
    user("m1", "继续推进目标：整理本周的随访数据。", "req_goal"),
    { info: { id: "m3", role: "user", source: "loopx-continuation", sourceRequestId: "req_loopx", turnStartSeq: 3 }, parts: [{ type: "text", text: "继续：根据上一轮结果推进目标。" }] },
    assistant("m4", "已更新。"),
  ];
  const read = conversationMemorySources(messages, "s", { dispatchedRequestIds: new Set(["req_goal"]) });
  assert.deepEqual(read.excluded.map((entry) => entry.reason).sort(), ["dispatched", "injected"]);
  assert.deepEqual(read.sources.map((source) => source.role), ["assistant"]);
});

test("a ledger that cannot be read leaves the current run's own dispatch refused and is audited, never failing the run", async () => {
  const { messages, runs, current } = reusedConversation("autopilot:routine");
  const audits = [];
  const intelligence = new MemoryIntelligence(config, new StoreDouble(), {
    dispatchedRequests: async () => { throw Object.assign(new Error("ledger"), { code: "agent_runs_too_large" }); },
    audit: async (event) => { audits.push(event); },
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] }),
  });
  const result = await intelligence.recordRun(project, { ...finished, ...current }, messages);
  assert.deepEqual(audits, ["memory.dispatched_requests"]);
  // Only the current run's request is known: the first execution's instruction stays readable until the ledger is back.
  assert.deepEqual(result.excluded, [{ reason: "dispatched", count: 1 }]);
  assert.equal(runs.length, 2);
});

// An independent verification of a scheduled task's claims is dispatched by the platform with `automated` unset (production:
// fourteen such runs on one account by 2026-10-14), so the route reason is the only structure there is. Every reason the
// dispatchers can write is named here from the constants that mint it, so a renamed route breaks this test and not memory.
const VERIFICATION_ROUTES = [VERIFICATION_ROUTE_REASON, EVIDENCE_PROGRAMME_VERIFICATION_ROUTE_REASON];
const SCHEDULED_ROUTES = [...["routine", "literature-sentinel", "evidence-update", "data-prospecting"].map((type) => `autopilot:${type}`),
  ...["evidence-update", "literature-sentinel"].map((type) => evidenceProgrammeRouteReason(type))];

test("every route reason the autopilot and the evidence programme mint is a run the platform started", () => {
  assert.equal(VERIFICATION_ROUTE_REASON, "autopilot-verify");
  assert.ok(EVIDENCE_PROGRAMME_ROUTE_REASON_PREFIX.startsWith("autopilot:"));
  for (const reason of [...VERIFICATION_ROUTES, ...SCHEDULED_ROUTES]) {
    assert.equal(isPlatformStartedRun({ effectiveRouteReason: reason }), true, reason);
    assert.equal(isPlatformStartedRun({ effectiveRouteReason: `adopted:runtime-ui:${reason}` }), false, "a person's turn adopted from the page is not a dispatch, whatever route it was given");
  }
});

for (const reason of VERIFICATION_ROUTES) {
  test(`a ${reason} run learns nothing from its dispatch: not through its request, not through its tag, and no model is asked`, async () => {
    const BRIEF = "核对上一轮研究报告中的三条结论是否被所引文献支持。";
    const messages = [
      user("m1", `<evimed-autopilot-verification>ep_1</evimed-autopilot-verification>\n<evimed-budget-scope>a.b</evimed-budget-scope>\n${BRIEF}`, "req_unrecorded"),
      assistant("m2", "三条结论均有出处。"),
      user("m3", BRIEF, "req_verify"),
      assistant("m4", "已复核。"),
    ];
    const current = { id: "run_verify", sessionId: "s", effectiveRouteReason: reason, kernelRequestIds: ["req_verify"] };
    const store = new StoreDouble();
    let called = 0;
    const result = await extractor(store, { runs: [], onCall: () => { called += 1; } }).recordRun(project, { ...finished, ...current }, messages);
    assert.equal(called, 0);
    assert.equal(result.extracted, 0);
    assert.deepEqual(kept(store), []);
    assert.deepEqual(result.excluded.map((entry) => entry.reason).sort(), ["dispatched", "injected"]);
  });
}
