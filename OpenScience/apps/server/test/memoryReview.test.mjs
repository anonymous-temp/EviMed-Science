import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_REVIEW_RULES, MemoryReview, REVIEWED_ORIGINS, reviewVerdicts, structuralVerdict } from "../src/memoryReview.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-key", deepseekBaseUrl: "https://api.deepseek.com",
  memoryExtractionModel: "deepseek-v4-flash", production: false };

/** @param {Partial<any>} fields */
const record = (fields) => ({ id: "rec_1", version: 1, kind: "project_fact", scope: "project", scopeId: "prj_1", key: "project.fact.a",
  value: "", summary: "", origin: "inferred", status: "active", revisions: [], evidence: [], ...fields });

/** A store with the review's three methods, recording what it was asked. @param {any[]} batch */
function store(batch, { conflictOn = null } = {}) {
  const calls = { unreviewed: [], noted: [], upserts: [] };
  return {
    calls,
    async unreviewedRecords(/** @type {string} */ userId, /** @type {string} */ rules, /** @type {any} */ options) {
      calls.unreviewed.push({ userId, rules, options }); return batch;
    },
    async noteReviewed(/** @type {string} */ userId, /** @type {string} */ rules, /** @type {any[]} */ verdicts) {
      calls.noted.push({ userId, rules, verdicts }); return verdicts.length;
    },
    async upsertRecord(/** @type {string} */ userId, /** @type {any} */ input, /** @type {any} */ evidence, /** @type {any} */ options) {
      if (input.id === conflictOn) throw Object.assign(new Error("changed"), { code: "memory_conflict" });
      calls.upserts.push({ userId, input, options }); return input;
    },
  };
}

/** A provider that answers the review with `forget`. @param {unknown} forget */
function provider(forget) {
  const requests = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ forget }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  };
  return { requests, fetchImpl: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)) };
}

test("the model's verdicts count only for memories it was shown and reasons the rules name; anything else keeps the memory", () => {
  const batch = [{ id: "rec_1" }, { id: "rec_2" }, { id: "rec_3" }];
  const verdicts = reviewVerdicts(JSON.stringify({ forget: [
    { id: "rec_1", reason: "platform" }, { id: "rec_9", reason: "platform" }, { id: "rec_2", reason: "because" }, { id: "rec_3", reason: "report_content" },
  ] }), batch);
  assert.deepEqual([...verdicts], [["rec_1", "platform"], ["rec_3", "report_content"]]);
  assert.equal(reviewVerdicts("not json", batch).size, 0);
  assert.equal(reviewVerdicts(JSON.stringify({ keep: ["rec_1"] }), batch).size, 0);
});

test("a memory the rules would not write now is forgotten the way a researcher forgets one, and every memory read is noted", async () => {
  const batch = [
    record({ id: "rec_1", summary: "平台现有三份病种知识包：非小细胞肺癌、乳腺癌、2 型糖尿病。" }),
    record({ id: "rec_2", summary: "本项目研究利妥昔单抗治疗儿童激素敏感型肾病综合征。", version: 3 }),
  ];
  const memory = store(batch);
  const { requests, fetchImpl } = provider([{ id: "rec_1", reason: "platform" }]);
  const result = await new MemoryReview(config, memory, { fetchImpl }).review("u1", { projectId: "prj_1", runId: "run_1" });

  assert.equal(result.read, 2);
  assert.deepEqual(result.forgotten, [{ id: "rec_1", kind: "project_fact", scope: "project", reason: "platform" }]);
  assert.equal(memory.calls.upserts.length, 1);
  assert.equal(memory.calls.upserts[0].input.status, "archived");
  assert.equal(memory.calls.upserts[0].options.by, "system", "the platform's own reading, never told as the researcher's");
  assert.equal(memory.calls.upserts[0].options.expectedVersion, 1);
  assert.match(memory.calls.upserts[0].options.reason, /platform$/);
  assert.deepEqual(memory.calls.noted[0].verdicts, [{ id: "rec_1", kept: false, reason: "platform" }, { id: "rec_2", kept: true, reason: "" }]);
  assert.equal(memory.calls.noted[0].rules, MEMORY_REVIEW_RULES);
  // What the model was shown: the sentence, the kind and whose it is — never an id it could not have been given.
  const shown = JSON.parse(requests[0].messages[1].content).memories;
  assert.deepEqual(shown.map((/** @type {any} */ item) => item.id), ["rec_1", "rec_2"]);
  assert.equal(shown[1].scope, "project");
  assert.equal(requests[0].temperature, 0);
});

