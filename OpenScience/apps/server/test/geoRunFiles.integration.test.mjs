// Nothing the AI wrote is dropped at the platform's boundary (rectification 2026-10-14, G2): the strategy file and the article files of
// a finished run are written through the same validators as the tools' own writes, at the run's end, idempotently — and every field
// the platform does not keep is named, with its reason, in `GEO_NOT_STORED`.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createGeoDeliveryImport } from "../src/geoDeliveryImport.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { GEO_TABLES, migrateGeo } from "../src/geoPersistence.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GEO_NOT_STORED, geoArticlesFileCoverage, geoStrategyDraft, geoStrategyFileCoverage, geoStrategyWriteOfFile } from "../src/geoWrites.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const run = randomBytes(4).toString("hex");
const USER = `files-${run}`;

const resultsDir = fileURLToPath(new URL("../../../evals/geo-strategy/results/", import.meta.url));
const SAMPLES = ["2026-09-25-xinermei-sources-step", "2026-09-28-geo-strategy-004-mazdutide-conditions-written"];
const samplePath = (/** @type {string} */ name) => `${resultsDir}${name}/deliverable/deliverables/geo-strategy/strategy.json`;
const haveSamples = SAMPLES.every((name) => existsSync(samplePath(name)));
const sampleOptions = { skip: !haveSamples && "the stored strategy runs are not in this checkout" };
/** Both conditions in one options object: `test(name, a, b, fn)` takes no second options and would run nothing. */
const bothOptions = { skip: options.skip || sampleOptions.skip };
const sample = (/** @type {string} */ name) => JSON.parse(readFileSync(samplePath(name), "utf8"));

