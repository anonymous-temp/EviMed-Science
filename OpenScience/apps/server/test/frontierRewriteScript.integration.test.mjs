// scripts/ops/frontier-rewrite.mjs (ct-write W7) against a real PostgreSQL: the report asks and writes nothing; --apply writes the genre
// (code's where it is sure, the model's in batches where code fell back on the channel), and the 导读, 要点 and 推荐理由 of the items
// whose reader is read; a second run finds nothing; a budget no longer ok stops it where it can resume. The c3-faith steps make the
// study facts of reader-worthy study items and check their 导读 and 要点 against them, once per written text.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_BRIEF_VERSION } from "../src/frontierBrief.mjs";
import { FRONTIER_EDITOR_VERSION, FRONTIER_REASON_VERSION } from "../src/frontierEditor.mjs";
import { FRONTIER_FAITH_VERSION } from "../src/frontierFaith.mjs";
import { FRONTIER_LEAD_VERSION } from "../src/frontierLead.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { estimateRewriteCost, frontierRewrite, parseArguments } from "../../../scripts/ops/frontier-rewrite.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const SINCE = new Date("2026-10-01T00:00:00Z");
const UNTIL = new Date("2026-10-24T00:00:00Z");

/** @type {any} */
let database;
before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.close();
});
beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.events");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await insertSource(database, "nejm");
  await insertSource(database, "wx", { name: "医药观澜", lane: "mixed", source_type: "media" });
});

const ABSTRACT = "Background: Oral PCSK9 inhibition lowers LDL cholesterol.\n\nResults: Events fell to 7.2% from 8.8% (HR 0.82).";

