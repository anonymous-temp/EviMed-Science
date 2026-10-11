// 「给患者找试验」 through the real hosted app, over HTTP, against a real PostgreSQL: a run writes two registry trials for a patient
// (the registry answers from a recorded shape), the platform judges the patient against each, and the matching tab of the study
// answers the ranked trials and the chosen trial's criteria — as the owner, as a reader who may only read, and not at all for
// somebody outside the study. The page's one action dispatches a run of the matching capability. Nothing leaves the process: the
// registry and the engine are one fetch double, and a run is recorded and not started.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "test-only-vcr-password";
const accounts = { owner: `own${suffix}`, viewer: `view${suffix}`, stranger: `str${suffix}` };

/** What ClinicalTrials.gov answers for the two trials, in the shape of its v2 API (the fields the registry client reads). */
const REGISTRY = {
  NCT07000001: {
    title: "A randomised phase 3 study of EV-201 versus docetaxel in previously treated NSCLC", phases: ["PHASE3"], status: "RECRUITING", sites: 3,
    eligibility: "Inclusion Criteria:\n* Age >= 18 years\n* ECOG performance status 0 or 1\nExclusion Criteria:\n* Active brain metastases",
  },
  NCT07000002: {
    title: "A phase 2 study of EV-201 in EGFR-mutant NSCLC after osimertinib", phases: ["PHASE2"], status: "NOT_YET_RECRUITING", sites: 1,
    eligibility: "Inclusion Criteria:\n* Age >= 18 years\n* Documented EGFR exon 19 deletion or L858R mutation\nExclusion Criteria:\n* Active brain metastases",
  },
};

/** @param {string} id */
function recordOf(id) {
  const trial = /** @type {Record<string, any>} */ (REGISTRY)[id];
  return {
    protocolSection: {
      identificationModule: { nctId: id, briefTitle: trial.title },
      statusModule: { overallStatus: trial.status },
      conditionsModule: { conditions: ["Non-small Cell Lung Cancer"] },
      designModule: { studyType: "INTERVENTIONAL", phases: trial.phases },
      eligibilityModule: { eligibilityCriteria: trial.eligibility, sex: "ALL", minimumAge: "18 Years" },
      contactsLocationsModule: { locations: Array.from({ length: trial.sites }, (_, index) => ({ facility: `Site ${index + 1}`, city: "Beijing", country: "China", status: "RECRUITING",
        contacts: [{ name: "A. Coordinator", email: "coordinator@example.org" }] })) },
    },
    hasResults: false,
  };
}

/** @type {any} */
let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {any[]} */
const dispatches = [];
/** @type {string[]} */
const registryReads = [];

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrpt");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-vcr-pt-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000,
    vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane, vcrCandidateTrialsMax: 5,
    vcrEngineUrl: "http://engine.test:8080", vcrEngineToken: "t".repeat(40), vcrEngineReceiptKey: "r".repeat(40),
    // The registry and the engine are one double: ClinicalTrials.gov's API answers the two records, the engine its health.
    vcrFetch: async (/** @type {any} */ url) => {
      const target = new URL(String(url));
      if (target.hostname === "clinicaltrials.gov") {
        const id = target.pathname.split("/").pop() ?? "";
        registryReads.push(id);
        return id in REGISTRY ? new Response(JSON.stringify(recordOf(id)), { status: 200, headers: { "content-type": "application/json" } })
          : new Response("{}", { status: 404 });
      }
      const body = target.pathname === "/health" ? { ok: true, engineVersion: "test", rVersion: "test", methods: [], packageLockHash: "" } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    vcrDispatchRun: async (/** @type {any} */ input) => {
      dispatches.push(input);
      return { runId: `run_${dispatches.length}`, sessionId: `session_${dispatches.length}`, status: "running" };
    },
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [name, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[name] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
});

