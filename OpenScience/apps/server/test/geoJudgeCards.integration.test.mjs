// The parse loop judges against the cards (flywheel F21) on the real tables: a project with verified card claims is shown those and
// nothing else, one with no cards yet is shown its claim table as before, every statement records the card revision it was judged
// against, and the three checks are stored beside the facts and read back with the answer.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GEO_CITATION_INSTRUCTIONS, GeoJudge, tickParse } from "../src/geoJudge.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { geoMeasureState } from "../src/geoProbeQueue.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };

/** @type {any} */ let isolated, db, store, measure;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geojudgecards");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  store = new GeoStore({ database: db });
  await store.ready();
  measure = new GeoMeasureStore(db);
  await measure.ready();
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => { if (db) await db.query("TRUNCATE evimed_geo.projects, evimed_geo.snapshots CASCADE"); });

const CLAIMS = [
  { claimKey: "dose", statement: "每周一次皮下注射", quote: "本品每周一次皮下注射给药，起始剂量为 2.5 mg。", sourceRef: "说明书", sourceKind: "label", inLabel: true },
  { claimKey: "contra", statement: "对本品过敏者禁用", quote: "对本品活性成分或辅料过敏者禁用。", sourceRef: "说明书", sourceKind: "label", inLabel: true },
  { claimKey: "shaky", statement: "一条没有进卡片的结论", quote: "原文里找不到的引文", sourceRef: "某文献", sourceKind: "literature", inLabel: false },
];

async function project(withCards) {
  const created = await store.createProject({ userId: "alice", projectId: `p-${Math.random().toString(36).slice(2, 8)}`, engines: ["deepseek"], coverageDays: 90,
    product: { brandName: "信尔美", genericName: "玛仕度肽注射液" } });
  const written = await store.upsertClaims("alice", created.id, CLAIMS);
  if (withCards) {
    // The first two were verified into a card at revision 4; the third was held back by the card ruler.
    await store.markClaimsCarded(created.id, written.slice(0, 2).map((entry, index) => ({ id: entry.id, cardId: "ec_AbCd1234Ef", cardClaimId: CLAIMS[index].claimKey, cardRevision: 4 })));
  }
  await db.query(`INSERT INTO evimed_geo.snapshots (id, user_id, geo_project_id, engine, asked_at, status, answer_text, citations)
    VALUES ($1, 'alice', $2, 'deepseek', now(), 'valid', $3, $4::jsonb)`,
  [`snap_${created.id}`, created.id, "信尔美每周一次皮下注射。信尔美对活性成分过敏者禁用。信尔美也可以用于青少年减重。", JSON.stringify([{ url: "https://example.org/a", domain: "example.org", title: "某医学网", inBody: null }])]);
  return created;
}
const config = { geoDailyBudgetCny: 20, geoTimeZone: "Asia/Shanghai" };
/** The alias the judge was given a claim under: the claims are shown in claim-key order. @param {any} shown @param {string} statement */
const aliasOf = (shown, statement) => shown.claims.find((/** @type {any} */ claim) => claim.statement === statement).id;
const answer = (/** @type {any} */ shown) => ({
  refusal: false,
  statements: [
    { text: "信尔美每周一次皮下注射", topic: "dosage", verdict: "correct", claim: aliasOf(shown, "每周一次皮下注射"), evidence: "本品每周一次皮下注射给药" },
    { text: "信尔美对活性成分过敏者禁用", topic: "contraindication", verdict: "correct", claim: aliasOf(shown, "对本品过敏者禁用"), evidence: "对本品活性成分或辅料过敏者禁用" },
  ],
  offLabel: ["信尔美也可以用于青少年减重"], omittedSafety: [], citationClaims: [{ link: "L1", statement: "信尔美每周一次皮下注射" }],
  entities: [], recommendations: [], careHint: false, redFlagsExpected: [], redFlagsHit: [], safetyTerms: [],
});

/** A judge that records what it was shown and answers from the script. @param {(input: any) => any} script */
const fakeJudge = (script) => {
  const seen = /** @type {any[]} */ ([]);
  const real = new GeoJudge({ deepseekProviderEnabled: true, deepseekApiKey: "k" }, {
    callModel: async (_deps, request) => {
      // The citation check is its own small call: the sentence and the page, with its own instructions.
      if (request.body.messages[0].content === GEO_CITATION_INSTRUCTIONS) {
        return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(script({ citation: JSON.parse(request.body.messages[1].content) })) } }] };
      }
      const prefix = String(request.body.messages[1].content);
      const shown = JSON.parse(prefix.slice(prefix.indexOf("{"), prefix.indexOf("\n\n")));
      seen.push(shown.claims.map((/** @type {any} */ claim) => claim.statement));
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(script(shown)) } }] };
    },
  });
  return { judge: real, seen };
};

