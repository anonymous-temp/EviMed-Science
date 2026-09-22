// `frontier_search` against a real PostgreSQL: the gateway over HTTP in front
// of the real `FrontierService`, so what the tool receives is what the page's
// own method lists — the selected view, the reader's hidden items, the search
// that widens 精选 and is narrowed back here, and the audience.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_GATEWAY_PATH, createFrontierGatewayHandler } from "../src/frontierGateway.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const operator = { id: `operator_${randomUUID().slice(0, 8)}` };
const vocabulary = frontierVocabularyView(TEST_VOCABULARY);
const NOW = new Date("2026-09-22T04:00:00Z");

let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development'),($2,'Operator','development')",
    [reader.id, operator.id]);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[reader.id, operator.id]]);
  await database.close();
});

/** @type {Record<string, { id: string, publicId: string }>} */
let rows = {};

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("DELETE FROM evimed_frontier.user_prefs");
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key IN ('content_version','plugin_cursor')");
  await insertSource(database, "nejm", { name: "NEJM" });
  await insertSource(database, "medrxiv", { name: "medRxiv", source_type: "preprint" });
  rows = {
    picked: await insertItem(database, { selected: true, selectedRule: "threshold", title: "Semaglutide cuts heart failure events",
      titleZh: "司美格鲁肽减少心衰事件", summaryZh: "一项随机对照试验……", reasonZh: "改变 HFpEF 的治疗选择", specialties: ["cardiology"],
      doi: "10.1056/NEJMoa2600001", pmid: "41000001", timelineAt: "2026-09-22T03:00:00Z", visibleAt: "2026-09-22T03:00:00Z",
      publishedAt: "2026-09-21T00:00:00Z" }),
    unpicked: await insertItem(database, { selected: false, sourceId: "medrxiv", sourceType: "preprint", flags: ["preprint"],
      title: "Semaglutide weight trial", titleZh: "司美格鲁肽减重试验", timelineAt: "2026-09-22T02:00:00Z" }),
    oncology: await insertItem(database, { selected: true, title: "Oncology update", titleZh: "肿瘤进展", specialties: ["oncology"],
      timelineAt: "2026-09-22T01:00:00Z" }),
    hidden: await insertItem(database, { selected: true, title: "Semaglutide hidden by the reader", titleZh: "司美格鲁肽（已隐藏）",
      timelineAt: "2026-09-22T00:30:00Z" }),
    old: await insertItem(database, { selected: true, title: "Semaglutide last quarter", titleZh: "司美格鲁肽旧闻",
      timelineAt: "2026-06-01T00:00:00Z" }),
  };
});

/** The gateway over HTTP, in front of the real service. @param {import("node:test").TestContext} t @param {Record<string, any>} [config] */
async function gatewayFor(t, config = {}) {
  const fullConfig = { frontierEnabled: true, frontierAudience: "all", operatorUsers: [operator.id], frontierPreviewUsers: [],
    frontierDailyBudgetCny: 10, frontierTimeZone: "Asia/Shanghai", ...config };
  const service = new FrontierService({ database, vocabulary, now: () => NOW, config: fullConfig });
  await service.setItemState(reader, rows.hidden.publicId, "hide");
  const runtimeManager = { assertActiveModelGatewayToken: () => ({ userId: reader.id, projectId: "project-1" }) };
  const handler = createFrontierGatewayHandler(fullConfig, runtimeManager, { service });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (body) => {
    const response = await fetch(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}${FRONTIER_GATEWAY_PATH}`, {
      method: "POST", headers: { authorization: "Bearer runtime-token", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("without a question the tool lists the reader's newest picks of the window, as leads", options, async (t) => {
  const call = await gatewayFor(t);
  const { status, body } = await call({});
  assert.equal(status, 200);
  assert.equal(body.data.searchMode, "list");
  assert.deepEqual(body.data.items.map((item) => item.titleRaw), ["Semaglutide cuts heart failure events", "Oncology update"],
    "the picks only; the reader's hidden item and last quarter's stay out");
  const [lead] = body.data.items;
  assert.equal(lead.title, "司美格鲁肽减少心衰事件");
  assert.equal(lead.summary, "一项随机对照试验……");
  assert.equal(lead.reason, "改变 HFpEF 的治疗选择");
  assert.deepEqual(lead.source, { name: "NEJM", type: "journal", typeLabel: "期刊" });
  assert.equal(lead.evidenceTypeLabel, "RCT");
  assert.equal(lead.doi, "10.1056/NEJMoa2600001");
  assert.equal(lead.pmid, "41000001");
  assert.match(lead.url, /^https:\/\/nejm\.example\.org\//);
  assert.equal(lead.publishedAt, "2026-09-21T00:00:00.000Z");
  assert.equal(lead.visibleAt, "2026-09-22T03:00:00.000Z");
  assert.equal(lead.selected, true);
  assert.equal("state" in lead || "levels" in lead || "id" in lead, false, "nothing of the reader's page state leaves");
  const cardiology = await call({ specialty: "cardiology", window: "24h" });
  assert.deepEqual(cardiology.body.data.items.map((item) => item.titleRaw), ["Semaglutide cuts heart failure events"]);
});

test("a selected search narrows the page's widened search back to the picks and says what it left out", options, async (t) => {
  const call = await gatewayFor(t);
  const selected = await call({ q: "司美格鲁肽" });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.data.searchMode, "keyword");
  assert.deepEqual(selected.body.data.items.map((item) => item.titleRaw), ["Semaglutide cuts heart failure events"]);
  assert.equal(selected.body.data.unselectedSkipped, 1, "the unselected preprint matched and was dropped");
  const all = await call({ q: "司美格鲁肽", mode: "all" });
  assert.deepEqual(all.body.data.items.map((item) => [item.titleRaw, item.selected]).sort(),
    [["Semaglutide cuts heart failure events", true], ["Semaglutide weight trial", false]]);
  const preprint = all.body.data.items.find((item) => item.titleRaw === "Semaglutide weight trial");
  assert.deepEqual(preprint.flags, [{ key: "preprint", label: "未经同行评议" }]);
  assert.equal(preprint.source.typeLabel, "预印本");
});

test("an account the module is not open to is told frontier_disabled, and the list is never read", options, async (t) => {
  const call = await gatewayFor(t, { frontierAudience: "operators" });
  const refused = await call({ q: "司美格鲁肽" });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "frontier_disabled");
});