/** @type {any} */
let database = null;
/** @type {GeoStore} */
let store;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
let counter = 0;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geofiles");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  await store.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** A GEO project with a finished baseline (a strategy is only written after one). */
async function projectWithBaseline() {
  counter += 1;
  const created = await store.createProject({ userId: USER, projectId: `p-${run}-${counter}`, engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"], coverageDays: 90 });
  await database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, status, surface) VALUES ($1, $2, $3, 'baseline', 'done', '{}'::jsonb)`,
    [`rb-${created.id}`, USER, created.id]);
  return { geo: /** @type {any} */ (await store.getProject(USER, created.id)), control: { id: `p-${run}-${counter}`, userId: USER, workspaceDir: "/nowhere" } };
}

/** An importer that reads from an in-memory workspace. @param {Map<string, string>} files @param {Record<string, any>} [extra] */
function importerOf(files, extra = {}) {
  const reports = /** @type {string[]} */ ([]);
  const importDelivery = createGeoDeliveryImport({ store, report: (code) => reports.push(code), listInsightFolders: async () => [],
    readFile: async (_root, file) => {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(file) ?? "";
    }, ...extra });
  return { importDelivery, reports };
}

test("a strategy run's file is stored whole: gaps with their evidence and expected points, the battlefield's reasons, the tiers' words, the layout and its client to-dos", bothOptions, async () => {
  const { geo, control } = await projectWithBaseline();
  const file = sample(SAMPLES[0]);
  const { importDelivery, reports } = importerOf(new Map([["deliverables/geo-strategy/strategy.json", JSON.stringify(file)]]));
  const result = await importDelivery(control, { id: "run_s1", status: "succeeded", deliverables: [{ id: "geo-strategy", capability: "geo-strategy" }] });
  assert.equal(result?.files?.strategies, 1);
  assert.equal(result?.files?.gaps, 20);
  assert.equal(result?.files?.dropped.length, 0, "no field outside the list was dropped");
  assert.ok(reports.some((line) => line.startsWith("run files imported: strategy 1")));

  const latest = await store.latestStrategy(geo.id);
  assert.ok(latest);
  // gaps: the run's rank, consequence, evidence, expected points with their claim references, handoff and pin
  assert.equal(latest.gaps.length, 20);
  const first = latest.gaps.find((/** @type {any} */ gap) => gap.gapId === "GAP-01");
  assert.equal(first.class, "benefit_only", "the method's Chinese class word is the platform's id");
  assert.equal(first.rank, 1);
  assert.deepEqual(first.consequence, { band: "高", basis: "健康后果：缺失的是禁忌与必须就医的情形；本组 9 条问句全部是说明书安全题" });
  assert.equal(first.safetyPinned, true);
  assert.equal(first.handoff, "content");
  assert.equal(first.expectedPoints.length, 5);
  assert.deepEqual(first.expectedPoints[0].refs, [{ type: "claim_id", id: "gcl_3c26e8c398a45c4bb98647e59397d8b3" }]);
  assert.deepEqual(first.evidence.errors, ["ge_81faf3b6bae0cb32643b075ea7de0c21"]);
  assert.deepEqual(first.ecErrorRefs.length, 2);
  assert.ok(first.judgment.includes("66.67%"));
  assert.equal(Object.hasOwn(first, "pool"), false, "derived from the group, declined");
  // the battlefield: an object with its why, action and groups (the method's `measuredOn`), and the secondary ones as objects
  assert.equal(latest.battlefield.id, "BF-01");
  assert.equal(latest.battlefield.why.length, 5);
  assert.ok(latest.battlefield.action.startsWith("先出 6 篇结构化事实稿"));
  assert.deepEqual(latest.battlefield.groups, file.battlefield.measuredOn, "the orchestrator reads these");
  assert.equal(latest.battlefield.secondary.length, 2);
  assert.equal(latest.battlefield.secondary[0].id, "BF-02");
  assert.equal(typeof latest.battlefield.secondary[0].why[0], "string", "a single why is a list of one");
  // the things not to do, the tiers in words, the assumptions
  assert.equal(latest.noGo.length, 5);
  assert.deepEqual(latest.tiers.map((/** @type {any} */ tier) => tier.tier), ["1", "2", "3"]);
  const tier2 = latest.tiers.find((/** @type {any} */ tier) => tier.tier === "2");
  assert.ok(tier2.buys.startsWith("覆盖层 12 个位次"));
  assert.equal(tier2.notPromised.length, 3);
  assert.equal(tier2.contentUnits, 14);
  assert.equal(Object.hasOwn(tier2, "budgetCny"), false, "the targets table's");
  assert.ok(tier2.targets.every((/** @type {any} */ target) => !("baseline" in target) && !("target" in target)), "a tier's numbers are the targets table's, never typed twice");
  assert.equal(latest.assumptions.length, 9);
  assert.equal(latest.assumptions[0].field, "tier");
  // engines: promise, ceiling as a word, what leans where
  assert.equal(latest.expectations.length, 5);
  const qianwen = latest.expectations.find((/** @type {any} */ entry) => entry.engine === "qianwen");
  assert.equal(qianwen.ceiling, "mention_and_accuracy");
  assert.ok(qianwen.ceilingBasis.includes("98.86%"));
  assert.deepEqual(qianwen.clusterLeverage, [{ track: "accuracy", note: "说准优先：引用不带域名，内容位改动能否被它采用无法事前核对，只承诺讲对" }]);
  assert.equal(Object.hasOwn(qianwen, "retrieval"), false, "measured: the platform's own M-10 row");
  // layout: by engine, with the client's to-dos
  assert.equal(latest.layout.clientActions.length, 3);
  assert.equal(latest.layout.byEngine.length, 5);
  assert.equal(latest.layout.constraints.length, 6);
  // the source table
  const sources = await store.listSources(geo.id);
  assert.equal(sources.length, file.sources.table.length - 3, "the three rows whose `domain` names several sites (“a.com / b.com”) are refused alone, with their reason");
  assert.ok(sources.find((source) => source.domain === "mp.weixin.qq.com"), "a source of the table");
  assert.deepEqual(sources.find((source) => source.icpMatches === true)?.checkedAt?.slice(0, 10), "2026-09-25");
});

test("the same file again is not a version, and a changed file is", bothOptions, async () => {
  const { geo, control } = await projectWithBaseline();
  const file = sample(SAMPLES[1]);
  const files = new Map([["deliverables/geo-strategy/strategy.json", JSON.stringify(file)]]);
  const { importDelivery } = importerOf(files);
  const deliverables = [{ id: "geo-strategy", capability: "geo-strategy" }];
  await importDelivery(control, { id: "run_a", status: "succeeded", deliverables });
  const v1 = (await store.latestStrategy(geo.id))?.version;
  assert.ok(v1 >= 1);
  const sourcesBefore = (await store.listSources(geo.id)).length;
  await importDelivery(control, { id: "run_b", status: "succeeded", deliverables });
  assert.equal((await store.latestStrategy(geo.id))?.version, v1, "an unchanged strategy is not a new version");
  assert.equal((await store.listSources(geo.id)).length, sourcesBefore);
  const changed = { ...file, gaps: file.gaps.map((/** @type {any} */ gap, /** @type {number} */ index) => (index === 0 ? { ...gap, judgment: `${gap.judgment}（补充）` } : gap)) };
  files.set("deliverables/geo-strategy/strategy.json", JSON.stringify(changed));
  await importDelivery(control, { id: "run_c", status: "succeeded", deliverables });
  assert.equal((await store.latestStrategy(geo.id))?.version, v1 + 1);
  // an older run's file is never laid over a newer one: only the run's own deliverables are read
  files.set("deliverables/geo-strategy/strategy.json", JSON.stringify(file));
  await importDelivery(control, { id: "run_d", status: "succeeded", deliverables: [{ id: "geo-content", capability: "geo-content" }] });
  assert.equal((await store.latestStrategy(geo.id))?.version, v1 + 1, "a run that is not the strategy run's reads no strategy file");
});

test("a run's file adds to what the run wrote through the platform and never takes the place of it; a run that wrote nothing is the file's to say", options, async () => {
  const { geo, control } = await projectWithBaseline();
  const before = new Date(Date.now() - 60_000).toISOString();
  // The run wrote its plan in the platform's own words.
  const written = await geoRuntimeWrite({ store, project: geo, what: "strategy", body: { data: {
    summary: "一份完整的计划",
    battlefield: { id: "BF-01", name: "主战场", why: ["提及已到位"], action: "先补锚点", groups: ["品牌身份"] },
    gaps: [{ gapId: "GAP-01", class: "benefit_only", groupId: "g1", rank: 1, text: "只讲获益", judgment: "只讲获益不讲安全",
      consequence: { band: "高", basis: "健康后果" }, expectedPoints: [{ pointId: "EP-1", kind: "safety", statement: "出现过敏及时就医", refs: [] }] }],
    actions: [{ gapId: "GAP-01", what: { layer: "qa", channel: "wechat_mp" }, promise: "coverage_complete", reason: "补禁忌" }],
  } } });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  const v1 = await store.latestStrategy(geo.id);
  // Its file says less of the same plan, under fewer fields, and one gap more.
  const file = { gaps: [{ gapId: "GAP-01", class: "只讲获益不讲安全", text: "文件里的措辞" }, { gapId: "GAP-02", class: "丢条件", text: "新增的缺口", groupId: "g2" }],
    battlefield: { secondary: [{ id: "BF-02", name: "次要战场", why: "红旗覆盖不足" }] }, summary: "文件里的摘要" };
  const files = new Map([["deliverables/geo-strategy/strategy.json", JSON.stringify(file)]]);
  const { importDelivery } = importerOf(files);
  const deliverables = [{ id: "geo-strategy", capability: "geo-strategy" }];
  await importDelivery(control, { id: "run_own", status: "succeeded", startedAt: before, deliverables });
  const after = await store.latestStrategy(geo.id);
  assert.ok(after.version > v1.version, "the file added something");
  const first = after.gaps.find((/** @type {any} */ gap) => gap.gapId === "GAP-01");
  assert.equal(first.text, "只讲获益", "the run's own words stay");
  assert.equal(first.rank, 1);
  assert.equal(first.expectedPoints.length, 1);
  assert.deepEqual(first.consequence, { band: "高", basis: "健康后果" });
  assert.deepEqual(after.gaps.map((/** @type {any} */ gap) => gap.gapId), ["GAP-01", "GAP-02"], "a gap only the file has is added");
  assert.equal(after.summary, "一份完整的计划");
  assert.deepEqual([after.battlefield.id, after.battlefield.name, after.battlefield.groups], ["BF-01", "主战场", ["品牌身份"]], "the battlefield stays whole");
  assert.equal(after.battlefield.secondary.length, 1, "what it lacked is added");
  assert.equal(after.actions.length, 1);
  // The same file again changes nothing.
  await importDelivery(control, { id: "run_own", status: "succeeded", startedAt: before, deliverables });
  assert.equal((await store.latestStrategy(geo.id)).version, after.version);

  // A run that started after the stored strategy was written wrote nothing itself: its file is its statement.
  const later = new Date(Date.now() + 60_000).toISOString();
  files.set("deliverables/geo-strategy/strategy.json", JSON.stringify({ gaps: [{ gapId: "GAP-09", class: "过时", text: "新一轮的缺口", groupId: "g3" }] }));
  await importDelivery(control, { id: "run_next", status: "succeeded", startedAt: later, deliverables });
  assert.deepEqual((await store.latestStrategy(geo.id)).gaps.map((/** @type {any} */ gap) => gap.gapId), ["GAP-09"]);
});

test("a write that carries only the strategy's actions amends them and keeps the rest", options, async () => {
  const { geo } = await projectWithBaseline();
  const { geoRuntimeWrite } = await import("../src/geoWrites.mjs");
  const write = (/** @type {string} */ what, /** @type {any} */ body) => geoRuntimeWrite({ store, project: geo, what, body });
  const first = await write("strategy", { data: {
    gaps: [{ gapId: "G1", class: "缺证据", groupId: "g1", judgment: "没有说明书依据" }, { gapId: "G2", class: "benefit_only", groupId: "g2", judgment: "只讲获益" }],
    actions: [{ gapId: "G1", what: { layer: "qa", channel: "wechat_mp" }, promise: "raise_mention", reason: "补上说明书原文" }],
  } });
  assert.equal(first.ok, true);
  assert.ok(first.issues.some((/** @type {any} */ issue) => issue.code === "notice" && issue.gapId === "G2"), "the gap nobody answered is said, in the same turn");
  const added = await write("actions", { items: [
    { gapId: "G2", what: { layer: "popular", channel: "投放到专业渠道" }, promise: "guaranteed", engines: ["qianwen", "nope"], reason: "补安全提示" },
    { reason: "no gap and no group" },
  ] });
  assert.equal(added.ok, true);
  const codes = added.issues.map((/** @type {any} */ issue) => issue.code);
  assert.ok(codes.includes("missing"), "an entry that answers nothing is refused alone");
  assert.ok(codes.filter((/** @type {string} */ code) => code === "notice").length >= 3, "a word outside the list, an engine that is none: noted, the entry kept");
  const latest = await store.latestStrategy(geo.id);
  assert.equal(latest?.actions.length, 2);
  assert.deepEqual(latest?.actions[0].what, { layer: "qa", channel: "wechat_mp" }, "the first action stayed as it was");
  assert.deepEqual(latest?.actions[1], { gapId: "G2", what: { layer: "popular" }, engines: ["qianwen"], reason: "补安全提示" });
  assert.equal(latest?.gaps.length, 2, "the gaps are carried forward");
  const again = await write("actions", { items: [{ gapId: "G2", what: { layer: "popular" }, engines: ["qianwen"], reason: "补安全提示" }] });
  assert.equal(again.unchanged, true);
  assert.equal((await store.latestStrategy(geo.id))?.version, latest?.version);
});

test("the stored strategy runs hold no field the platform neither keeps nor has declined by name", sampleOptions, () => {
  for (const name of SAMPLES) {
    const file = sample(name);
    const coverage = geoStrategyFileCoverage(file);
    assert.deepEqual(coverage.dropped, [], `${name}: a field nobody decided on`);
    assert.ok(Object.keys(coverage.declined).length > 0);
    // and the same file, through the validators, has no refused or ignored part
    const { sources, ...rest } = geoStrategyWriteOfFile(file);
    const draft = geoStrategyDraft({ ...rest, sources });
    assert.deepEqual(draft.issues.filter((issue) => issue.code === "ignored_fields").map((issue) => issue.field), [], `${name}: no field was ignored`);
    // What is refused is a whole item for its own fault: a "domain" that names several sites ("mip.39yst.com / 39yst.com") is not a host.
    assert.deepEqual([...new Set(draft.issues.filter((issue) => !["notice", "declined_fields"].includes(issue.code)).map((issue) => `${issue.field}:${issue.code}`))]
      .filter((entry) => entry !== "sources.domain:invalid"), [], `${name}: nothing else is refused`);
    for (const key of ["gaps", "expectations", "battlefield", "layout", "tiers", "assumptions"]) {
      assert.ok(draft.strategy[key] !== undefined, `${name}: ${key} is stored`);
    }
  }
});

test("every field the platform declines has a reason, and the declared lists name nothing twice", () => {
  for (const [shape, reasons] of Object.entries(GEO_NOT_STORED)) {
    assert.ok(Object.keys(reasons).length > 0, shape);
    for (const [field, reason] of Object.entries(reasons)) {
      assert.ok(typeof reason === "string" && reason.length >= 20, `${shape}.${field} has no reason`);
    }
  }
});

test("an articles file enriches the articles the run registered with their channel and audience, and registers what it did not", options, async () => {
  const { geo, control } = await projectWithBaseline();
  await database.query(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, set_version, pool, name) VALUES ($1, $2, $3, 1, 'P2', 'g')`,
    [`gg-${geo.id}`, USER, geo.id]);
  await store.upsertClaims(USER, geo.id, [{ claimKey: "MAZ-1", statement: "s", quote: "q", sourceRef: "r" }]);
  const registered = "deliverables/geo-content/articles/a.md";
  const [articleId] = await store.registerArticles(USER, geo.id, [{ path: registered, layer: "qa", title: "已登记", groupId: `gg-${geo.id}`, claimIds: [],
    gate: "unverified", safety: "clear", contentSha256: "a".repeat(64), runId: "run_c", deliverableId: "geo-content" }]);
  const body = "# 稿件\n正文\n";
  const files = new Map([
    ["deliverables/geo-content/articles.json", JSON.stringify({ minimal: false, assumptions: ["x"], articles: [
      { id: "a", layer: "qa", title: "已登记", question: "q?", groupKey: "P2-01", claimKeys: ["MAZ-1"], path: "articles/a.md", recordPath: "records/a.md",
        audience: "药师、临床医生等专业读者", channel: "wechat_mp", author: "待甲方提供", reviewer: "待甲方提供", updatedAt: "2026-09-25",
        safety: { status: "clear", findings: [], note: "n" } },
      { id: "b", layer: "popular", title: "新稿", groupId: `gg-${geo.id}`, claimKeys: ["MAZ-1", "NOPE"], path: "articles/b.md", audience: "patient",
        channel: "公众科普与问答渠道；不放购买链接", safety: { status: "clear" } },
      { id: "c", layer: "popular", title: "没有群的稿", claimKeys: [], path: "articles/c.md", safety: { status: "clear" } },
      { id: "d", layer: "correction", title: "更正", errorId: "ge_unknown", claimKeys: [], path: "articles/d.md", safety: { status: "clear" } },
    ] })],
    ["deliverables/geo-content/articles/b.md", body],
    ["deliverables/geo-content/articles/c.md", body],
    ["deliverables/geo-content/articles/d.md", body],
  ]);
  const { importDelivery } = importerOf(files, { articleGate: async () => "passed" });
  const result = await importDelivery(control, { id: "run_c", status: "succeeded", deliverables: [{ id: "geo-content", capability: "geo-content" }] });
  assert.equal(result?.files?.articles, 4);
  assert.equal(result?.files?.enriched, 1);
  assert.equal(result?.files?.registered, 1, "b is registered; c has no group and d names an error the project does not have");
  assert.equal(result?.files?.dropped.length, 0);
  const enriched = await store.getArticle(geo.id, articleId);
  assert.deepEqual([enriched?.channel, enriched?.channelNote, enriched?.audience, enriched?.audienceNote], ["wechat_mp", null, null, "药师、临床医生等专业读者"],
    "a closed word is the word, and the run's own words are kept as a note");
  const all = await store.listArticles(geo.id);
  const added = all.find((article) => article.path === "deliverables/geo-content/articles/b.md");
  assert.ok(added);
  assert.deepEqual([added.channel, added.channelNote?.startsWith("公众科普"), added.audience, added.groupId, added.gate], [null, true, "patient", `gg-${geo.id}`, "passed"]);
  assert.equal(added.contentSha256, createHash("sha256").update(body).digest("hex"), "the platform's own hash of the bytes it read");
  assert.equal(added.claimIds.length, 1, "the key the library has is its id; a key it does not is left out");
  // again: nothing changes
  const second = await importDelivery(control, { id: "run_c2", status: "succeeded", deliverables: [{ id: "geo-content", capability: "geo-content" }] });
  assert.equal(second?.files?.enriched, 0);
  assert.equal(second?.files?.registered, 0);
  assert.equal((await store.listArticles(geo.id)).length, all.length);
});