/** Four items: a 公众号 article and a journal paper with no genre, a selected paper owed every write, and one far below the line. */
async function seed() {
  const wechat = await insertItem(database, { sourceId: "wx", sourceType: "media", evidenceType: null, title: "恒瑞公布 2 期数据", visibleAt: "2026-10-10T00:00:00Z" });
  const journal = await insertItem(database, { title: "A cohort study", visibleAt: "2026-10-11T00:00:00Z" });
  const selected = await insertItem(database, { title: "Oral PCSK9 Inhibition", summaryZh: "卡片摘要。", reasonZh: "可了解口服 PCSK9 抑制剂的心血管获益与安全性。", selected: true,
    visibleAt: "2026-10-12T00:00:00Z" });
  const low = await insertItem(database, { title: "Far below", visibleAt: "2026-10-13T00:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET platform = 'wechat', channel = 'wechat' WHERE id = $1", [wechat.id]);
  await database.query("UPDATE evimed_frontier.items SET score_total = 90, editor_version = $2, genre = 'paper', genre_basis = 'code', lead_zh = '旧导读。', lead_version = 'frontier-lead-1' WHERE id = $1",
    [selected.id, FRONTIER_EDITOR_VERSION]);
  await database.query("UPDATE evimed_frontier.items SET score_total = 40, editor_version = $2 WHERE id = $1", [low.id, FRONTIER_EDITOR_VERSION]);
  for (const row of [selected, low]) {
    await database.query("UPDATE evimed_frontier.item_texts SET abstract_raw = $2, reader_tidy = $3::jsonb WHERE item_id = $1",
      [row.id, ABSTRACT, JSON.stringify({ sha: `sha-${row.id}`, source: "abstract", drop: [] })]);
  }
  return { wechat, journal, selected, low };
}

/** An editor that answers every step, and counts what it was asked. */
function fakeEditor() {
  return {
    asked: { genre: 0, lead: 0, brief: 0, reason: 0 },
    async classifyGenres(/** @type {any[]} */ items) { this.asked.genre += 1; return items.map(() => "industry"); },
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ _input, /** @type {number} */ _max, /** @type {any} */ opts) {
      this.asked.lead += 1;
      assert.match(instructions, /本条类型：研究论文/);
      assert.match(instructions, /另有「要点」/, "a paper with 要点 has its 导读 held shorter");
      const checked = opts.verify({ lead_zh: "口服 PCSK9 抑制剂使心血管事件从 8.8% 降至 7.2%（HR 0.82）。" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson() { this.asked.brief += 1; return { points: { results: ["事件 7.2% 对 8.8%（HR 0.82）。"] } }; },
    async writeReason(/** @type {any} */ input) {
      this.asked.reason += 1;
      assert.equal(input.genre, "paper");
      return { reason: "降脂治疗选择上，口服 PCSK9 抑制剂给不能耐受注射剂的高危患者多了一个有硬终点证据的方案。", verification: "passed", error: null };
    },
  };
}

test("the arguments: a window of at most thirty days, the steps by name, a resume point", () => {
  assert.deepEqual(parseArguments([]), { apply: false, days: 30, since: null, steps: ["genre", "lead", "brief", "reason", "facts", "faith"], concurrency: 4, limit: 100_000 });
  assert.deepEqual(parseArguments(["--apply", "--steps", "reason,genre", "--since", "2026-10-01T00:00:00Z"]).steps, ["genre", "reason"]);
  assert.deepEqual(parseArguments(["--steps", "faith,facts"]).steps, ["facts", "faith"]);
  assert.throws(() => parseArguments(["--days", "31"]));
  assert.throws(() => parseArguments(["--steps", "summary"]));
  const estimate = estimateRewriteCost({ genre: 1, lead: 100, brief: 100, reason: 100 }, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
  assert.ok(estimate.cny > 0 && estimate.cny < 5, `about ¥0.01 an item a step, measured: ${estimate.cny}`);
  const checks = estimateRewriteCost({ facts: 100, faith: 100 }, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
  assert.ok(checks.cny > 0.4 && checks.cny < 2, `facts and a check, erring high of the measured ¥0.0045 an item: ${checks.cny}`);
});

test("the report asks nothing and writes nothing; --apply writes every step; a second run finds nothing to do", options, async () => {
  const { wechat, journal, selected, low } = await seed();
  const editor = fakeEditor();
  const writing = ["genre", "lead", "brief", "reason"];
  const report = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: writing });
  assert.deepEqual(editor.asked, { genre: 0, lead: 0, brief: 0, reason: 0 });
  assert.deepEqual(report.genre, { items: 3, byCode: 2, toAsk: 1, codeGenres: { paper: 2 }, written: 0, model: 0 });
  assert.deepEqual([report.lead.items, report.brief.items, report.reason.items], [1, 1, 1]);
  assert.deepEqual(report.calls, { genre: 1, lead: 1, brief: 1, reason: 1 });
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE genre IS NOT NULL")).rows[0].n, 1, "only the seeded genre");

  const applied = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, apply: true, steps: writing });
  assert.equal(applied.failed, 0);
  assert.deepEqual(editor.asked, { genre: 1, lead: 1, brief: 1, reason: 1 });
  const rows = new Map((await database.query("SELECT * FROM evimed_frontier.items")).rows.map((row) => [String(row.id), row]));
  assert.deepEqual([rows.get(wechat.id).genre, rows.get(wechat.id).genre_basis], ["industry", "model"]);
  assert.deepEqual([rows.get(journal.id).genre, rows.get(journal.id).genre_basis], ["paper", "code"]);
  assert.deepEqual([rows.get(low.id).genre, rows.get(low.id).lead_version, rows.get(low.id).brief], ["paper", null, null], "far below the line: a genre, nothing written");
  const done = rows.get(selected.id);
  assert.equal(done.lead_zh, "口服 PCSK9 抑制剂使心血管事件从 8.8% 降至 7.2%（HR 0.82）。");
  assert.deepEqual([done.lead_version, done.lead_basis], [FRONTIER_LEAD_VERSION, `sha-${selected.id}`]);
  assert.deepEqual(done.brief, { genre: "paper", points: [{ key: "results", label: "主要结果", items: ["事件 7.2% 对 8.8%（HR 0.82）。"] }] });
  assert.deepEqual([done.brief_version, done.brief_basis], [FRONTIER_BRIEF_VERSION, `sha-${selected.id}:paper`]);
  assert.match(String(done.reason_zh), /^降脂治疗选择上/);
  assert.equal(done.reason_version, FRONTIER_REASON_VERSION);

  const again = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, apply: true, steps: writing });
  assert.deepEqual([again.genre.items, again.lead.items, again.brief.items, again.reason.items], [0, 0, 0, 0]);
  assert.deepEqual(editor.asked, { genre: 1, lead: 1, brief: 1, reason: 1 }, "nothing asked twice");
});

