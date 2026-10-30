// The study facts step and the faithfulness check in the pipeline (c3-faith, 2026-10-25), against a real PostgreSQL: facts made once per
// text, a mismatching 导读 repaired or cut, the previous accepted text kept when nothing would be left, the outcome in
// editor_diagnostics.faith and never served, nothing asked when the levers are off or the genre is not a study's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION } from "../src/frontierEditor.mjs";
import { FRONTIER_FAITH_VERSION } from "../src/frontierFaith.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { FRONTIER_STUDY_FACTS_VERSION } from "../src/frontierStudyFacts.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const operator = `frontier_op_${randomUUID().slice(0, 8)}`;
const owner = { userId: operator, projectId: "evimed-frontier" };
const vocabulary = frontierVocabularyView(TEST_VOCABULARY);
const NOW = new Date("2026-10-24T04:00:00Z");

/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateUsageLedger(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development'),($2,'Operator','development')", [reader.id, operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[reader.id, operator]]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.events");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await insertSource(database, "nejm");
  await insertSource(database, "wx", { name: "NEJM医学前沿", lane: "mixed", source_type: "media" });
});

/** @param {string} id @param {Record<string, any>} columns @param {Record<string, any>} [texts] */
async function set(id, columns, texts = {}) {
  for (const [table, values, key] of [["items", columns, "id"], ["item_texts", texts, "item_id"]]) {
    const names = Object.keys(values);
    if (!names.length) continue;
    await database.query(`UPDATE evimed_frontier.${table} SET ${names.map((name, index) => `${name} = $${index + 2}`).join(", ")} WHERE ${key} = $1`,
      [id, ...names.map((name) => (values[name] !== null && typeof values[name] === "object" && !Array.isArray(values[name]) ? JSON.stringify(values[name]) : values[name]))]);
  }
}

const ABSTRACT = [
  "Background: Oral drug X may lower LDL cholesterol.",
  "Methods: In a double-blind randomised trial, 1200 adults aged 40 years or older were assigned to drug X or placebo for 12 weeks.",
  "Results: The primary end point, LDL change, was lower with drug X than with placebo (24% vs 3%; P<0.001).",
  "Conclusions: These results suggest that drug X may be useful in adults at risk; confirmation is needed.",
].join("\n\n");
const QUOTE = "was lower with drug X than with placebo (24% vs 3%; P<0.001)";
const GOOD = "一项随机对照试验纳入 1200 名成人，药物 X 较安慰剂降低 LDL（24% 对 3%）。";
const BAD = "一项随机对照试验纳入 1200 名成人。药物 X 与安慰剂相比无显著差异。";

const FACTS = {
  design: "rct", design_quote: "In a double-blind randomised trial", n: 1200,
  population_text: "40 岁及以上成人", population_quote: "1200 adults aged 40 years or older", species: "human", age: "adult", sex: "not-stated",
  intervention_text: "药物 X", intervention_quote: "assigned to drug X or placebo",
  comparator_text: "安慰剂", comparator_quote: "assigned to drug X or placebo", comparator_kind: "placebo",
  endpoint_text: "LDL 变化", endpoint_quote: "The primary end point, LDL change",
  direction: "favours-intervention", direction_quote: QUOTE,
  certainty: "suggestive", certainty_quote: "These results suggest that drug X may be useful in adults at risk",
  spin_present: false, spin_reason: "结论与主要终点一致", spin_quote: null,
};

/**
 * An editor that writes `lead` for a 导读 and answers the facts, the claim reader, the source check and the repair by their
 * instructions. `counts` says how often each was asked.
 * @param {{ lead: string, repair?: string | null, claims?: (text: string) => any }} behaviour
 */
