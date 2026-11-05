// The prediction registry's pure rules (evidence-flywheel plan §5.2, F25): what a filing is. Scoring a filing against a published result was an experiment and left with the
// online engine (2026-11-04), and every read that waited for a score went with it. No database; the registry's switch-off is proved by a double that fails on touch.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createPredictionRegistry, normalizePrediction, predictionRegistryMetricFamilies } from "../src/predictionRegistry.mjs";

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


test("with its switch off the registry does nothing at all: it refuses to register by name and touches no table", async () => {
  const touched = [];
  const watch = new Proxy({}, { get: (_target, name) => { touched.push(String(name)); return () => { throw new Error("must not be touched"); }; } });
  for (const config of [{ predictionRegistryEnabled: false }, { predictionRegistryEnabled: true }]) {
    const registry = createPredictionRegistry({ config, evolution: config.predictionRegistryEnabled ? null : watch, now: () => NOW });
    assert.equal(registry.enabled, false);
    await assert.rejects(() => registry.register(filing()), refused("prediction_registry_disabled"));
  }
  assert.deepEqual(touched, [], "no read of the ledger, no write");
});

test("the metrics carry the switch and the count of registrations, and read zero with the module off", () => {
  const families = predictionRegistryMetricFamilies(null, { predictionRegistryEnabled: false });
  assert.deepEqual(families.map((family) => family.name), ["open_science_prediction_registry_enabled", "open_science_prediction_registrations_total"]);
  assert.ok(families.every((family) => family.series.every((entry) => entry.value === 0)));
});

test("the registry files and counts, and promises no score: nothing online can give one", async () => {
  const registry = createPredictionRegistry({ config: { predictionRegistryEnabled: false }, evolution: null, now: () => NOW });
  assert.deepEqual(Object.keys(registry).sort(), ["enabled", "register", "status"]);
  const example = await readFile(new URL("../../../deploy/web/.env.example", import.meta.url), "utf8");
  const lines = example.split("\n"), at = lines.indexOf("OPEN_SCIENCE_PREDICTION_REGISTRY_ENABLED=false");
  const comment = lines.slice(Math.max(0, at - 3), at).filter((line) => /prediction/i.test(line)).join(" ");
  assert.match(comment, /prediction registry/i);
  assert.doesNotMatch(comment, /scored|calibration/i);
});
