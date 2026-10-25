// scripts/ops/frontier-rewrite.mjs (ct-write W7) against a real PostgreSQL: the report asks and writes nothing; --apply writes the genre
// (code's where it is sure, the model's in batches where code fell back on the channel), and the 导读, 要点 and 推荐理由 of the items
// whose reader is read; a second run finds nothing; a budget no longer ok stops it where it can resume.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_BRIEF_VERSION } from "../src/frontierBrief.mjs";
import { FRONTIER_EDITOR_VERSION, FRONTIER_REASON_VERSION, FRONTIER_SCORE_VERSION } from "../src/frontierEditor.mjs";
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
  assert.deepEqual(parseArguments([]), { apply: false, days: 30, since: null, steps: ["genre", "lead", "brief", "reason"], concurrency: 4, limit: 100_000, minOldTotal: 50 });
  assert.deepEqual(parseArguments(["--steps", "reason,score,genre", "--min-old-total", "40"]), { apply: false, days: 30, since: null, steps: ["genre", "score", "reason"], concurrency: 4, limit: 100_000, minOldTotal: 40 }, "score only by name, after genre");
  assert.deepEqual(parseArguments(["--apply", "--steps", "reason,genre", "--since", "2026-10-01T00:00:00Z"]).steps, ["genre", "reason"]);
  assert.throws(() => parseArguments(["--days", "31"]));
  assert.throws(() => parseArguments(["--steps", "summary"]));
  const estimate = estimateRewriteCost({ genre: 1, lead: 100, brief: 100, reason: 100 }, REFERENCE_PRICE_LIST.model["deepseek-flash"]);
  assert.ok(estimate.cny > 0 && estimate.cny < 5, `about ¥0.01 an item a step, measured: ${estimate.cny}`);
});

test("the report asks nothing and writes nothing; --apply writes every step; a second run finds nothing to do", options, async () => {
  const { wechat, journal, selected, low } = await seed();
  const editor = fakeEditor();
  const report = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL });
  assert.deepEqual(editor.asked, { genre: 0, lead: 0, brief: 0, reason: 0 });
  assert.deepEqual(report.genre, { items: 3, byCode: 2, toAsk: 1, codeGenres: { paper: 2 }, written: 0, model: 0 });
  assert.deepEqual([report.lead.items, report.brief.items, report.reason.items], [1, 1, 1]);
  assert.deepEqual(report.calls, { genre: 1, lead: 1, brief: 1, reason: 1 });
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE genre IS NOT NULL")).rows[0].n, 1, "only the seeded genre");

  const applied = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, apply: true });
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

  const again = await frontierRewrite({ database, editor, threshold: 80, since: SINCE, until: UNTIL, apply: true });
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