function faithEditor(behaviour) {
  const counts = { facts: 0, claims: 0, verify: 0, repair: 0, brief: 0 };
  return {
    owner, available: true, timeZone: "Asia/Shanghai", model: "deepseek-flash", counts,
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ _input, /** @type {number} */ _max, /** @type {any} */ opts) {
      if (!instructions.includes("「AI 导读」")) return { verification: "passed", output: {}, error: null };
      const checked = opts.verify({ lead_zh: behaviour.lead });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson(/** @type {any[]} */ messages) {
      const system = String(messages[0].content);
      if (system.includes("研究设计审读员")) { counts.facts += 1; return FACTS; }
      if (system.includes("稿件已经按句编号")) {
        counts.claims += 1;
        const text = String(messages[1].content);
        // The numbered sentence that says "no difference" is read as the primary result's direction.
        const hit = text.split("\n").map((line) => /^(\d+)\. .*无显著差异/.exec(line)).find(Boolean);
        return behaviour.claims ? behaviour.claims(text) : (hit ? { s: [{ i: Number(hit[1]), direction: "no-difference", scope: "primary", direction_w: "无显著差异" }] } : { s: [] });
      }
      if (system.includes("被怀疑")) { counts.verify += 1; return { v: [{ i: 1, verdict: "misstated", quote: QUOTE }] }; }
      if (system.includes("「AI 导读」")) { counts.repair += 1; return behaviour.repair === null || behaviour.repair === undefined ? { lead_zh: "" } : { lead_zh: behaviour.repair }; }
      if (system.includes("「要点」")) { counts.brief += 1; return { points: {} }; }
      return { drop: [] };
    },
    async screen() { return { verdicts: new Map(), errors: new Map(), calls: 0 }; },
    async edit() { throw new Error("not in this test"); },
    async translateBody(/** @type {any} */ input) { return { paragraphs: input.paragraphs.map(() => null), complete: false, calls: 0, error: null }; },
  };
}

/** @param {any} editor @param {Record<string, any>} [config] */
function pipelineFor(editor, config = {}) {
  return new FrontierPipeline({ database, editor, plugin: { text: async () => ({ status: "pending" }) }, embedder: null, now: () => NOW,
    workerId: `test-${randomUUID()}`, glossary: new FrontierGlossary([]),
    config: { kbEmbeddingDimension: 1024, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, frontierSelectThreshold: 80,
      frontierStudyFactsEnabled: true, frontierFaithEnabled: true, ...config } });
}

async function paper(extra = {}) {
  const item = await insertItem(database, { title: "Oral drug X versus placebo for LDL", summaryZh: "卡片摘要。", selected: true, visibleAt: "2026-10-23T00:00:00Z" });
  await set(item.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION, genre: "paper", genre_basis: "code", ...extra }, { abstract_raw: ABSTRACT });
  return item;
}

const row = async (/** @type {string} */ id) => (await database.query("SELECT i.lead_zh, i.lead_basis, i.study_facts, i.study_facts_version, i.editor_diagnostics, t.reader_tidy FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id WHERE i.id = $1", [id])).rows[0];

test("a faithful 导读 is stored as written; the study facts are made once per text, anchored to quotations, with the outcome kept in the diagnostics", options, async () => {
  const item = await paper();
  const editor = faithEditor({ lead: GOOD });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();
  const stored = await row(item.id);
  assert.equal(stored.lead_zh, GOOD);
  assert.equal(stored.study_facts.basis, stored.reader_tidy.sha);
  assert.equal(stored.study_facts.design, "rct");
  assert.equal(stored.study_facts.comparator.kind, "placebo");
  assert.equal(stored.study_facts.quotes_verified, true);
  assert.equal(stored.study_facts_version, FRONTIER_STUDY_FACTS_VERSION);
  assert.equal(stored.editor_diagnostics.faith.version, FRONTIER_FAITH_VERSION);
  // Each text's record carries the version and time of its check, so a text written later reads as not checked (frontier-rewrite).
  const { version, at, ...lead } = stored.editor_diagnostics.faith.lead;
  assert.deepEqual([version, at], [FRONTIER_FAITH_VERSION, NOW.toISOString()]);
  assert.deepEqual(lead, { outcome: "clean", candidates: 0, confirmed: 0, remaining: 0, rules: [], calls: 1, error: null });
  assert.equal(editor.counts.facts, 1, "the step made them; the lead step found them stored");
  // The 导读 and the card's summary are both read against the facts.
  assert.deepEqual([pipeline.counters.faithOutcomes, pipeline.counters.faithSummaryOutcomes, pipeline.counters.studyFacts], [{ clean: 2 }, { clean: 1 }, 1]);
  // Nothing changed: not asked again (idempotent per text hash).
  const before = { ...editor.counts };
  await pipelineFor(editor).processBatch();
  assert.deepEqual(editor.counts, before);
  // The diagnostics are the operator's: the reader's item never carries them or the facts.
  const service = new FrontierService({ database, vocabulary, now: () => NOW, config: { frontierEnabled: true, frontierAudience: "all", operatorUsers: [], frontierPreviewUsers: [],
    frontierDailyBudgetCny: 300, frontierTimeZone: "Asia/Shanghai", frontierSelectThreshold: 80 } });
  const detail = JSON.stringify((await service.getItem(reader, item.publicId)).body.item);
  assert.doesNotMatch(detail, /study_facts|studyFacts|faith|quotes_verified/);
});

