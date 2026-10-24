// Nothing the AI wrote is dropped at the platform's boundary (rectification 2026-10-14, G2): the strategy file and the article files of
// a finished run are written through the same validators as the tools' own writes, at the run's end, idempotently — and every field
// the platform does not keep is named, with its reason, in `GEO_NOT_STORED`.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createGeoDeliveryImport, fillStrategy } from "../src/geoDeliveryImport.mjs";
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

test('delayed scoped strategy import uses the actual producing run basis and plain outputFiles, and retries do not create versions', options, async () => {
  const {geo,control} = await projectWithBaseline();
  const original = {schemaVersion:1,capturedAt:'2026-10-24T00:00:00Z',selection:{dataRevision:'original'},priceReferences:[{kind:'source_price',id:'media-quote',digest:'a'.repeat(64)}],marker:'selected group at submission'};
  const context = {referenceId:'gpc_actual',scopeKey:'gps_group_a',basis:original,runId:'scoped-real-run',mode:'strategy'};
  const action = {gapId:'missing',kind:'fill_gap',what:{layer:'popular',title:'Native content'},work:{mode:'new',audience:'patient',outputs:['article.md']},sequence:2,timing:{durationDays:{low:2,high:4},basis:'Supplied schedule'},effort:{unit:'hours',low:2,high:3,basis:'Supplied workload'},estimate:{currency:'CNY',low:50,high:80,basis:[{kind:'source_price',id:'media-quote',digest:'a'.repeat(64)}]}};
  const files = new Map([['deliverables/native-plan/strategy.json',JSON.stringify({summary:'Produced from original input',actions:[action]})]]);
  const captured = new Map(files);
  const readRunFile = async (_project,actualRun,path)=>{assert.equal(actualRun.id,'scoped-real-run');return captured.get(path);};
  const {importDelivery} = importerOf(files,{readRunFile,planningContext:async (_project,actualRun)=>actualRun.id==='scoped-real-run'?context:null});
  const produced = {id:'scoped-real-run',startedAt:'2026-10-23T00:00:00Z',status:'succeeded',sessionId:'native-session',kernelRequestIds:['actual-native-request'],outputFiles:[{path:'deliverables/native-plan/strategy.json'}]};
  await store.writeStrategy(USER,geo.id,{summary:'Unrelated global plan after generation'});
  await store.writeStrategy(USER,geo.id,{scopeKey:context.scopeKey,basis:{marker:'another newer run'},summary:'Other run in same scope',runId:'other-run'});
  files.set('deliverables/native-plan/strategy.json',JSON.stringify({summary:'Mutable workspace changed after producer finished'}));
  await importDelivery(control,produced);
  const plan = await store.latestStrategy(geo.id,{scopeKey:context.scopeKey});
  assert.equal(plan.summary,'Produced from original input'); assert.deepEqual(plan.basis,original);
  assert.equal(plan.actions[0].work.mode,'new'); assert.equal(plan.actions[0].sequence,2);
  assert.equal(plan.actions[0].timing.durationDays.high,4);assert.equal(plan.actions[0].effort.high,3);assert.equal(plan.actions[0].estimate.high,80);
  assert.equal((await store.latestStrategy(geo.id)).summary,'Unrelated global plan after generation');
  const retry = importerOf(files,{readRunFile,planningContext:async()=>context}); await retry.importDelivery(control,produced);
  assert.equal((await store.latestStrategy(geo.id,{scopeKey:context.scopeKey})).version,plan.version);
});

for (const field of ['presentedFiles', 'artifacts', 'unverifiedArtifacts', 'outputFiles']) test(`native scoped strategy discovers ${field} without declared deliverables and preserves the original scope`, options, async () => {
  const { geo, control } = await projectWithBaseline();
  const relative = 'deliverables/native-specialist/strategy.json';
  const basis = { schemaVersion: 1, selection: { groupIds: ['original-group'], sourceId: 'original-source', questionVersion: 1 } };
  const context = { mode: 'strategy', scopeKey: `native-${field}`, basis, runId: `native-${field}` };
  const produced = { id: context.runId, status: 'succeeded', sessionId: 'native-session', kernelRequestIds: ['request'], progress: { deliverables: [] }, [field]: [relative] };
  const original = JSON.stringify({ summary: 'Original immutable strategy', scopeKey: 'forged', basis: { replaced: true }, runId: 'forged' });
  const make = () => importerOf(new Map([[relative, '{"summary":"New workspace bytes"}']]), {
    planningContext: async () => context, readRunFile: async (_project, actual, file) => { assert.equal(actual.id, context.runId); assert.equal(file, relative); return original; },
    listInsightFolders: async () => { throw new Error('Bound import must not scan workspace'); },
    listDeliverableFolders: async () => { throw new Error('Bound import must not scan workspace'); },
  }).importDelivery;
  await store.writeStrategy(USER, geo.id, { summary: 'Global control' });
  const importer = make();
  const first = await importer(control, produced);
  assert.equal(first?.files?.strategies, 1);
  await Promise.all([importer(control, produced), importer(control, produced)]);
  await make()(control, produced);
  const stored = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey });
  assert.equal(stored?.summary, 'Original immutable strategy'); assert.equal(stored?.runId, produced.id);
  assert.deepEqual(stored?.basis, basis);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM evimed_geo.strategy WHERE geo_project_id=$1 AND scope_key=$2', [geo.id, context.scopeKey])).rows[0].n, 1);
  assert.equal((await store.latestStrategy(geo.id))?.summary, 'Global control');
});

test('bound structured import reports unavailable for missing, invalid or empty files and explicit recovery bypasses exhausted attempts without recapture', options, async () => {
  const { geo, control } = await projectWithBaseline();
  const relative = 'deliverables/recover/strategy.json';
  const produced = { id: 'recover-native', status: 'succeeded', sessionId: 'native-session', artifacts: [relative] };
  const context = { mode: 'strategy', scopeKey: 'retry-original', basis: { original: true }, runId: produced.id };
  let bytes = null, captures = 0;
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => context,
    beforeImport: async () => { captures++; }, readRunFile: async () => { if (bytes === null) throw Object.assign(new Error('missing'), { code: 'geo_plan_output_unavailable' }); return bytes; } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await importDelivery(control, produced);
    assert.ok(result?.failed?.includes('geo_plan_output_unavailable'));
  }
  assert.equal(importDelivery.counters.imported, 0);
  bytes = '{';
  const invalid = await importDelivery(control, produced, { recovery: true, readRunFile: async () => bytes });
  assert.ok(invalid?.failed?.includes('geo_plan_output_invalid'));
  bytes = '{}';
  const empty = await importDelivery(control, produced, { recovery: true, readRunFile: async () => bytes });
  assert.ok(empty?.failed?.includes('geo_plan_output_unavailable'));
  bytes = '{"summary":"Recovered original"}';
  const recovered = await importDelivery(control, produced, { recovery: true, readRunFile: async () => bytes });
  assert.equal(recovered?.files?.strategies, 1); assert.equal(captures, 2, 'Recovery never calls beforeImport capture');
  assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey }))?.runId, produced.id);
});

