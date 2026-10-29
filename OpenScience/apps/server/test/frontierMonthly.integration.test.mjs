// The monthly against a real PostgreSQL: compiled from the month's dailies through the `frontier-monthly` job, once; its
// writer's sentences held to the entries; read back with its items live.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FrontierMonthly } from "../src/frontierMonthly.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { FRONTIER_PROJECT_ID } from "../src/internalProjects.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { TEST_VOCABULARY, insertSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem, resetFrontier } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const operator = `monthly_op_${randomUUID().slice(0, 8)}`;
const reader = { id: `monthly_reader_${randomUUID().slice(0, 8)}` };
/** 07:31 on 1 November in Beijing: October is due. */
const DUE = new Date("2026-10-31T23:31:00Z");
let database;
let jobs;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateProductStore(database);
  for (const id of [operator, reader.id]) await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $1, 'development')", [id]);
  await database.query("INSERT INTO evimed_control.projects(user_id, id, name, quota_bytes) VALUES ($1, $2, 'EviMed 前沿动态', 1000000)", [operator, FRONTIER_PROJECT_ID]);
  jobs = new ProductJobs(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.monthlies");
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[operator, reader.id]]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await resetFrontier(database);
  await database.query("DELETE FROM evimed_frontier.monthlies");
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id = $1", [operator]);
  await insertSource(database, "nejm", { authority: 5 });
  await insertSource(database, "fda", { name: "FDA", lane: "regulatory", source_type: "regulator", authority: 5 });
});

/** @param {{ overview?: string | null, sections?: Record<string, string>, error?: string | null }} answer */
function writer(answer) {
  /** @type {any[]} */
  const calls = [];
  return { calls, available: true, model: "deepseek-flash",
    async writeMonthly(/** @type {any} */ input) {
      calls.push(input);
      const { buildMonthlyInput } = await import("../src/frontierEditor.mjs");
      return { overview: answer.overview ?? null, sections: answer.sections ?? {}, input: buildMonthlyInput(input), error: answer.error ?? null, model: "deepseek-flash" };
    } };
}

/** @param {any} editor */
function monthly(editor) {
  return new FrontierMonthly({ database, jobs, editor, owner: () => ({ userId: operator, projectId: FRONTIER_PROJECT_ID }),
    glossary: new FrontierGlossary([{ kind: "drug", termEn: "tirzepatide", termZh: "替尔泊肽", keepOriginal: false }]),
    config: { frontierTimeZone: "Asia/Shanghai", frontierDailyTime: "07:30" }, budget: async () => ({ state: "ok" }), now: () => DUE, workerId: "test-monthly" });
}

/** A daily of `day` that published these items. @param {string} day @param {string[]} ids */
async function daily(day, ids) {
  await database.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, markdown, item_ids, model)
    VALUES ($1::date, now(), now(), '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '#', $2::bigint[], 'deepseek-flash')`, [day, ids]);
}