test("an articles file's own fields are stored, mapped or declined by name", () => {
  const coverage = geoArticlesFileCoverage({ minimal: false, assumptions: [], articles: [
    { id: "a", layer: "qa", title: "t", question: "q", groupKey: "k", claimKeys: [], path: "p", recordPath: "r", audience: "a", channel: "c", author: "a", reviewer: "r",
      updatedAt: "d", safety: { status: "clear", findings: [], note: "n" }, errorId: "e", groupId: "g", contentSha256: "x", engine: "kimi", questionId: "q1" },
    { id: "b", surprise: true, safety: { status: "open", other: 1 } },
  ] });
  assert.deepEqual(coverage.dropped.sort(), ["articles[1].safety.other", "articles[1].surprise"]);
  assert.ok(coverage.declined["articles[0].groupKey"]);
  assert.ok(coverage.declined["articles[0].safety.findings"]);
  assert.ok(coverage.declined["articles.json.minimal"]);
});

test("a database of the previous release gets the new columns, the choices table and the widened lists, and keeps its rows", options, async () => {
  const previous = await createGeoTestDatabase(databaseUrl, "geoprev");
  const left = new ControlPlaneDatabase({ databaseUrl: previous.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try {
    await migrateGeo(left);
    // The previous release's shape: none of this release's columns or its table, and a list the vocabulary has since grown.
    await left.query(`ALTER TABLE evimed_geo.articles DROP COLUMN channel, DROP COLUMN channel_note, DROP COLUMN audience, DROP COLUMN audience_note`);
    await left.query(`ALTER TABLE evimed_geo.strategy DROP COLUMN tiers, DROP COLUMN no_go, DROP COLUMN assumptions, DROP COLUMN actions`);
    await left.query(`ALTER TABLE evimed_geo.question_groups DROP COLUMN journey_stage_no`);
    await left.query(`ALTER TABLE evimed_geo.sources DROP COLUMN check_evidence`);
    await left.query(`DROP TABLE evimed_geo.action_choices`);
    await left.query(`INSERT INTO evimed_geo.projects (id, user_id, project_id, engines) VALUES ('geo_old', 'u-old', 'p-old', ARRAY['deepseek'])`);
    await left.query(`INSERT INTO evimed_geo.strategy (geo_project_id, version, user_id, battlefield, gaps, summary) VALUES
      ('geo_old', 1, 'u-old', '{"groups":["g"],"reason":"r"}'::jsonb, '[{"class":"benefit_only","text":"t"}]'::jsonb, 's')`);
    await left.query(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, path, layer, safety, status) VALUES ('gart_old', 'u-old', 'geo_old', 'a.md', 'qa', 'clear', 'draft')`);
  } finally {
    await left.close();
  }
  // a new process: a new database object, so the migration runs again
  const right = new ControlPlaneDatabase({ databaseUrl: previous.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  const reference = await createGeoTestDatabase(databaseUrl, "georef");
  const fresh = new ControlPlaneDatabase({ databaseUrl: reference.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try {
    const migrated = await migrateGeo(right);
    await migrateGeo(fresh);
    assert.ok(migrated.tables.includes("action_choices") && GEO_TABLES.includes("action_choices"));
    const shape = async (/** @type {any} */ db) => (await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'evimed_geo' AND (table_name, column_name) IN (('articles', 'channel'), ('articles', 'channel_note'), ('articles', 'audience'),
        ('articles', 'audience_note'), ('strategy', 'tiers'), ('strategy', 'no_go'), ('strategy', 'assumptions'), ('strategy', 'actions'),
        ('question_groups', 'journey_stage_no'), ('sources', 'check_evidence'), ('action_choices', 'action_key'), ('action_choices', 'skipped'))
      ORDER BY 1, 2`)).rows;
    const wanted = await shape(fresh);
    assert.equal(wanted.length, 12);
    assert.deepEqual(await shape(right), wanted);
    const checks = async (/** @type {any} */ db) => (await db.query(`SELECT c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'evimed_geo' AND r.relname IN ('articles', 'question_groups', 'action_choices') AND c.contype IN ('c', 'p', 'f') ORDER BY c.conname`)).rows;
    assert.deepEqual(await checks(right), await checks(fresh), "the constraints equal a freshly migrated database's");
    // the old rows are read as they were, the new fields are null
    const old = await new GeoStore({ database: right }).latestStrategy("geo_old");
    assert.deepEqual([old?.summary, old?.battlefield?.reason, old?.gaps?.length, old?.tiers, old?.noGo, old?.assumptions, old?.actions], ["s", "r", 1, null, null, null, null]);
    const article = await new GeoStore({ database: right }).getArticle("geo_old", "gart_old");
    assert.deepEqual([article?.channel, article?.channelNote, article?.audience, article?.audienceNote], [null, null, null, null]);
  } finally {
    await right.close();
    await fresh.close();
    await previous.drop();
    await reference.drop();
  }
});