test('selected ordinary analysis remains a no-op even when it presents a report', options, async () => {
  const { geo, control } = await projectWithBaseline();
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => ({ mode: 'analysis', runId: 'analysis' }),
    readRunFile: async () => { throw new Error('No structured output'); }, listInsightFolders: async () => [], listDeliverableFolders: async () => [] });
  const result = await importDelivery(control, { id: 'analysis', status: 'succeeded', presentedFiles: ['deliverables/analysis/report.md'] });
  assert.equal(result?.failed, undefined); assert.equal(await store.latestStrategy(geo.id), null);
});

for (const field of ['presentedFiles', 'artifacts', 'outputFiles']) test(`native content discovers ${field} and reads article bytes only from its preserved run`, options, async () => {
  const { geo, control } = await projectWithBaseline();
  await database.query(`INSERT INTO evimed_geo.question_groups (id,user_id,geo_project_id,set_version,pool,name) VALUES ($1,$2,$3,1,'P2','Native content')`, [`native-${geo.id}`, USER, geo.id]);
  const body = '# Preserved article\n';
  const relative = 'deliverables/native-content/articles.json', article = 'deliverables/native-content/articles/a.md';
  const immutable = new Map([[relative, JSON.stringify({ articles: [{ path: 'articles/a.md', layer: 'popular', title: 'Preserved', groupId: `native-${geo.id}`, safety: 'clear', channel: 'wechat_mp', audience: 'patient' }] })], [article, body]]);
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => ({ mode: 'content', runId: `content-${field}` }),
    readRunFile: async (_project, actual, file) => { assert.equal(actual.id, `content-${field}`); if (!immutable.has(file)) throw new Error('missing preserved file'); return immutable.get(file); },
    readFile: async () => { throw new Error('No mutable workspace bytes'); }, listInsightFolders: async () => [], listDeliverableFolders: async () => [] });
  const result = await importDelivery(control, { id: `content-${field}`, sessionId: 'content-session', status: 'succeeded', [field]: [relative, article] });
  assert.equal(result?.files?.registered, 1); assert.equal(result?.failed, undefined);
  const saved = (await store.listArticles(geo.id))[0];
  assert.equal(saved.runId, `content-${field}`); assert.equal(saved.path, article);
  assert.equal(saved.contentSha256, createHash('sha256').update(body).digest('hex'));
  const repeated = await importDelivery(control, { id: `content-${field}`, sessionId: 'content-session', status: 'succeeded', [field]: [relative, article] }, { recovery: true, readRunFile: async (_p, _r, file) => immutable.get(file) });
  assert.equal(repeated?.failed, undefined, 'An already registered identical article is a successful idempotent reconciliation');
});

test('concurrent explicit recoveries of the same immutable candidate join one import attempt', options, async () => {
  const { control } = await projectWithBaseline();
  const produced = { id: 'join-recovery', status: 'succeeded', sessionId: 'session', artifacts: ['deliverables/join/strategy.json'] };
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => ({ mode: 'strategy', scopeKey: 'join', basis: {}, runId: produced.id }) });
  let release, reached, reads = 0;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  const recovery = { recovery: true, candidateIdentity: 'same-pinned-version-and-digest', readRunFile: async () => { reads++; reached(); await held; return '{"summary":"One attempt"}'; } };
  const first = importDelivery(control, produced, recovery); await entered;
  const second = importDelivery(control, produced, recovery); release();
  const results = await Promise.all([first, second]);
  assert.equal(reads, 1); assert.deepEqual(results[0], results[1]);
});

async function nativeContentFixture(artifacts, makeFiles) {
  const { geo, control } = await projectWithBaseline();
  const groupId = `spec-${geo.id}`;
  await database.query(`INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES($1,$2,$3,1,'P2','Selected')`, [groupId, USER, geo.id]);
  const produced = { id: `spec-${geo.id}`, status: 'succeeded', sessionId: 'session', effectiveAgentId: 'geo-content', artifacts };
  const context = { mode: 'content', runId: produced.id };
  let files = makeFiles(groupId);
  const makeImporter = () => importerOf(new Map(), { planningContext: async () => context, readRunFile: async (_project, _run, file) => {
    if (!files.has(file)) throw Object.assign(new Error('No preserved bytes'), { code: 'geo_plan_output_unavailable' }); return files.get(file);
  }, readFile: async () => { throw new Error('No workspace reads'); } }).importDelivery;
  return { geo, control, produced, makeImporter, replaceFiles: next => { files = next(groupId); } };
}

test('SPEC-1: each manifest may register only its own canonical deliverable even when another candidate body is pinned', options, async () => {
  const artifacts = ['deliverables/a/articles.json', 'deliverables/b/articles.json', 'deliverables/b/articles/b.md'];
  const f = await nativeContentFixture(artifacts, groupId => new Map([
    [artifacts[0], JSON.stringify({ articles: [{ path: artifacts[2], layer: 'popular', title: 'Cross-folder', groupId }] })],
    [artifacts[1], '{"articles":[]}'], [artifacts[2], '# B'],
  ]));
  const importDelivery = f.makeImporter(), result = await importDelivery(f.control, f.produced);
  assert.equal((await store.listArticles(f.geo.id)).length, 0);
  assert.ok(result.failed?.includes('geo_plan_output_unavailable')); assert.equal(importDelivery.counters.imported, 0);
  f.replaceFiles(groupId => new Map([
    [artifacts[0], JSON.stringify({ articles: [{ path: 'articles/a.md', layer: 'popular', title: 'A', groupId }] })],
    [artifacts[1], JSON.stringify({ articles: [{ path: artifacts[2], layer: 'popular', title: 'B', groupId }] })],
    ['deliverables/a/articles/a.md', '# A'], [artifacts[2], '# B'],
  ]));
  const recovered = await importDelivery(f.control, f.produced, { recovery: true });
  assert.equal(recovered.failed, undefined);
  assert.deepEqual((await store.listArticles(f.geo.id)).map(article => [article.path, article.deliverableId]).sort(), [
    ['deliverables/a/articles/a.md', 'a'], ['deliverables/b/articles/b.md', 'b'],
  ]);
});

