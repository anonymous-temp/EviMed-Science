// The page contract, proven on real rows (contract 2026-09-29 §5).
//
// A study is seeded through the real stores (`vcrViewsSeed.mjs`), read through
// the real `VcrService`, and what the browser would be sent is compared, byte
// for byte after ids are numbered, with the JSON files under
// `test/fixtures/vcr-views/`. The web tests render the real components from the
// same files through the real readers with only the network mocked — so the
// server cannot change a page without the fixture changing, and the fixture
// cannot change without the browser being shown what it will now receive.
//
// A page shape changes on purpose with
//
//   VCR_VIEWS_WRITE_FIXTURES=1 node --test test/vcrViews.integration.test.mjs
//
// and the diff of the fixtures is the review.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

import { VCR_TABS } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrEvidenceStore } from "../src/vcrEvidenceStore.mjs";
import { VcrJobs } from "../src/vcrJobs.mjs";
import { VcrCandidateTrialStore } from "../src/vcrCandidateTrialStore.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { createPatientTrials } from "../src/vcrPatientTrials.mjs";
import { createVcrRecords } from "../src/vcrRecords.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { FIXTURE_DIR } from "./vcrViewsFixtures.mjs";
import { SEED_NOW, seedEv201, seedPatientTrials } from "./vcrViewsSeed.mjs";

const WRITE = process.env.VCR_VIEWS_WRITE_FIXTURES === "1";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const config = { vcrEnabled: true, vcrAudience: "all", vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 7_200,
  vcrMaxConcurrentJobs: 2, vcrLeaseMs: 900_000, vcrDataPlaneDir: "" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {VcrService} */
let service;
/** @type {any} */
let seeded;
/** The third study: another account's, with the trials found for a patient. @type {any} */
let trialsStudy;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";
/** The data plane the patient set's table is written in: a directory of this run's own. */
let plane = "";

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrviews_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  const store = new VcrStore({ database });
  await store.ready();
  const matchStore = new VcrMatchStore({ database });
  const evidenceStore = new VcrEvidenceStore({ database });
  const jobs = new VcrJobs({ store, config });
  plane = mkdtempSync(join(tmpdir(), "vcr-views-plane-"));
  chmodSync(plane, 0o700);
  seeded = await seedEv201({ store, matchStore, evidenceStore, plane });
  const patientTrials = createPatientTrials({ candidateStore: new VcrCandidateTrialStore({ database }), matchStore, config: { vcrCandidateTrialsMax: 20 }, now: () => SEED_NOW });
  service = new VcrService({ store, config, jobs, matchStore, evidenceStore, patientTrials, now: () => SEED_NOW });
  service.attach({ records: createVcrRecords({ store, config: { vcrDataPlaneDir: plane } }) });
  number(seeded.study.id);
  number(seeded.empty.id);
  trialsStudy = await seedPatientTrials({ store, matchStore, patientTrials });
});

