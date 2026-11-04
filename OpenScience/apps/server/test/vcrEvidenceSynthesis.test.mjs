// The evidence tab's cards for a network meta-analysis, a dose-response meta-analysis and the shrinkage of a published effect (algorithm round C5, C6, E8),
// the base rates beside an assurance (E6) and the heterogeneity prior of a pooling (E7): the engine's real results (tests/numeric N74-N77 hold their
// numbers to references) read into the payloads the page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_METHODS, VCR_RESULT_KIND_TABS } from "@evimed/domain";
import { readPoolResult } from "../src/vcrEvidence.mjs";
import {
  presentDoseResponse, presentEffectShrinkage, presentEvidenceSyntheses, presentNetworkMeta, tauPriorWords, vcrSuccessRatesPage, vcrSuccessRatesRead, vcrSynthesisSubjectId,
} from "../src/vcrEvidenceSynthesis.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";
import { VCR_RESULT_KINDS } from "../src/vcrStore.mjs";
import { measureLabel, measureValue } from "../src/vcrViewsKit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-evidence-synthesis/${name}.json`, import.meta.url), "utf8"));
const value = (result, kind) => (measure) => measureValue(measure, { kind, result, tab: "data", staleMark: null });
/** The sentences and labels of a card, flattened: every string leaf (a back-office key or an id would show as ascii with underscores or dots). */
const WORD_KEYS = new Set(["question", "sentence", "note", "title", "label", "meaning", "basis", "scoreNote", "headline", "measure", "direction", "model", "value", "population", "ratioWord"]);
const sayings = (node, key = "") => {
  if (typeof node === "string") return WORD_KEYS.has(key) ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((each) => sayings(each, key));
  return node && typeof node === "object" ? Object.entries(node).flatMap(([k, each]) => sayings(each, k)) : [];
};
const BACK_OFFICE = /(?:^|[^A-Za-z])(?:evidence\.|netmeta|dosresmeta|bayesmeta|tauPrior|job_|diagnostics|hash|seed)|_[a-z]+_/;

test("the three kinds are results of their own, read on the evidence tab and filed under the label the call gave them", () => {
  assert.equal(VCR_JOB_METHODS.network_meta, "evidence.network");
  assert.equal(VCR_JOB_METHODS.dose_response_meta, "evidence.dose_response");
  assert.equal(VCR_JOB_METHODS.effect_shrinkage, "evidence.shrinkage");
  for (const kind of ["network_meta", "dose_response_meta", "effect_shrinkage"]) {
    assert.equal(vcrResultKindFor(kind), kind);
    assert.ok(VCR_RESULT_KINDS.includes(kind), kind);
    assert.equal(VCR_RESULT_KIND_TABS[kind], "data", kind);
  }
  assert.match(vcrSynthesisSubjectId("network_meta", { label: "  response  " }), /^nm:response:[0-9a-f]{10}$/, "the label the call gave stays in the key");
  assert.match(vcrSynthesisSubjectId("dose_response_meta", {}), /^dr:default:[0-9a-f]{10}$/);
  assert.equal(vcrSynthesisSubjectId("effect_shrinkage", { label: "x".repeat(200) }).length, "es:".length + 80 + ":".length + 10);
  assert.notEqual(vcrSynthesisSubjectId("network_meta", { label: "a" }), vcrSynthesisSubjectId("network_meta", { label: "b" }), "two outcomes stand side by side");
});

test("two analyses with no label are two cards, and the same one asked again is one (review RF2 P1-1)", () => {
  const one = { measure: "odds_ratio", treatments: ["A", "B", "C"], studies: [{ id: "s1", arms: [{ treatment: "A", events: 10, n: 100 }, { treatment: "B", events: 15, n: 100 }] }] };
  const other = { ...one, measure: "risk_ratio" };
  assert.notEqual(vcrSynthesisSubjectId("network_meta", one), vcrSynthesisSubjectId("network_meta", other));
  assert.equal(vcrSynthesisSubjectId("network_meta", one), vcrSynthesisSubjectId("network_meta", structuredClone(one)));
  assert.notEqual(vcrSynthesisSubjectId("network_meta", one), vcrSynthesisSubjectId("dose_response_meta", one), "another method is another card");
});