test('SPEC-2: mixed accepted/refused entries retain useful rows but stay partial and allow bounded corrected recovery', options, async () => {
  const artifacts = ['deliverables/a/articles.json', 'deliverables/a/articles/a.md', 'deliverables/a/articles/b.md'];
  const files = (groupId, layer) => new Map([
    [artifacts[0], JSON.stringify({ articles: [{ path: 'articles/a.md', layer: 'popular', title: 'A', groupId }, { path: 'articles/b.md', layer, title: 'B', groupId }] })],
    [artifacts[1], '# A'], [artifacts[2], '# B'],
  ]);
  const f = await nativeContentFixture(artifacts, groupId => files(groupId, 'invalid-layer'));
  const importDelivery = f.makeImporter(), first = await importDelivery(f.control, f.produced);
  assert.equal(first.files.registered, 1); assert.equal(first.files.skipped, 1); assert.ok(first.failed?.includes('geo_plan_output_unavailable'));
  assert.equal(importDelivery.counters.imported, 0);
  const kept = (await store.listArticles(f.geo.id))[0];
  const retry = await importDelivery(f.control, f.produced);
  assert.ok(retry.failed?.includes('geo_plan_output_unavailable')); assert.equal(await importDelivery(f.control, f.produced), null, 'Automatic attempts remain bounded');
  f.replaceFiles(groupId => files(groupId, 'popular'));
  const recovered = await importDelivery(f.control, f.produced, { recovery: true });
  assert.equal(recovered.failed, undefined); assert.equal((await store.listArticles(f.geo.id)).length, 2);
  assert.equal((await store.listArticles(f.geo.id)).find(article => article.path === kept.path).id, kept.id);
  await f.makeImporter()(f.control, f.produced, { recovery: true }); assert.equal((await store.listArticles(f.geo.id)).length, 2);
});

for (const empty of ['{}', '{"articles":[]}', 'null', '42']) test(`SPEC-2: a valid first manifest cannot hide an unavailable second manifest ${empty}`, options, async () => {
  const artifacts = ['deliverables/a/articles.json', 'deliverables/b/articles.json', 'deliverables/a/articles/a.md'];
  const f = await nativeContentFixture(artifacts, groupId => new Map([
    [artifacts[0], JSON.stringify({ articles: [{ path: 'articles/a.md', layer: 'popular', title: 'A', groupId }] })],
    [artifacts[1], empty], [artifacts[2], '# A'],
  ]));
  const importer = f.makeImporter(), result = await importer(f.control, f.produced);
  assert.equal(result.files.registered, 1); assert.ok(result.failed?.includes('geo_plan_output_unavailable'));
  assert.equal(importer.counters.imported, 0); assert.equal((await store.listArticles(f.geo.id)).length, 1);
});

test('SPEC-3: an authorized bound source review imports its preserved value idempotently and rejects foreign review scope', options, async () => {
  const { geo, control } = await projectWithBaseline();
  const relative = 'deliverables/review/geo-value.json';
  const produced = { id: `review-${geo.id}`, status: 'succeeded', sessionId: 'session', effectiveAgentId: 'geo-insight', artifacts: [relative], deliverables: [{ id: 'review', capability: 'geo-insight' }] };
  const basis = { signal: { id: 'signal', kind: 'source_changed', basisDigest: 'signal-digest' }, event: { notice: { id: 'source' }, targets: [{ key: 'selected' }] }, focusRefs: ['selected'], intent: 'review' };
  const context = { mode: 'signal', referenceId: 'context', runId: produced.id, basis };
  const review = { signalId: 'signal', basisDigest: 'signal-digest', contextRef: 'context', targets: [{ targetKey: 'selected', outcome: 'uncertain', reason: 'The original source is unavailable.' }] };
  let file = JSON.stringify({ sourceChanges: [{ id: 'source', review }] });
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => context, readRunFile: async (_p, actual, path) => { assert.equal(actual.id, produced.id); assert.equal(path, relative); return file; },
    readFile: async () => { throw new Error('No workspace fallback'); } });
  const first = await importDelivery(control, produced);
  assert.equal(first.failed, undefined);
  const profile = await store.latestValue(geo.id); assert.equal(profile.runId, produced.id); assert.deepEqual(profile.data.sourceChanges[0].review, review);
  await importDelivery(control, produced, { recovery: true }); assert.equal((await store.latestValue(geo.id)).version, profile.version);
  for (const invalid of [{ ...review, signalId: 'foreign' }, { ...review, basisDigest: 'foreign' }, { ...review, contextRef: 'foreign' },
    { ...review, targets: [{ ...review.targets[0], targetKey: 'unselected' }] }]) {
    file = JSON.stringify({ sourceChanges: [{ id: 'source', review: invalid }] });
    const result = await importDelivery(control, produced, { recovery: true });
    assert.ok(result.failed?.includes('geo_plan_output_unavailable')); assert.equal((await store.latestValue(geo.id)).version, profile.version);
  }
});