after(async () => {
  if (plane) rmSync(plane, { recursive: true, force: true });
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

/**
 * The ids generated in this run, numbered by first appearance across EVERY
 * fixture written in one run, so `std_1` is the same study in the home list, on
 * its page and in each tab — the web tests address the fixtures by those ids.
 * The two studies are pinned first, so the numbering does not depend on which
 * page happens to be written first.
 */
const numbered = new Map();
const counters = new Map();

/** @param {string} id */
function number(id) {
  if (!numbered.has(id)) {
    const prefix = id.slice(0, id.indexOf("_"));
    counters.set(prefix, (counters.get(prefix) ?? 0) + 1);
    numbered.set(id, `${prefix}_${counters.get(prefix)}`);
  }
  return numbered.get(id);
}

/**
 * A fixture's text: generated ids replaced by their run-independent numbers,
 * hashes masked. Fixed ids (`job_seed_1`) are left as they are.
 * @param {unknown} value
 */
function normalize(value) {
  const text = JSON.stringify(value, null, 2)
    .replace(/\b(std|def|prt|crt|pre|evd|asm|pop|pts|cmp|scn|grd|mdl|mth|exe|res|fct|mas|jdg|rev|fup|rvw|dec|exp|ctr|ctc|cta|fac)_[0-9a-f]{22}\b/g, (match) => number(match))
    .replace(/"hash": "[0-9a-f]{12}"/g, '"hash": "HASH"');
  return `${text}\n`;
}

/** @param {string} name @param {unknown} value */
function check(name, value) {
  const path = join(FIXTURE_DIR, name);
  const text = normalize(value);
  if (WRITE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  assert.equal(text, readFileSync(path, "utf8"), `${name} differs from what the service now sends; regenerate with VCR_VIEWS_WRITE_FIXTURES=1 and read the diff`);
}

test("the home list is exactly the browser's VcrHome", options, async () => {
  const home = await service.listStudies({ id: seeded.owner });
  assert.equal(home.studies.length, 2);
  const row = home.studies.find((/** @type {any} */ entry) => entry.id === seeded.study.id);
  assert.equal(row.tier, "T0", "tier, not dataTier");
  assert.equal(typeof row.updatedAt, "string");
  assert.ok(row.conclusion?.text, "a conclusion sentence rendered from a result");
  assert.ok(row.attention.length > 0);
  check("ev201/home.json", home);
  assert.ok(Array.isArray(home.todos) && home.todos.length > 0, "a lead may contact patients, so 招募待办 is there");
  const reviewer = await service.listStudies({ id: "u_stat" });
  assert.equal(reviewer.todos, undefined, "a statistical reviewer has no recruiting role, so the column is absent");
  assert.equal(reviewer.studies.length, 1, "a member sees the study they belong to and nothing else");
});

test("the study page and its overview carry what the browser reads", options, async () => {
  const study = await service.studyView({ id: seeded.owner }, seeded.study.id);
  assert.equal(study.tier, "T0");
  assert.ok(study.overview.metrics.length > 0 && study.overview.designs.length === 4 && study.overview.deliverables.length === 2);
  assert.deepEqual(study.abilities.includes("run"), true);
  assert.equal(study.jobs.some((/** @type {any} */ job) => job.state === "awaiting_budget"), true);
  assert.ok(study.budget.awaitingBudget >= 1);
  check("ev201/study.json", study);
  const fresh = await service.studyView({ id: seeded.owner }, seeded.empty.id);
  assert.equal(fresh.overview.designs.length, 0);
  check("empty/study.json", fresh);
});

test("every one of the six data tabs answers the shape its component reads", options, async () => {
  for (const tab of VCR_TABS.filter((entry) => entry !== "overview")) {
    check(`ev201/${tab}.json`, await service.tab({ id: seeded.owner }, seeded.study.id, tab));
    check(`empty/${tab}.json`, await service.tab({ id: seeded.owner }, seeded.empty.id, tab));
  }
});

/**
 * Keys a payload used to carry that were the platform's sentences about itself — how a population was made and what it may be used for,
 * the missing-profile request, the run card — and the notes under the counts. Gone as keys, not emptied, in every payload the pages
 * read (2026-10-14, B §2.4): the check is on structure, never on a phrase.
 */
const REMOVED_KEYS = ["profileNote", "profileMissing", "allowedUses", "runRecord", "method:population", "notes:counts", "note:counts", "origin:example"];

/** @param {unknown} value @param {string} where @param {string[]} found */
function walkForRemoved(value, where, found, parent = "") {
  if (Array.isArray(value)) { value.forEach((entry, index) => walkForRemoved(entry, `${where}[${index}]`, found, parent)); return; }
  if (!value || typeof value !== "object") return;
  const object = /** @type {Record<string, unknown>} */ (value);
  const isCounts = "generatedRecords" in object || "realPatients" in object || "effectiveSampleSize" in object;
  for (const [key, entry] of Object.entries(object)) {
    if (["profileNote", "profileMissing", "allowedUses", "runRecord"].includes(key)) found.push(`${where}.${key}`);
    if (isCounts && (key === "notes" || key === "note")) found.push(`${where}.${key}`);
    if (parent === "example" && key === "origin") found.push(`${where}.${key}`);
    walkForRemoved(entry, `${where}.${key}`, found, key);
  }
}

test("no payload a page reads carries a sentence the platform wrote about itself: the keys are gone (R2, B §2.4)", options, async () => {
  /** @type {string[]} */
  const found = [];
  const owner = { id: seeded.owner };
  walkForRemoved(await service.studyView(owner, seeded.study.id), "study", found);
  for (const tab of VCR_TABS.filter((entry) => entry !== "overview")) {
    walkForRemoved(await service.tab(owner, seeded.study.id, tab), tab, found);
    walkForRemoved(await service.tab(owner, seeded.empty.id, tab), `empty.${tab}`, found);
  }
  walkForRemoved(await service.listStudies(owner), "home", found);
  assert.deepEqual(found, [], `payloads still carry removed keys: ${REMOVED_KEYS.join(", ")}`);
  // The generated population's tab and the patients' carry facts where the sentences were.
  const patients = await service.tab(owner, seeded.study.id, "patients");
  assert.equal(patients.example.title, "示例患者 · 年龄 62 岁 · ECOG 1");
  assert.equal(patients.example.record.id, "VP-0412");
  assert.equal("origin" in patients.example, false);
  const trial = await service.tab(owner, seeded.study.id, "trial");
  assert.ok(trial.designs.every((/** @type {any} */ design) => design.record === null || typeof design.record === "object"));
  assert.ok(trial.designs.some((/** @type {any} */ design) => design.record?.check?.agrees === true), "the closed form held against the simulation, as numbers");
});

test("the matching tab answers each view and the candidate it is asked for", options, async () => {
  const asked = await service.tab({ id: seeded.owner }, seeded.study.id, "matching", new URLSearchParams("view=matching&candidate=P-0201"));
  assert.equal(asked.selected.candidate.id, "P-0201");
  check("ev201/matching-p0201.json", asked);
  // The one person whose referral is waiting on a coordinator's confirmation.
  const waiting = await service.tab({ id: seeded.owner }, seeded.study.id, "matching", new URLSearchParams("candidate=P-0192"));
  assert.equal(waiting.selected.canContact, true);
  assert.ok(waiting.selected.referralId, "the contact confirms a referral, not a candidate key");
  check("ev201/matching-p0192.json", waiting);
  for (const view of ["referral", "sites", "followup"]) {
    const answer = await service.tab({ id: seeded.owner }, seeded.study.id, "matching", new URLSearchParams(`view=${view}`));
    assert.equal(answer.view, view);
    check(`ev201/matching-${view}.json`, answer);
  }
});

test("the matching tab answers 给患者找试验: a patient's trials in order, the chosen trial's criteria, and an empty answer for a patient nobody has searched for", options, async () => {
  const mine = { id: trialsStudy.userId };
  const asked = (/** @type {string} */ query) => service.tab(mine, trialsStudy.study.id, "matching", new URLSearchParams(`view=matching&direction=patient_to_trial&${query}`));
  // The patient, and the first of her trials chosen.
  const first = await asked("candidate=P-0192");
  assert.equal(first.direction, "patient_to_trial");
  assert.deepEqual(first.directions, ["trial_to_patient", "patient_to_trial"]);
  assert.equal(first.patientTrials.subject, "P-0192");
  assert.deepEqual(first.patientTrials.trials.map((/** @type {any} */ row) => [row.rank, row.kind, row.registryId, row.eligibility]), [
    [1, "registry", "NCT05000001", "eligible"],
    [2, "protocol", null, "eligible"],
    [3, "registry", "NCT05000002", "insufficient_evidence"],
    [4, "registry", "NCT05000003", "ineligible"],
  ], "every criterion met first (the registry's recruiting trial before the study's own), the one that waits on a report next, the excluded last");
  assert.equal(first.patientTrials.selected.id, first.patientTrials.trials[0].id, "the first is chosen when none is asked for");
  assert.deepEqual(first.patientTrials.selected.criteria.map((/** @type {any} */ row) => [row.code, row.state]), [["I1", "satisfied"], ["I2", "satisfied"], ["E1", "satisfied"]]);
  assert.equal(first.patientTrials.selected.verdict.text, "符合：全部适用的入排条件都满足");
  check("ev201/matching-patient-trials.json", first);
  // Her trial that waits on a biomarker report: the rule that is open, and what to ask for.
  const waitingId = first.patientTrials.trials[2].id;
  const waiting = await asked(`candidate=P-0192&trial=${waitingId}`);
  assert.equal(waiting.patientTrials.selected.id, waitingId);
  const open = waiting.patientTrials.selected.criteria.find((/** @type {any} */ row) => row.state === "unknown");
  assert.deepEqual([open.code, open.request], ["I2", "EGFR 突变检测报告"]);
  assert.deepEqual(waiting.patientTrials.trials[2].counts, { satisfied: 2, unknown: 1, notSatisfied: 0, pending: 0 });
  assert.equal(waiting.patientTrials.trials[2].summary, "2 条满足 · 1 条未知 · 0 条不满足");
  check("ev201/matching-patient-trials-open.json", waiting);
  // A patient nobody has searched for: nothing judged, nothing listed, and the page's one sentence and one button.
  const none = await asked("candidate=P-0201");
  assert.deepEqual([none.patientTrials.subject, none.patientTrials.trials, none.patientTrials.selected], ["P-0201", [], null]);
  check("ev201/matching-patient-trials-none.json", none);
  // No patient chosen yet, a key the study does not hold, and a trial that is not this patient's all read as the first of these.
  const nobody = await asked("");
  assert.deepEqual([nobody.patientTrials.subject, nobody.patientTrials.trials.length], [null, 0]);
  check("ev201/matching-patient-trials-nobody.json", nobody);
  assert.equal((await asked("candidate=P-9999")).patientTrials.subject, null);
  assert.equal((await asked("candidate=P-0192&trial=ctr_not_hers")).patientTrials.selected.id, first.patientTrials.trials[0].id);
  // The other direction is what it was: the same view, no patient-trials block.
  const other = await service.tab(mine, trialsStudy.study.id, "matching", new URLSearchParams("view=matching&candidate=P-0192"));
  assert.equal(other.direction, "trial_to_patient");
  assert.equal(other.patientTrials, undefined);
  assert.deepEqual(other.directions, ["trial_to_patient", "patient_to_trial"]);
});

test("the model library, the precedents and a package read", options, async () => {
  check("ev201/models.json", await service.modelLibrary({ id: seeded.owner }));
  const precedents = await service.precedents({ id: seeded.owner }, new URLSearchParams("q=CTR"));
  assert.equal(precedents.available, true);
  assert.equal(precedents.precedents.length, 1);
  check("ev201/precedents.json", precedents);
  const unavailable = await new VcrService({ store: service.store, config, now: () => SEED_NOW }).precedents({ id: seeded.owner }, {});
  assert.equal(unavailable.available, false);
  assert.ok(unavailable.message, "the sentence saying the library is not there");
  check("ev201/precedents-unavailable.json", unavailable);
  check("ev201/export.json", await service.exportView({ id: seeded.owner }, seeded.study.id, seeded.packageId));
});
