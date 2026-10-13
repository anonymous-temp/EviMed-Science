// What extraction does with the project card (2026-10-12; general since 2026-10-13): the work a researcher describes — a study, a
// refactor, a launch plan — is kept under the card's own keys, the clinical elements are an extension written only when stated,
// the field is the researcher's own words, and only the researcher's own message fills a slot. The live replay that chose the
// instruction's wording is `evals/memory-write-quality` (the project-card cases); what is here needs no model.
import assert from "node:assert/strict";
import test from "node:test";

import { FRONTIER_SPECIALTY_LABELS_ZH, PROJECT_CARD_CLINICAL_SLOTS, PROJECT_CARD_GENERAL_SLOTS } from "@evimed/domain";
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
  constructor(seed = []) {
    this.records = new Map(); this.configured = false;
    for (const record of seed) this.records.set([record.scope, record.scopeId ?? "", record.kind, record.key].join("\u0000"), { id: record.key, version: 1, revisions: [], evidence: [], evidenceCount: 0, status: "active", ...record });
  }
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

const written = (store) => [...store.records.values()].filter((record) => record.kind !== "run_summary" && !record.seeded);
const SOFTWARE = "我们在重构支付服务：目标是把单体拆成三个服务，十一月底前必须切完，现在在写迁移方案。";

test("the extraction instructions name the general slots for any kind of work, the clinical elements as an extension, and no list to choose a field from", async () => {
  const { seen } = await extract(new StoreDouble(), []);
  for (const slot of PROJECT_CARD_GENERAL_SLOTS) assert.match(seen.instructions, new RegExp(`project\\.${slot}\\b`), `${slot} is named`);
  for (const slot of PROJECT_CARD_CLINICAL_SLOTS) assert.match(seen.instructions, new RegExp(`project\\.${slot}\\b`), `${slot} is named, as an extension`);
  assert.match(seen.instructions, /Only when they describe a clinical or epidemiological study, also record the elements of it they stated/);
  assert.match(seen.instructions, /project\.ext\.<one lowercase word>/);
  assert.match(seen.instructions, /a software refactor/);
  // The medical specialties are no longer the field's vocabulary: the list is not in the instructions.
  assert.ok(!Object.values(FRONTIER_SPECIALTY_LABELS_ZH).slice(0, 6).every((label) => seen.instructions.includes(label)), "the closed list of specialties is gone");
  assert.match(seen.instructions, /there is no list to choose from/);
  // The line that keeps a question from becoming a project (the replay's one regression).
  assert.match(seen.instructions, /A research direction is a profile, and what they ask you to look up or answer is a question/);
});

test("a software refactor is a project with a card: goal, subject, stage and constraints, and a field no medical list holds", async () => {
  const store = new StoreDouble();
  const { result } = await extract(store, [
    { key: "project.field", value: "后端架构 / 支付系统", quote: "重构支付服务" },
    { key: "project.goal", value: "把单体拆成三个服务", quote: "把单体拆成三个服务" },
    { key: "project.subject", value: "支付服务", quote: "支付服务" },
    { key: "project.constraints", value: "十一月底前必须切完", quote: "十一月底前必须切完" },
    { key: "project.stage", value: "在写迁移方案", quote: "现在在写迁移方案" },
    { key: "project.ext.interface", value: "对外接口保持不变", quote: "把单体拆成三个服务" },
  ], [message("u1", SOFTWARE), message("a1", "好的，先列迁移方案的要点。", "assistant")]);
  assert.equal(result.extracted, 6, result.rejectionReasons.join(" | "));
  const byKey = Object.fromEntries(written(store).map((record) => [record.key, record.value]));
  assert.equal(byKey["project.field"], "后端架构、支付系统");
  assert.equal(byKey["project.goal"], "把单体拆成三个服务");
  assert.equal(byKey["project.ext.interface"], "对外接口保持不变");
});