after(async () => {
  if (context) {
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  await isolated?.drop();
});

/** @param {string} who @param {string} method @param {string} route @param {unknown} [body] */
async function call(who, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[who], body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  /** @type {any} */
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
  return { status: response.status, body: parsed, text };
}

/** A study of the owner's with a patient the chart settles most of, and the viewer a member. */
async function furnishedStudy() {
  const made = await call("owner", "POST", "/api/vcr/studies", { name: "EV-201 患者找试验", question: "晚期肺腺癌患者现在有哪些试验可以去问？", dataTier: "T1" });
  assert.equal(made.status, 201, made.text);
  const study = await context.app.vcr.store.studyById(made.body.data.id);
  const fact = (/** @type {string} */ variable, /** @type {any} */ value, /** @type {Record<string, any>} */ extra = {}, /** @type {number} */ minute = 0) => context.app.vcr.matchStore.saveFact({
    studyId: study.id, userId: study.userId, fact: { subjectKey: "P-0192", variable, value, unit: null, polarity: "affirmed", occurredAt: `2026-09-10T00:0${minute}:00.000Z`,
      recordedAt: null, visibleAt: `2026-09-10T00:0${minute}:00.000Z`, surface: "", source: null, extractedBy: "code", ...extra } });
  await fact("age", 63, { unit: "year" });
  await fact("ecog", 1, {}, 1);
  await fact("active_brain_metastasis", false, { polarity: "negated" }, 2);
  const joined = await call("owner", "POST", `/api/vcr/studies/${study.id}/members`, { userId: accounts.viewer, role: "viewer" });
  assert.equal(joined.status, 201, joined.text);
  return study;
}

/** The run's write, as the gateway makes it: the composed module's own seams. @param {any} study @param {any[]} items */
function runWrites(study, items) {
  const vcr = context.app.vcr;
  return vcrRuntimeWrite({
    store: vcr.store, service: vcr.service, orchestrator: vcr.orchestrator, study, what: "candidate_trial", items,
    evidence: vcr.evidence, evidenceStore: vcr.evidenceStore, matchStore: vcr.matchStore, matching: vcr.matching, patientTrials: vcr.patientTrials,
    seal: vcr.seal, dataPlane: vcr.dataPlaneSeam, documents: vcr.documents, report: () => {}, caller: { runtimeRunId: null },
  });
}

const AGE = { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18 years", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } };
const ECOG = { kind: "inclusion", criterionType: "performance_status", sourceText: "ECOG performance status 0 or 1", requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 1 } };
// Written as the registry states it -- the condition that excludes; the platform stores the negation (2026-10-11).
const BRAIN = { kind: "exclusion", criterionType: "comorbidity", sourceText: "Active brain metastases", requirement: { op: "present", variable: "active_brain_metastasis" },
  evidenceNeeded: ["申请近 4 周头颅 MRI"] };
const EGFR = { kind: "inclusion", criterionType: "biomarker", sourceText: "Documented EGFR exon 19 deletion or L858R mutation", requirement: { op: "present", variable: "egfr_mutation" },
  evidenceNeeded: ["EGFR 突变检测报告"] };

test("a run writes two registry trials for a patient, the platform judges her against each, and the tab answers them ranked", options, async () => {
  const study = await furnishedStudy();
  const S = `/api/vcr/studies/${study.id}`;
  const wrote = await runWrites(study, [
    { registryId: "NCT07000002", criteria: [AGE, EGFR, BRAIN], subjectKeys: ["P-0192"] },
    { registryId: "NCT07000001", criteria: [AGE, ECOG, BRAIN], subjectKeys: ["P-0192"] },
  ]);
  assert.deepEqual(wrote.issues, []);
  assert.equal(wrote.ids.length, 2);
  assert.deepEqual(wrote.results.map((row) => [row.registryId, row.evaluated[0].summary, row.located]), [["NCT07000002", "insufficient_evidence", 3], ["NCT07000001", "eligible", 3]],
    "the registry's record gave each its identity, the platform found each wording in it, and judged the patient at once");
  assert.deepEqual(registryReads.sort(), ["NCT07000001", "NCT07000002"]);

  // The page's read: the patient chosen, her trials in order, the first trial's criteria.
  const asked = await call("owner", "GET", `${S}/matching?view=matching&direction=patient_to_trial&candidate=P-0192`);
  assert.equal(asked.status, 200, asked.text);
  const page = asked.body.data;
  assert.equal(page.direction, "patient_to_trial");
  assert.deepEqual(page.directions, ["trial_to_patient", "patient_to_trial"]);
  assert.deepEqual(page.candidateRoster, ["P-0192"]);
  assert.deepEqual(page.patientTrials.trials.map((row) => [row.rank, row.registryId, row.eligibility, row.status, row.phase]), [
    [1, "NCT07000001", "eligible", "招募中", "III 期"],
    [2, "NCT07000002", "insufficient_evidence", "尚未开始招募", "II 期"],
  ]);
  const [first, second] = page.patientTrials.trials;
  assert.equal(first.url, "https://clinicaltrials.gov/study/NCT07000001");
  assert.equal(first.title, REGISTRY.NCT07000001.title);
  assert.deepEqual(first.sites, { total: 3, countries: ["China"] });
  assert.ok(!JSON.stringify(page).includes("coordinator@example.org"), "no contact of a site reaches a page");
  assert.deepEqual(page.patientTrials.selected.criteria.map((row) => [row.code, row.state, row.text]), [
    ["I1", "satisfied", "Age >= 18 years"], ["I2", "satisfied", "ECOG performance status 0 or 1"], ["E1", "satisfied", "Active brain metastases"]]);

  // The second is the one that waits on a report, and says which.
  const chosen = await call("owner", "GET", `${S}/matching?view=matching&direction=patient_to_trial&candidate=P-0192&trial=${second.id}`);
  const open = chosen.body.data.patientTrials.selected.criteria.find((row) => row.state === "unknown");
  assert.deepEqual([chosen.body.data.patientTrials.selected.id, open.code, open.request], [second.id, "I2", "EGFR 突变检测报告"]);
  assert.equal(chosen.body.data.patientTrials.selected.verdict.text, "不能判为符合：入选标准 I2 未知");

  // The runtime's read of the same list, and what it still owes.
  const read = await context.app.vcr.service.runtimeRead(study, "candidate_trials", { subjectKey: "P-0192" });
  assert.deepEqual(read.ranking.map((row) => [row.rank, row.registryId, row.eligibility]), [[1, "NCT07000001", "eligible"], [2, "NCT07000002", "insufficient_evidence"]]);
  assert.deepEqual(read.unjudged, []);

  // Neither direction's counts moved: the study has no protocol of its own, so its funnel and ledger know nothing of the trials.
  assert.deepEqual(page.funnel, []);
  assert.deepEqual(page.protocols, []);
  assert.deepEqual(page.ledger, []);
});

test("a reader may read the trials but not ask for a search; somebody outside the study finds none of it", options, async () => {
  const study = await furnishedStudy();
  const S = `/api/vcr/studies/${study.id}`;
  await runWrites(study, [{ registryId: "NCT07000001", criteria: [AGE, ECOG, BRAIN], subjectKeys: ["P-0192"] }]);
  const read = await call("viewer", "GET", `${S}/matching?view=matching&direction=patient_to_trial&candidate=P-0192`);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.data.patientTrials.trials.length, 1);
  const refused = await call("viewer", "POST", `${S}/trial-search`, { subjectKey: "P-0192" });
  assert.deepEqual([refused.status, refused.body.code], [403, "vcr_forbidden"]);
  assert.equal(dispatches.length, 0, "nothing was sent");
  for (const [method, route, body] of [["GET", `${S}/matching?direction=patient_to_trial&candidate=P-0192`, undefined], ["POST", `${S}/trial-search`, { subjectKey: "P-0192" }]]) {
    const outsider = await call("stranger", String(method), String(route), body);
    assert.deepEqual([outsider.status, outsider.body.code], [404, "vcr_study_not_found"], `${method} ${route}`);
  }
});