test('QUALITY-Q2: real strategy field refusals keep valid summary partial and preserve two-attempt and corrected-recovery behavior', options, async () => {
  const { geo, control } = await projectWithBaseline();
  const relative = 'deliverables/partial-strategy/strategy.json', produced = { id: `quality-${geo.id}`, status: 'succeeded', artifacts: [relative] };
  const context = { mode: 'strategy', runId: produced.id, scopeKey: 'quality-original', basis: { original: true } };
  let file = JSON.stringify({ summary: 'Usable preserved summary', gaps: 42 });
  const make = () => importerOf(new Map(), { planningContext: async () => context, readRunFile: async () => file }).importDelivery;
  const importer = make(), first = await importer(control, produced);
  assert.ok(first.failed?.includes('geo_plan_output_unavailable')); assert.equal(first.files.refused, 1);
  assert.ok(first.files.unavailable.some(path => path.includes('gaps'))); assert.equal(importer.counters.imported, 0);
  const kept = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey });
  assert.equal(kept.summary, 'Usable preserved summary'); assert.equal(kept.gaps, null);
  assert.ok((await importer(control, produced)).failed?.includes('geo_plan_output_unavailable'));
  assert.equal(await importer(control, produced), null); assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).version, kept.version);
  file = JSON.stringify({ summary: 'Usable preserved summary', gaps: [{ gapId: 'corrected', class: 'benefit_only', text: 'Preserved correction' }] });
  const recovered = await importer(control, produced, { recovery: true }); assert.equal(recovered.failed, undefined);
  const corrected = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey }); assert.equal(corrected.gaps[0].gapId, 'corrected');
  await make()(control, produced, { recovery: true }); assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).version, corrected.version);
});

test('QUALITY-Q2: invalid source rows stay partial beside a valid strategy and accepted source rows', options, async () => {
  const { geo, control } = await projectWithBaseline();
  const produced = { id: `quality-sources-${geo.id}`, status: 'succeeded', artifacts: ['deliverables/source-strategy/strategy.json'] };
  const context = { mode: 'strategy', runId: produced.id, scopeKey: 'quality-source', basis: {} };
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => context,
    readRunFile: async () => JSON.stringify({ summary: 'Valid strategy', sources: [{ domain: 'valid.example', name: 'Retained' }, { domain: 'not a host', name: 'Refused' }] }) });
  const result = await importDelivery(control, produced);
  assert.ok(result.failed?.includes('geo_plan_output_unavailable')); assert.equal(result.files.sources, 1);
  assert.ok(result.files.unavailable.some(path => path.includes('sources'))); assert.equal(importDelivery.counters.imported, 0);
  assert.deepEqual((await store.listSources(geo.id)).map(source => source.domain), ['valid.example']);
  assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).summary, 'Valid strategy');
});

test('QUALITY-Q2: numeric ownership declines, advisory notices and optional markers do not make a valid strategy unavailable', options, async () => {
  const { control } = await projectWithBaseline();
  const produced = { id: 'quality-advisory', status: 'succeeded', artifacts: ['deliverables/advisory/strategy.json'] };
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => ({ mode: 'strategy', runId: produced.id, scopeKey: 'advisory', basis: {} }),
    readRunFile: async () => JSON.stringify({ summary: 'Supported', acceptanceMark: 'ignored', minimal: true, chosenTier: 'standard',
      tiers: [{ tier: 'standard', placements: 2, budgetCny: 10, targets: [{ baseline: null, target: 0.98, dataType: 'forecast' }] }], expectations: [{ engine: 'deepseek', retrieval: 0.3 }],
      actions: [{ gapId: 'unmatched', what: { layer: 'popular' } }] }) });
  const result = await importDelivery(control, produced);
  assert.equal(result.failed, undefined); assert.deepEqual(result.files.unavailable, []); assert.equal(importDelivery.counters.imported, 1);
});

for (const capability of ['geo-strategy', 'geo-content', 'geo-insight']) test(`QUALITY-Q3: source-review-only intent using ${capability} requires only its authorized value output`, options, async () => {
  const { geo, control } = await projectWithBaseline();
  const relative = 'deliverables/review/geo-value.json', produced = { id: `quality-review-${geo.id}`, status: 'succeeded', effectiveAgentId: capability, artifacts: [relative] };
  const basis = { intent: 'review', signal: { kind: 'source_changed', id: 'signal', basisDigest: 'digest' }, event: { notice: { id: 'source' }, targets: [{ key: 'selected' }] }, focusRefs: ['selected'] };
  const context = { mode: 'signal', runId: produced.id, referenceId: 'context', basis };
  const review = { signalId: 'signal', basisDigest: 'digest', contextRef: 'context', targets: [{ targetKey: 'selected', outcome: 'uncertain', reason: 'Original unavailable' }] };
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => context, readRunFile: async () => JSON.stringify({ sourceChanges: [{ id: 'source', review }] }) });
  const result = await importDelivery(control, produced);
  assert.equal(result.valueFiles.imported, 1); assert.equal(result.failed, undefined); assert.equal(importDelivery.counters.imported, 1);
  assert.deepEqual((await store.latestValue(geo.id)).data.sourceChanges[0].review, review);
  if (capability !== 'geo-insight') {
    const invalidDeclared = { ...produced, deliverables: [{ id: 'invalid', capability }] };
    const partial = await importDelivery(control, invalidDeclared, { recovery: true });
    assert.ok(partial.failed?.includes('geo_plan_output_unavailable'), 'A separately declared structured candidate keeps its own failure');
    assert.equal(partial.valueFiles.imported, 1);
  }
});


const N09_SUMMARIES = [
  "除平台硬线外不写效果预测：g1 仅 1 条回答且未判定，M-01、M-06 均为 not_measurable（0/0）；位置数与预算也未取得依据。",
  "平台默认档位。除平台硬线外不写效果预测；位置数与预算无依据，保持未知。",
  "除平台硬线外不写效果预测；位置数与预算无依据，保持未知。",
];
const N09_NOTE = "平台准确率硬线 98%，不是本项目基线推算；g1 的 M-06 判定为 0/0（not_adjudicated），基线不可测。";
const n09Tiers = () => N09_SUMMARIES.map((basis, index) => ({ tier: index + 1, basis, placements: null, budgetCny: null,
  targets: [{ metricId: "M-06", pool: "P2", baseline: null, target: 0.98, dataType: "forecast", basis: N09_NOTE }] }));

