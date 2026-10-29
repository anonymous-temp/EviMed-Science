// scripts/ops/frontier-rewrite.mjs (ct-write W7) against a real PostgreSQL: the report asks and writes nothing; --apply writes the genre
// (code's where it is sure, the model's in batches where code fell back on the channel), and the 导读, 要点 and 推荐理由 of the items
// whose reader is read; a second run finds nothing; a budget no longer ok stops it where it can resume. The c3-faith steps make the
// study facts of reader-worthy study items and check their 导读 and 要点 against them, once per written text.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_BRIEF_VERSION } from "../src/frontierBrief.mjs";
import { FRONTIER_EDITOR_VERSION, FRONTIER_REASON_VERSION, FRONTIER_SCORE_VERSION, FRONTIER_TITLE_VERSION } from "../src/frontierEditor.mjs";
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
  assert.deepEqual(parseArguments([]), { apply: false, days: 30, since: null, steps: ["genre", "title", "lead", "brief", "reason", "facts", "faith"], concurrency: 4, limit: 100_000, minOldTotal: 50 });
  assert.deepEqual(parseArguments(["--steps", "reason,score,genre", "--min-old-total", "40"]), { apply: false, days: 30, since: null, steps: ["genre", "score", "reason"], concurrency: 4, limit: 100_000, minOldTotal: 40 }, "score only by name, after genre");
  assert.deepEqual(parseArguments(["--apply", "--steps", "reason,genre", "--since", "2026-10-01T00:00:00Z"]).steps, ["genre", "reason"]);
  assert.deepEqual(parseArguments(["--steps", "faith,facts"]).steps, ["facts", "faith"]);
  assert.deepEqual(parseArguments(["--steps", "reason,title,genre"]).steps, ["genre", "title", "reason"], "title follows genre");
  assert.throws(() => parseArguments(["--days", "31"]));
  assert.throws(() => parseArguments(["--steps", "summary"]));
  const estimate = estimateRewriteCost({ genre: 1, lead: 100, brief: 100, reason: 100 }, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
  assert.ok(estimate.cny > 0 && estimate.cny < 5, `about ¥0.01 an item a step, measured: ${estimate.cny}`);
  const titles = estimateRewriteCost({ title: 1000 }, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
  assert.ok(titles.cny > 1 && titles.cny < 3, `about ¥0.0016 a title, measured on 127 sample titles: ${titles.cny}`);
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

/** The content version the readers' caches follow. */
const contentVersion = async () => Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key = 'content_version'")).rows[0]?.value ?? 0);

test("title (c4-title): the report asks nothing; --apply writes the answered titles with their words, a change row and one version bump; refusals and kept titles are stamped; a failed call is not; a second run asks only what was not stamped", options, async () => {
  const hook = await insertItem(database, { sourceId: "wx", sourceType: "media", evidenceType: null, title: "重磅！司美格鲁肽获批？-医学界官网", titleZh: "重磅！司美格鲁肽获批？-医学界官网",
    summaryZh: "国家药监局批准司美格鲁肽。", visibleAt: "2026-10-10T00:00:00Z" });
  const clean = await insertItem(database, { sourceId: "wx", sourceType: "media", evidenceType: null, title: "国家药监局批准司美格鲁肽新适应症", titleZh: "国家药监局批准司美格鲁肽新适应症", visibleAt: "2026-10-10T01:00:00Z" });
  const english = await insertItem(database, { title: "Oral PCSK9 Inhibition", titleZh: "口服 PCSK9 抑制", summaryZh: "卡片摘要。", visibleAt: "2026-10-10T02:00:00Z" });
  const refused = await insertItem(database, { sourceId: "wx", sourceType: "media", evidenceType: null, title: "【指南】右心疾病无创影像评估共识", titleZh: "【指南】右心疾病无创影像评估共识", visibleAt: "2026-10-10T03:00:00Z" });
  const failing = await insertItem(database, { title: "Fails to answer", titleZh: "无法回答", visibleAt: "2026-10-10T04:00:00Z" });
  const waiting = await insertItem(database, { title: "No Chinese title yet", visibleAt: "2026-10-10T05:00:00Z" });
  const stamped = await insertItem(database, { title: "Already written", titleZh: "已经写过", visibleAt: "2026-10-10T06:00:00Z" });
  const outside = await insertItem(database, { title: "Outside the window", titleZh: "窗口之外", visibleAt: "2026-09-01T00:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET platform = 'wechat', channel = 'wechat', genre = 'approval', genre_basis = 'code' WHERE id = $1", [hook.id]);
  await database.query("UPDATE evimed_frontier.items SET editor_diagnostics = $2::jsonb WHERE id = $1", [stamped.id, JSON.stringify({ titleVersion: FRONTIER_TITLE_VERSION })]);
  await database.query("UPDATE evimed_frontier.items SET editor_diagnostics = $2::jsonb WHERE id = $1", [failing.id, JSON.stringify({ scoreVersion: "keep-me", titleVersion: "frontier-title-1.older" })]);
  await database.query("UPDATE evimed_frontier.item_texts SET body_excerpt = $2 WHERE item_id = $1", [hook.id, "国家药监局批准司美格鲁肽用于降低心血管事件风险。"]);
  await database.query("UPDATE evimed_frontier.item_texts SET reader_tidy = $2::jsonb WHERE item_id = $1", [hook.id, JSON.stringify({ sha: "s", source: "excerpt", drop: [] })]);

  /** @type {any[]} */
  const inputs = [];
  const editor = { mode: "answer",
    async writeTitle(/** @type {any} */ input) {
      inputs.push(input);
      if (input.titleRaw.startsWith("重磅")) return { titleZh: "国家药监局批准司美格鲁肽用于降低心血管事件风险", basis: "rewritten" };
      if (input.titleRaw === "国家药监局批准司美格鲁肽新适应症") return { titleZh: input.titleRaw, basis: "kept" };
      if (input.titleRaw === "Oral PCSK9 Inhibition") return { titleZh: "口服 PCSK9 抑制剂降低 LDL-C", basis: "translated" };
      if (input.titleRaw === "Fails to answer" && this.mode === "answer") throw Object.assign(new Error("down"), { code: "model_gateway_upstream_unavailable" });
      return null;
    } };
  const report = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["title"] });
  assert.deepEqual(inputs, [], "the report asks nothing");
  assert.deepEqual(report.title, { items: 5, byLanguage: { zh: 3, other: 2 }, titleVersion: FRONTIER_TITLE_VERSION, written: 0, kept: 0, refused: 0, raced: 0 },
    "not the item with no Chinese title, the stamped one or the one outside the window");
  assert.deepEqual(report.calls, { title: 5 });
  assert.equal(report.versions.title, FRONTIER_TITLE_VERSION);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE editor_diagnostics->>'titleVersion' = $1", [FRONTIER_TITLE_VERSION])).rows[0].n, 1, "the report wrote nothing");

  const versionBefore = await contentVersion();
  const applied = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["title"], apply: true });
  assert.equal(applied.failed, 1, "the failed call is counted");
  assert.deepEqual(applied.title, { items: 5, byLanguage: { zh: 3, other: 2 }, titleVersion: FRONTIER_TITLE_VERSION, written: 2, kept: 1, refused: 1, raced: 0 });
  const hookInput = inputs.find((input) => input.titleRaw.startsWith("重磅"));
  assert.deepEqual(hookInput, { sourceName: "医药观澜", titleRaw: "重磅！司美格鲁肽获批？-医学界官网", isChinese: true, genre: "approval", summaryZh: "国家药监局批准司美格鲁肽。",
    text: "国家药监局批准司美格鲁肽用于降低心血管事件风险。", titleZh: "重磅！司美格鲁肽获批？-医学界官网" });
  const english1 = inputs.find((input) => input.titleRaw === "Oral PCSK9 Inhibition");
  assert.equal(english1.isChinese, false);
  assert.equal(english1.titleZh, "口服 PCSK9 抑制");

  const rows = new Map((await database.query(`SELECT id, title_zh, editor_diagnostics, lexemes::text AS lexemes FROM evimed_frontier.items`)).rows.map((row) => [String(row.id), row]));
  assert.equal(rows.get(hook.id).title_zh, "国家药监局批准司美格鲁肽用于降低心血管事件风险");
  assert.equal(rows.get(hook.id).editor_diagnostics.titleVersion, FRONTIER_TITLE_VERSION);
  assert.match(rows.get(hook.id).lexemes, /国家药监局/, "the search words follow the title");
  assert.equal(rows.get(english.id).title_zh, "口服 PCSK9 抑制剂降低 LDL-C");
  assert.equal(rows.get(clean.id).title_zh, "国家药监局批准司美格鲁肽新适应症", "a kept title stays");
  assert.equal(rows.get(clean.id).editor_diagnostics.titleVersion, FRONTIER_TITLE_VERSION, "and is stamped, so it is not asked again");
  assert.equal(rows.get(refused.id).title_zh, "【指南】右心疾病无创影像评估共识", "a refused answer keeps the title there was");
  assert.equal(rows.get(refused.id).editor_diagnostics.titleVersion, FRONTIER_TITLE_VERSION, "and is stamped");
  assert.equal(rows.get(failing.id).title_zh, "无法回答");
  assert.deepEqual(rows.get(failing.id).editor_diagnostics, { scoreVersion: "keep-me", titleVersion: "frontier-title-1.older" }, "a failed call writes nothing");
  assert.equal(rows.get(waiting.id).title_zh, null);
  assert.equal(rows.get(outside.id).title_zh, "窗口之外");
  const changes = (await database.query("SELECT item_id::text AS id, op, reason FROM evimed_frontier.item_changes WHERE reason = 'title' ORDER BY item_id")).rows;
  assert.deepEqual(changes.map((row) => row.id).sort(), [hook.id, english.id].sort(), "a change row for each title that moved, none for a kept one");
  assert.ok(changes.every((row) => row.op === "upsert"));
  assert.equal(await contentVersion(), versionBefore + 1, "one bump for the batch");

  // A second run asks only what was not stamped: the failed one, and now it is answered.
  inputs.length = 0;
  editor.mode = "refuse";
  const again = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["title"], apply: true });
  assert.deepEqual(inputs.map((input) => input.titleRaw), ["Fails to answer"]);
  assert.deepEqual([again.failed, again.title.items, again.title.refused], [0, 1, 1]);
  assert.equal(await contentVersion(), versionBefore + 1, "a run that changed no title bumps nothing");
  inputs.length = 0;
  const third = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["title"], apply: true });
  assert.deepEqual([inputs.length, third.title.items], [0, 0], "nothing asked twice");
});