test("a network card ranks by the score, shows every pair in a league table, words the consistency, and its premises are the few it rests on", () => {
  const result = fixture("network");
  const card = presentNetworkMeta(result, value(result, "network_meta"));
  assert.equal(card.title, "网络荟萃分析：response");
  assert.deepEqual(card.ranking.map((entry) => entry.rank), [1, 2, 3]);
  const scores = card.ranking.map((entry) => entry.score.value);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "ranked by the P-score, best first");
  assert.ok(card.ranking.every((entry) => entry.score.unit === "%"));
  assert.equal(card.ranking.filter((entry) => entry.isReference).length, 1);
  assert.equal(card.ranking.find((entry) => entry.isReference).versusReference, null);
  assert.equal(card.league.treatments.length, 3);
  for (const [i, row] of card.league.rows.entries()) {
    assert.equal(row.cells.length, 3);
    assert.equal(row.cells[i], null, "no cell against itself");
    assert.ok(row.cells.filter(Boolean).every((cell) => cell.value.interval && cell.value.interval.low < cell.value.value && cell.value.value < cell.value.interval.high));
  }
  // the cell of row A against column B is the inverse of row B against column A (a ratio): the table is one table read two ways
  const a = card.league.treatments.indexOf("A"); const b = card.league.treatments.indexOf("B");
  assert.ok(Math.abs(card.league.rows[a].cells[b].value.value * card.league.rows[b].cells[a].value.value - 1) < 1e-6);
  assert.ok(card.league.rows[a].cells[b].directStudies >= 1);
  assert.match(card.consistency.sentence, /Q = .*P = /);
  assert.ok(card.consistency.betweenDesigns);
  const decisive = card.premises.filter((row) => row.decisive);
  assert.ok(decisive.length >= 3 && decisive.length <= 5, `3 to 5 decisive premises, got ${decisive.length}`);
  assert.ok(card.premises.every((row) => row.value && row.label));
  assert.ok(card.premises.some((row) => row.key === "continuity" && /S4/.test(row.value)), "the zero-event study that was corrected is named");
  assert.ok(card.premises.some((row) => row.key === "direction" && /越大越好/.test(row.value)));
  for (const word of sayings(card)) assert.doesNotMatch(word, BACK_OFFICE, word);
});

test("a chain of treatments has no loop, and the card says the agreement cannot be tested instead of printing a p-value of nothing", () => {
  const result = fixture("network-chain");
  const card = presentNetworkMeta(result, value(result, "network_meta"));
  assert.equal(card.consistency.betweenDesigns, null);
  assert.match(card.consistency.sentence, /没有环/);
  assert.equal(card.ranking.length, 3);
});

test("a dose-response card says what a step of dose does, where the curve first leaves 1, and what it assumed", () => {
  const linear = fixture("dose-linear");
  const lin = presentDoseResponse(linear, value(linear, "dose_response_meta"));
  assert.equal(lin.title, "剂量反应：alcohol and colorectal cancer");
  assert.match(lin.headline, /剂量每增加 12 g\/day，相对危险度变为 1\.08/);
  assert.equal(lin.modelKind, "linear");
  assert.ok(lin.predictions.length >= 2 && lin.predictions.every((row) => row.value.interval));
  assert.ok(lin.curve.length >= 20 && lin.curve.every((point) => point.lower <= point.ratio && point.ratio <= point.upper));
  assert.match(lin.firstDose.sentence, /逐点|没有离开 1/);
  assert.equal(lin.tests.nonlinearity, null);
  const spline = fixture("dose-spline");
  const spl = presentDoseResponse(spline, value(spline, "dose_response_meta"));
  assert.equal(spl.modelKind, "spline");
  assert.match(spl.headline, /非线性检验 P = 0\.0/);
  assert.deepEqual(spl.predictions.map((row) => row.dose), [0, 12, 24, 36, 48, 60]);
  assert.equal(spl.predictions[0].isReference, true);
  assert.ok(spl.premises.some((row) => row.key === "model" && /样条/.test(row.value)));
  for (const card of [lin, spl]) {
    assert.ok(card.premises.filter((row) => row.decisive).length <= 5);
    for (const word of sayings(card)) assert.doesNotMatch(word, BACK_OFFICE, word);
    assert.match(card.note, /不是对某一个人的预测/);
  }
});

test("a shrinkage card carries the stated value unchanged beside the shrunken one, with the probabilities in words; a z of 0 has no direction", () => {
  const result = fixture("shrinkage");
  const card = presentEffectShrinkage(result, value(result, "effect_shrinkage"));
  assert.equal(card.rows.length, 2);
  const first = card.rows[0];
  assert.ok(Math.abs(first.stated.value.value - 0.66) < 1e-9, "the person's value is shown exactly as stated");
  assert.ok(first.shrunken.value.value > 0.66 && first.shrunken.value.value < 1, "shrunk toward no effect (a hazard ratio toward 1)");
  assert.ok(first.shrunken.value.interval.low < first.shrunken.value.value);
  assert.ok(first.shrunken.factor.value > 0 && first.shrunken.factor.value < 100);
  assert.ok(first.correctSign.value > 50 && first.replication.value > 0 && first.futureSuccess.value.value > first.replication.value, "a more precise later trial is more likely to confirm");
  assert.match(first.sentence, /你写的值是 0\.66.*保留了估计中约.*方向正确的概率约.*再做一次/);
  assert.match(card.note, /你写的值保持原样/);
  assert.ok(card.premises.length >= 2);
  const nothing = fixture("shrinkage-null");
  const zero = presentEffectShrinkage(nothing, value(nothing, "effect_shrinkage"));
  assert.equal(zero.rows[0].degenerate, true);
  assert.match(zero.rows[0].sentence, /没有方向/);
  assert.equal(zero.rows[0].shrunken, null);
  for (const word of sayings(card)) assert.doesNotMatch(word, BACK_OFFICE, word);
});