test("tier narrative aliases share canonical normalization, limits and diagnostics without refusing siblings", () => {
  const draft = tiers => geoStrategyDraft({ tiers }).strategy.tiers;
  assert.deepEqual(draft([{ tier: 1, basis: "  First\nSecond\u0000  ", targets: [{ metricId: "M-06", basis: " one\n two\u0000 " }] }]),
    [{ tier: "1", summary: "First\nSecond", targets: [{ metricId: "M-06", note: "one two" }] }]);
  for (const [summary, basis, expected] of [["Canonical", "Canonical", "Canonical"], ["First\n\nSecond", "Second", "First\n\nSecond"], ["First\n\nOne two", "One\n two", "First\n\nOne two"],
    ["Canonical", "Extra", "Canonical\n\nExtra"], ["", "Alias", "Alias"], [null, "Alias", "Alias"]]) {
    assert.equal(draft([{ tier: 1, summary, basis }])[0].summary, expected);
  }
  assert.equal(draft([{ tier: 1, targets: [{ metricId: "M-06", note: "First\n\nOne two", basis: "One\n two" }] }])[0].targets[0].note, "First One two");
  assert.equal(draft([{ tier: 1, targets: [{ metricId: "M-06", note: "First", basis: "Second" }] }])[0].targets[0].note, "First Second");
  assert.equal(draft([{ tier: 1, targets: [{ metricId: "M-06", basis: "Hard line in words", hardLine: true }] }])[0].targets[0].hardLine, true);
  assert.equal(draft([{ tier: 1, summary: "x".repeat(597), basis: "y" }])[0].summary.length, 600);
  assert.equal(draft([{ tier: 1, targets: [{ metricId: "M-06", note: "x".repeat(498), basis: "y" }] }])[0].targets[0].note.length, 500);
  const unicode = "😀".repeat(600), note = "😀".repeat(500);
  assert.equal(draft([{ tier: 1, basis: unicode, targets: [{ metricId: "M-09", basis: note }] }])[0].summary, unicode);
  assert.equal(draft([{ tier: 1, targets: [{ metricId: "M-09", note: "One two", basis: "One\n two" }] }])[0].targets[0].note, "One two");
  for (const bad of [{ raw: {}, code: "invalid" }, { raw: "😀".repeat(601), code: "too_long" }, { raw: " \n\u0000 ", code: "empty" }]) {
    const input = { tiers: [{ tier: 1, summary: "Kept", basis: bad.raw, buys: "Useful", targets: [{ metricId: "M-06", note: "Held", basis: bad.raw }] }, { tier: 2, basis: "Sibling" }] };
    const before = JSON.stringify(input), result = geoStrategyDraft(input);
    assert.equal(result.strategy.tiers[0].summary, "Kept"); assert.equal(result.strategy.tiers[0].buys, "Useful");
    assert.equal(result.strategy.tiers[0].targets[0].note, "Held"); assert.equal(result.strategy.tiers[1].summary, "Sibling");
    assert.ok(result.issues.some(issue => issue.field === "tiers.basis" && issue.code === `alias_${bad.code}`));
    assert.ok(result.issues.some(issue => issue.field === "tiers.targets[0].basis" && issue.code === `alias_${bad.code}`));
    assert.equal(JSON.stringify(input), before);
    assert.ok(geoStrategyFileCoverage(input).dropped.includes("tiers[0].basis"), "unconsumed aliases are still reported");
  }
  const overflow = geoStrategyDraft({ tiers: [{ tier: 1, summary: unicode, basis: "Extra", targets: [{ metricId: "M-06", note, basis: "Extra" }] }] });
  assert.equal(overflow.strategy.tiers[0].summary, unicode); assert.equal(overflow.strategy.tiers[0].targets[0].note, note);
  assert.equal(overflow.issues.filter(issue => issue.code === "alias_too_long").length, 2);
  const unknown = geoStrategyFileCoverage({ tiers: [{ tier: 1, basis: "Fine", surprise: true, targets: [{ metricId: "M-06", basis: "Fine", unknown: 1 }] }] });
  assert.deepEqual(unknown.dropped, ["tiers[0].surprise", "tiers[0].targets[0].unknown"]);
});

test("the exact six N09 narratives agree through direct writes, draft and file import with no numeric authority", options, async () => {
  const preservedPath = process.env.GEO_N09_PRESERVED_STRATEGY_PATH;
  const bytes = preservedPath ? readFileSync(preservedPath) : null;
  if (bytes) { assert.equal(bytes.length, 11941); assert.equal(createHash("sha256").update(bytes).digest("hex"), "a74e561549c426755bec5e4925151d5274d2fdf4c3af53a48738f5268d6b12d0"); }
  const original = bytes ? JSON.parse(bytes.toString("utf8")) : { tiers: n09Tiers(), sources: [{ domain: "n09.example.invalid", url: "https://n09.example.invalid/g1", sourceId: "n09c5-source1", availability: "unknown" }] };
  const input = structuredClone(original), unchanged = JSON.stringify(input);
  const draft = geoStrategyDraft(geoStrategyWriteOfFile(input));
  assert.deepEqual(draft.strategy.tiers.map(tier => tier.summary), N09_SUMMARIES);
  assert.deepEqual(draft.strategy.tiers.map(tier => tier.targets[0].note), [N09_NOTE, N09_NOTE, N09_NOTE]);
  assert.equal(draft.issues.some(issue => issue.code === "ignored_fields" && issue.field?.includes("basis")), false);
  const coverage = geoStrategyFileCoverage(input);
  assert.equal(coverage.dropped.some(path => /^tiers.*basis$/.test(path)), false);
  for (const key of ["url", "sourceId", "availability"]) assert.ok(coverage.dropped.includes(`sources.table[0].${key}`));
  for (const source of draft.sources) for (const key of ["url", "sourceId", "availability", "checkEvidence"]) assert.ok(!source[key], `${key} has no source-page mapping`);
  assert.deepEqual(draft.sources[0].valueContext, {});
  assert.equal(draft.strategy.tiers.some(tier => "basis" in tier || tier.targets.some(target => "basis" in target || "target" in target || "hardLine" in target)), false);
  assert.ok(draft.issues.filter(issue => issue.code === "declined_fields" && issue.field?.includes("baseline,target,dataType")).length === 3);
  const direct = await projectWithBaseline(), imported = await projectWithBaseline();
  await geoRuntimeWrite({ store, project: direct.geo, what: "strategy", body: { data: geoStrategyWriteOfFile(input) } });
  const { importDelivery } = importerOf(new Map([["deliverables/n09/strategy.json", JSON.stringify(input)]]));
  await importDelivery(imported.control, { id: "six-narratives", status: "succeeded", deliverables: [{ id: "n09", capability: "geo-strategy" }] });
  assert.deepEqual((await store.latestStrategy(direct.geo.id)).tiers, draft.strategy.tiers);
  assert.deepEqual((await store.latestStrategy(imported.geo.id)).tiers, draft.strategy.tiers);
  assert.deepEqual((await store.latestTargets(imported.geo.id))?.rows ?? [], []);
  const sources = await store.listSources(imported.geo.id);
  assert.equal(sources[0].domain, "n09.example.invalid"); assert.notEqual(sources[0].id, "n09c5-source1");
  assert.equal((await database.query("SELECT * FROM evimed_geo.owned_links WHERE geo_project_id=$1", [imported.geo.id])).rows.length, 0);
  assert.equal(JSON.stringify(input), unchanged);
  if (bytes) assert.deepEqual(readFileSync(preservedPath), bytes);
});