test("a person's choices are two reversible words per action and nothing else", options, async () => {
  const { geo } = await projectWithBaseline();
  const key = "fill_gap:ggr_x:benefit_only";
  assert.deepEqual(await store.actionChoices(geo.id), []);
  const skipped = await store.setActionChoice({ geoId: geo.id, ownerId: USER, key, decidedBy: "editor-1", skipped: true });
  assert.deepEqual([skipped?.skipped, skipped?.sourceDomain], [true, null]);
  const swapped = await store.setActionChoice({ geoId: geo.id, ownerId: USER, key, decidedBy: "editor-2", sourceDomain: "kepuchina.cn" });
  assert.deepEqual([swapped?.skipped, swapped?.sourceDomain], [true, "kepuchina.cn"], "a swap does not undo a skip");
  const unskipped = await store.setActionChoice({ geoId: geo.id, ownerId: USER, key, decidedBy: "editor-1", skipped: false });
  assert.deepEqual([unskipped?.skipped, unskipped?.sourceDomain], [false, "kepuchina.cn"]);
  assert.equal((await store.actionChoices(geo.id))[0].decidedBy, "editor-1");
  const cleared = await store.setActionChoice({ geoId: geo.id, ownerId: USER, key, decidedBy: "editor-1", sourceDomain: null });
  assert.equal(cleared, null, "nothing decided is no row");
  assert.deepEqual(await store.actionChoices(geo.id), []);
});
