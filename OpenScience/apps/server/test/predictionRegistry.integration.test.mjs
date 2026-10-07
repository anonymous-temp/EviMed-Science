// The prediction registry over real PostgreSQL and the evolution module's own service (evidence-flywheel plan §5.2, F25): a registration is a tenant's
// immutable row, a publication the module's match tells the registry of scores it in code, and what anyone but the owner and an operator can read
// follows the rules of the plan: nothing before the result, predicted against actual after it, the overall calibration only from thirty scored.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { EvolutionService } from "../src/evolutionService.mjs";
import { EvolutionIntegration } from "../src/evolutionIntegration.mjs";
import { PREDICTION_CALIBRATION_MIN_SCORED, createPredictionRegistry } from "../src/predictionRegistry.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "A disposable localhost test database is required" };
const operator = `prediction_${randomUUID()}`, alice = `prediction_${randomUUID()}`, bob = `prediction_${randomUUID()}`;
const refused = (code) => (error) => error?.code === code;

let database, documents, service, clock, extractor;
const config = { predictionRegistryEnabled: true, operatorUsers: [operator] };
const makeRegistry = (extractPublished = (input) => extractor(input)) => createPredictionRegistry({ config, evolution: service, isOperator: (viewer) => viewer.id === operator, extractPublished, now: () => clock });

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Operator','development'),($2,'Alice','development'),($3,'Bob','development')", [operator, alice, bob]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576),($2,'vcr-study','Study',1048576),($3,'vcr-study','Study',1048576)", [operator, alice, bob]);
  documents = new ProductDocuments(database);
  service = new EvolutionService({ documents, jobs: new ProductJobs(database), ownerId: operator, now: () => clock });
});
after(async () => { if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[operator, alice, bob]]); await database.close(); } });

let sequence = 0;
const filing = (over = {}) => ({ source: "vcr", studyId: `study-${++sequence}`, projectId: "vcr-study", accountId: alice, registryId: `NCT0000${String(sequence).padStart(4, "0")}`, endpoint: "Overall survival",
  estimate: 0.78, interval: [0.65, 0.93], probability: 0.7, methodId: "design.analytic", engineJobId: `job-${sequence}`, filedAt: "2026-10-06T07:59:00.000Z", ...over });
const paperFor = (registryId, over = {}) => ({ id: `doi:10.1000/${registryId}`, identity: `doi:10.1000/${registryId}`, title: `Results of ${registryId}`, url: `https://doi.org/10.1000/${registryId}`,
  firstPublicAt: "2026-12-01T00:00:00.000Z", excerpt: `Trial ${registryId}: the hazard ratio was 0.80 (95% CI 0.68 to 0.94).`, ...over });
extractor = async ({ paper }) => ({ ok: true, value: 0.8, met: true, quote: "the hazard ratio was 0.80", metQuote: null, paperId: paper.id });

test("a registration is the filing account's row: stamped, hashed, found again when retried, a new row when revised, and never overwritten", options, async () => {
  clock = new Date("2026-10-06T08:00:00.000Z");
  const registry = makeRegistry();
  const input = filing();
  const first = await registry.register(input);
  assert.deepEqual([first.status, first.existing, first.recordedAt], ["waiting-publication", false, "2026-10-06T08:00:00.000Z"]);
  assert.match(first.payloadHash, /^[a-f0-9]{64}$/);
  const again = await registry.register(input);
  assert.deepEqual([again.id, again.existing], [first.id, true], "the same filing is the same row");
  const revised = await registry.register({ ...input, estimate: 0.8, interval: [0.7, 0.9], filedAt: "2026-10-06T07:59:30.000Z" });
  assert.notEqual(revised.id, first.id, "the same trial, endpoint and source, filed again, is another row");
  assert.equal((await documents.history(alice, "knowledge", first.id)).length, 1, "nothing ever rewrote the first");
  assert.equal(await service.get(first.id, operator), null, "it is the account's, not the operator's, in the ledger");
  assert.equal((await service.get(first.id, alice)).payload.status, "waiting-publication");
  assert.equal((await service.list("prospective", operator)).some((row) => row.id === first.id), false, "the module's own prospective list does not see it");
  const agenda = await registry.registerAgendaPrediction({ agendaId: "agenda-1", projectId: "vcr-study", accountId: bob, registryId: "NCT09999999", endpoint: "PFS", probability: 0.4, filedAt: "2026-10-06T07:00:00.000Z" });
  assert.equal(agenda.status, "waiting-publication");
  assert.equal((await service.get(agenda.id, bob)).payload.source, "agenda");
  await assert.rejects(() => registry.register(filing({ estimate: undefined, probability: undefined })), refused("prediction_invalid"));
  await assert.rejects(() => registry.register(filing({ projectId: "no-such-project" })));
});