test("same-run tier note enrichment uses metric plus pool, preserves canonical fields and creates one semantic version", options, async () => {
  const { geo, control } = await projectWithBaseline();
  const runId = `rationale-${geo.id}`, relative = "deliverables/rationale/strategy.json";
  const basis = { groups: [{ id: "g1" }], targets: { version: null, rows: [] }, sources: [{ id: "source", url: "https://n09.example.invalid/g1", availability: "unknown" }] };
  const context = { mode: "strategy", runId, scopeKey: "original", basis };
  const held = n09Tiers().map(({ tier }) => ({ tier: String(tier), targets: [{ metricId: "M-06", pool: "P2", level: "Held" }, { metricId: "M-06", pool: "P3", note: "Other pool" }] }));
  await store.writeStrategy(USER, geo.id, { tiers: held, runId, scopeKey: context.scopeKey, basis });
  const before = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey });
  const input = { tiers: n09Tiers() }, original = JSON.stringify(input);
  const make = () => importerOf(new Map(), { planningContext: async () => context, readRunFile: async () => original }).importDelivery;
  const produced = { id: runId, status: "succeeded", artifacts: [relative] };
  await Promise.all([make()(control, produced), make()(control, produced)]);
  const next = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey });
  assert.equal(next.version, before.version + 1); assert.equal(next.runId, runId); assert.deepEqual(next.basis, basis);
  assert.deepEqual(next.tiers.map(tier => tier.summary), N09_SUMMARIES);
  for (const tier of next.tiers) {
    assert.equal(tier.targets.find(target => target.pool === "P2").note, N09_NOTE);
    assert.equal(tier.targets.find(target => target.pool === "P2").level, "Held");
    assert.equal(tier.targets.find(target => target.pool === "P3").note, "Other pool");
  }
  await make()(control, produced); assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).version, next.version);
  assert.deepEqual((await store.latestStrategy(geo.id, { strategyVersion: before.version, scopeKey: context.scopeKey }))?.tiers ?? before.tiers, held);
  assert.deepEqual((await store.latestTargets(geo.id))?.rows ?? [], []); assert.equal(JSON.stringify(input), original);
  const conflict = { tiers: [{ tier: 1, targets: [{ metricId: "M-06", pool: "P2", note: "Extra qualification" }] }] };
  const importer = importerOf(new Map(), { planningContext: async () => context, readRunFile: async () => JSON.stringify(conflict) });
  await importer.importDelivery(control, produced);
  assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).version, next.version);
  assert.ok(importer.reports.some(message => message.includes("qualification") && message.includes("P2")), "held canonical conflicts are explicit");
});


test("tier note enrichment is narrow, immutable and preserves generic array identity rules", () => {
  const held = { tiers: [{ tier: "1", summary: "Held words", targets: [{ metricId: "M-06", pool: "P2", level: "Held" }] }],
    actions: [{ metricId: "M-06", pool: "P2", reason: "Held action" }] };
  const given = { tiers: [{ tier: "1", summary: "File words", targets: [{ metricId: "M-06", pool: "P2", note: "Missing note", level: "File" }, { metricId: "M-06", pool: "P3", note: "Distinct pool" }] }],
    actions: [{ metricId: "M-06", pool: "P2", note: "Must not merge" }] };
  const before = JSON.stringify({ held, given }), filled = fillStrategy(held, given);
  assert.equal(filled.tiers[0].summary, "Held words"); assert.equal(filled.tiers[0].targets[0].level, "Held");
  assert.equal(filled.tiers[0].targets[0].note, "Missing note"); assert.equal(filled.tiers[0].targets[1].pool, "P3");
  assert.equal(filled.actions, undefined); assert.equal(JSON.stringify({ held, given }), before);
});


test("an invalid optional tier alias still writes canonical text and valid siblings through the shared writer", options, async () => {
  const { geo } = await projectWithBaseline();
  const data = { tiers: [{ tier: 1, summary: "Canonical", basis: {}, buys: "Useful", targets: [{ metricId: "M-06", note: "Held", basis: "😀".repeat(501) }] }, { tier: 2, basis: "Sibling" }] };
  const original = JSON.stringify(data), draft = geoStrategyDraft(data);
  const written = await geoRuntimeWrite({ store, project: geo, what: "strategy", body: { data } });
  assert.equal(written.ok, true); assert.equal(written.ids.length, 1);
  assert.ok(written.issues.some(issue => issue.code === "alias_invalid")); assert.ok(written.issues.some(issue => issue.code === "alias_too_long"));
  assert.deepEqual((await store.latestStrategy(geo.id)).tiers, draft.strategy.tiers);
  assert.equal((await store.latestStrategy(geo.id)).tiers[0].targets[0].note, "Held"); assert.equal(JSON.stringify(data), original);
});