test("a refused answer keeps what was there; a budget no longer ok stops the run where it can resume", options, async () => {
  const { selected } = await seed();
  const refusing = { ...fakeEditor(),
    async writeJson() { return { verification: "dropped", output: null, error: null }; },
    async writeReason() { return { reason: null, verification: "dropped", error: null }; } };
  await frontierRewrite({ database, editor: refusing, threshold: 80, since: SINCE, until: UNTIL, apply: true, steps: ["lead", "reason"] });
  const kept = (await database.query("SELECT lead_zh, lead_version, reason_zh, reason_version FROM evimed_frontier.items WHERE id = $1", [selected.id])).rows[0];
  assert.deepEqual(kept, { lead_zh: "旧导读。", lead_version: FRONTIER_LEAD_VERSION, reason_zh: "可了解口服 PCSK9 抑制剂的心血管获益与安全性。", reason_version: FRONTIER_REASON_VERSION });
  await database.query("UPDATE evimed_frontier.items SET brief_version = NULL, brief_basis = NULL WHERE id = $1", [selected.id]);
  const editor = fakeEditor();
  const stopped = await frontierRewrite({ database, editor, budget: async () => ({ state: "throttled" }), threshold: 80, since: SINCE, until: UNTIL, apply: true,
    steps: ["brief"] });
  assert.equal(stopped.stopped, "budget");
  assert.equal(stopped.resumeFrom, "2026-10-12T00:00:00.000Z");
  assert.equal(editor.asked.brief, 0);
});

test("a run that stops says so", options, async () => {
  await seed();
  const editor = { ...fakeEditor(), async classifyGenres() { throw Object.assign(new Error("down"), { code: "model_gateway_upstream_unavailable" }); } };
  const result = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, apply: true, steps: ["genre"] });
  assert.equal(result.failed, 1);
  assert.equal(result.genre.written, 2, "code's answers are written; the batch the model could not answer waits for the next run");
});

const STUDY = [
  "Background: Oral drug X may lower LDL cholesterol.",
  "Methods: In a double-blind randomised trial, 1200 adults aged 40 years or older were assigned to drug X or placebo for 12 weeks.",
  "Results: The primary end point, LDL change, was lower with drug X than with placebo (24% vs 3%; P<0.001).",
  "Conclusions: These results suggest that drug X may be useful in adults at risk; confirmation is needed.",
].join("\n\n");
const STUDY_QUOTE = "was lower with drug X than with placebo (24% vs 3%; P<0.001)";
const STUDY_FACTS = {
  design: "rct", design_quote: "In a double-blind randomised trial", n: 1200,
  population_text: "40 岁及以上成人", population_quote: "1200 adults aged 40 years or older", species: "human", age: "adult", sex: "not-stated",
  intervention_text: "药物 X", intervention_quote: "assigned to drug X or placebo",
  comparator_text: "安慰剂", comparator_quote: "assigned to drug X or placebo", comparator_kind: "placebo",
  endpoint_text: "LDL 变化", endpoint_quote: "The primary end point, LDL change",
  direction: "favours-intervention", direction_quote: STUDY_QUOTE,
  certainty: "suggestive", certainty_quote: "These results suggest that drug X may be useful in adults at risk",
  spin_present: false, spin_reason: "结论与主要终点一致", spin_quote: null,
};
const MISSTATED = "一项随机对照试验纳入 1200 名成人。药物 X 与安慰剂相比无显著差异。";
const FAITHFUL = "一项随机对照试验纳入 1200 名成人，药物 X 较安慰剂降低 LDL（24% 对 3%）。";

/** An editor that answers the facts, the claim reader, the source check and the repair by their instructions, and counts them. */
function checkingEditor() {
  const asked = { facts: 0, claims: 0, verify: 0, repair: 0 };
  return {
    asked,
    async callJson(/** @type {any[]} */ messages) {
      const system = String(messages[0].content);
      if (system.includes("研究设计审读员")) { asked.facts += 1; return STUDY_FACTS; }
      if (system.includes("稿件已经按句编号")) {
        asked.claims += 1;
        const hit = String(messages[1].content).split("\n").map((line) => /^(\d+)\. .*无显著差异/.exec(line)).find(Boolean);
        return hit ? { s: [{ i: Number(hit[1]), direction: "no-difference", scope: "primary", direction_w: "无显著差异" }] } : { s: [] };
      }
      if (system.includes("被怀疑")) { asked.verify += 1; return { v: [{ i: 1, verdict: "misstated", quote: STUDY_QUOTE }] }; }
      if (system.includes("「AI 导读」")) { asked.repair += 1; return { lead_zh: FAITHFUL }; }
      throw new Error(`not asked in this test: ${system.slice(0, 40)}`);
    },
  };
}

