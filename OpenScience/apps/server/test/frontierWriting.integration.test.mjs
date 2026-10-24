// Each genre written its own way (ct-write 2026-10-24), against a real PostgreSQL: the pipeline's 导读 by genre (above 要点, held
// shorter), its 「AI 要点」 stage — reader-worthy items only, a post recorded as none without a call, a basis that writes it again when
// the text or the genre changes — and the service's genre on every list item and brief (with a reading's `about`) on the detail.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_BRIEF_VERSION } from "../src/frontierBrief.mjs";
import { FRONTIER_EDITOR_VERSION } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FRONTIER_LEAD_VERSION } from "../src/frontierLead.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
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
  await insertSource(database, "xfeed", { name: "X 医学账号", lane: "mixed", source_type: "media" });
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

/**
 * An editor whose 导读 and 要点 answers are given by genre: the 导读 call through `writeJson` (its own verify), the 要点 call and the
 * reader-text verdict through `callJson`, told apart by their instructions.
 * @param {{ lead?: (instructions: string) => any, brief?: (instructions: string, input: string) => any }} behaviour
 */
function writingEditor(behaviour = {}) {
  return {
    owner, available: true, timeZone: "Asia/Shanghai", model: "deepseek-flash",
    leads: /** @type {string[]} */ ([]), briefs: /** @type {Array<{ instructions: string, input: string }>} */ ([]),
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ _input, /** @type {number} */ _max, /** @type {any} */ opts) {
      if (!instructions.includes("「AI 导读」")) return { verification: "passed", output: { insight_zh: null }, error: null };
      this.leads.push(instructions);
      const checked = opts.verify(behaviour.lead ? behaviour.lead(instructions) : { lead_zh: "" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson(/** @type {any[]} */ messages) {
      const instructions = String(messages[0].content);
      if (instructions.includes("「要点」")) {
        this.briefs.push({ instructions, input: String(messages[1].content) });
        return behaviour.brief ? behaviour.brief(instructions, String(messages[1].content)) : { points: {} };
      }
      return { drop: [] };
    },
    async screen() { return { verdicts: new Map(), errors: new Map(), calls: 0 }; },
    async edit() { throw new Error("not in this test"); },
    async translateBody(/** @type {any} */ input) { return { paragraphs: input.paragraphs.map(() => null), complete: false, calls: 0, error: null }; },
  };
}

/** @param {any} editor */
function pipelineFor(editor) {
  return new FrontierPipeline({ database, editor, plugin: { text: async () => ({ status: "pending" }) }, embedder: null, now: () => NOW,
    workerId: `test-${randomUUID()}`, glossary: new FrontierGlossary([]),
    config: { kbEmbeddingDimension: 1024, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, frontierSelectThreshold: 80 } });
}

function serviceFor() {
  return new FrontierService({ database, vocabulary, now: () => NOW, config: { frontierEnabled: true, frontierAudience: "all", operatorUsers: [],
    frontierPreviewUsers: [], frontierDailyBudgetCny: 300, frontierTimeZone: "Asia/Shanghai", frontierSelectThreshold: 80 } });
}

const ABSTRACT = "Background: Oral PCSK9 inhibition lowers LDL cholesterol.\n\nMethods: 12,000 patients were randomised.\n\nResults: Events fell to 7.2% from 8.8% (HR 0.82).\n\nConclusions: Oral PCSK9 inhibition reduced cardiovascular events.";

test("要点 are written for the items whose reader is read, with the genre's fields; the 导读 above them is told to leave the details to them", options, async () => {
  const paper = await insertItem(database, { title: "Oral PCSK9 Inhibition and Cardiovascular Outcomes", summaryZh: "卡片摘要。", selected: true, visibleAt: "2026-10-23T00:00:00Z" });
  const low = await insertItem(database, { title: "A paper far below the line", summaryZh: "卡片。", visibleAt: "2026-10-23T00:00:00Z" });
  const post = await insertItem(database, { sourceId: "xfeed", sourceType: "media", evidenceType: null, title: "NEJM on X: a new trial", selected: true, visibleAt: "2026-10-23T00:00:00Z" });
  await set(paper.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION, genre: "paper", genre_basis: "code" }, { abstract_raw: ABSTRACT });
  await set(low.id, { score_total: 40, editor_version: FRONTIER_EDITOR_VERSION }, { abstract_raw: "A note with little to say about anything at all." });
  await set(post.id, { score_total: 88, editor_version: FRONTIER_EDITOR_VERSION, platform: "x", channel: "x" }, { body_text: "Presented today: a new trial of oral PCSK9 inhibition." });
  const editor = writingEditor({
    lead: () => ({ lead_zh: "口服 PCSK9 抑制剂使心血管事件从 8.8% 降至 7.2%（HR 0.82）。" }),
    brief: () => ({ points: { design: "12,000 例患者的随机试验。", results: ["事件 7.2% 对 8.8%（HR 0.82）。"], next: "未提及" },
      quote: { text: "Oral PCSK9 inhibition reduced cardiovascular events." } }),
  });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();
  // One brief call: the selected paper. The post (no fields) is recorded as none without a call; the far-below paper is not a reader's.
  assert.equal(editor.briefs.length, 1);
  assert.match(editor.briefs[0].instructions, /本条类型：研究论文/);
  assert.match(editor.briefs[0].input, /正文（摘要）：\nBackground: Oral PCSK9/);
  const rows = new Map((await database.query("SELECT i.id, i.brief, i.brief_basis, i.brief_version, i.lead_version, t.reader_tidy FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id")).rows
    .map((row) => [String(row.id), row]));
  const written = rows.get(paper.id);
  assert.deepEqual(written.brief, { genre: "paper", points: [
    { key: "design", label: "设计与对象", text: "12,000 例患者的随机试验。" },
    { key: "results", label: "主要结果", items: ["事件 7.2% 对 8.8%（HR 0.82）。"] },
  ], quote: { key: "conclusion", label: "作者结论", text: "Oral PCSK9 inhibition reduced cardiovascular events." } });
  assert.equal(written.brief_basis, `${written.reader_tidy.sha}:paper`);
  assert.equal(written.brief_version, FRONTIER_BRIEF_VERSION);
  assert.equal(written.lead_version, FRONTIER_LEAD_VERSION);
  assert.equal(rows.get(post.id).brief, null);
  assert.equal(rows.get(post.id).brief_basis, `${rows.get(post.id).reader_tidy.sha}:social`, "a post is recorded as none, not asked again");
  assert.equal(rows.get(low.id).brief_basis, null);
  assert.deepEqual({ briefs: pipeline.counters.briefs, empty: pipeline.counters.briefsEmpty, dropped: pipeline.counters.briefFieldsDropped },
    { briefs: 1, empty: 1, dropped: { unknown: 1 } });
  // The 导读 is written by genre: the paper's above its 要点, the post's as a post.
  const paperLead = editor.leads.find((instructions) => instructions.includes("本条类型：研究论文"));
  assert.match(String(paperLead), /另有「要点」/);
  assert.match(String(editor.leads.find((instructions) => instructions.includes("本条类型：社交动态"))), /一两句话/);
  assert.doesNotMatch(String(editor.leads.find((instructions) => instructions.includes("本条类型：社交动态"))), /另有「要点」/);
  // Nothing changed: not asked again. A changed genre writes it again.
  await pipelineFor(editor).processBatch();
  assert.equal(editor.briefs.length, 1);
  await set(paper.id, { genre: "conference", genre_basis: "model" });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.briefs.length, 2);
  assert.match(editor.briefs[1].instructions, /本条类型：会议报道/);
});