for (const held of [false, true]) for (const alias of [
  { name: "wrong-type", value: {}, targetValue: {}, code: "alias_invalid" },
  { name: "blank", value: " \n\u0000 ", targetValue: " \t\u0000 ", code: "alias_empty" },
  { name: "too-long", value: "😀".repeat(601), targetValue: "😀".repeat(501), code: "alias_too_long" },
  { name: "canonical-plus-alias-overflow", value: "Extra", targetValue: "Extra", summary: "😀".repeat(600), note: "😀".repeat(500), code: "alias_too_long" },
]) test(`trusted ${held ? "same-run" : "first"} import treats ${alias.name} narrative aliases as visible advisory results`, options, async () => {
  const { geo, control } = await projectWithBaseline();
  const runId = `advisory-${geo.id}`, relative = "deliverables/advisory/strategy.json";
  const context = { mode: "strategy", runId, scopeKey: "original-advisory", basis: { targets: { version: null, rows: [] } } };
  const input = { tiers: [{ tier: 1, summary: alias.summary ?? "Canonical text", basis: alias.value, buys: "Valid purchase scope",
    targets: [{ metricId: "M-06", pool: "P2", note: alias.note ?? "Valid qualification", basis: alias.targetValue }] }, { tier: 2, basis: "Valid sibling rationale" }] };
  const original = JSON.stringify(input), expected = geoStrategyDraft(input).strategy.tiers;
  if (held) await store.writeStrategy(USER, geo.id, { tiers: expected, runId, scopeKey: context.scopeKey, basis: context.basis });
  const make = () => importerOf(new Map(), { planningContext: async () => context,
    readRunFile: async () => original, readFile: async () => { throw new Error("No unpreserved workspace reads"); } });
  const { importDelivery, reports } = make(), produced = { id: runId, status: "succeeded", artifacts: [relative] };
  const result = await importDelivery(control, produced);
  assert.equal(result.failed, undefined, "optional aliases cannot mark the valid strategy unavailable");
  assert.equal(result.files.strategies, 1); assert.equal(result.files.refused, 0); assert.deepEqual(result.files.unavailable, []);
  assert.equal(importDelivery.counters.imported, 1); assert.equal(importDelivery.counters.failed, 0);
  assert.deepEqual(result.files.notices.map(notice => [notice.path, notice.code]), [
    [`${relative}#[0]tiers.basis`, alias.code], [`${relative}#[0]tiers.targets[0].basis`, alias.code],
  ]);
  for (const notice of result.files.notices) {
    assert.match(notice.message, /kept only in the original file/);
    assert.ok(reports.some(report => report.includes(notice.path) && report.includes(notice.code)), "the retained-original qualification remains visible");
  }
  assert.deepEqual(result.files.dropped, ["advisory:tiers[0].basis", "advisory:tiers[0].targets[0].basis"]);
  const stored = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey });
  assert.deepEqual(stored.tiers, expected); assert.deepEqual(stored.basis, context.basis); assert.equal(stored.runId, runId);
  assert.equal(stored.tiers[0].buys, "Valid purchase scope"); assert.equal(stored.tiers[1].summary, "Valid sibling rationale");
  assert.deepEqual((await store.latestTargets(geo.id))?.rows ?? [], []); assert.equal(JSON.stringify(input), original);
  assert.equal(await importDelivery(control, produced), null, "a successful advisory import does not consume failure retries");
  const replay = await make().importDelivery(control, produced, { recovery: true });
  assert.equal(replay.failed, undefined); assert.deepEqual(replay.files.notices, result.files.notices);
  assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).version, stored.version);
});

for (const invalid of ["canonical", "gaps", "source"]) test(`optional narrative notices cannot hide a real invalid ${invalid} field`, options, async () => {
  const { geo, control } = await projectWithBaseline();
  const runId = `real-refusal-${geo.id}`, relative = "deliverables/real-refusal/strategy.json";
  const context = { mode: "strategy", runId, scopeKey: "real-refusal", basis: {} };
  const input = { summary: "Usable strategy", tiers: [{ tier: 1, summary: "Canonical", basis: {}, targets: [{ metricId: "M-06", note: "Held", basis: {} }] }],
    ...(invalid === "canonical" ? { tiers: [{ tier: 1, summary: {}, basis: "Optional rationale" }, { tier: 2, summary: "Valid sibling", basis: {} }] } : {}),
    ...(invalid === "gaps" ? { gaps: 42 } : {}),
    ...(invalid === "source" ? { sources: [{ domain: "valid.example", name: "Retained" }, { domain: "not a host", name: "Refused" }] } : {}) };
  const { importDelivery } = importerOf(new Map(), { planningContext: async () => context, readRunFile: async () => JSON.stringify(input) });
  const result = await importDelivery(control, { id: runId, status: "succeeded", artifacts: [relative] });
  assert.ok(result.failed?.includes("geo_plan_output_unavailable")); assert.ok(result.files.refused > 0);
  assert.ok(result.files.unavailable.some(path => path.includes(invalid === "canonical" ? "tiers.summary" : invalid === "source" ? "sources" : "gaps")));
  assert.equal(result.files.unavailable.some(path => path.endsWith(".basis")), false, "only the real validation problem is unavailable");
  assert.ok(result.files.notices.length > 0); assert.equal(importDelivery.counters.imported, 0); assert.equal(importDelivery.counters.failed, 1);
  assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).summary, "Usable strategy");
  if (invalid === "source") assert.deepEqual((await store.listSources(geo.id)).map(source => source.domain), ["valid.example"]);
});


for (const scenario of [
  { name: "populated held note", held: "First qualification", incoming: ["First qualification", "Second qualification", "Second qualification", "Third qualification"], expected: "First qualification", extra: [1, 3] },
  { name: "empty held and first incoming notes", held: null, incoming: [null, "First qualification", "First qualification", "Second qualification"], expected: "First qualification", extra: [3] },
  { name: "equal repeated incoming notes", held: null, incoming: [null, null, "First qualification", "First qualification"], expected: "First qualification", extra: [] },
]) test(`every duplicate compound target qualification is accounted for with ${scenario.name}`, options, async () => {
  const { geo, control } = await projectWithBaseline();
  const runId = `duplicate-${geo.id}`, relative = "deliverables/duplicates/strategy.json";
  const context = { mode: "strategy", runId, scopeKey: "duplicate-notes", basis: { targets: { version: null, rows: [] } } };
  const held = { tiers: [{ tier: "1", targets: [{ metricId: "M-06", pool: "P2", level: "Held", ...(scenario.held ? { note: scenario.held } : {}) },
    { metricId: "M-06", pool: "P3", note: "Other pool" }] }], runId, scopeKey: context.scopeKey, basis: context.basis };
  await store.writeStrategy(USER, geo.id, held);
  const before = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey });
  const input = { tiers: [{ tier: 1, targets: [...scenario.incoming.map(note => ({ metricId: "M-06", pool: "P2", ...(note ? { basis: note } : {}) })),
    { metricId: "M-06", pool: "P3", basis: "Other pool" }, { metricId: "M-06", pool: "P3", basis: "Other pool" },
    { metricId: "M-06", pool: "P3", basis: "Distinct other pool qualification" }] }] };
  const original = JSON.stringify(input);
  assert.equal(geoStrategyDraft(input).issues.length, 0);
  const make = () => importerOf(new Map(), { planningContext: async () => context, readRunFile: async () => original });
  const { importDelivery, reports } = make(), produced = { id: runId, status: "succeeded", artifacts: [relative] };
  const result = await importDelivery(control, produced);
  assert.equal(result.failed, undefined); assert.equal(result.files.refused, 0);
  const next = await store.latestStrategy(geo.id, { scopeKey: context.scopeKey });
  assert.equal(next.tiers[0].targets.length, 2, "equal duplicate descriptions do not create duplicate stored notes");
  assert.equal(next.tiers[0].targets[0].note, scenario.expected); assert.equal(next.tiers[0].targets[0].level, "Held");
  assert.equal(next.tiers[0].targets[1].note, "Other pool"); assert.equal(next.version, before.version + (scenario.held ? 0 : 1));
  const omitted = reports.filter(report => report.includes("qualification_not_stored"));
  assert.equal(omitted.length, scenario.extra.length + 1, "each distinct extra qualification has one original-only diagnostic");
  for (const index of scenario.extra) assert.ok(omitted.some(report => report.includes("pool=P2") && report.includes(`targets[${index}]`)));
  assert.equal(omitted.filter(report => report.includes("pool=P3")).length, 1);
  for (const report of omitted) assert.match(report, /original file/);
  const replay = make(); await replay.importDelivery(control, produced, { recovery: true });
  assert.deepEqual(replay.reports.filter(report => report.includes("qualification_not_stored")), omitted);
  assert.equal((await store.latestStrategy(geo.id, { scopeKey: context.scopeKey })).version, next.version);
  assert.deepEqual(next.basis, context.basis); assert.deepEqual((await store.latestTargets(geo.id))?.rows ?? [], []);
  assert.equal(JSON.stringify(input), original);
});