test("a 导读 that turns the main result over is sent back once; the repaired text is stored and the mismatch counted, never shown", options, async () => {
  const item = await paper();
  const editor = faithEditor({ lead: BAD, repair: GOOD });
  const pipeline = pipelineFor(editor);
  const summary = await pipeline.processBatch();
  const stored = await row(item.id);
  assert.equal(stored.lead_zh, GOOD);
  assert.deepEqual([editor.counts.repair, editor.counts.verify], [1, 1]);
  assert.deepEqual({ outcome: stored.editor_diagnostics.faith.lead.outcome, confirmed: stored.editor_diagnostics.faith.lead.confirmed, rules: stored.editor_diagnostics.faith.lead.rules },
    { outcome: "repaired", confirmed: 1, rules: ["direction-contradiction"] });
  assert.deepEqual([summary.faithChecked, summary.faithMismatched, summary.faithRepaired, summary.faithTrimmed], [2, 1, 1, 0], "the 导读 and the card summary");
  assert.deepEqual(pipeline.counters.faithRules, { "direction-contradiction": 1 });
});

test("a card summary that turns the main result over loses that sentence, never rewritten; checked once per summary text, again after a new edit", options, async () => {
  const item = await paper({ summary_zh: BAD });
  const editor = faithEditor({ lead: GOOD });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();
  const stored = await row(item.id);
  const card = (await database.query("SELECT summary_zh, lexemes::text AS lexemes FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0];
  assert.equal(card.summary_zh, "一项随机对照试验纳入 1200 名成人。");
  assert.doesNotMatch(card.lexemes, /差异/, "search no longer finds the removed sentence");
  assert.equal(editor.counts.repair, 0, "a card summary is not sent back to a writer");
  assert.deepEqual([stored.editor_diagnostics.faith.summary.outcome, stored.editor_diagnostics.faith.summary.rules], ["trimmed", ["direction-contradiction"]]);
  assert.equal(stored.editor_diagnostics.faith.summary.basis, (await database.query("SELECT md5(summary_zh) AS m FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0].m);
  assert.deepEqual(pipeline.counters.faithSummaryOutcomes, { trimmed: 1 });
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.item_changes WHERE item_id = $1 AND reason = 'faith'", [item.id])).rows[0].n, 1);

  const before = { ...editor.counts };
  await pipelineFor(editor).processBatch();
  assert.deepEqual(editor.counts, before, "the kept text is not read again");
  // A new edit writes another summary: it is read again.
  await set(item.id, { summary_zh: "药物 X 与安慰剂相比无显著差异，研究纳入 1200 名成人。" });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.counts.claims, before.claims + 1);
  assert.equal((await row(item.id)).editor_diagnostics.faith.summary.outcome, "emptied");
  assert.equal((await database.query("SELECT summary_zh FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0].summary_zh, "", "nothing left: the card shows its title");
});

test("a repair the writer's own checks refuse takes the mismatching sentence out; when nothing would be left the previous accepted 导读 stays", options, async () => {
  const item = await paper();
  const trimmed = faithEditor({ lead: BAD, repair: null });
  const pipeline = pipelineFor(trimmed);
  const summary = await pipeline.processBatch();
  assert.equal((await row(item.id)).lead_zh, "一项随机对照试验纳入 1200 名成人。");
  assert.equal(summary.faithTrimmed, 1);

  // Only the mismatching sentence: nothing left. The earlier 导读 (written from an older text) is kept.
  const second = await paper();
  await set(second.id, { lead_zh: "此前已通过复核的导读。", lead_basis: "older-text", lead_version: "old" });
  const only = faithEditor({ lead: "药物 X 与安慰剂相比无显著差异。", repair: null });
  await pipelineFor(only).processBatch();
  assert.equal((await row(second.id)).lead_zh, "此前已通过复核的导读。");
  assert.equal((await row(second.id)).editor_diagnostics.faith.lead.outcome, "emptied");

  // No earlier text either: the reader gets the card's summary (no 导读), and the item is not asked again.
  const third = await paper();
  const none = faithEditor({ lead: "药物 X 与安慰剂相比无显著差异。", repair: null });
  await pipelineFor(none).processBatch();
  const left = await row(third.id);
  assert.deepEqual([left.lead_zh, left.lead_basis === left.reader_tidy.sha], [null, true]);
  const asked = { ...none.counts };
  await pipelineFor(none).processBatch();
  assert.deepEqual(none.counts, asked);
});

test("the levers: off asks for nothing; facts only keeps the facts and checks nothing; a genre that is not a study's has none", options, async () => {
  const item = await paper();
  const off = faithEditor({ lead: BAD });
  await pipelineFor(off, { frontierStudyFactsEnabled: false, frontierFaithEnabled: false }).processBatch();
  assert.deepEqual([off.counts.facts, off.counts.claims], [0, 0]);
  assert.equal((await row(item.id)).lead_zh, BAD, "the writer's draft is stored as it came");
  assert.equal((await row(item.id)).study_facts, null);

  await database.query("UPDATE evimed_frontier.items SET lead_basis = NULL WHERE id = $1", [item.id]);
  const factsOnly = faithEditor({ lead: BAD });
  await pipelineFor(factsOnly, { frontierFaithEnabled: false }).processBatch();
  assert.deepEqual([factsOnly.counts.facts, factsOnly.counts.claims], [1, 0]);
  assert.equal((await row(item.id)).study_facts.design, "rct");
  assert.equal((await row(item.id)).lead_zh, BAD);

  const news = await insertItem(database, { sourceId: "wx", sourceType: "media", evidenceType: null, title: "A news story", summaryZh: "卡片。", selected: true, visibleAt: "2026-10-23T00:00:00Z" });
  await set(news.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION, genre: "news", genre_basis: "model", platform: "wechat", channel: "wechat" }, { abstract_raw: ABSTRACT });
  const editor = faithEditor({ lead: BAD });
  await pipelineFor(editor).processBatch();
  assert.equal((await row(news.id)).study_facts, null);
});

test("a provider that cannot be reached leaves the draft as the writer produced it and records nothing", options, async () => {
  const item = await paper();
  const editor = faithEditor({ lead: BAD });
  const call = editor.callJson.bind(editor);
  editor.callJson = async (/** @type {any[]} */ messages) => {
    if (String(messages[0].content).includes("研究设计审读员")) throw Object.assign(new Error("down"), { code: "usage_budget_exceeded" });
    return call(messages);
  };
  await pipelineFor(editor).processBatch();
  const stored = await row(item.id);
  assert.equal(stored.lead_zh, BAD);
  assert.equal(stored.study_facts, null, "asked again later");
  assert.equal(stored.editor_diagnostics?.faith ?? null, null);
});

test("c3 review: a facts call that fails for its own reason is recorded as asked for that text; new instructions ask again; a text read from reports is never read for facts", options, async () => {
  const item = await paper({ lead_zh: GOOD });
  const editor = faithEditor({ lead: GOOD });
  const call = editor.callJson.bind(editor);
  let cut = true;
  editor.callJson = async (/** @type {any[]} */ messages) => {
    if (cut && String(messages[0].content).includes("研究设计审读员")) { editor.counts.facts += 1; throw Object.assign(new Error("cut"), { code: "frontier_model_incomplete" }); }
    return call(messages);
  };
  await pipelineFor(editor).processBatch();
  const failed = (await row(item.id)).study_facts;
  assert.deepEqual([failed.empty, failed.failed, failed.basis], [true, "frontier_model_incomplete", (await row(item.id)).reader_tidy.sha]);
  const asked = editor.counts.facts;
  await pipelineFor(editor).processBatch();
  assert.equal(editor.counts.facts, asked, "a text that always fails is not asked every round");
  // New instructions: the record of the old ones is made again.
  cut = false;
  await set(item.id, { study_facts_version: "frontier-study-facts-0.000000000000" });
  await pipelineFor(editor).processBatch();
  assert.equal((await row(item.id)).study_facts.design, "rct");
  assert.equal(editor.counts.facts, asked + 1);

  // A paper read through its reports (c3-primary): its 导读 is not checked and no facts are made from the reports.
  const held = await paper();
  await set(held.id, {}, { abstract_raw: null, reader_reports: "据医学媒体报道，药物 X 在试验中降低了 LDL。", reader_tidy: { sha: "reports-abc", source: "reports", drop: [] } });
  const before = editor.counts.facts;
  await pipelineFor(editor).processBatch();
  assert.equal((await row(held.id)).study_facts, null);
  assert.equal(editor.counts.facts, before, "no facts call for a reports text");
});