test("the service names every item's genre — the stored one, else code's — and serves the brief with the report a reading reads", options, async () => {
  const primary = await insertItem(database, { title: "Atacicept in IgA Nephropathy", titleZh: "atacicept 治疗 IgA 肾病", visibleAt: "2026-10-22T00:00:00Z", timelineAt: "2026-10-22T00:00:00Z" });
  const reading = await insertItem(database, { sourceId: "wx", sourceType: "media", evidenceType: null, title: "IgA 肾病新药两篇 NEJM 同日发表", titleZh: "IgA 肾病新药两篇 NEJM 同日发表",
    selected: true, visibleAt: "2026-10-23T00:00:00Z", timelineAt: "2026-10-23T00:00:00Z" });
  const unwritten = await insertItem(database, { sourceId: "xfeed", sourceType: "media", evidenceType: null, title: "A post", visibleAt: "2026-10-23T00:00:00Z" });
  await set(reading.id, { genre: "commentary", genre_basis: "model", platform: "wechat", channel: "wechat", brief: { genre: "commentary", points: [
    { key: "subject", label: "旧", text: "NEJM 同日发表的两项 3 期试验。" }, { key: "gone", label: "已删", text: "x" }], quote: { text: "现有结果支持两种策略均具有临床价值。" } } });
  await set(unwritten.id, { platform: "x", channel: "x" });
  // The event layer put the reading with its primary report.
  const event = await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at, report_count)
    VALUES ('ev-iga', 'IgA 肾病两项 3 期试验', 'evidence', $1, $1, 2) RETURNING id`, [NOW]);
  await database.query(`INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1, $2, 'primary', 'identifier'), ($1, $3, 'report', 'model')`,
    [event.rows[0].id, primary.id, reading.id]);
  const service = serviceFor();
  const list = (await service.listItems(reader, new URLSearchParams("view=all"))).body.items;
  const byId = new Map(list.map((/** @type {any} */ entry) => [entry.id, entry]));
  assert.deepEqual([byId.get(reading.publicId).genre, byId.get(reading.publicId).genreLabel], ["commentary", "解读评论"]);
  assert.deepEqual([byId.get(primary.publicId).genre, byId.get(primary.publicId).genreLabel], ["paper", "研究论文"], "no stored genre: code's, from the journal source");
  assert.deepEqual([byId.get(unwritten.publicId).genre, byId.get(unwritten.publicId).genreLabel], ["social", "社交动态"]);
  const detail = (await service.getItem(reader, reading.publicId)).body.item;
  assert.deepEqual(detail.brief, { genre: "commentary",
    points: [{ key: "subject", label: "解读的对象", text: "NEJM 同日发表的两项 3 期试验。" }],
    quote: { key: "remark", label: "原文观点", text: "现有结果支持两种策略均具有临床价值。" },
    about: { publicId: primary.publicId, title: "atacicept 治疗 IgA 肾病" } });
  assert.equal((await service.getItem(reader, primary.publicId)).body.item.brief, null);
});
