// The reader's 「就此提问」 questions, against a real PostgreSQL (c3-ask): the pipeline writes up to three for an item that has a 导读,
// the sure items first and the rest as the batch allows, each set once per text and per prompt; an answer with none is recorded as
// none; a call that failed records nothing; the reader's detail serves them, a list card never does, and an event page is given the
// questions of its first-hand item.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_ASK_INSTRUCTIONS, FRONTIER_ASK_VERSION } from "../src/frontierAsk.mjs";
import { FRONTIER_EDITOR_VERSION } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
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
const NOW = new Date("2026-10-25T04:00:00Z");
const ABSTRACT = "Background: Oral PCSK9 inhibition lowers LDL cholesterol.\n\nMethods: 12,000 patients were randomised.\n\nResults: Events fell to 7.2% from 8.8% (HR 0.82).\n\nConclusions: Oral PCSK9 inhibition reduced cardiovascular events.";
const QUESTIONS = ["这个结果适用于中国患者吗？", "和现有标准治疗比差别在哪？", "安全性数据有哪些？"];

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
  await database.query("DELETE FROM evimed_frontier.events");
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
});

/** @param {string} id @param {Record<string, any>} columns @param {Record<string, any>} [texts] */
async function set(id, columns, texts = {}) {
  for (const [table, values, key] of [["items", columns, "id"], ["item_texts", texts, "item_id"]]) {
    const names = Object.keys(values);
    if (!names.length) continue;
    await database.query(`UPDATE evimed_frontier.${table} SET ${names.map((name, index) => `${name} = $${index + 2}`).join(", ")} WHERE ${key} = $1`, [id, ...names.map((name) => values[name])]);
  }
}

/**
 * An editor whose 导读 is a fixed sentence (or none for titles named in `noLead`) and whose question call is scripted: it records each
 * call's input and answers `ask(input)`.
 * @param {{ ask?: (input: string) => any, noLead?: string[], fail?: (input: string) => string | null }} behaviour
 */
