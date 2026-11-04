// The virtual-patients page's card of a disease-progression simulation (algorithm round P4): the engine's real results (tests/numeric N99 hold their numbers to
// the closed form) read into the payload the page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_RESULT_KIND_TABS } from "@evimed/domain";
import { progressionCard, presentProgressions, vcrProgressionSubjectId } from "../src/vcrProgression.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";

const fixture = (name) => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/vcr-progression/${name}.json`, import.meta.url), "utf8")), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-04T00:00:00Z" });
const strings = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);

test("a progression simulation is a result of its own kind, read on the patients tab", () => {
  assert.equal(VCR_JOB_METHODS.generate_progression, "patients.progression");
  assert.equal(vcrResultKindFor("generate_progression"), "progression_simulation");
  assert.equal(VCR_RESULT_KIND_TABS.progression_simulation, "patients");
  const scenario = { design: { nTreat: 100 }, treatment: { slowing: { value: 0.25 } } };
  assert.equal(vcrProgressionSubjectId(scenario), vcrProgressionSubjectId(structuredClone(scenario)));
  assert.notEqual(vcrProgressionSubjectId(scenario), vcrProgressionSubjectId({ ...scenario, treatment: { slowing: { value: 0.3 } } }));
});

test("the card says it is population level first, and why", () => {
  const card = progressionCard(fixture("linear-change"));
  assert.equal(card.label, "人群层面，不是对个人的预测");
  assert.match(card.reason, /0\.16/);
  assert.match(card.question, /减慢 25%/);
});

test("the curve is exact and the power is simulated, with the closed form beside it", () => {
  const card = progressionCard(fixture("linear-change"));
  assert.equal(card.power.source, "synthetic");
  assert.ok(card.power.mcse > 0 && card.power.unit === "%");
  assert.equal(card.approximation.source, "calculated");
  assert.ok(Math.abs(card.power.value - card.approximation.value) < 4 * card.power.mcse + 1.2, "the simulation agrees with the closed form of the same test");
  assert.deepEqual(card.visits, [0, 6, 12, 18]);
  const last = card.table.rows[3];
  assert.equal(last.control.mean.source, "calculated");
  assert.equal(last.control.mean.unit, "points");
  assert.ok(Math.abs(last.control.mean.value - (3 + 0.12 * 18)) < 1e-6, "the control mean is the baseline plus the slope times the time");
  assert.ok(Math.abs(last.gap.value - 0.12 * 18 * (0.75 - 1)) < 1e-6, "the treated curve is the clock slowed by a quarter");
  assert.equal(card.series.length, 2);
  assert.ok(card.series.every((series) => series.points.length === 4 && series.points[3].low < series.points[3].y && series.points[3].y < series.points[3].high));
});

test("the source of every stated number is a premise, in the page's words", () => {
  const card = progressionCard(fixture("linear-change"));
  const byKey = Object.fromEntries(card.premises.map((premise) => [premise.key, premise]));
  assert.equal(byKey["progression:model.amplitude"].source, "literature");
  assert.equal(byKey["progression:model.amplitude"].reason, "case", "the citation travels");
  assert.equal(byKey["progression:baseline.sd"].source, "given", "an estimate from the person's own data is theirs");
  assert.equal(byKey["progression:treatment.slowing"].source, "assumed");
  assert.equal(byKey["progression:treatment.slowing"].value, "25%");
  assert.ok(byKey["progression:alpha"].source === "default" && byKey["progression:clock"]);
  assert.ok(card.premises.filter((premise) => premise.decisive).length <= 5);
});

test("with no slowing the same number is the type I error, and the question changes", () => {
  const card = progressionCard(fixture("null"));
  assert.equal(card.powerName, "没有真实效应时误判有效的概率");
  assert.match(card.question, /误判有效/);
  assert.ok(Math.abs(card.power.value - 5) < 4 * card.power.mcse + 0.5, "the level of the test");
  assert.ok(card.table.rows.every((row) => Math.abs(row.gap.value) < 1e-9));
});

test("the cards of the tab are the current results, newest first, and no back-office word is in a sentence", () => {
  const bundle = { allResults: [fixture("linear-change"), { ...fixture("emax-slope"), id: "res_2", createdAt: "2026-11-05T00:00:00Z" }, { ...fixture("null"), id: "res_3", supersededBy: "res_4" }], stale: [] };
  const cards = presentProgressions(bundle, { nodeOf: (result) => `result:${result.id}` });
  assert.deepEqual(cards.map((card) => card.id), ["res_2", "res_1"]);
  assert.match(cards[0].title, /Emax/);
  assert.match(cards[0].question, /斜率/);
  for (const card of cards) {
    for (const word of strings({ title: card.title, question: card.question, label: card.label, reason: card.reason, premises: card.premises.map((p) => [p.label, p.value]) })) assert.ok(!/[a-z]+_[a-z_]+/.test(word), word);
  }
});