test("a described study is kept under the card's keys, the clinical elements among them, and the field stored under the feed's name when it is one", async () => {
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

test("a field the medical list does not hold is kept, a sentence is no field, and either way the rest of the card is kept", async () => {
  const store = new StoreDouble();
  const { result } = await extract(store, [
    { key: "project.field", value: "口腔正畸" },
    { key: "project.population", value: "75 岁以上非瓣膜性房颤患者" },
  ]);
  assert.equal(result.extracted, 2, result.rejectionReasons.join(" | "));
  assert.deepEqual(written(store).map((record) => [record.key, record.value]), [["project.field", "口腔正畸"], ["project.population", "75 岁以上非瓣膜性房颤患者"]]);

  const sentence = new StoreDouble();
  const bad = await extract(sentence, [
    { key: "project.field", value: "比较新型口服抗凝药和华法林在 75 岁以上非瓣膜性房颤患者里的大出血风险，设计是回顾性队列" },
    { key: "project.population", value: "75 岁以上非瓣膜性房颤患者" },
  ]);
  assert.equal(bad.result.extracted, 1);
  assert.match(bad.result.rejectionReasons.join(" "), /"project\.field" must be one to 3 short phrases naming the field of the work, not a sentence/);
  assert.deepEqual(written(sentence).map((record) => record.key), ["project.population"]);

  const crowded = new StoreDouble();
  const many = await extract(crowded, [{ key: "project.field", value: "心血管、肿瘤、神经、儿科" }]);
  assert.equal(many.result.extracted, 1, "more than three keep the first three");
  assert.equal(written(crowded)[0].value, "心血管、肿瘤、神经");
});

test("an extension is checked for the shape of its name and the length of its value, and for nothing else", async () => {
  const store = new StoreDouble();
  const { result } = await extract(store, [
    { key: "project.ext.audience", value: "临床内科医生" },
    { key: "project.ext.peer_venue", value: "拟投 Heart 或 JACC 的子刊" },
    { key: "project.ext.Bad Name", value: "读者" },
    { key: "project.ext.a.b", value: "读者" },
    { key: "project.ext.venue", value: "长".repeat(600) },
  ]);
  assert.equal(result.extracted, 2, result.rejectionReasons.join(" | "));
  assert.deepEqual(written(store).map((record) => record.key), ["project.ext.audience", "project.ext.peer_venue"]);
  assert.match(result.rejectionReasons.join(" "), /is not a card extension/);
  assert.match(result.rejectionReasons.join(" "), /longer than a card shows/);
});

test("only the researcher's own message fills a slot: a trial an assistant summarised stays under a key of its own", async () => {
  const store = new StoreDouble();
  const conversation = [message("u1", "把 GLORY-1 的关键信息整理一下，后面写文章要用。"),
    message("a1", "GLORY-1 是玛仕度肽在中国成人超重或肥胖人群中的 3 期试验，每周一次皮下注射。", "assistant")];
  const { result } = await extract(store, [
    { key: "project.population", value: "中国成人超重或肥胖人群", origin: "system", from: "assistant", quote: "中国成人超重或肥胖人群中的 3 期试验" },
    { key: "project.ext.audience", value: "中国成人", origin: "system", from: "assistant", quote: "中国成人超重或肥胖人群" },
    { key: "project.glory1.study_shape", value: "GLORY-1 为 3 期试验", origin: "system", from: "assistant", quote: "3 期试验" },
  ], conversation);
  assert.equal(result.extracted, 1, result.rejectionReasons.join(" | "));
  assert.match(result.rejectionReasons.join(" "), /"project\.population" is a slot of the project card, which only the researcher's own message fills/);
  assert.match(result.rejectionReasons.join(" "), /"project\.ext\.audience" is a slot of the project card/);
  assert.deepEqual(written(store).map((record) => record.key), ["project.glory1.study_shape"]);
});

const seeded = (key, value, origin) => ({ scope: "project", scopeId: project.id, kind: "project_fact", key, value, summary: value, origin, seeded: true });

test("a weaker basis never replaces a stronger one on the card: the researcher's own edit of the field stands against a later reading", async () => {
  // They corrected the field on the memory page (manual); a later conversation's reading, inferred or stated, does not overwrite it.
  const edited = new StoreDouble([seeded("project.field", "后端架构", "manual")]);
  const first = await extract(edited, [{ key: "project.field", value: "金融科技", origin: "inferred" }], [message("u1", SOFTWARE)]);
  assert.equal(first.result.extracted, 0);
  assert.match(first.result.rejectionReasons.join(" "), /"project\.field" was set by the researcher \(manual\)/);
  assert.equal(edited.records.get(["project", project.id, "project_fact", "project.field"].join("\u0000")).value, "后端架构");
  const second = await extract(edited, [{ key: "project.field", value: "金融科技", origin: "explicit" }], [message("u1", SOFTWARE)]);
  assert.equal(second.result.extracted, 0, "a statement ranks below a hand edit");

  // The same value seen again is evidence, kept; an inference does not replace what they said outright.
  const stated = new StoreDouble([seeded("project.stage", "在写迁移方案", "explicit")]);
  const again = await extract(stated, [{ key: "project.stage", value: "在写迁移方案", origin: "inferred", quote: "现在在写迁移方案" }], [message("u1", SOFTWARE)]);
  assert.equal(again.result.extracted, 1, again.result.rejectionReasons.join(" | "));
  const guess = await extract(stated, [{ key: "project.stage", value: "已经切完", origin: "inferred", quote: "现在在写迁移方案" }], [message("u1", SOFTWARE)]);
  assert.equal(guess.result.extracted, 0);

  // Their own later word moves a stated slot, and replaces an inference.
  const moved = await extract(stated, [{ key: "project.stage", value: "迁移已完成一半", origin: "explicit", quote: "现在在写迁移方案" }], [message("u1", SOFTWARE)]);
  assert.equal(moved.result.extracted, 1, moved.result.rejectionReasons.join(" | "));
  const inferred = new StoreDouble([seeded("project.field", "后端架构", "inferred")]);
  const replaced = await extract(inferred, [{ key: "project.field", value: "支付系统", origin: "explicit", quote: "重构支付服务" }], [message("u1", SOFTWARE)]);
  assert.equal(replaced.result.extracted, 1, replaced.result.rejectionReasons.join(" | "));
});

test("the card's keys carry nothing new for the kinds and scopes that already had rules", async () => {
  // The catch-all project still has no single subject, whatever the key.
  const shared = new StoreDouble();
  const inDefault = await new MemoryIntelligence(config, shared, {
    fetchImpl: async (_input, init) => {
      const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [{
        scope: "project", kind: "project_fact", key: "project.goal", value: "拆服务", summary: "拆服务", origin: "explicit", importance: 0.6, sensitive: false,
        sourceRef: sources[0].sourceRef, evidenceQuote: sources[0].text.slice(0, 8) }] }) } }] });
    },
  }).recordRun({ id: "default", userId: "usr_1" }, run, [message("u1", SOFTWARE)]);
  assert.equal(inDefault.extracted, 0);
  assert.match(inDefault.rejectionReasons.join(" "), /catch-all project/);
});
