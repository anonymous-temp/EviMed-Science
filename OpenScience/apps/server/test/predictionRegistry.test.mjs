// The prediction registry's pure rules (evidence-flywheel plan §5.2, F25): what a registration is, how it is scored, what the public may see of
// it, and what a published value must prove before it is scored. No database; the registry's switch-off is proved by a double that fails on touch.
import assert from "node:assert/strict";
import test from "node:test";
import {
  PREDICTION_CALIBRATION_MIN_SCORED, createPredictionRegistry, createQuoteBondedPublishedValue, normalizePrediction, predictionRegistryMetricFamilies, publicPredictionView, scorePrediction,
} from "../src/predictionRegistry.mjs";

const NOW = new Date("2026-10-06T08:00:00.000Z");
const filing = (over = {}) => ({ source: "vcr", studyId: "study-1", projectId: "p1", accountId: "alice", registryId: "nct01234567", endpoint: "Overall survival", estimate: 0.78, interval: [0.65, 0.93], probability: 0.7,
  methodId: "design.analytic", engineJobId: "job-1", receiptId: "rv-1", filedAt: "2026-10-06T07:59:00.000Z", ...over });
const refused = (code) => (error) => error?.code === code;

test("a registration names its source, trial, endpoint and prediction in closed formats, and is hashed over its canonical payload", () => {
  const { payload, payloadHash } = normalizePrediction(filing(), NOW);
  assert.deepEqual([payload.registryId, payload.registryKey, payload.endpointKey, payload.studyId], ["NCT01234567", "reg:NCT01234567", "overall survival", "study-1"]);
  assert.deepEqual(payload.prediction, { estimate: 0.78, interval: [0.65, 0.93], probability: 0.7 });
  assert.match(payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(normalizePrediction(filing(), NOW).payloadHash, payloadHash, "the same filing hashes the same");
  assert.notEqual(normalizePrediction(filing({ estimate: 0.8 }), NOW).payloadHash, payloadHash);
  assert.notEqual(normalizePrediction(filing({ filedAt: "2026-10-06T07:58:00.000Z" }), NOW).payloadHash, payloadHash, "a revised filing is a different registration");
  assert.deepEqual(normalizePrediction(filing({ source: "agenda", studyId: undefined, agendaId: "agenda-1", estimate: undefined, interval: undefined }), NOW).payload.prediction, { probability: 0.7 });
  for (const broken of [{ source: "geo" }, { studyId: "" }, { accountId: "" }, { projectId: undefined }, { registryId: "not a registry id" }, { endpoint: " " }, { estimate: NaN }, { estimate: undefined, probability: undefined },
    { probability: 1.2 }, { probability: -0.1 }, { interval: [0.9, 0.6] }, { interval: [0.1, 0.2] }, { interval: [0.6] }, { filedAt: "yesterday" }, { filedAt: "2026-10-06T09:00:00.000Z" }, { methodId: 5 }]) {
    assert.throws(() => normalizePrediction(filing(broken), NOW), refused("prediction_invalid"), JSON.stringify(broken));
  }
  assert.throws(() => normalizePrediction(filing({ source: "agenda" }), NOW), refused("prediction_invalid"), "an agenda's filing names the agenda");
  assert.throws(() => normalizePrediction(filing({ estimate: undefined, interval: [0.1, 0.2] }), NOW), refused("prediction_invalid"), "an interval is around an estimate");
});

test("a score is computed in code: the Brier score of a probability, the absolute error and coverage of an estimate; a kind that cannot be given is absent", () => {
  const prediction = { estimate: 0.78, interval: [0.65, 0.93], probability: 0.7 };
  const hit = scorePrediction(prediction, { value: 0.8, met: true });
  assert.ok(Math.abs(hit.brier - 0.09) < 1e-12);
  assert.ok(Math.abs(hit.absoluteError - 0.02) < 1e-12);
  assert.equal(hit.covered, true);
  const miss = scorePrediction(prediction, { value: 1.4, met: false });
  assert.ok(Math.abs(miss.brier - 0.49) < 1e-12);
  assert.equal(miss.covered, false);
  assert.deepEqual(scorePrediction({ probability: 0.7 }, { value: 0.8 }), {}, "a probability needs to know whether the endpoint was met");
  assert.deepEqual(Object.keys(scorePrediction({ estimate: 1 }, { value: 2, met: true })), ["absoluteError"], "no interval, no coverage; no probability, no Brier");
  assert.deepEqual(scorePrediction({ probability: 0.5 }, { met: true }), { brier: 0.25 }, "one half is as wrong as a coin: 0.25");
});

test("the public sees nothing of a prediction before its result, and after it only the prediction beside the actual with the time it was recorded", () => {
  const stored = { source: "vcr", studyId: "study-1", accountId: "alice", projectId: "p1", methodId: "design.analytic", engineJobId: "job-1", receiptId: "rv-1", registryId: "NCT01234567", registryKey: "reg:NCT01234567",
    endpoint: "Overall survival", prediction: { estimate: 0.78, probability: 0.7 }, recordedAt: "2026-10-06T08:00:00.000Z", payloadHash: "a".repeat(64), status: "waiting-publication" };
  assert.equal(publicPredictionView(stored), null, "before the result: not there at all");
  assert.equal(publicPredictionView({ ...stored, status: "ineligible-after-result" }), null);
  const scored = { ...stored, status: "scored", score: { brier: 0.09 }, actual: { value: 0.8, met: true, quote: "the hazard ratio was 0.80", sourceUrl: "https://example.org/paper", firstPublicAt: "2026-12-01T00:00:00.000Z", textHash: "b".repeat(64) } };
  const shown = publicPredictionView(scored);
  assert.equal(shown.registeredAt, "2026-10-06T08:00:00.000Z");
  assert.deepEqual(shown.predicted, { estimate: 0.78, probability: 0.7 });
  assert.equal(shown.actual.value, 0.8);
  const json = JSON.stringify(shown);
  for (const secret of ["alice", "study-1", "p1", "design.analytic", "job-1", "rv-1", "accountId", "studyId", "projectId", "methodId", "engineJobId", "receiptId"]) assert.equal(json.includes(secret), false, `${secret} does not leave with the public view`);
});

test("a published value is accepted only with a quotation in the preserved text that prints that very number; a met judgement only with a quotation in the text", async () => {
  const paper = { excerpt: "Median overall survival hazard ratio was 0.80 (95% CI 0.68 to 0.94). The trial met its primary endpoint." };
  const propose = (answer) => createQuoteBondedPublishedValue({ propose: async () => answer });
  const run = (answer, text = paper) => propose(answer)({ registration: {}, paper: text });
  assert.deepEqual(await run({ value: 0.8, quote: "hazard ratio was 0.80", met: true, metQuote: "The trial met its primary endpoint." }),
    { ok: true, value: 0.8, met: true, quote: "hazard ratio was 0.80", metQuote: "The trial met its primary endpoint." });
  assert.equal((await run({ value: 0.8, quote: "hazard ratio was 0.80" })).met, undefined);
  assert.deepEqual(await run({ value: 0.85, quote: "hazard ratio was 0.80" }), { ok: false, reason: "quotation_not_bonded" }, "the quotation prints another number");
  assert.deepEqual(await run({ value: 0.8, quote: "hazard ratio was 0.8" }), { ok: false, reason: "quotation_not_bonded" }, "a quotation that is not in the text is no bond");
  const onlyMet = await run({ value: 9, quote: "nowhere", met: false, metQuote: "The trial met its primary endpoint." });
  assert.deepEqual([onlyMet.ok, onlyMet.value, onlyMet.met], [true, undefined, false], "a value that is not bonded is dropped; a bonded judgement stays");
  assert.deepEqual(await run({ met: true, metQuote: "a sentence the paper never says" }), { ok: false, reason: "quotation_not_bonded" });
  assert.deepEqual(await run(null), { ok: false, reason: "nothing_proposed" });
  assert.deepEqual(await run({ value: 0.8, quote: "hazard ratio was 0.80" }, { excerpt: "" }), { ok: false, reason: "no_preserved_text" });
});

test("with its switch off the registry does nothing at all: it refuses to register by name and touches no table", async () => {
  const touched = [];
  const watch = new Proxy({}, { get: (_target, name) => { touched.push(String(name)); return () => { throw new Error("must not be touched"); }; } });
  for (const config of [{ predictionRegistryEnabled: false }, { predictionRegistryEnabled: true }]) {
    const registry = createPredictionRegistry({ config, evolution: config.predictionRegistryEnabled ? null : watch, now: () => NOW });
    assert.equal(registry.enabled, false);
    await assert.rejects(() => registry.register(filing()), refused("prediction_registry_disabled"));
    await assert.rejects(() => registry.read({ id: "x", viewer: { id: "alice" } }), refused("prediction_registry_disabled"));
    assert.deepEqual(await registry.predictionCalibration(), { available: false, scored: 0 });
    assert.deepEqual(await registry.onPublication({ paper: { excerpt: "NCT01234567" } }), { matched: 0 });
  }
  assert.deepEqual(touched, [], "no read of the ledger, no write");
});

test("the metrics carry the switch, the counts and every publication outcome, and read zero with the module off", () => {
  const families = predictionRegistryMetricFamilies(null, { predictionRegistryEnabled: false });
  assert.deepEqual(families.map((family) => family.name), ["open_science_prediction_registry_enabled", "open_science_prediction_registrations_total", "open_science_prediction_scored_total", "open_science_prediction_publication_outcomes_total"]);
  assert.ok(families.every((family) => family.series.every((entry) => entry.value === 0)));
  assert.equal(PREDICTION_CALIBRATION_MIN_SCORED, 30, "the plan's number");
});