test("title (c4-title): a title the pipeline wrote while the answer was being asked is not overwritten and not stamped; a stopped budget asks nothing", options, async () => {
  const item = await insertItem(database, { title: "Oral PCSK9 Inhibition", titleZh: "口服 PCSK9 抑制", visibleAt: "2026-10-10T02:00:00Z" });
  const editor = {
    async writeTitle() {
      // The pipeline re-edited the item while the call was out.
      await database.query("UPDATE evimed_frontier.items SET title_zh = '流水线刚写的标题' WHERE id = $1", [item.id]);
      return { titleZh: "口服 PCSK9 抑制剂降低 LDL-C", basis: "translated" };
    },
  };
  const versionBefore = await contentVersion();
  const raced = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["title"], apply: true });
  assert.deepEqual([raced.failed, raced.title.raced, raced.title.written], [0, 1, 0]);
  const row = (await database.query("SELECT title_zh, editor_diagnostics FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0];
  assert.equal(row.title_zh, "流水线刚写的标题");
  assert.equal(row.editor_diagnostics?.titleVersion ?? null, null, "the answer was to a title that is no longer there");
  assert.equal(await contentVersion(), versionBefore);
  const asked = /** @type {string[]} */ ([]);
  const stopped = await frontierRewrite({ database, editor: { async writeTitle(/** @type {any} */ input) { asked.push(input.titleRaw); return null; } }, budget: async () => ({ state: "throttled" }),
    threshold: 80, since: SINCE, until: UNTIL, steps: ["title"], apply: true });
  assert.equal(stopped.stopped, "budget");
  assert.deepEqual(asked, []);
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
  await database.query("UPDATE evimed_frontier.items SET lead_zh = $2, lead_at = clock_timestamp() WHERE id = $1", [paper.id, MISSTATED]);
  const rewritten = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["faith"], apply: true });
  assert.deepEqual([rewritten.faith.items, rewritten.faith.outcomes], [1, { repaired: 1 }]);
  assert.equal(editor.asked.facts, 1);

  // A card summary that misstates the study is trimmed, never sent to a writer, and checked once per summary text.
  await database.query("UPDATE evimed_frontier.items SET summary_zh = $2 WHERE id = $1", [paper.id, MISSTATED]);
  const carded = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["faith"], apply: true });
  assert.deepEqual([carded.faith.items, carded.faith.outcomes, carded.faith.changed], [1, { trimmed: 1 }, 1]);
  const card = (await database.query("SELECT summary_zh, editor_diagnostics FROM evimed_frontier.items WHERE id = $1", [paper.id])).rows[0];
  assert.equal(card.summary_zh, "一项随机对照试验纳入 1200 名成人。");
  assert.equal(card.editor_diagnostics.faith.summary.outcome, "trimmed");
  assert.equal(editor.asked.repair, 2, "only the two 导读 repairs");
  const settled = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["faith"], apply: true });
  assert.equal(settled.faith.items, 0);
});