test("a memory that changed while it was read is neither forgotten nor noted, so it is read again next time", async () => {
  const memory = store([record({ id: "rec_1" }), record({ id: "rec_2" })], { conflictOn: "rec_1" });
  const { fetchImpl } = provider([{ id: "rec_1", reason: "run_state" }, { id: "rec_2", reason: "duplicate" }]);
  const result = await new MemoryReview(config, memory, { fetchImpl }).review("u1", { projectId: "prj_1" });
  assert.deepEqual(result.forgotten.map((item) => item.id), ["rec_2"]);
  assert.deepEqual(memory.calls.noted[0].verdicts.map((/** @type {any} */ item) => item.id), ["rec_2"]);
});

test("a dry reading reports what it would forget and changes nothing", async () => {
  const memory = store([record({ id: "rec_1" })]);
  const { fetchImpl } = provider([{ id: "rec_1", reason: "source_detail" }]);
  const result = await new MemoryReview(config, memory, { fetchImpl }).review("u1", { projectId: "prj_1", apply: false });
  assert.deepEqual(result.forgotten, [{ id: "rec_1", kind: "project_fact", scope: "project", reason: "source_detail" }]);
  assert.equal(memory.calls.upserts.length, 0);
  assert.equal(memory.calls.noted.length, 0);
});

test("nothing is read without a store that keeps readings, without a model, or with nothing left to read", async () => {
  const { requests, fetchImpl } = provider([]);
  assert.deepEqual(await new MemoryReview(config, { upsertRecord() {} }, { fetchImpl }).review("u1", { projectId: "p" }), { read: 0, forgotten: [] });
  assert.deepEqual(await new MemoryReview({ ...config, deepseekApiKey: "" }, store([record({})]), { fetchImpl }).review("u1", { projectId: "p" }), { read: 0, forgotten: [] });
  assert.deepEqual(await new MemoryReview(config, store([]), { fetchImpl }).review("u1", { projectId: "p" }), { read: 0, forgotten: [] });
  assert.equal(requests.length, 0);
});

test("what rests on the assistant's words or on a platform dispatch is decided in code, from who wrote the quoted message", () => {
  // Extraction wrote origin system only from an assistant or tool source: nothing the person said, whatever the voices say.
  assert.equal(structuralVerdict(record({ origin: "system" }), null), "assistant_text");
  assert.equal(structuralVerdict(record({ origin: "system", evidence: [{}] }), ["person"]), "assistant_text");
  // Every observation placed, none of them the person's: the assistant's, or the platform's when any is a dispatch.
  assert.equal(structuralVerdict(record({ evidence: [{}, {}] }), ["assistant", "assistant"]), "assistant_text");
  assert.equal(structuralVerdict(record({ origin: "explicit", evidence: [{}, {}] }), ["dispatched", "dispatched"]), "dispatched_instruction");
  assert.equal(structuralVerdict(record({ origin: "explicit", evidence: [{}, {}] }), ["assistant", "dispatched"]), "dispatched_instruction");
  // One observation of the person's own, or one nothing can place, keeps the memory; so does no answer at all.
  assert.equal(structuralVerdict(record({ evidence: [{}, {}] }), ["dispatched", "person"]), null);
  assert.equal(structuralVerdict(record({ evidence: [{}, {}] }), ["dispatched", "unknown"]), null);
  assert.equal(structuralVerdict(record({ evidence: [{}, {}] }), ["dispatched"]), null, "an answer that does not cover the evidence decides nothing");
  assert.equal(structuralVerdict(record({ evidence: [{}] }), null), null);
  assert.equal(structuralVerdict(record({ evidence: [] }), []), null);
});