test("compound qualification accounting is immutable for missing target lists and prototype-looking identities", () => {
  const input = { tiers: [{ tier: "1", targets: [{ metricId: "__proto__", pool: "constructor" }, { metricId: "__proto__", pool: "constructor", note: "First" },
    { metricId: "__proto__", pool: "constructor", note: "First" }, { metricId: "__proto__", pool: "constructor", note: "Second" }] }] };
  const held = { tiers: [{ tier: "1" }] }, original = JSON.stringify({ held, input }), notices = [];
  const filled = fillStrategy(held, input, notice => notices.push(notice));
  assert.equal(filled.tiers[0].targets.length, 1); assert.equal(filled.tiers[0].targets[0].note, "First");
  assert.equal(notices.length, 1); assert.match(notices[0], /targets\[3\]/);
  assert.equal(Object.prototype.polluted, undefined); assert.equal(JSON.stringify({ held, input }), original);
});

for (const held of [false, true]) for (const alias of [
  { name: "wrong-type", value: {}, targetValue: {}, code: "alias_invalid" },
  { name: "blank", value: " \n\u0000 ", targetValue: " \t\u0000 ", code: "alias_empty" },
  { name: "too-long", value: "😀".repeat(601), targetValue: "😀".repeat(501), code: "alias_too_long" },
  { name: "canonical-plus-alias-overflow", value: "Extra", targetValue: "Extra", summary: "😀".repeat(600), note: "😀".repeat(500), code: "alias_too_long" },
]) test(`unbound ${held ? "same-run" : "first"} import preserves ${alias.name} alias diagnostics through semantic replay`, options, async () => {
  const { geo, control } = await projectWithBaseline();
  const runId = `unbound-advisory-${geo.id}`, relative = "deliverables/unbound-advisory/strategy.json";
  const input = { tiers: [{ tier: 1, summary: alias.summary ?? "Held summary", basis: alias.value,
    targets: [{ metricId: "M-06", pool: "P2", note: alias.note ?? "Held note", basis: alias.targetValue }] }] };
  const expected = geoStrategyDraft(input).strategy.tiers, original = JSON.stringify(input);
  if (held) await store.writeStrategy(USER, geo.id, { tiers: expected, runId });
  const make = () => importerOf(new Map([[relative, original]]), { listDeliverableFolders: async () => [] });
  const { importDelivery, reports } = make();
  const produced = { id: runId, status: "succeeded", startedAt: "2000-01-01T00:00:00Z", deliverables: [{ id: "unbound-advisory", capability: "geo-strategy" }] };
  const result = await importDelivery(control, produced);
  assert.equal(result.failed, undefined); assert.ok(result.files, "an unchanged strategy still returns file diagnostics");
  assert.equal(result.files.strategies, held ? 0 : 1); assert.equal(result.files.refused, 0);
  assert.deepEqual(result.files.notices.map(notice => [notice.path, notice.code]), [
    [`${relative}#[0]tiers.basis`, alias.code], [`${relative}#[0]tiers.targets[0].basis`, alias.code],
  ]);
  assert.deepEqual(result.files.dropped, ["unbound-advisory:tiers[0].basis", "unbound-advisory:tiers[0].targets[0].basis"]);
  for (const notice of result.files.notices) {
    assert.match(notice.message, /kept only in the original file/); assert.ok(reports.some(report => report.includes(notice.path) && report.includes(notice.code)));
  }
  const next = await store.latestStrategy(geo.id); assert.deepEqual(next.tiers, expected);
  const replay = await make().importDelivery(control, produced, { recovery: true });
  assert.deepEqual(replay.files.notices, result.files.notices); assert.deepEqual(replay.files.dropped, result.files.dropped);
  assert.equal((await store.latestStrategy(geo.id)).version, next.version); assert.equal(JSON.stringify(input), original);
});

test("unchanged unbound files still expose unrelated dropped fields", options, async () => {
  const { geo, control } = await projectWithBaseline();
  const tiers = [{ tier: "1", summary: "Held summary" }]; await store.writeStrategy(USER, geo.id, { tiers });
  const relative = "deliverables/drop-only/strategy.json";
  const { importDelivery } = importerOf(new Map([[relative, JSON.stringify({ tiers: [{ ...tiers[0], unexpectedField: "Original-only" }] })]]), { listDeliverableFolders: async () => [] });
  const result = await importDelivery(control, { id: `drop-only-${geo.id}`, status: "succeeded", startedAt: "2000-01-01T00:00:00Z", deliverables: [{ id: "drop-only", capability: "geo-strategy" }] });
  assert.deepEqual(result.files?.dropped, ["drop-only:tiers[0].unexpectedField"]); assert.equal(result.files?.strategies, 0);
});