test("before its result nothing about a prediction is readable but to its owner and an operator, and to anyone else it does not exist", options, async () => {
  clock = new Date("2026-10-06T09:00:00.000Z");
  const registry = makeRegistry();
  const { id } = await registry.register(filing());
  assert.equal((await registry.read({ id, viewer: { id: alice } })).view, "full");
  const seen = await registry.read({ id, viewer: { id: operator } });
  assert.deepEqual([seen.view, seen.accountId, seen.prediction.estimate], ["full", alice, 0.78]);
  for (const viewer of [{ id: bob }, { id: "anonymous" }, null]) await assert.rejects(() => registry.read({ id, viewer }), refused("prediction_not_found"), JSON.stringify(viewer));
  await assert.rejects(() => registry.read({ id: "evolution-prospective-" + "0".repeat(64), viewer: { id: bob } }), refused("prediction_not_found"), "a missing one answers the same, so a private one is not confirmed to exist");
  assert.deepEqual((await registry.listOwn({ viewer: { id: bob } })).filter((row) => row.id === id), [], "another account's list does not hold it");
  assert.equal((await registry.listOwn({ viewer: { id: alice } })).some((row) => row.id === id), true);
  assert.equal((await registry.publicScored()).some((row) => row.registryId === seen.registryId), false, "and it is in no public list");
});

test("the module's publication match scores a registered prediction in code, and afterwards it is shown only as predicted against actual", options, async () => {
  clock = new Date("2026-10-06T10:00:00.000Z");
  const registry = makeRegistry();
  service.callbacks.predictionPublication = (input) => registry.onPublication(input);
  const input = filing();
  const { id } = await registry.register(input);
  // The module's own publication match tells the registry: the paper is the one that names this trial.
  const integration = new EvolutionIntegration({ service, autopilot: {} });
  const paper = paperFor(input.registryId);
  await integration.matchProspectivePublication({ id: "event-1", paper });
  const stored = (await service.get(id, alice)).payload;
  assert.equal(stored.status, "scored");
  assert.ok(Math.abs(stored.score.brier - 0.09) < 1e-12);
  assert.ok(Math.abs(stored.score.absoluteError - 0.02) < 1e-12);
  assert.equal(stored.score.covered, true);
  assert.equal(stored.actual.value, 0.8);
  assert.equal(stored.actual.firstPublicAt, "2026-12-01T00:00:00.000Z");
  assert.equal(stored.estimate, undefined, "the prediction itself is as it was filed");
  assert.deepEqual(stored.prediction, { estimate: 0.78, interval: [0.65, 0.93], probability: 0.7 });
  const publicView = await registry.read({ id, viewer: { id: bob } });
  assert.deepEqual([publicView.view, publicView.registeredAt, publicView.actual.value], ["public", "2026-10-06T10:00:00.000Z", 0.8], "predicted against actual, with its original time");
  const json = JSON.stringify(publicView);
  for (const secret of [alice, input.studyId, "design.analytic", input.engineJobId, "accountId", "projectId"]) assert.equal(json.includes(secret), false, secret);
  assert.equal((await registry.publicScored()).some((row) => row.registryId === input.registryId.toUpperCase()), true);
  // The score is an observation on the method that made the prediction, in the module's own observation records.
  const observations = (await service.list("observation", operator)).filter((row) => row.payload.kind === "prediction-score" && row.payload.methodId === "design.analytic");
  assert.equal(observations.length >= 1, true);
  const observation = observations.find((row) => row.payload.brier !== undefined && Math.abs(row.payload.brier - 0.09) < 1e-12);
  assert.deepEqual(observation.payload.scoreKinds, ["absoluteError", "brier", "covered"]);
  assert.equal(JSON.stringify(observation.payload).includes(alice), false, "an observation carries no account");
  // A paper that does not name the trial wakes nothing, and a second publication of a scored one is left alone.
  assert.equal((await registry.onPublication({ paper: paperFor("NCT01110111") })).matched, 0);
  assert.equal((await registry.onPublication({ paper })).matched, 0);
});