test("c3-faith: facts made for reader-worthy study items; a live 导读 that misstates the study is repaired once; checked once per written text", options, async () => {
  const paper = await insertItem(database, { title: "Oral drug X versus placebo for LDL", selected: true, visibleAt: "2026-10-12T00:00:00Z" });
  const news = await insertItem(database, { sourceId: "wx", sourceType: "media", evidenceType: null, title: "药物 X 的新闻", selected: true, visibleAt: "2026-10-13T00:00:00Z" });
  await database.query(`UPDATE evimed_frontier.items SET score_total = 90, editor_version = $2, genre = 'paper', genre_basis = 'code', lead_zh = $3,
    lead_version = $4, lead_at = '2026-10-12T01:00:00Z' WHERE id = $1`, [paper.id, FRONTIER_EDITOR_VERSION, MISSTATED, FRONTIER_LEAD_VERSION]);
  await database.query(`UPDATE evimed_frontier.items SET score_total = 90, editor_version = $2, genre = 'news', genre_basis = 'code', lead_zh = '新闻导读。',
    lead_at = '2026-10-13T01:00:00Z' WHERE id = $1`, [news.id, FRONTIER_EDITOR_VERSION]);
  for (const row of [paper, news]) {
    await database.query("UPDATE evimed_frontier.item_texts SET abstract_raw = $2, reader_tidy = $3::jsonb WHERE item_id = $1",
      [row.id, STUDY, JSON.stringify({ sha: `sha-${row.id}`, source: "abstract", drop: [] })]);
  }
  const editor = checkingEditor();
  const steps = ["facts", "faith"];
  const report = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps });
  assert.deepEqual(editor.asked, { facts: 0, claims: 0, verify: 0, repair: 0 }, "the report asks nothing");
  assert.deepEqual([report.facts.items, report.faith.items, report.calls], [1, 1, { facts: 1, faith: 1 }], "the news item is not a study's");

  const applied = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps, apply: true });
  assert.equal(applied.failed, 0);
  assert.deepEqual([applied.facts.written, applied.faith.outcomes, applied.faith.changed, applied.faith.facts], [1, { repaired: 1 }, 1, 0]);
  assert.deepEqual(editor.asked, { facts: 1, claims: 2, verify: 1, repair: 1 }, "facts once (the faith step reads the stored record)");
  const stored = (await database.query("SELECT lead_zh, lead_at, study_facts, editor_diagnostics FROM evimed_frontier.items WHERE id = $1", [paper.id])).rows[0];
  assert.equal(stored.lead_zh, FAITHFUL);
  assert.equal(stored.study_facts.basis, `sha-${paper.id}`);
  assert.deepEqual([stored.editor_diagnostics.faith.lead.outcome, stored.editor_diagnostics.faith.lead.version], ["repaired", FRONTIER_FAITH_VERSION]);
  assert.equal(new Date(stored.lead_at).toISOString(), "2026-10-12T01:00:00.000Z", "the 导读's own write time is left alone");

  const again = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps, apply: true });
  assert.deepEqual([again.facts.items, again.faith.items], [0, 0]);
  assert.deepEqual(editor.asked, { facts: 1, claims: 2, verify: 1, repair: 1 }, "nothing asked twice");

  // A 导读 written after its check (the lead step, or the pipeline) is owed a check again; the facts of the unchanged text are reused.
  await database.query("UPDATE evimed_frontier.items SET lead_zh = $2, lead_at = clock_timestamp() + interval '1 minute' WHERE id = $1", [paper.id, MISSTATED]);
  const rewritten = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["faith"], apply: true });
  assert.deepEqual([rewritten.faith.items, rewritten.faith.outcomes], [1, { repaired: 1 }]);
  assert.equal(editor.asked.facts, 1);
});