test("a project with cards is judged against its card claims alone, and every statement keeps the card revision it was judged against", options, async () => {
  const created = await project(true);
  const { judge, seen } = fakeJudge((shown) => answer(shown));
  const state = geoMeasureState();
  const counts = await tickParse({ store: measure, config, judge, state, maxParse: 5 });
  assert.equal(counts.parsed, 1);
  assert.deepEqual(state.checkTotals, { offLabel: 1 }, "what the checks found is counted, for the operator's metrics");
  assert.deepEqual([...seen[0]].sort(), ["每周一次皮下注射", "对本品过敏者禁用"].sort(), "the claim the card ruler held back is not what an answer is held to");
  const [fact] = (await db.query("SELECT statements, checks, parser_version FROM evimed_geo.facts WHERE geo_project_id = $1", [created.id])).rows;
  assert.deepEqual(fact.statements.map((/** @type {any} */ statement) => [statement.topic, statement.verdict, statement.cardId, statement.cardClaimId, statement.cardRevision]), [
    ["dosage", "correct", "ec_AbCd1234Ef", "dose", 4],
    ["contraindication", "correct", "ec_AbCd1234Ef", "contra", 4],
  ]);
  assert.deepEqual(fact.checks.offLabel, ["信尔美也可以用于青少年减重"]);
  assert.deepEqual(fact.checks.citations.map((/** @type {any} */ entry) => [entry.link, entry.url, entry.exists, entry.supports]), [["L1", "https://example.org/a", null, null]],
    "with no link checker a citation is recorded, not called good or bad");
  assert.match(fact.parser_version, /\+geo-judge-1\./);
  assert.equal(counts.offLabel, 1);
});

test("a project with no cards yet is judged against its claim table, as before the chain", options, async () => {
  await project(false);
  const { judge, seen } = fakeJudge((shown) => answer(shown));
  await tickParse({ store: measure, config, judge, state: geoMeasureState(), maxParse: 5 });
  assert.deepEqual([...seen[0]].sort(), ["一条没有进卡片的结论", "每周一次皮下注射", "对本品过敏者禁用"].sort());
  const [fact] = (await db.query("SELECT statements FROM evimed_geo.facts")).rows;
  assert.deepEqual(fact.statements.map((/** @type {any} */ statement) => statement.cardRevision), [null, null], "no card, no revision");
});

test("the answer page reads the specified information's accuracy and the three checks back with the answer", options, async () => {
  const created = await project(true);
  const { judge } = fakeJudge((shown) => answer(shown));
  await tickParse({ store: measure, config, judge, state: geoMeasureState(), maxParse: 5 });
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const view = await service.answer({ id: "alice" }, created.id, `snap_${created.id}`);
  assert.equal(view.facts.specifiedInfo.rate, 1);
  assert.deepEqual([view.facts.specifiedInfo.correct, view.facts.specifiedInfo.wrong, view.facts.specifiedInfo.decided], [2, 0, 2]);
  assert.deepEqual(view.facts.checks.offLabel, ["信尔美也可以用于青少年减重"]);
  // Another account's project does not exist for this read.
  await assert.rejects(() => service.answer({ id: "bob" }, created.id, `snap_${created.id}`), { code: "geo_project_not_found" });
});

test("a link checker, where the deployment has one, says whether the cited page exists and what it says", options, async () => {
  await project(true);
  const { judge } = fakeJudge((/** @type {any} */ shown) => (shown.citation ? { supports: "yes", evidence: "每周一次皮下注射" } : answer(shown)));
  const asked = /** @type {string[]} */ ([]);
  const counts = await tickParse({ store: measure, config, judge, state: geoMeasureState(), maxParse: 5,
    linkChecker: async (address) => { asked.push(address); return { exists: true, text: "本品每周一次皮下注射给药。" }; } });
  assert.deepEqual(asked, ["https://example.org/a"]);
  assert.deepEqual([counts.linkExists, counts.linkSupports], [1, 1]);
  const [fact] = (await db.query("SELECT checks FROM evimed_geo.facts")).rows;
  assert.deepEqual(fact.checks.citations.map((/** @type {any} */ entry) => [entry.exists, entry.supports, entry.evidence]), [[true, "yes", "每周一次皮下注射"]]);
});