test("a prediction recorded after its result was public is never scored, and with no extractor or no bonded value a matched registration waits and says why", options, async () => {
  clock = new Date("2026-12-05T00:00:00.000Z");
  const late = makeRegistry();
  const input = filing();
  const { id } = await late.register(input);
  await late.onPublication({ paper: paperFor(input.registryId) });
  assert.equal((await service.get(id, alice)).payload.status, "ineligible-after-result", "recorded after the result: not a prediction");
  assert.equal((await service.get(id, alice)).payload.score, undefined);
  await assert.rejects(() => late.read({ id, viewer: { id: bob } }), refused("prediction_not_found"), "and it is never shown");

  clock = new Date("2026-10-06T11:00:00.000Z");
  const none = makeRegistry(null);
  const waiting = filing();
  const filed = await none.register(waiting);
  await none.onPublication({ paper: paperFor(waiting.registryId) });
  assert.equal((await service.get(filed.id, alice)).payload.status, "waiting-publication");
  assert.equal(none.status().counters.outcomes.extractor_unavailable, 1);
  const failing = makeRegistry(async () => ({ ok: false, reason: "quotation_not_bonded" }));
  await failing.onPublication({ paper: paperFor(waiting.registryId) });
  assert.equal(failing.status().counters.outcomes.extraction_failed, 1);
  await failing.onPublication({ paper: paperFor(waiting.registryId, { firstPublicAt: undefined, publishedAt: undefined }) });
  assert.equal(failing.status().counters.outcomes.no_publication_date, 1);
  const throwing = makeRegistry(async () => { throw Object.assign(new Error("down"), { code: "extractor_down" }); });
  assert.deepEqual(await throwing.onPublication({ paper: paperFor(waiting.registryId) }), { matched: 1 }, "a failing extractor never reaches the module that told us");
  assert.equal(throwing.status().counters.outcomes.error, 1);
  assert.equal((await service.get(filed.id, alice)).payload.status, "waiting-publication");
});

test("the overall calibration is exported only from thirty scored predictions, and says how many there are until then", options, async () => {
  const before = (await makeRegistry().predictionCalibration()).scored;
  assert.deepEqual(await makeRegistry().predictionCalibration(), { available: false, scored: before });
  clock = new Date("2026-10-06T12:00:00.000Z");
  const registry = makeRegistry(async ({ registration }) => {
    const met = Number(registration.registryId.slice(-4)) % 2 === 0;
    return { ok: true, value: met ? 0.7 : 1.2, met, quote: met ? "the hazard ratio was 0.70" : "the hazard ratio was 1.20", metQuote: null };
  });
  const needed = PREDICTION_CALIBRATION_MIN_SCORED - before;
  const filed = [];
  for (let index = 0; index < needed - 1; index += 1) filed.push(filing({ probability: ((index % 10) + 0.5) / 10, estimate: 0.9, interval: [0.5, 1.0] }));
  for (const input of filed) await registry.register(input);
  for (const input of filed) await registry.onPublication({ paper: paperFor(input.registryId, { excerpt: `Trial ${input.registryId}: the hazard ratio was 0.70 or 1.20.` }) });
  const short = await registry.predictionCalibration();
  assert.deepEqual([short.available, short.scored], [false, PREDICTION_CALIBRATION_MIN_SCORED - 1], "twenty-nine is not thirty: no curve, only the count");
  assert.equal("probability" in short, false);
  const last = filing({ probability: 0.95, estimate: 0.9, interval: [0.5, 1.0] });
  await registry.register(last);
  await registry.onPublication({ paper: paperFor(last.registryId, { excerpt: `Trial ${last.registryId}: the hazard ratio was 0.70 or 1.20.` }) });
  const curve = await registry.predictionCalibration();
  assert.equal(curve.available, true);
  assert.equal(curve.scored, PREDICTION_CALIBRATION_MIN_SCORED);
  assert.equal(curve.probability.bins.every((bin) => bin.n > 0 && bin.observedRate >= 0 && bin.observedRate <= 1 && bin.from < bin.to), true);
  assert.equal(curve.probability.bins.reduce((sum, bin) => sum + bin.n, 0), curve.probability.n);
  assert.equal(typeof curve.estimate.meanAbsoluteError, "number");
  assert.equal(JSON.stringify(curve).includes(alice), false, "the curve names no one");
});
