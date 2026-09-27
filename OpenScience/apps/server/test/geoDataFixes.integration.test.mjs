// The 2026-09-26 audit's data corrections for one GEO project, against the
// real DDL: a dry run reports and changes nothing, `--apply` writes it all in
// one transaction, and a second `--apply` finds nothing left to do.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GEO_NOT_OWNED_DOMAINS, runGeoDataFixes } from "../src/geoDataFixes.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { parseGeoDataFixArguments } from "../../../scripts/ops/geo-data-fixes.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geofixes");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await new GeoMeasureStore(database).ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

const ID = "geo_xinermei";
const USER = "cdss-access";
/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

/** The shape of the production project on 2026-09-26, reduced to one of each thing. */
async function seed() {
  await q(`INSERT INTO evimed_geo.projects (id, user_id, project_id, product, competitors, engines) VALUES ($1, $2, 'geo', $3::jsonb, $4::jsonb, ARRAY['kimi','qianwen'])`,
    [ID, USER, JSON.stringify({ brandName: "信尔美", genericName: "玛仕度肽注射液", holder: "信达生物" }),
      JSON.stringify([{ brandName: "穆峰达", genericName: "替尔泊肽注射液", aliases: ["替尔泊肽"] }, { brandName: "诺和盈", genericName: "司美格鲁肽注射液", aliases: ["司美格鲁肽"] }])]);
  await q(`INSERT INTO evimed_geo.question_sets (geo_project_id, version, user_id, locked_at, measured_count, created_at) VALUES ($1, 1, $2, now(), 1, '2026-09-25T09:40:00Z')`,
    [ID, USER]);
  await q(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, set_version, pool, name) VALUES ('grp', $2, $1, 1, 'P2', '减重药怎么选')`, [ID, USER]);
  await q(`INSERT INTO evimed_geo.questions (id, user_id, geo_project_id, group_id, set_version, text, kind, pool, platform, is_measured)
    VALUES ('q1', $2, $1, 'grp', 1, '玛仕度肽和替尔泊肽哪个好', 'real', 'P2', 'zhihu', true)`, [ID, USER]);
  for (const domain of ["innoventbio.com", ...GEO_NOT_OWNED_DOMAINS]) {
    await q(`INSERT INTO evimed_geo.sources (id, user_id, geo_project_id, domain, layer) VALUES ($1, $2, $3, $4, 'owned')`, [`src-${domain}`, USER, ID, domain]);
  }
  // The baseline, parsed before the ruling and the registrations: brand only, no rival, 漏提我方.
  await q(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, set_version, engines, status, planned, done, sample_date, finished_at)
    VALUES ('gr_base', $2, $1, 'baseline', 1, ARRAY['kimi','qianwen'], 'done', 2, 2, '2026-09-25', '2026-09-25T17:59:00Z')`, [ID, USER]);
  const answer = "玛仕度肽每周注射一次，替尔泊肽也可以考虑，详见说明书。";
  for (const engine of ["kimi", "qianwen"]) {
    await q(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, question_id, engine, asked_at, status, answer_text, citations)
      VALUES ($1, $2, 'gr_base', $3, 'q1', $4, '2026-09-25T15:00:00Z', 'valid', $5, $6::jsonb)`,
    [`s-${engine}`, USER, ID, engine, answer, JSON.stringify([{ url: "https://www.lillymedical.cn/a", domain: "www.lillymedical.cn", title: "礼来" }])]);
    await q(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, brands, statements, failure_mode, mentions_ours, judged_at, created_at)
      VALUES ($1, $2, $3, '[]'::jsonb, '[{"text":"玛仕度肽每周注射一次","verdict":"correct"}]'::jsonb, 'omitted', false, now(), '2026-09-25T17:00:00Z')`,
    [`s-${engine}`, USER, ID]);
  }
  // Two errors; one content batch was given the first and wrote one correction.
  for (const id of ["e1", "e2"]) {
    await q(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, status, materials) VALUES ($1, $2, $3, $1, 'kimi', 'open', '[]'::jsonb)`,
      [id, USER, ID]);
  }
  await q(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, run_id, detail)
    VALUES ($1, 'run:content:1', $2, 'run', 'done', 'run_c1', '{"purpose":"content","errorIds":["e1"]}'::jsonb)`, [ID, USER]);
  await q(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, run_id, path, layer, title, gate, safety, status)
    VALUES ('art_fix', $2, $1, 'run_c1', 'deliverables/geo-content-1/articles/fix.md', 'correction', '纠错：禁忌人群', 'passed', 'clear', 'publishable')`, [ID, USER]);
}

/** What the strategy run wrote in its own file, in the method's names. */
const STRATEGY = {
  battlefield: { groups: ["减重药怎么选"], reason: "证据最硬" },
  expectations: [{ provider: "千问", promiseCeiling: { value: "mention_and_accuracy", basis: "检索触发率 99%" }, layersNeeded: ["anchor", "coverage"] }],
  gaps: [{ class: "只讲获益不讲安全", text: "只讲减重不讲胃肠反应" }],
  layout: { layers: { anchor: ["dayi.org.cn"] }, by_engine: [], constraints: [] },
  sources: [{ domain: "dayi.org.cn", sourceType: "医学科普平台", layer: "anchor",
    threeConditions: { icpMatches: true, newsIndexed: true, medicalVertical: true, checkedAt: "2026-09-25" } }],
};

const fix = (/** @type {boolean} */ apply) => runGeoDataFixes({ database, geoProjectId: ID, apply, ourSingleSource: true, ourGenericAliases: ["玛仕度肽"],
  competitorSingleSource: { 穆峰达: true, 诺和盈: false }, strategy: STRATEGY });

test("the fixes: a dry run reports and changes nothing; --apply writes them in one transaction; a second --apply has nothing left", options, async () => {
  await seed();
  const state = async () => ({
    owned: (await q(`SELECT domain FROM evimed_geo.sources WHERE geo_project_id = $1 AND layer = 'owned' ORDER BY domain`, [ID])).map((row) => row.domain),
    product: (await q(`SELECT product, competitors FROM evimed_geo.projects WHERE id = $1`, [ID]))[0],
    facts: await q(`SELECT snapshot_id, mentions_ours, failure_mode, reparsed_at FROM evimed_geo.facts ORDER BY snapshot_id`),
    errors: await q(`SELECT id, status, jsonb_array_length(materials) AS materials FROM evimed_geo.errors ORDER BY id`),
    collected: (await q(`SELECT collected_at FROM evimed_geo.questions WHERE id = 'q1'`))[0].collected_at,
    strategies: Number((await q(`SELECT count(*) AS n FROM evimed_geo.strategy WHERE geo_project_id = $1`, [ID]))[0].n),
    metrics: Number((await q(`SELECT count(*) AS n FROM evimed_geo.metrics WHERE geo_project_id = $1`, [ID]))[0].n),
  });
  const untouched = await state();

  const dry = await fix(false);
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.disowned, ["lillymedical.cn", "lm.qa.lilly.cn"]);
  assert.deepEqual(dry.identity, { changed: ["ours:true", "ours:genericAlias:玛仕度肽", "穆峰达:true", "诺和盈:false"], unmatchedCompetitors: [] },
    "an unstated rival counted as multi-source already; saying so is still recorded");
  assert.deepEqual([dry.strategy.fields.sort(), dry.strategy.expectations, dry.strategy.sourcesWritten, dry.strategy.sourcesWithConditions, dry.strategy.refused],
    [["battlefield", "expectations", "gaps", "layout"], 1, 1, 1, []]);
  assert.deepEqual(dry.materials, { pairs: 1, attached: 1, errors: 1 });
  assert.equal(dry.collected, 1);
  assert.equal(dry.recounted, 2);
  assert.equal(dry.remeasured, 1);
  assert.notEqual(dry.registryAfter, dry.registryBefore);
  assert.deepEqual(dry.before.map((/** @type {any} */ row) => row.round), ["gr_base"]);
  assert.equal(dry.before[0]["M-19"], undefined, "the baseline had no numbers here");
  assert.ok(dry.after[0]["M-01S"] !== undefined, "and has them after");
  assert.deepEqual(await state(), untouched, "a dry run changes nothing");

  const applied = await fix(true);
  assert.equal(applied.applied, true);
  const now = await state();
  assert.deepEqual(now.owned, ["innoventbio.com"]);
  assert.deepEqual([now.product.product.singleSource, now.product.product.genericAliases], [true, ["玛仕度肽"]]);
  assert.deepEqual(now.product.competitors.map((/** @type {any} */ entry) => [entry.brandName, entry.singleSource]), [["穆峰达", true], ["诺和盈", false]]);
  assert.deepEqual(now.facts.map((/** @type {any} */ row) => [row.mentions_ours, row.failure_mode]), [[true, "correct"], [true, "correct"]],
    "玛仕度肽 is one holder's: the answers that named only it mention us");
  assert.ok(now.facts.every((/** @type {any} */ row) => row.reparsed_at));
  assert.deepEqual(now.errors, [{ id: "e1", status: "acting", materials: 1 }, { id: "e2", status: "open", materials: 0 }]);
  assert.equal(new Date(now.collected).toISOString(), "2026-09-25T09:40:00.000Z");
  assert.equal(now.strategies, 1);
  assert.ok(now.metrics > 0);
  const [dayi] = await q(`SELECT icp_matches, news_indexed, medical_vertical, kind FROM evimed_geo.sources WHERE domain = 'dayi.org.cn'`);
  assert.deepEqual({ ...dayi }, { icp_matches: true, news_indexed: true, medical_vertical: true, kind: "vertical" });

  const again = await fix(true);
  assert.deepEqual([again.disowned, again.identity.changed, again.strategy.unchanged, again.strategy.version, again.materials.attached, again.collected,
    again.recounted], [[], [], true, null, 0, 0, 0]);
  assert.equal((await state()).strategies, 1, "no second strategy version");
});

test("the script's arguments: a project is required; the ruling's two domains are disowned unless kept", () => {
  assert.throws(() => parseGeoDataFixArguments([]), /--geo-project/);
  const parsed = parseGeoDataFixArguments(["--geo-project", "geo_1", "--our-single-source", "true", "--our-generic-alias", "玛仕度肽",
    "--competitor-single-source", "穆峰达=false",
    "--keep-owned", "--disown", "Example.com", "--no-materials"]);
  assert.deepEqual(parsed, { apply: false, geoProjectId: "geo_1", ourSingleSource: true, ourGenericAliases: ["玛仕度肽"],
    competitorSingleSource: { 穆峰达: false }, strategyFile: null,
    disown: ["example.com"], materials: false, collected: true });
  assert.throws(() => parseGeoDataFixArguments(["--geo-project", "geo_1", "--our-single-source", "yes"]), /true or false/);
  assert.deepEqual(parseGeoDataFixArguments(["--geo-project", "geo_1", "--apply"]).disown, [...GEO_NOT_OWNED_DOMAINS]);
});