test("October from its dailies: one row through the job, the writer's grounded sentences kept, a stray one replaced by the template", options, async () => {
  const items = [];
  for (let index = 0; index < 5; index += 1) {
    items.push(await insertComposedItem(database, { title: `Trial ${index}`, titleZh: `试验 ${index} 降低事件 ${10 + index}%`, summaryZh: `导读 ${index}，降低 ${10 + index}%。`,
      selected: true, lane: index < 3 ? "evidence" : "safety", scoreTotal: 90 - index, visibleAt: `2026-10-0${index + 1}T01:00:00Z` }));
  }
  const withdrawn = await insertComposedItem(database, { title: "Withdrawn", titleZh: "已撤回", summaryZh: "导读。", selected: true, state: "withdrawn", scoreTotal: 99 });
  const september = await insertComposedItem(database, { title: "September", titleZh: "九月条目", summaryZh: "导读。", selected: true, scoreTotal: 99 });
  const untitled = await insertComposedItem(database, { title: "No summary", summaryZh: null, selected: true, scoreTotal: 99 });
  await daily("2026-10-02", [items[0].id, items[1].id, withdrawn.id, untitled.id]);
  await daily("2026-10-15", [items[2].id, items[3].id, items[4].id]);
  await daily("2026-09-30", [september.id]);
  const editor = writer({ overview: "本月临床证据有 3 件要事，试验 0 降低事件 10%。替尔泊肽也有新数据。", sections: { 临床证据: "试验 1 降低事件 11%。" } });
  const producer = monthly(editor);
  const ran = await producer.runDue();
  assert.deepEqual(ran, { ran: true, empty: false, month: "2026-10" });
  assert.equal(editor.calls.length, 1);
  assert.deepEqual(editor.calls[0].groups.map((/** @type {any} */ group) => [group.label, group.intro, group.items.length]), [["临床证据", true, 3], ["药物安全", false, 2]]);
  const row = (await database.query("SELECT * FROM evimed_frontier.monthlies WHERE month = '2026-10'")).rows[0];
  assert.equal(row.overview, "本月临床证据有 3 件要事，试验 0 降低事件 10%。本月精选 5 件要事，临床证据 3 件、药物安全 2 件。",
    "the sentence naming a drug no entry names is replaced by the template sentence");
  assert.deepEqual(row.sections.map((/** @type {any} */ section) => [section.lane, section.intro, section.itemIds.length]),
    [["evidence", "试验 1 降低事件 11%。", 3], ["safety", null, 2]], "only a section of three or more has an introduction");
  assert.equal(row.written, false, "a sentence was replaced");
  assert.deepEqual(row.item_ids.map(String).sort(), items.map((item) => String(item.id)).sort(), "September's, the withdrawn and the summary-less items are not October's");
  assert.equal(row.lead.itemId, items[0].publicId);
  assert.match(row.markdown, /^# EviMed 医学前沿月报 · 2026年10月/);
  // Once: a second run writes nothing and asks the writer nothing.
  assert.deepEqual(await producer.runDue(), { ran: false, month: "2026-10" });
  assert.equal(editor.calls.length, 1);

  // Read back with its items live: an item hidden by the reader leaves, the Markdown says what the page says.
  const service = new FrontierService({ database, vocabulary: frontierVocabularyView(TEST_VOCABULARY), monthly: producer, now: () => DUE,
    config: { frontierEnabled: true, frontierAudience: "all", operatorUsers: [], frontierPreviewUsers: [], frontierTimeZone: "Asia/Shanghai" } });
  await database.query("INSERT INTO evimed_frontier.user_state (user_id, item_id, hidden_at) VALUES ($1, $2, now())", [reader.id, items[4].id]);
  const { monthly: issue } = await service.monthlyIssue(reader, "2026-10");
  assert.equal(issue.label, "2026年10月");
  assert.equal(issue.itemCount, 4);
  assert.deepEqual(issue.sections.map((/** @type {any} */ section) => [section.laneLabel, section.items.length]), [["临床证据", 3], ["药物安全", 1]]);
  assert.equal(issue.lead.item.id, items[0].publicId);
  assert.doesNotMatch(issue.markdown, /试验 4/);
  assert.deepEqual((await service.monthlies(new URLSearchParams())).monthlies.map((/** @type {any} */ entry) => [entry.month, entry.itemCount]), [["2026-10", 5]]);
  await assert.rejects(service.monthlyIssue(reader, "2026-09"), { code: "frontier_monthly_not_found" });
});

test("a month whose dailies published nothing is no issue; a writer that failed leaves the template overview and no introductions", options, async () => {
  assert.deepEqual(await monthly(writer({})).runDue(), { ran: true, empty: true, month: "2026-10" });
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.monthlies")).rows[0].n, 0);

  await database.query("DELETE FROM evimed_product.jobs WHERE user_id = $1", [operator]);
  const items = [];
  for (let index = 0; index < 3; index += 1) {
    items.push(await insertComposedItem(database, { title: `T${index}`, titleZh: `条目 ${index}`, summaryZh: `导读 ${index}。`, selected: true, lane: "evidence", scoreTotal: 80 - index }));
  }
  await daily("2026-10-20", items.map((item) => item.id));
  assert.equal((await monthly(writer({ error: "usage_budget_exceeded" })).runDue()).empty, false);
  const row = (await database.query("SELECT overview, sections, written FROM evimed_frontier.monthlies WHERE month = '2026-10'")).rows[0];
  assert.deepEqual([row.overview, row.sections[0].intro, row.written], ["本月精选 3 件要事，临床证据 3 件。", null, false]);
});