test("score: items an older scoring wrote are scored again under the ceilings, the proposal is held and admitted for the day, a failed answer keeps the score; a second run finds nothing", options, async () => {
  await insertSource(database, "medrxiv", { name: "medRxiv", source_type: "preprint", authority: 2, owner_entity: "medRxiv" });
  await insertSource(database, "ema", { name: "EMA", source_type: "regulator", lane: "regulatory", authority: 5, owner_entity: "EMA" });
  const approval = await insertItem(database, { sourceId: "ema", sourceType: "regulator", evidenceType: "regulatory-decision", title: "EMA approves a drug", selected: true, selectedRule: "threshold", visibleAt: "2026-10-12T00:00:00Z", timelineAt: "2026-10-12T03:00:00Z" });
  const preprint = await insertItem(database, { sourceId: "medrxiv", sourceType: "preprint", evidenceType: "other", title: "A preprint", visibleAt: "2026-10-12T01:00:00Z", timelineAt: "2026-10-12T04:00:00Z" });
  const refused = await insertItem(database, { title: "The model fails on this one", visibleAt: "2026-10-12T02:00:00Z", timelineAt: "2026-10-12T05:00:00Z" });
  const low = await insertItem(database, { title: "Under the old total", visibleAt: "2026-10-12T02:30:00Z", timelineAt: "2026-10-12T06:00:00Z" });
  const old = { [approval.id]: 88, [preprint.id]: 76, [refused.id]: 70, [low.id]: 40 };
  for (const [id, total] of Object.entries(old)) await database.query("UPDATE evimed_frontier.items SET score_total = $2, genre = $3, genre_basis = 'code', editor_diagnostics = '{}'::jsonb WHERE id = $1",
    [id, total, id === preprint.id ? "preprint" : id === approval.id ? "approval" : "paper"]);
  await database.query("UPDATE evimed_frontier.items SET evidence_basis = 'registry' WHERE id = $1", [approval.id]);
  const asked = /** @type {string[]} */ ([]);
  const editor = {
    async scoreItem(/** @type {any} */ item) {
      asked.push(item.titleRaw);
      if (item.titleRaw.startsWith("The model fails")) return { scores: null, scoresRaw: null, practice: null, error: "frontier_score_invalid" };
      const approvalItem = item.titleRaw.startsWith("EMA");
      return { scores: { impact: 28, novelty: 19, relevance: 17 }, scoresRaw: { impact: 28, novelty: 19, relevance: 17 }, error: null,
        practice: approvalItem ? { changing: true, reasonZh: "首个口服药获批，成人患者多了一线选择。" } : { changing: true, reasonZh: "预印本也提出了。" } };
    },
  };
  const report = await frontierRewrite({ database, editor, threshold: 68, since: SINCE, until: UNTIL, steps: ["score"] });
  assert.deepEqual(asked, [], "the report asks nothing");
  assert.equal(report.score.items, 3, "the one under the old total of 50 is not asked about");
  assert.deepEqual(report.calls, { score: 3 });
  const day = estimateRewriteCost({ score: 1_500 }, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
  assert.ok(day.cny > 1.5 && day.cny < 2.5, `a day of 1,500 items costs about ¥1.8 to score: ${day.cny}`);

  const applied = await frontierRewrite({ database, editor, threshold: 68, since: SINCE, until: UNTIL, steps: ["score"], apply: true });
  assert.equal(applied.failed, 0);
  assert.deepEqual(applied.score.moved, { up: 1, down: 1, same: 0 }, "the approval rose (94 from 88), the preprint fell under its ceilings (55 from 76)");
  assert.deepEqual([applied.score.written, applied.score.kept, applied.score.capped, applied.score.practiceProposed, applied.score.labelled], [2, 1, 1, 2, 1]);
  const rows = new Map((await database.query("SELECT * FROM evimed_frontier.items")).rows.map((row) => [String(row.id), row]));
  const a = rows.get(approval.id);
  assert.deepEqual([a.score_impact, a.score_novelty, a.score_relevance], [28, 19, 17], "no ceiling holds an approval of a regulator");
  assert.equal(a.score_total, a.score_authority + 28 + 19 + 17);
  assert.deepEqual([a.editor_diagnostics.scoreVersion, a.editor_diagnostics.scoresRaw, a.editor_diagnostics.capped], [FRONTIER_SCORE_VERSION, { impact: 28, novelty: 19, relevance: 17 }, undefined]);
  assert.deepEqual([a.practice_changing, a.practice_zh], [true, "首个口服药获批，成人患者多了一线选择。"], "the day's cap is one and the approval is selected and admissible");
  const p = rows.get(preprint.id);
  assert.deepEqual([p.score_impact, p.score_novelty, p.score_relevance], [18, 14, 17], "a preprint's ceilings: 28 -> 18, 19 -> 14");
  assert.deepEqual(p.editor_diagnostics.capped, ["genre:preprint"]);
  assert.deepEqual([p.practice_changing, p.practice_zh, p.selected], [false, "预印本也提出了。", false], "held, not admitted: not selected, and a preprint never carries it");
  const r = rows.get(refused.id);
  assert.deepEqual([r.score_total, r.editor_diagnostics.scoreVersion], [70, undefined], "a failed answer keeps the score there was, and is asked again next time");
  assert.equal(rows.get(low.id).score_total, 40);
  assert.deepEqual([...new Set(asked)].sort(), ["A preprint", "EMA approves a drug", "The model fails on this one"].sort());
  assert.equal(rows.get(approval.id).selected, true, "selection is never touched");

  asked.length = 0;
  const again = await frontierRewrite({ database, editor, threshold: 68, since: SINCE, until: UNTIL, steps: ["score"], apply: true });
  assert.equal(again.score.items, 1, "only the refused one is owed");
  assert.deepEqual(asked, ["The model fails on this one"]);
});

test("c3 review: the faith step writes nothing over a 导读 the pipeline wrote while it was checking, and leaves it owed", options, async () => {
  const paper = await insertItem(database, { title: "Oral drug X versus placebo for LDL", selected: true, visibleAt: "2026-10-12T00:00:00Z" });
  await database.query(`UPDATE evimed_frontier.items SET score_total = 90, editor_version = $2, genre = 'paper', genre_basis = 'code', lead_zh = $3,
    lead_version = $4, lead_at = '2026-10-12T01:00:00Z' WHERE id = $1`, [paper.id, FRONTIER_EDITOR_VERSION, MISSTATED, FRONTIER_LEAD_VERSION]);
  await database.query("UPDATE evimed_frontier.item_texts SET abstract_raw = $2, reader_tidy = $3::jsonb WHERE item_id = $1",
    [paper.id, STUDY, JSON.stringify({ sha: `sha-${paper.id}`, source: "abstract", drop: [] })]);
  const editor = checkingEditor();
  const call = editor.callJson.bind(editor);
  let raced = false;
  editor.callJson = async (/** @type {any[]} */ messages) => {
    // The pipeline writes a new 导读 while the script's check is under way.
    if (!raced && String(messages[0].content).includes("稿件已经按句编号")) {
      raced = true;
      await database.query("UPDATE evimed_frontier.items SET lead_zh = '流水线刚写的导读。', lead_at = clock_timestamp() WHERE id = $1", [paper.id]);
    }
    return call(messages);
  };
  const run = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["facts", "faith"], apply: true });
  assert.deepEqual([run.faith.raced, run.faith.changed], [1, 0]);
  const stored = (await database.query("SELECT lead_zh, editor_diagnostics FROM evimed_frontier.items WHERE id = $1", [paper.id])).rows[0];
  assert.equal(stored.lead_zh, "流水线刚写的导读。", "the newer text stands");
  assert.equal(stored.editor_diagnostics?.faith?.lead ?? null, null, "and is not marked checked");
  const again = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, steps: ["faith"] });
  assert.equal(again.faith.items, 1, "still owed a check");
});
