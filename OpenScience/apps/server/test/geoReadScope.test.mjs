import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGeoReadScope, normalizeGeoMember, geoScopeFromQuery, computeGeoSelection } from "../src/geoReadScope.mjs";
import { balanceRows } from "../src/geoMetricsJob.mjs";

test("scope has closed fields, inclusive local dates and compatible aliases", () => {
  const scope = normalizeGeoReadScope({ from: "2026-10-01", to: "2026-10-23", engine: "kimi", version: 2, pool: "P2" });
  assert.equal(scope.timeZone, "Asia/Shanghai");
  assert.deepEqual(scope.engines, ["kimi"]);
  assert.equal(scope.questionVersion, 2);
  assert.deepEqual(scope.pools, ["P2"]);
  for (const input of [{ typo: 1 }, { engines: ["unknown"] }, { from: "2026-02-30" }, { from: "2026-10-24", to: "2026-10-23" },
    { timeZone: "Mars/Olympus" }, { round: "../other" }, { questionVersion: 0 }, { engine: "kimi", engines: ["deepseek"] }]) {
    assert.throws(() => normalizeGeoReadScope(input), (error) => error.code === "geo_read_filter_invalid");
  }
  assert.deepEqual(geoScopeFromQuery(new URLSearchParams("engines=kimi,deepseek&clientTags=a%2Cb&clientTags=c")).clientTags, ["a,b", "c"]);
});

test("URL tag lists accept JSON arrays without splitting commas inside labels", () => {
  assert.deepEqual(geoScopeFromQuery(new URLSearchParams({ clientTags: JSON.stringify(["a,b", "c"]) })).clientTags, ["a,b", "c"]);
  assert.throws(() => geoScopeFromQuery(new URLSearchParams({ clientTags: '["broken"' })), (error) => error.status === 400);
});

test("a provided daily member date is required to be a real nonempty day", () => {
  const metric = { metricId: "M-01", scope: "project" };
  assert.deepEqual(normalizeGeoMember(metric), metric);
  assert.equal(normalizeGeoMember({ ...metric, observationDate: "2026-10-01" }).observationDate, "2026-10-01");
  for (const observationDate of ["", " ", "2026-02-30", null]) {
    assert.throws(() => normalizeGeoMember({ ...metric, observationDate }), (error) => error.code === "geo_read_filter_invalid");
  }
});

const facts = { brands: [{ name: "Ours", ours: true, count: 2 }], statements: [{ text: "known", verdict: "correct" }],
  checks: { judgementCoverage: { status: "complete" } }, judgedAt: "2026-10-01T00:00:00Z" };
const row = (id, roundId, engine = "deepseek", extra = {}) => ({ snapshotId: id, questionId: "q1", roundId, engine, status: "valid",
  pool: "P2", groupId: "g1", roundKind: "baseline", askedAt: `${roundId === "r1" ? "2026-10-01" : "2026-10-02"}T00:00:00Z`, facts, ...extra });

test("balance keeps one observation per round, question, engine and repeat", () => {
  const balanced = balanceRows([row("s1", "r1"), row("s2", "r2")]);
  assert.equal(balanced.deduped.length, 2);
  assert.equal(balanced.rows.length, 2);
  assert.equal(balanced.questions, 1, "independent question count differs from round observations");
  assert.equal(balanced.observations, 2);
});

test("selection computes pooled counts and uses the actual denominator for drilldowns", () => {
  const result = computeGeoSelection([row("s1", "r1"), row("s2", "r2"), row("s3", "r2", "deepseek", { questionId: "q2", facts: null }),
    row("s4", "r2", "deepseek", { questionId: "q3", status: "refusal", facts: { ...facts, brands: [] } })], { engines: ["deepseek"], competitors: [], owned: {}, arms: { pilot: ["g1"], control: [] } });
  const cell = result.cells.find((entry) => entry.scope === "project" && entry.metricId === "M-06");
  assert.equal(cell.denominator, 2);
  assert.deepEqual(cell.snapshotIds, ["s1", "s2"]);
  assert.equal(cell.members.total, 2);
  assert.equal(cell.members.unit, "answers");
  const mentions = result.cells.find((entry) => entry.scope === "project" && entry.metricId === "M-04");
  assert.equal(mentions.members.unit, "brand_mentions");
  assert.equal(mentions.members.total, 2, "two contributing snapshots can contribute four mentions");
  assert.equal(mentions.denominator, 4);
});