test("the tab payload lists the current result of each kind, newest first, and leaves out a superseded one", () => {
  const rows = [
    { ...fixture("network"), id: "res_n1", version: 1, kind: "network_meta", createdAt: "2026-11-03T10:00:00Z" },
    { ...fixture("network-chain"), id: "res_n2", version: 2, kind: "network_meta", createdAt: "2026-11-03T11:00:00Z" },
    { ...fixture("network"), id: "res_n3", version: 1, kind: "network_meta", createdAt: "2026-11-03T09:00:00Z", supersededBy: "res_n1" },
    { ...fixture("dose-spline"), id: "res_d1", version: 1, kind: "dose_response_meta", createdAt: "2026-11-03T10:00:00Z" },
    { ...fixture("shrinkage"), id: "res_s1", version: 1, kind: "effect_shrinkage", createdAt: "2026-11-03T10:00:00Z" },
  ];
  const payload = presentEvidenceSyntheses({ allResults: rows, stale: [] }, { nodeOf: (row) => `result:${row.id}` });
  assert.deepEqual(payload.networkMeta.map((card) => card.id), ["res_n2", "res_n1"]);
  assert.equal(payload.doseResponses.length, 1);
  assert.equal(payload.effectShrinkages.length, 1);
  const empty = presentEvidenceSyntheses({ allResults: [], stale: [] }, { nodeOf: () => "" });
  assert.deepEqual(empty, { networkMeta: [], doseResponses: [], effectShrinkages: [] });
});

test("the success rates are a reference with both sources side by side, each with its own endpoint, and never a probability for a trial", () => {
  const page = vcrSuccessRatesPage();
  assert.equal(page.title, "历史上这一阶段的通过率");
  assert.match(page.note, /不是这个试验成功的概率/);
  assert.deepEqual(page.sources.map((source) => source.id), ["bio_2011_2020", "wong_2019"]);
  assert.ok(page.sources.every((source) => source.method && source.data && source.endpoint));
  const all = page.areas.find((area) => area.id === "all");
  assert.equal(all.phases.phase2.bio.toNext.text, "28.9%");
  assert.equal(all.phases.phase2.bio.toNext.n, 4933);
  assert.equal(all.phases.phase3.bio.toFiling.text, "57.8%");
  assert.equal(all.phases.phase3.wong.toApproval.text, "59%");
  assert.equal(all.phases.phase2.wong.toNext, null, "the overall phase 2 to 3 rate of Wong is left out: the paper's two printed forms disagree");
  const heme = page.areas.find((area) => area.id === "hematology");
  assert.equal(heme.phases.phase2.wong, null, "no Wong group covers haematology: nothing is filled from the other source");
  const onc = page.areas.find((area) => area.id === "oncology");
  assert.equal(onc.phases.phase1.wong.toApproval.text, "3.4%");
  assert.ok(onc.wongGroup);
  // what the model reads
  const read = vcrSuccessRatesRead({ kind: "phase2", query: "oncology" });
  assert.equal(read.area.id, "oncology");
  assert.equal(read.phases.length, 1);
  assert.match(read.reference, /不是任何一个试验成功的概率/);
  assert.equal(vcrSuccessRatesRead({ query: "肿瘤" }).area.id, "oncology", "an area by its name in the table");
  const unknown = vcrSuccessRatesRead({ query: "dermatology" });
  assert.equal(unknown.unknownArea, "dermatology");
  assert.ok(unknown.areas.length >= 15);
  assert.equal(vcrSuccessRatesRead({}).phases.length, 3);
});

test("a pooling with a heterogeneity prior reads like any pooling: a credible interval stands where the confidence interval stood, and two studies have a prediction interval", () => {
  const read = readPoolResult(fixture("pool-prior"));
  assert.equal(read.ok, true);
  assert.equal(read.k, 2);
  assert.ok(read.confidence && read.confidence.low < read.pooled && read.pooled < read.confidence.high);
  assert.equal(read.predictionAvailable, true, "two studies, and a prediction interval");
  assert.ok(read.prediction.low < read.confidence.low && read.prediction.high > read.confidence.high);
  assert.equal(read.tauPrior.kind, "turner_2015");
  assert.match(tauPriorWords(read.tauPrior), /Turner 等，2015.*药物对安慰剂或对照.*全因死亡/);
  assert.match(tauPriorWords({ kind: "bartos_2023", setting: { effectScale: "log_hazard_ratio" } }), /Bartoš 等，2023/);
  assert.match(tauPriorWords({ kind: "turner_2015_generic" }), /总体情况/);
  assert.equal(measureLabel("network_effect"), "两种治疗的比较");
});