test("a reading asks for the researcher's own readings too, decides the structural ones without a model, and sends the model only what the platform inferred", async () => {
  const batch = [
    record({ id: "rec_sys", origin: "system", kind: "follow_up", summary: "研究终点设计需加入 NT-proBNP 变化", evidence: [{ sourceRef: "sessions/s/messages/seq_2", quote: "研究终点设计需加入 NT-proBNP 变化" }] }),
    record({ id: "rec_task", origin: "explicit", kind: "behavior", scope: "user", summary: "每天早上检索新文献并整理成简报", evidence: [{ sourceRef: "sessions/s/messages/seq_8", quote: "每天早上检索新文献" }] }),
    record({ id: "rec_own", origin: "explicit", kind: "preference", scope: "user", summary: "报告一律用中文", evidence: [{ sourceRef: "sessions/s/messages/seq_9", quote: "报告一律用中文" }] }),
    record({ id: "rec_inferred", origin: "inferred", summary: "本项目研究利妥昔单抗", evidence: [{ sourceRef: "sessions/s/messages/seq_10", quote: "我们在做利妥昔单抗" }] }),
    record({ id: "rec_report", origin: "inferred", summary: "ROR 为 3.42", evidence: [{ sourceRef: "sessions/s/messages/seq_11", quote: "ROR 为 3.42" }] }),
  ];
  const voices = { seq_8: ["dispatched"], seq_9: ["person"], seq_10: ["person"], seq_11: ["person"] };
  const memory = store(batch);
  const asked = [];
  const { requests, fetchImpl } = provider([{ id: "rec_report", reason: "report_content" }]);
  const result = await new MemoryReview(config, memory, { fetchImpl, evidenceProvenance: () => async (_user, item) => {
    asked.push(item.id); return voices[item.evidence[0].sourceRef.split("/").at(-1)];
  } }).review("u1", { projectId: "prj_1", runId: "run_1" });

  assert.deepEqual(memory.calls.unreviewed[0].options.origins, [...REVIEWED_ORIGINS]);
  assert.ok(REVIEWED_ORIGINS.includes("explicit"));
  // The model saw the two inferred memories and neither the assistant-grounded one nor the researcher's own words.
  assert.deepEqual(JSON.parse(requests[0].messages[1].content).memories.map((/** @type {any} */ item) => item.id), ["rec_inferred", "rec_report"]);
  assert.equal(requests.length, 1);
  assert.deepEqual(asked, ["rec_task", "rec_own", "rec_inferred", "rec_report"], "an origin-system memory needs no reader: nothing the person said can be under it");
  assert.deepEqual(result.forgotten.map((item) => [item.id, item.reason]), [["rec_sys", "assistant_text"], ["rec_task", "dispatched_instruction"], ["rec_report", "report_content"]]);
  // Forgotten the way the researcher forgets one: archived by the platform, restorable, never deleted.
  assert.deepEqual(memory.calls.upserts.map((call) => [call.input.id, call.input.status, call.options.by]), [["rec_sys", "archived", "system"], ["rec_task", "archived", "system"], ["rec_report", "archived", "system"]]);
  assert.match(memory.calls.upserts[1].options.reason, /dispatched_instruction$/);
  assert.deepEqual(memory.calls.noted[0].verdicts.map((/** @type {any} */ item) => [item.id, item.kept, item.reason]), [
    ["rec_sys", false, "assistant_text"], ["rec_task", false, "dispatched_instruction"], ["rec_own", true, ""], ["rec_inferred", true, ""], ["rec_report", false, "report_content"],
  ]);
  // The model is shown the words the memory rests on.
  assert.equal(JSON.parse(requests[0].messages[1].content).memories[0].quote, "我们在做利妥昔单抗");
});

test("a researcher's own words are never put to the model, and a reader that fails or cannot place a message keeps the memory", async () => {
  const batch = [
    record({ id: "rec_a", origin: "explicit", kind: "preference", scope: "user", summary: "报告一律用中文", evidence: [{ sourceRef: "sessions/s/messages/seq_1" }] }),
    record({ id: "rec_b", origin: "explicit", kind: "preference", scope: "user", summary: "引用用 Vancouver", evidence: [{ sourceRef: "sessions/s/messages/seq_2" }] }),
    record({ id: "rec_c", origin: "explicit", kind: "preference", scope: "user", summary: "统计用 R", evidence: [{ sourceRef: "sessions/s/messages/seq_3" }] }),
  ];
  const audits = [];
  const memory = store(batch);
  const { requests, fetchImpl } = provider([{ id: "rec_a", reason: "platform" }]);
  const review = new MemoryReview(config, memory, { fetchImpl, audit: (event) => { audits.push(event); }, evidenceProvenance: () => async (_user, item) => {
    if (item.id === "rec_a") throw new Error("ledger gone");
    return item.id === "rec_b" ? ["unknown"] : ["person"];
  } });
  const result = await review.review("u1", { projectId: "prj_1" });
  assert.deepEqual(result.forgotten, []);
  assert.equal(requests.length, 0, "an explicit memory is not the model's to judge");
  assert.deepEqual(audits, ["memory.review.provenance"]);
  assert.equal(memory.calls.noted[0].verdicts.length, 3);
  // Without any reader only origin system is decided in code.
  const bare = store([record({ id: "rec_x", origin: "explicit", kind: "behavior", scope: "user" }), record({ id: "rec_y", origin: "system" })]);
  const bareResult = await new MemoryReview(config, bare, { fetchImpl }).review("u1", { projectId: "prj_1" });
  assert.deepEqual(bareResult.forgotten.map((item) => item.id), ["rec_y"]);
});

test("the rules a reading is made under change with the structural rules, and a dry reading reports the code's verdicts too", async () => {
  assert.match(MEMORY_REVIEW_RULES, /^[0-9a-f]{16}$/);
  const memory = store([record({ id: "rec_sys", origin: "system" })]);
  const { requests, fetchImpl } = provider([]);
  const result = await new MemoryReview(config, memory, { fetchImpl }).review("u1", { projectId: "prj_1", apply: false });
  assert.deepEqual(result.forgotten, [{ id: "rec_sys", kind: "project_fact", scope: "project", reason: "assistant_text" }]);
  assert.equal(memory.calls.upserts.length, 0);
  assert.equal(memory.calls.noted.length, 0);
  assert.equal(requests.length, 0);
});
