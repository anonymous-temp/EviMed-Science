import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_REVIEW_RULES, MemoryReview, reviewVerdicts } from "../src/memoryReview.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-key", deepseekBaseUrl: "https://api.deepseek.com",
  memoryExtractionModel: "deepseek-v4-flash", production: false };

/** @param {Partial<any>} fields */
const record = (fields) => ({ id: "rec_1", version: 1, kind: "project_fact", scope: "project", scopeId: "prj_1", key: "project.fact.a",
  value: "", summary: "", origin: "system", status: "active", revisions: [], evidence: [], ...fields });

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
