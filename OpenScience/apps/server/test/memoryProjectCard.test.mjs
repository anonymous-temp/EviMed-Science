// What extraction does with the project card (2026-10-12): a described study is kept under the card's own keys, the specialty
// is one of the frontier feed's twenty-one, and only the researcher's own message fills a slot. The live replay that chose the
// instruction's wording is `evals/memory-write-quality` (the project-card cases); what is here needs no model.
import assert from "node:assert/strict";
import test from "node:test";

import { FRONTIER_SPECIALTY_LABELS_ZH, PROJECT_CARD_SLOTS } from "@evimed/domain";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";

const config = {
  deepseekProviderEnabled: true,
  deepseekApiKey: "unit-test-key",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  memoryExtractionEnabled: true,
  memoryExtractionTimeoutMs: 1_000,
};

class StoreDouble {
  constructor() { this.records = new Map(); this.configured = false; }
  async listRecords() { return [...this.records.values()]; }
  async upsertRecord(_userId, input) {
    const stored = { ...input, id: input.key, version: 1, revisions: [], evidence: [], evidenceCount: 0 };
    this.records.set([input.scope, input.scopeId ?? "", input.kind, input.key].join("\u0000"), stored);
    return stored;
  }
  async getRecord() { throw Object.assign(new Error("not found"), { code: "memory_not_found" }); }
}

const project = { id: "af-2026", userId: "usr_1" };
const run = { id: "run_1", sessionId: "session_1", status: "succeeded", finishedAt: "2026-10-12T01:10:00.000Z" };
const message = (id, text, role = "user") => ({ info: { id, role }, parts: [{ type: "text", text }] });
const STUDY = "我们课题是 75 岁以上非瓣膜性房颤患者，比较新型口服抗凝药和华法林，主要结局是大出血，设计是回顾性队列。";

/** One extraction that returns `candidates`, each citing the message named by `from` (the first user message by default). */
function extract(store, candidates, conversation = [message("u1", STUDY), message("a1", "明白，我先列分析计划的要点。", "assistant")]) {
  /** @type {any} */ const seen = {};
  const intelligence = new MemoryIntelligence(config, store, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init.body));
      seen.instructions = body.messages[0].content;
      const sources = JSON.parse(body.messages[1].content).sources;
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        candidates: candidates.map(({ from = "user", quote, ...candidate }) => {
          const source = sources.find((item) => item.role === from);
          return { scope: "project", kind: "project_fact", origin: "explicit", importance: 0.7, sensitive: false,
            sourceRef: source.sourceRef, evidenceQuote: quote ?? source.text.slice(0, 14), summary: String(candidate.value), ...candidate };
        }),
      }) } }] });
    },
  });
  return intelligence.recordRun(project, run, conversation).then((result) => ({ result, seen }));
}

const written = (store) => [...store.records.values()].filter((record) => record.kind !== "run_summary");

test("the extraction instructions name the card's keys and the closed list a project's field is chosen from", async () => {
  const { seen } = await extract(new StoreDouble(), []);
  for (const slot of PROJECT_CARD_SLOTS) assert.match(seen.instructions, new RegExp(`project\\.${slot}\\b`), `${slot} is named`);
  for (const label of Object.values(FRONTIER_SPECIALTY_LABELS_ZH)) assert.ok(seen.instructions.includes(label), `${label} is on the list`);
  // The line that keeps a question from becoming a study (the replay's one regression).
  assert.match(seen.instructions, /A research direction is a profile, and what they ask you to look up or answer is a question/);
});

test("a described study is kept under the card's keys, and the specialty is stored as one name", async () => {
  const store = new StoreDouble();
  const { result } = await extract(store, [
    { key: "project.field", value: "cardiology" },
    { key: "project.population", value: "75 岁以上非瓣膜性房颤患者" },
    { key: "project.outcome", value: "大出血", quote: "主要结局是大出血" },
    { key: "project.design", value: "回顾性队列", quote: "设计是回顾性队列" },
  ]);
  assert.equal(result.extracted, 4, result.rejectionReasons.join(" | "));
  const byKey = Object.fromEntries(written(store).map((record) => [record.key, record.value]));
  assert.equal(byKey["project.field"], "心血管", "the vocabulary's own id is stored as its name");
  assert.equal(byKey["project.population"], "75 岁以上非瓣膜性房颤患者");
});

test("a field off the list, or more than three, is dropped and the rest of the card is kept", async () => {
  const store = new StoreDouble();
  const { result } = await extract(store, [
    { key: "project.field", value: "口腔正畸" },
    { key: "project.population", value: "75 岁以上非瓣膜性房颤患者" },
  ]);
  assert.equal(result.extracted, 1);
  assert.match(result.rejectionReasons.join(" "), /"project\.field" must name one to 3 specialties from the closed list/);
  assert.deepEqual(written(store).map((record) => record.key), ["project.population"]);

  const crowded = new StoreDouble();
  const many = await extract(crowded, [{ key: "project.field", value: "心血管、肿瘤、神经、儿科" }]);
  assert.equal(many.result.extracted, 0);
  const two = new StoreDouble();
  await extract(two, [{ key: "project.field", value: "内分泌代谢、肾脏" }]);
  assert.equal(written(two)[0].value, "内分泌代谢、肾脏");
});

test("only the researcher's own message fills a slot: a trial an assistant summarised stays under a key of its own", async () => {
  const store = new StoreDouble();
  const conversation = [message("u1", "把 GLORY-1 的关键信息整理一下，后面写文章要用。"),
    message("a1", "GLORY-1 是玛仕度肽在中国成人超重或肥胖人群中的 3 期试验，每周一次皮下注射。", "assistant")];
  const { result } = await extract(store, [
    { key: "project.population", value: "中国成人超重或肥胖人群", origin: "system", from: "assistant", quote: "中国成人超重或肥胖人群中的 3 期试验" },
    { key: "project.glory1.study_shape", value: "GLORY-1 为 3 期试验", origin: "system", from: "assistant", quote: "3 期试验" },
  ], conversation);
  assert.equal(result.extracted, 1, result.rejectionReasons.join(" | "));
  assert.match(result.rejectionReasons.join(" "), /"project\.population" is a slot of the project card, which only the researcher's own message fills/);
  assert.deepEqual(written(store).map((record) => record.key), ["project.glory1.study_shape"]);
});

test("the card's keys carry nothing new for the kinds and scopes that already had rules", async () => {
  // The catch-all project still has no single subject, whatever the key.
  const shared = new StoreDouble();
  const inDefault = await new MemoryIntelligence(config, shared, {
    fetchImpl: async (_input, init) => {
      const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [{
        scope: "project", kind: "project_fact", key: "project.population", value: "房颤患者", summary: "房颤患者", origin: "explicit", importance: 0.6, sensitive: false,
        sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text.slice(0, 8) }] }) } }] });
    },
  }).recordRun({ id: "default", userId: "usr_1" }, run, [message("u1", STUDY)]);
  assert.equal(inDefault.extracted, 0);
  assert.match(inDefault.rejectionReasons.join(" "), /catch-all project/);
});