function askEditor(behaviour = {}) {
  return {
    owner, available: true, timeZone: "Asia/Shanghai", model: "deepseek-flash",
    asked: /** @type {string[]} */ ([]),
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ input, /** @type {number} */ _max, /** @type {any} */ opts) {
      if (!instructions.includes("「AI 导读」")) return { verification: "passed", output: { insight_zh: null }, error: null };
      const empty = (behaviour.noLead ?? []).some((title) => input.includes(title));
      const checked = opts.verify({ lead_zh: empty ? "" : "口服 PCSK9 抑制剂使心血管事件从 8.8% 降至 7.2%（HR 0.82）。" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson(/** @type {any[]} */ messages) {
      const instructions = String(messages[0].content);
      if (instructions === FRONTIER_ASK_INSTRUCTIONS) {
        const input = String(messages[1].content);
        this.asked.push(input);
        const code = behaviour.fail?.(input) ?? null;
        if (code) throw Object.assign(new Error("scripted"), { code });
        return behaviour.ask ? behaviour.ask(input) : { questions: QUESTIONS };
      }
      return instructions.includes("「要点」") ? { points: {} } : { drop: [] };
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

/** A published paper with an abstract: it gets its reader text settled and a 导读 in the first batch, its questions in the same one. */
async function paper(title, overrides = {}, columns = {}) {
  const item = await insertItem(database, { title, summaryZh: "卡片摘要。", visibleAt: "2026-10-24T00:00:00Z", abstract: ABSTRACT, ...overrides });
  await set(item.id, { score_total: 60, editor_version: FRONTIER_EDITOR_VERSION, genre: "paper", genre_basis: "code", ...columns });
  return item;
}

const row = async (id) => (await database.query("SELECT ask_zh, ask_basis, ask_version, ask_at, lead_zh, lease_owner FROM evimed_frontier.items WHERE id = $1", [id])).rows[0];

test("an item with a 导读 gets its questions, written from its title, lead and text, and stored with their basis", options, async () => {
  const item = await paper("Oral PCSK9 Inhibition and Cardiovascular Outcomes", { titleZh: "口服 PCSK9 抑制剂与心血管结局" }, { selected: true });
  const editor = askEditor();
  const pipeline = pipelineFor(editor);
  const batch = await pipeline.processBatch();
  assert.equal(editor.asked.length, 1);
  const shown = editor.asked[0];
  assert.match(shown, /^来源：NEJM Journal\n日期：2026-09-21\n类型：研究论文\n标题：Oral PCSK9 Inhibition and Cardiovascular Outcomes\n中文标题：口服 PCSK9 抑制剂与心血管结局\n导读：口服 PCSK9 抑制剂使心血管事件从 8.8% 降至 7.2%（HR 0.82）。\n正文（摘要）：\nBackground: Oral PCSK9/);
  const stored = await row(item.id);
  assert.deepEqual(stored.ask_zh, QUESTIONS);
  assert.equal(stored.ask_version, FRONTIER_ASK_VERSION);
  assert.equal(stored.ask_basis, (await database.query("SELECT reader_tidy->>'sha' AS sha FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id])).rows[0].sha);
  assert.ok(stored.ask_at instanceof Date);
  assert.equal(stored.lease_owner, null, "the lease is released with the write");
  assert.equal(batch.asks, 1);
  assert.equal(pipeline.counters.asks, 1);
  // Nothing changed: not asked again.
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 1);
});

test("an item with no 导读 is not asked about: the questions follow the reader that is read", options, async () => {
  const withLead = await paper("A paper with a lead");
  const without = await paper("A paper the source supports no lead for");
  const editor = askEditor({ noLead: ["the source supports no lead for"] });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 1);
  assert.deepEqual((await row(withLead.id)).ask_zh, QUESTIONS);
  const none = await row(without.id);
  assert.equal(none.lead_zh, null);
  assert.equal(none.ask_basis, null, "nothing is recorded for an item that was never a candidate");
});

test("the sure items are asked about first, eight a round, and the rest the round after", options, async () => {
  const safety = await paper("Safety item", { safetyAlert: true });
  const picked = await paper("Selected item", { selected: true });
  const strong = await paper("Strong item", { visibleAt: "2026-10-24T20:00:00Z" }, { score_total: 75 });
  const others = [];
  for (let n = 1; n <= 8; n += 1) others.push(await paper(`Plain item ${n}`, { visibleAt: `2026-10-24T0${n}:00:00Z` }));
  const editor = askEditor();
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 8, "eight items a round");
  const firstRound = new Set(editor.asked.map((input) => /标题：(.+)/.exec(input)?.[1]));
  for (const title of ["Safety item", "Selected item", "Strong item"]) assert.ok(firstRound.has(title), `${title} is in the first round`);
  // The newest plain items fill the round; the oldest waits.
  assert.ok(firstRound.has("Plain item 8") && firstRound.has("Plain item 4") && !firstRound.has("Plain item 1"), [...firstRound].join(", "));
  const waiting = (await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE ask_basis IS NULL")).rows[0].n;
  assert.equal(waiting, 3);
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 11);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE ask_basis IS NULL")).rows[0].n, 0);
  void safety; void picked; void strong; void others;
});

test("a changed text or changed instructions write the questions again; an unchanged item is left alone", options, async () => {
  const item = await paper("Oral PCSK9 Inhibition");
  const editor = askEditor();
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 1);
  await set(item.id, { ask_basis: "an-older-text" });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 2, "the settled text is no longer the one the questions were written from");
  await set(item.id, { ask_version: "frontier-ask-1.older" });
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 3, "an older prompt wrote them");
  assert.equal((await row(item.id)).ask_version, FRONTIER_ASK_VERSION);
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 3);
});

test("an answer with no question, or none that code keeps, is recorded as none and not asked again; a failed call records nothing", options, async () => {
  const empty = await paper("Item with nothing to ask");
  const refused = await paper("Item whose questions carry a number it lacks");
  const failing = await paper("Item whose call fails");
  const editor = askEditor({
    ask: (input) => (input.includes("nothing to ask") ? { questions: [] } : { questions: ["入组 500 人，样本量够吗？", "这个问题写得太长了所以会被代码拒绝因为它超过了三十个字的上限而且还很啰嗦吗？"] }),
    fail: (input) => (input.includes("call fails") ? "frontier_model_incomplete" : null),
  });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();
  assert.equal(editor.asked.length, 3);
  const emptyRow = await row(empty.id);
  assert.equal(emptyRow.ask_zh, null);
  assert.ok(emptyRow.ask_basis, "recorded as none for this text");
  const refusedRow = await row(refused.id);
  assert.equal(refusedRow.ask_zh, null);
  assert.ok(refusedRow.ask_basis);
  assert.deepEqual(pipeline.counters.askQuestionsDropped, { number: 1, length: 1 });
  assert.equal(pipeline.counters.asksEmpty, 2);
  const failed = await row(failing.id);
  assert.equal(failed.ask_basis, null, "a call that could not be made is asked again");
  assert.equal(failed.lease_owner, null);
  await pipelineFor(editor).processBatch();
  assert.equal(editor.asked.length, 4, "only the one that failed");
});

test("a provider that is out of balance pauses the questions without recording any", options, async () => {
  const item = await paper("Item asked while the provider is out of balance");
  const editor = askEditor({ fail: () => "insufficient_quota" });
  await pipelineFor(editor).processBatch();
  assert.equal((await row(item.id)).ask_basis, null);
});

test("the reader's detail is served the questions and a list card never is", options, async () => {
  const item = await paper("Oral PCSK9 Inhibition and Cardiovascular Outcomes", {}, { selected: true });
  await pipelineFor(askEditor()).processBatch();
  const service = serviceFor();
  const detail = await service.getItem(reader, item.publicId);
  assert.deepEqual(detail.body.item.ask, QUESTIONS);
  const list = await service.listItems(reader, new URLSearchParams({ view: "all" }));
  assert.ok(list.body.items.length > 0);
  for (const card of list.body.items) assert.equal("ask" in card, false, "the questions are the reader's, not the card's");
  // A column that holds more or longer than the rule is served inside it.
  await set(item.id, { ask_zh: JSON.stringify(["一？？？", "二二二二？", "二二二二？", "三三三三？", "四四四四？", "字".repeat(40)]) });
  assert.deepEqual((await service.getItem(reader, item.publicId)).body.item.ask, ["一？？？", "二二二二？", "三三三三？"]);
  // An item with none serves an empty list, never a missing field.
  const bare = await paper("An item nobody has asked about yet");
  assert.deepEqual((await service.getItem(reader, bare.publicId)).body.item.ask, []);
});

test("an event page is given the questions of its first first-hand item, and none when no first-hand item has any", options, async () => {
  const primary = await paper("The trial itself", {}, { ask_zh: JSON.stringify(QUESTIONS) });
  const report = await paper("A news report on the trial", {}, { ask_zh: JSON.stringify(["报道里没有写的是什么？"]) });
  const event = await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at, report_count, status)
    VALUES ('ask0123456789abcd', '一项试验的发布', 'evidence', $1, $2, 2, 'developing') RETURNING id`, [new Date("2026-10-24T00:00:00Z"), new Date("2026-10-24T06:00:00Z")]);
  await database.query(`INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1, $2, 'primary', 'identifier'), ($1, $3, 'report', 'model')`,
    [event.rows[0].id, primary.id, report.id]);
  await database.query("UPDATE evimed_frontier.items SET event_id = $1 WHERE id = ANY($2::bigint[])", [event.rows[0].id, [primary.id, report.id]]);
  const service = serviceFor();
  /** @param {any} found */
  const askOf = (found) => found.event.ask;
  const events = (await import("../src/frontierEvents.mjs"));
  service.events = new events.FrontierEvents({ database, editor: null, embedder: null, now: () => NOW, config: {} });
  assert.deepEqual(askOf(await service.event(reader, "ask0123456789abcd")), { itemId: primary.publicId, title: "The trial itself", questions: QUESTIONS },
    "the report's question is about the report, not about the event");
  await set(primary.id, { ask_zh: null });
  assert.equal(askOf(await service.event(reader, "ask0123456789abcd")), null, "a report's questions are not the event's");
  await set(primary.id, { ask_zh: JSON.stringify(QUESTIONS), state: "withdrawn" });
  assert.equal(askOf(await service.event(reader, "ask0123456789abcd")), null, "a withdrawn item asks nothing");
});