test("the page's action dispatches a run of the matching capability for the patient and judges what the study already holds for her", options, async () => {
  const study = await furnishedStudy();
  const S = `/api/vcr/studies/${study.id}`;
  // Trials a run found for somebody else: held, and judged for nobody.
  await runWrites(study, [{ registryId: "NCT07000001", criteria: [AGE, ECOG, BRAIN] }, { registryId: "NCT07000002", criteria: [AGE, EGFR, BRAIN] }]);
  const before = await call("owner", "GET", `${S}/matching?view=matching&direction=patient_to_trial&candidate=P-0192`);
  assert.deepEqual(before.body.data.patientTrials.trials, [], "held trials that have not judged her are not results about her");
  assert.equal((await context.app.vcr.service.runtimeRead(study, "candidate_trials", { subjectKey: "P-0192" })).unjudged.length, 2);

  const asked = await call("owner", "POST", `${S}/trial-search`, { subjectKey: "P-0192" });
  assert.equal(asked.status, 200, asked.text);
  assert.ok(asked.body.data.runId && asked.body.data.sessionId);
  assert.equal(asked.body.data.evaluated, 2, "the two trials the study holds now have a verdict about her");
  const sent = dispatches.at(-1);
  assert.deepEqual([sent.capabilityId, sent.reason, sent.studyId], ["vcr-matching", "vcr:trial-search", study.id]);
  assert.match(sent.brief, /P-0192/);
  const after = await call("owner", "GET", `${S}/matching?view=matching&direction=patient_to_trial&candidate=P-0192`);
  assert.deepEqual(after.body.data.patientTrials.trials.map((row) => row.registryId), ["NCT07000001", "NCT07000002"]);

  // A patient the study does not hold, and a body that is not the key alone, are refused before anything is sent.
  const sentBefore = dispatches.length;
  assert.deepEqual([(await call("owner", "POST", `${S}/trial-search`, { subjectKey: "P-9999" })).body.code], ["vcr_subject_not_found"]);
  assert.equal((await call("owner", "POST", `${S}/trial-search`, { subjectKey: "P-0192", extra: 1 })).status, 400);
  assert.equal(dispatches.length, sentBefore);
});

test("a study holds only as many candidate trials as the deployment allows, and says so by item", options, async () => {
  const study = await furnishedStudy();
  const vcr = context.app.vcr;
  // The deployment's cap is five: five trials fit and the sixth is refused with the reason, the first five unharmed.
  for (let at = 1; at <= 5; at += 1) {
    const stored = await vcr.candidateStore.saveCandidateTrial({ studyId: study.id, userId: study.userId, max: 5, criteria: [AGE],
      trial: { registry: "clinicaltrials.gov", registryId: `NCT0800000${at}`, title: `Filler ${at}`, phase: "", status: "", conditions: [], locations: {}, url: "", recordHash: null, retrievedAt: null, eligibilityText: "" } });
    assert.ok(stored.created);
  }
  const refused = await runWrites(study, [{ registryId: "NCT07000001", criteria: [AGE, ECOG, BRAIN], subjectKeys: ["P-0192"] }]);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.issues.map((issue) => issue.code), ["vcr_write_refused"]);
  assert.match(refused.issues[0].message, /5 个候选试验/);
  assert.equal(vcr.patientTrials.counters.capReached >= 1, true, "and the counter says so");
  assert.equal((await vcr.candidateStore.listCandidateTrials({ studyId: study.id })).length, 5);
});
