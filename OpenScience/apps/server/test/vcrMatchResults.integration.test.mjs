// The matching page's reader and its files, in the real hosted app over HTTP against a real PostgreSQL: one patient's trials as the job fills them in, a
// protocol of five thousand people paged and filtered with the clause funnel, the three groups of reasons and the clause table of an opened pair, the failed
// pairs in plain words, the files for both directions streamed in small chunks, and the module's usual authorization on every route (another account refused).
// The model is not here: the rows are written the way the job writes them.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { trialVerdict, vcrSubjectLabel } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { NOTE, seedJudged, sentencesOf, trialId } from "./helpers/vcrJudgedSeed.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = Math.random().toString(36).slice(2, 8);
const PASSWORD = "test-only-vcr-password";
const accounts = { owner: `own${suffix}`, datamanager: `dm${suffix}`, clinician: `clin${suffix}`, viewer: `view${suffix}`, stranger: `str${suffix}` };
const ROLE_OF = { datamanager: "data_manager", clinician: "clinical_reviewer", viewer: "viewer" };
const PEOPLE = 5_000;

/** @type {any} */
let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {{ id: string, projectId: string } | null} */
let study = null;
/** @type {{ id: string } | null} */
let other = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "s2results");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-vcr-results-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000,
    vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane,
    vcrStartStudy: async () => ({ accepted: true }),
    vcrDispatchRun: async () => ({ runId: "run_1", sessionId: "session_1", status: "running" }),
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [name, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[name] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
  study = await makeStudy("匹配结果");
  other = await makeStudy("另一项研究");
});

after(async () => {
  if (context) { await context.app.close(); await rm(context.dataDir, { recursive: true, force: true }); }
  await isolated?.drop();
});

/** @param {string} who @param {string} method @param {string} route @param {unknown} [body] */
async function call(who, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[who], body: body === undefined ? undefined : JSON.stringify(body) });
  // Through a Buffer: `response.text()` drops a byte order mark, and the file's is a thing to check.
  const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
  /** @type {any} */
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
  return { status: response.status, body: parsed, text, headers: response.headers };
}
const db = () => context.app.vcr.store.database;

async function makeStudy(name) {
  const created = await call("owner", "POST", "/api/vcr/studies", { name, question: "在 ITT 人群中 X 相对 Y 的总生存期", dataTier: "T0", intendedUse: "exploratory" });
  assert.equal(created.status, 201, created.text);
  for (const [who, role] of Object.entries(ROLE_OF)) {
    const added = await call("owner", "POST", `/api/vcr/studies/${created.body.data.id}/members`, { userId: accounts[/** @type {keyof typeof accounts} */ (who)], role });
    assert.equal(added.status, 201, `${who}: ${added.text}`);
  }
  return created.body.data;
}

const S = () => `/api/vcr/studies/${study.id}`;
const TRIAL = (n) => `NCT0000000${n}`;

/** One judgment row the way the job writes it. */
async function save(studyId, entry) {
  return context.app.vcr.matchJudgments.save({ studyId, userId: accounts.owner, targetHash: "t", documentHash: "d", promptVersion: entry.mode === "fit" ? "fit-1" : "criteria-2", model: "deepseek-flash", thinking: "high", producer: "job",
    status: "done", ...entry });
}
const clause = (number, kind, label, basis, reason, evidence = []) => ({ number, kind, clause: `条款 ${number}`, label, reason, sentenceIds: evidence.map((item) => item.sentenceId), evidence, basis });
const sentence = (sentenceId, text, documentId = "doc_missing") => ({ sentenceId, text, start: 0, end: text.length, documentId });
const target = (id, title, extra = {}) => ({ kind: "candidate_trial", id, registry: "clinicaltrials.gov", registryId: id, title, url: `https://clinicaltrials.gov/study/${id}`, status: "RECRUITING", phase: "PHASE2", ...extra });

async function insertJob(studyId, scenario, state = "running") {
  const id = `job_${Math.random().toString(36).slice(2, 12)}`;
  await db().query(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method, state, scenario) VALUES ($1, $2, $3, 'match_judge', 'matching.judge', $4, $5::jsonb)`,
    [id, studyId, accounts.owner, state, JSON.stringify(scenario)]);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// One patient, trials
// ---------------------------------------------------------------------------------------------------------------------------------

test("a patient's trials fill in as they are judged: the list in order, n of m, what failed and why in plain words, and the cost so far", options, async () => {
  const subjectKey = "P-0192";
  const job = await insertJob(study.id, { direction: "patient_to_trial", subjects: [subjectKey], trials: [1, 2, 3, 4, 5, 6].map((n) => ({ registry: "clinicaltrials.gov", registryId: TRIAL(n) })), fit: true, topK: 20, thinking: "high",
    estimate: { cost: 1.5, currency: "CNY", calls: 12 } });
  // 1: every clause for the patient, with the model's three groups of reasons.
  await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(1), mode: "fit", fit: 92, confidence: 0.85, verdict: "eligible", jobId: job, usage: { cost: 0.0125 },
    answer: { target: target(TRIAL(1), "EGFR 突变晚期肺癌的一线治疗"), eligibilitySource: "registry", reasons: { eligible: ["确诊 EGFR 19del 的 IV 期肺腺癌"], ineligible: [], missing: ["近 4 周的头颅 MRI 报告"], rationale: "条件基本符合" } } });
  await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(1), mode: "criteria", fit: 92, confidence: 0.85, verdict: "possible", jobId: job, usage: { cost: 0.0225 },
    answer: { target: target(TRIAL(1), "EGFR 突变晚期肺癌的一线治疗"), eligibilitySource: "registry", rows: [
      clause(1, "inclusion", "included", "stated", "病理为肺腺癌", [sentence(3, "病理：肺腺癌，EGFR 19del 阳性。")]),
      clause(2, "inclusion", "included", "silent", "病历没写年龄，按符合"),
      clause(3, "exclusion", "not_excluded", "silent", "病历没有间质性肺病的记载"),
      clause(4, "exclusion", "not_enough_information", "silent", "没有近期头颅影像"),
    ], missing: [{ number: 5, kind: "exclusion", text: "条款 5" }] } });
  // 2: a stated disqualifier.
  await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(2), mode: "fit", fit: 12, confidence: 0.9, verdict: "ineligible", jobId: job, usage: { cost: 0.0125 },
    answer: { target: target(TRIAL(2), "肾功能不全患者的试验", { status: "COMPLETED" }), eligibilitySource: "registry", reasons: { eligible: [], ineligible: ["肌酐 3.1 mg/dL，超过入组上限"], missing: [] } } });
  await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(2), mode: "criteria", fit: 12, confidence: 0.9, verdict: "ineligible", jobId: job, usage: { cost: 0.02 },
    answer: { target: target(TRIAL(2), "肾功能不全患者的试验", { status: "COMPLETED" }), eligibilitySource: "registry", rows: [
      clause(1, "inclusion", "not_included", "stated", "肌酐 3.1 mg/dL 超过上限 2.0", [sentence(8, "肌酐 3.1 mg/dL。")]),
    ], missing: [] } });
  // 3: only a score, a trial whose record had no eligibility text.
  await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(3), mode: "fit", fit: 61, confidence: 0.4, verdict: "possible", jobId: job, usage: { cost: 0.0125 },
    answer: { target: target(TRIAL(3), "没有入排原文的试验"), eligibilitySource: "none", reasons: { eligible: [], ineligible: [], missing: [], rationale: "依据标题和疾病判断，方向相合。" } } });
  // 4 failed twice over (the fit stage and nothing else) with an internal code; 5 failed for a registry; 6 has not been tried.
  await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(4), mode: "fit", status: "failed", errorCode: "vcr_match_judge_timeout", jobId: job, usage: { cost: 0.01 },
    answer: { target: target(TRIAL(4), "超时的试验") } });
  await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(5), mode: "fit", status: "failed", errorCode: "registry_not_found", jobId: job, usage: {}, answer: { target: { kind: "candidate_trial", id: TRIAL(5), registry: "clinicaltrials.gov", registryId: TRIAL(5) } } });

  const read = await call("owner", "GET", `${S()}/matching/judged?direction=patient_to_trial&subjectKey=${subjectKey}`);
  assert.equal(read.status, 200, read.text);
  const page = read.body.data;
  assert.equal(page.held, true);
  // Done 3 of 6 asked, 2 failed, 1 still waiting; the job is out, so the page says it is running.
  assert.deepEqual([page.progress.total, page.progress.finished, page.progress.failed, page.progress.waiting, page.progress.state], [6, 3, 2, 1, "running"]);
  assert.equal(page.progress.jobId, job);
  assert.equal(page.progress.cost.ceiling, 1.5);
  assert.ok(Math.abs(page.progress.cost.spent - 0.09) < 1e-9, `spent ${page.progress.cost.spent}`);
  // The order: what is not disqualified first, by score; the disqualified last.
  assert.deepEqual(page.trials.map((trial) => trial.registryId), [TRIAL(1), TRIAL(3), TRIAL(2)]);
  assert.deepEqual(page.trials.map((trial) => trial.verdictLabel), ["可能符合", "可能符合", "不符合"]);
  const first = page.trials[0];
  assert.deepEqual([first.fit, first.fitLevel, first.fitLabel, first.confidenceLabel], [92, "high", "高", "较高"]);
  assert.deepEqual(first.counts, { support: 1, against: 0, silent: 2, open: 2, notApplicable: 0 }, "an unanswered clause is open beside the one the model left to confirm");
  assert.equal(first.why, "近 4 周的头颅 MRI 报告", "a trial still to settle says what is open");
  assert.equal(first.status, "招募中");
  assert.equal(first.phase, "II 期");
  assert.match(first.statusAsOf, /^\d{4}-\d{2}-\d{2}$/u, "the registry's word has its day");
  assert.equal(first.url, "https://clinicaltrials.gov/study/NCT00000001");
  assert.equal(page.trials[2].why, "肌酐 3.1 mg/dL 超过上限 2.0", "a no says the stated conflict");
  assert.equal(page.trials[1].eligibilityNote, "未取到入排原文，依据标题和疾病判断");
  assert.equal(page.trials[1].counts, null, "a pair with no clause rows has no clause counts, and a missing count is not a zero");
  assert.equal(page.trials[1].why, "依据标题和疾病判断，方向相合。");
  // The failures: two pairs, each with its words and none with its code.
  assert.equal(page.failed.count, 2);
  assert.deepEqual(page.failed.listed.map((entry) => [entry.registryId, entry.reason]).sort(), [[TRIAL(4), "模型回答超时"], [TRIAL(5), "登记库里没有这个登记号"]]);
  assert.doesNotMatch(read.text, /vcr_match_judge_|registry_not_found/u, "no internal code reaches the page");
  // The chosen trial opens into three groups and the clause table, without the note repeated.
  const open = page.selected;
  assert.equal(open.registryId, TRIAL(1));
  assert.deepEqual(Object.keys(open.groups), ["support", "open"], "a group with nothing in it is not there");
  assert.deepEqual(open.groups.support, ["确诊 EGFR 19del 的 IV 期肺腺癌"]);
  assert.deepEqual(open.clauses.map((entry) => [entry.number, entry.stance, entry.display]), [[1, "support", "符合"], [2, "silent", "未见记载，按符合"], [3, "silent", "未见记载，按未排除"], [4, "open", "未见记载，需确认"], [5, "open", "模型没有判断这一条"]]);
  assert.equal(open.clauses[1].evidence.length, 0, "a clause with no evidence has no quotation");
  assert.doesNotMatch(JSON.stringify(open.clauses[1]), /sentence|quote/iu);
  // The evidence is read again under the viewer, and a sentence of a document the study does not hold is not shown: counted, not quoted.
  assert.deepEqual(open.clauses[0].evidence, []);
  assert.equal(open.clauses[0].evidenceHidden, 1);
  assert.equal(open.withheld, 1);

  // Another trial, asked for by name.
  const second = (await call("owner", "GET", `${S()}/matching/judged?direction=patient_to_trial&subjectKey=${subjectKey}&target=${TRIAL(3)}`)).body.data;
  assert.equal(second.selected.registryId, TRIAL(3));
  assert.deepEqual(second.selected.groups, {}, "a pair with nothing to say in groups says so by having none");
  assert.equal(second.selected.summary, "依据标题和疾病判断，方向相合。");
  assert.equal(second.selected.eligibilityNote, "未取到入排原文，依据标题和疾病判断");

  // A patient nobody judged is not an error and not a result: `held` is false, and the page may show what it showed before.
  const nobody = (await call("owner", "GET", `${S()}/matching/judged?direction=patient_to_trial&subjectKey=P-9999`)).body.data;
  assert.deepEqual([nobody.held, nobody.trials.length, nobody.progress.state, nobody.selected], [false, 0, "idle", null]);
});

test("when the job is over, a patient with trials left over is stopped, not finished, and the rest can be continued with the settings it ran under", options, async () => {
  const subjectKey = "P-0192";
  await db().query(`UPDATE evimed_vcr.jobs SET state = 'failed', finished_at = now() WHERE study_id = $1`, [study.id]);
  const page = (await call("owner", "GET", `${S()}/matching/judged?direction=patient_to_trial&subjectKey=${subjectKey}`)).body.data;
  assert.deepEqual([page.progress.state, page.progress.finished, page.progress.failed, page.progress.waiting], ["stopped", 3, 2, 1]);

  let started = null;
  context.app.vcr.service.packages.matchJudge = { start: async (/** @type {any} */ _study, /** @type {any} */ selection, /** @type {any} */ meta) => { started = { selection, meta }; return { action: "start", jobId: "job_next", state: "queued", estimate: { cost: 0.5 } }; } };
  const resumed = await call("owner", "POST", `${S()}/matching/judge`, { direction: "patient_to_trial", subjectKey, resume: true });
  assert.equal(resumed.status, 201, resumed.text);
  assert.deepEqual(started.selection.registryIds.sort(), [TRIAL(4), TRIAL(5), TRIAL(6)], "the failed and the never tried, not the three that were judged");
  assert.deepEqual([started.selection.fit, started.selection.topK, started.selection.thinking], [true, 20, "high"], "the same settings, so the judged pairs are found in the ledger");
  assert.equal(started.meta.actor, "page");

  // Nothing left is a plain refusal, not an empty job.
  for (const n of [4, 5]) await save(study.id, { subjectKey, targetKind: "candidate_trial", targetId: TRIAL(n), mode: "fit", fit: 40, confidence: 0.5, verdict: "insufficient", usage: {}, answer: { target: target(TRIAL(n), `第 ${n} 个`) } });
  await db().query(`UPDATE evimed_vcr.jobs SET scenario = jsonb_set(scenario, '{trials}', (scenario -> 'trials') - 5) WHERE study_id = $1`, [study.id]);
  const none = await call("owner", "POST", `${S()}/matching/judge`, { direction: "patient_to_trial", subjectKey, resume: true });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "vcr_match_judge_nothing_to_resume");
  // A patient's trials are the ones a search found: the page names none of them.
  const named = await call("owner", "POST", `${S()}/matching/judge`, { direction: "patient_to_trial", subjectKey });
  assert.equal(named.status, 400);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// One protocol, five thousand people
// ---------------------------------------------------------------------------------------------------------------------------------

const PROTOCOL = "prt_scale";
/** What the SQL below writes for person i: the label and basis of each of twelve clauses. */
function mixOf(i) {
  const rows = Array.from({ length: 12 }, (_, at) => ({ number: at + 1, label: at < 6 ? "included" : "not_excluded", basis: "stated" }));
  const pick = i % 5;
  if (pick === 0) rows[7] = { number: 8, label: "excluded", basis: "stated" };
  if (pick === 1) rows[8] = { number: 9, label: "not_excluded", basis: "silent" };
  if (pick === 2) rows[9] = { number: 10, label: "not_enough_information", basis: "silent" };
  if (pick === 4) rows[10] = { number: 11, label: "excluded", basis: "silent" };
  return rows;
}
const fitOf = (i) => (i % 11 === 0 ? 30 : 90);

test("five thousand people are one page: the tallies equal the domain's verdict over every person, a filter and a page cut the list, and the funnel counts each clause", options, async (t) => {
  await db().query(`INSERT INTO evimed_vcr.match_judgments (id, study_id, user_id, subject_key, target_kind, target_id, target_hash, document_hash, mode, prompt_version, model, thinking, producer, status,
        fit, confidence, verdict, answer, usage, document_ids, job_id, created_at, updated_at)
      SELECT 'mjd_scale' || i, $1, $3, 'P-' || lpad(i::text, 5, '0'), 'protocol_version', $2, 'th', 'dh' || i, 'criteria', 'criteria-2', 'deepseek-flash', 'high', 'job', 'done',
        CASE WHEN i % 11 = 0 THEN 30 ELSE 90 END, 0.7, 'possible',
        jsonb_build_object('target', jsonb_build_object('kind', 'protocol_version', 'id', $2::text, 'title', '规模测试方案'), 'eligibilitySource', 'protocol',
          'rows', (SELECT jsonb_agg(jsonb_build_object('number', n, 'kind', CASE WHEN n <= 6 THEN 'inclusion' ELSE 'exclusion' END, 'clause', '条款 ' || n,
              'label', CASE WHEN n = 8 AND i % 5 = 0 THEN 'excluded' WHEN n = 10 AND i % 5 = 2 THEN 'not_enough_information' WHEN n = 11 AND i % 5 = 4 THEN 'excluded' WHEN n <= 6 THEN 'included' ELSE 'not_excluded' END,
              'basis', CASE WHEN (n = 9 AND i % 5 = 1) OR (n = 10 AND i % 5 = 2) OR (n = 11 AND i % 5 = 4) THEN 'silent' ELSE 'stated' END,
              'reason', '第 ' || n || ' 条的理由', 'sentenceIds', jsonb_build_array(n),
              'evidence', CASE WHEN (n = 9 AND i % 5 = 1) OR (n = 10 AND i % 5 = 2) OR (n = 11 AND i % 5 = 4) THEN '[]'::jsonb
                ELSE jsonb_build_array(jsonb_build_object('sentenceId', n, 'text', CASE WHEN i = 2 AND n = 1 THEN '=cmd|calc 的一句话' ELSE repeat('病历里的一句话，', 12) END, 'start', 0, 'end', 10, 'documentId', 'doc_' || i)) END)
              ORDER BY n) FROM generate_series(1, 12) n),
          'missing', '[]'::jsonb),
        '{"cost": 0.0004, "currency": "CNY"}'::jsonb, '[]'::jsonb, NULL, now() - (i || ' seconds')::interval, now() - (i || ' seconds')::interval
      FROM generate_series(1, ${PEOPLE}) i`, [study.id, PROTOCOL, accounts.owner]);
  await insertJob(study.id, { direction: "trial_to_patient", protocolVersionId: PROTOCOL, subjects: Array.from({ length: PEOPLE + 40 }, (_, at) => `P-${String(at + 1).padStart(5, "0")}`), fit: true, topK: 20, thinking: "high", estimate: { cost: 12.5, currency: "CNY" } }, "succeeded");
  // Another study's rows under the same keys must not show here.
  await db().query(`INSERT INTO evimed_vcr.match_judgments (id, study_id, user_id, subject_key, target_kind, target_id, target_hash, document_hash, mode, prompt_version, model, thinking, producer, status, fit, answer)
    VALUES ('mjd_other', $1, $2, 'P-00001', 'protocol_version', $3, 'th', 'dh', 'criteria', 'criteria-2', 'm', 'high', 'job', 'done', 99, '{"rows": [], "missing": []}'::jsonb)`, [other.id, accounts.owner, PROTOCOL]);

  const expected = { eligible: 0, possible: 0, insufficient: 0, ineligible: 0 };
  for (let i = 1; i <= PEOPLE; i += 1) expected[trialVerdict({ fit: fitOf(i), criteria: mixOf(i), missing: [] }).verdict] += 1;
  assert.ok(Object.values(expected).every((count) => count > 0), `the mix covers all four: ${JSON.stringify(expected)}`);

  const started = Date.now();
  const read = await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&limit=25`);
  const took = Date.now() - started;
  assert.equal(read.status, 200, read.text);
  t.diagnostic(`five thousand people read in ${took} ms`);
  assert.ok(took < 15_000, `five thousand people read in ${took} ms`);
  const page = read.body.data;
  assert.deepEqual(page.tallies, expected, "the database's counts and the domain's verdict agree for every person");
  assert.equal(page.total, PEOPLE);
  assert.equal(page.people.length, 25);
  assert.equal(page.more, true);
  // The order: eligible first, by score, then the keys.
  assert.deepEqual(page.people.slice(0, 3).map((person) => person.verdict), ["eligible", "eligible", "eligible"]);
  assert.equal(page.progress.total, PEOPLE + 40, "forty people were asked for and have no row yet: they are waiting, and the page counts them");
  assert.deepEqual([page.progress.finished, page.progress.waiting, page.progress.state], [PEOPLE, 40, "stopped"]);
  assert.equal(page.progress.cost.ceiling, 12.5);
  assert.ok(Math.abs(page.progress.cost.spent - 0) < 1, "the rows carry no job id here, so nothing is claimed as this job's");
  // A page past the first, and a filter.
  const last = (await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&offset=4990&limit=25`)).body.data;
  assert.equal(last.people.length, 10);
  assert.equal(last.more, false);
  for (const verdict of ["eligible", "possible", "insufficient", "ineligible"]) {
    const filtered = (await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&verdict=${verdict}&limit=100`)).body.data;
    assert.equal(filtered.total, expected[verdict], verdict);
    assert.ok(filtered.people.every((person) => person.verdict === verdict));
  }
  const bad = await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&verdict=nonsense`);
  assert.equal(bad.status, 400);
  // The row of one person: counts and the one line why.
  const ineligible = (await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&verdict=ineligible&limit=1`)).body.data.people[0];
  assert.deepEqual(ineligible.counts, { support: 11, against: 1, silent: 0, open: 0, notApplicable: 0 });
  assert.equal(ineligible.why, "第 8 条的理由");
  // The funnel: for each clause, who it satisfies, disqualifies, finds silent, leaves open — the clause that loses the most people first.
  assert.equal(page.clauses.judgedPeople, PEOPLE);
  const count = (predicate) => { let n = 0; for (let i = 1; i <= PEOPLE; i += 1) if (predicate(i)) n += 1; return n; };
  const row8 = page.clauses.rows[0];
  assert.deepEqual([row8.number, row8.kind, row8.clause, row8.against, row8.support], [8, "exclusion", "条款 8", count((i) => i % 5 === 0), PEOPLE - count((i) => i % 5 === 0)]);
  const row9 = page.clauses.rows.find((entry) => entry.number === 9);
  assert.deepEqual([row9.silent, row9.support, row9.against, row9.open], [count((i) => i % 5 === 1), PEOPLE - count((i) => i % 5 === 1), 0, 0]);
  const row10 = page.clauses.rows.find((entry) => entry.number === 10);
  assert.equal(row10.open, count((i) => i % 5 === 2));
  const row11 = page.clauses.rows.find((entry) => entry.number === 11);
  assert.deepEqual([row11.open, row11.against], [count((i) => i % 5 === 4), 0], "a silence read against the person is open, not a disqualifier");
  assert.deepEqual(page.clauses.rows.map((entry) => entry.number).slice(0, 4), [8, 9, 10, 11], "the clause that disqualifies the most first, then the ones left silent or open, then the rest in the protocol's order");
  // One person opened: the same clause table, and a person of another study is not found under the same key.
  const opened = (await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&subjectKey=P-00005`)).body.data.selected;
  assert.equal(opened.subjectKey, "P-00005");
  assert.equal(opened.clauses.length, 12);
  assert.equal(opened.clauses[7].stance, "against");
  // The study B read is its own.
  const mine = (await call("owner", "GET", `/api/vcr/studies/${other.id}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}`)).body.data;
  assert.equal(mine.total, 1);
  assert.equal(mine.people[0].fit, 99);
});

test("a person who withdrew is in no list, funnel or file", options, async () => {
  const before = (await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&limit=1`)).body.data;
  await db().query(`INSERT INTO evimed_vcr.subject_withdrawals (study_id, subject_key, withdrawn_by, detail) VALUES ($1, 'P-00001', $2, '{}'::jsonb)`, [study.id, accounts.owner]);
  const after = (await call("owner", "GET", `${S()}/matching/judged?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&limit=1`)).body.data;
  assert.equal(after.total, before.total - 1);
  assert.equal(after.clauses.judgedPeople, before.clauses.judgedPeople - 1);
  const file = await call("owner", "GET", `${S()}/matching/export?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&kind=pairs&format=csv`);
  assert.doesNotMatch(file.text, /P-00001,/u);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------------------------------------------------------------

test("the clause file of five thousand people is all of them, Excel-safe, and was loaded a few pairs at a time", options, async (t) => {
  const reader = context.app.vcr.matchResults;
  const sizes = [];
  const original = reader.judgments.byIds.bind(reader.judgments);
  reader.judgments.byIds = async (/** @type {string} */ studyId, /** @type {string[]} */ ids) => { sizes.push(ids.length); return original(studyId, ids); };
  try {
    const file = await call("owner", "GET", `${S()}/matching/export?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&kind=clauses&format=csv`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /^text\/csv/u);
    assert.match(file.headers.get("content-disposition") ?? "", /attachment; filename="matching-protocol-clauses-\d{4}-\d{2}-\d{2}\.csv"/u);
    assert.equal(file.text.charCodeAt(0), 0xFEFF, "a byte order mark, so Excel reads the Chinese");
    const lines = file.text.slice(1).split("\r\n");
    assert.equal(lines.at(-1), "");
    assert.equal(lines[0], "患者,对象,登记号,标题,结论,条款编号,类型,条款原文,判定,有无原文依据,理由,依据句号,依据原文");
    // 4,999 people (one withdrew) by twelve clauses, plus the header; quoted cells hold no line breaks of ours.
    assert.equal(lines.length - 2, (PEOPLE - 1) * 12);
    assert.ok(file.text.includes("'=cmd|calc"), "a sentence that starts with = is text");
    assert.ok(!/(^|,)=cmd/u.test(file.text), "and is not left as a formula");
    t.diagnostic(`${file.text.length} characters, ${sizes.length} chunks of at most ${Math.max(...sizes)}`);
    assert.ok(Math.max(...sizes) <= 200, `whole answers were loaded ${Math.max(...sizes)} at a time`);
    assert.ok(sizes.length >= 40, `in ${sizes.length} chunks`);
  } finally { reader.judgments.byIds = original; }
});

test("the pair file in both formats, and a patient's file, carry every row and the verdict in words", options, async () => {
  const csv = await call("owner", "GET", `${S()}/matching/export?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&kind=pairs&format=csv`);
  const lines = csv.text.slice(1).split("\r\n");
  assert.equal(lines.length - 2, PEOPLE - 1);
  assert.equal(lines[0], "患者,对象,登记号,标题,结论,匹配度（0-100）,匹配等级,把握度,满足,不满足,未见记载,待查,不适用,理由,判定方式,判定时间,依据已更新");
  assert.match(lines[1], /^P-0000\d,本研究方案,,规模测试方案,/u);
  const json = await call("owner", "GET", `${S()}/matching/export?direction=trial_to_patient&protocolVersionId=${PROTOCOL}&kind=pairs&format=json`);
  assert.match(json.headers.get("content-type") ?? "", /^application\/json/u);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.schema, "evimed-matching-export/1");
  assert.equal(parsed.rows.length, PEOPLE - 1);
  assert.deepEqual(Object.keys(parsed.rows[0]).sort(), ["basisChanged", "confidence", "counts", "fit", "fitLevel", "judgedAt", "producer", "reason", "subjectKey", "target", "verdict"]);
  const clauses = JSON.parse((await call("owner", "GET", `${S()}/matching/export?direction=patient_to_trial&subjectKey=P-0192&kind=clauses&format=json`)).text);
  assert.ok(clauses.rows.length >= 5);
  assert.deepEqual(Object.keys(clauses.rows[0].clause).sort(), ["basis", "display", "label", "number", "reason", "sentences", "stance", "text", "kind"].sort());
  const patient = await call("owner", "GET", `${S()}/matching/export?direction=patient_to_trial&subjectKey=P-0192&kind=pairs&format=csv`);
  const trials = patient.text.slice(1).split("\r\n").filter(Boolean).slice(1);
  assert.deepEqual(trials.map((line) => line.split(",")[2]).sort(), [TRIAL(1), TRIAL(2), TRIAL(3), TRIAL(4), TRIAL(5)], "every judged trial of the patient, and not the one nobody judged");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Who may
// ---------------------------------------------------------------------------------------------------------------------------------

test("the module's usual authorization: a stranger finds nothing, a viewer reads but may not start or download, and the ability each route names is the one asked", options, async () => {
  const read = `${S()}/matching/judged?direction=patient_to_trial&subjectKey=P-0192`;
  const file = `${S()}/matching/export?direction=patient_to_trial&subjectKey=P-0192&kind=pairs&format=csv`;
  const judge = [`${S()}/matching/judge`, { direction: "trial_to_patient", protocolVersionId: PROTOCOL }];
  // Another account: the study does not exist for it, on every route.
  for (const [method, route, body] of [["GET", read], ["GET", file], ["POST", judge[0], judge[1]]]) {
    const answer = await call("stranger", method, route, body);
    assert.equal(answer.status, 404, `${method} ${route}`);
    assert.equal(answer.body.code, "vcr_study_not_found");
  }
  // A viewer reads; the start and the file need more.
  assert.equal((await call("viewer", "GET", read)).status, 200);
  assert.equal((await call("viewer", "GET", file)).status, 403);
  assert.equal((await call("viewer", "POST", judge[0], judge[1])).status, 403);
  // A clinical reviewer may export, but a file of patient evidence also needs patient-level access, which that role does not hold.
  assert.equal((await call("clinician", "GET", file)).status, 403);
  assert.equal((await call("clinician", "POST", judge[0], judge[1])).status, 403);
  // A data manager runs and reads patient-level data, but does not export.
  assert.equal((await call("datamanager", "GET", file)).status, 403);
  let selection = null;
  context.app.vcr.service.packages.matchJudge = { start: async (/** @type {any} */ _study, /** @type {any} */ chosen) => { selection = chosen; return { action: "start", jobId: "job_dm", state: "queued", estimate: { cost: 0.5, pairs: 1 } }; } };
  const started = await call("datamanager", "POST", judge[0], judge[1]);
  assert.equal(started.status, 201, started.text);
  assert.deepEqual(selection, { direction: "trial_to_patient", protocolVersionId: PROTOCOL });
  // The owner holds both.
  assert.equal((await call("owner", "GET", file)).status, 200);
  // Closed words, bounded ids.
  assert.equal((await call("owner", "GET", `${S()}/matching/export?direction=patient_to_trial&subjectKey=P-0192&format=xml`)).status, 400);
  assert.equal((await call("owner", "GET", `${S()}/matching/export?direction=patient_to_trial&subjectKey=P-0192&kind=everything`)).status, 400);
  assert.equal((await call("owner", "GET", `${S()}/matching/judged?direction=sideways`)).status, 400);
  assert.equal((await call("owner", "GET", `${S()}/matching/judged?direction=patient_to_trial&subjectKey=${encodeURIComponent("a b")}`)).status, 400);
  assert.equal((await call("owner", "POST", judge[0], { direction: "trial_to_patient", extra: 1 })).status, 400);
  // Asked for nothing in particular, the page says where the newest work is.
  const latest = (await call("viewer", "GET", `${S()}/matching/judged`)).body.data;
  assert.equal(latest.available, true);
  assert.ok(["patient_to_trial", "trial_to_patient"].includes(latest.latest.direction));
  const bare = await makeStudy("没有判定");
  const empty = (await call("owner", "GET", `/api/vcr/studies/${bare.id}/matching/judged`)).body.data;
  assert.equal(empty.latest, null);
  // A study with no protocol version has nothing judged on one: a page with nothing on it, not a missing route; starting or downloading one is the 404.
  const none = await call("owner", "GET", `/api/vcr/studies/${bare.id}/matching/judged?direction=trial_to_patient`);
  assert.equal(none.status, 200, none.text);
  assert.deepEqual([none.body.data.held, none.body.data.total, none.body.data.progress.state], [false, 0, "idle"]);
  assert.equal((await call("owner", "GET", `/api/vcr/studies/${bare.id}/matching/export?direction=trial_to_patient`)).status, 404);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// What the browser reads
// ---------------------------------------------------------------------------------------------------------------------------------

const FIXTURES = new URL("./fixtures/vcr-views/judged/", import.meta.url);

/** A fixture's text: ids and instants that differ from run to run made the same, the way `vcrViews.integration.test.mjs` does it. @param {unknown} value @param {Record<string, string>} names */
function normalize(value, names) {
  let text = JSON.stringify(value, null, 2);
  for (const [from, to] of Object.entries(names)) text = text.replaceAll(from, to);
  text = text.replace(/\b(sfl|job|std|mjd)_[0-9a-z]{10,22}\b/g, (match) => `${match.slice(0, 3)}_fixed`)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "2026-11-04T08:00:00.000Z")
    .replace(/"statusAsOf": "\d{4}-\d{2}-\d{2}"/g, '"statusAsOf": "2026-11-04"');
  return `${text}\n`;
}

test("the pages the browser reads are the fixtures the web tests draw from: a patient's trials as the job fills them in, and a protocol's people", options, async () => {
  const seeded = await seedJudged({ app: context.app, call, owner: accounts.owner }, "给浏览器的页面");
  const base = `/api/vcr/studies/${seeded.study.id}/matching/judged`;
  // The key and its short name are one fixed name in a fixture: the web tests that must tell them apart say a label of their own.
  const names = { [seeded.patient]: "P-0192", [vcrSubjectLabel(seeded.patient)]: "P-0192", [seeded.document]: "sfl_fixed", [seeded.study.id]: "std_fixed", [seeded.protocolId]: "prt_screen" };
  const read = async (/** @type {string} */ query) => { const answer = await call("owner", "GET", `${base}?${query}`); assert.equal(answer.status, 200, answer.text); return answer.body.data; };
  const pages = {
    "patient-running.json": await read(`direction=patient_to_trial&subjectKey=${seeded.patient}`),
    "patient-eligible.json": await read(`direction=patient_to_trial&subjectKey=${seeded.patient}&target=${trialId(7)}`),
    "patient-disqualified.json": await read(`direction=patient_to_trial&subjectKey=${seeded.patient}&target=${trialId(2)}`),
    "patient-no-eligibility.json": await read(`direction=patient_to_trial&subjectKey=${seeded.patient}&target=${trialId(3)}`),
    "protocol.json": await read(`direction=trial_to_patient&protocolVersionId=${seeded.protocolId}`),
    "protocol-person.json": await read(`direction=trial_to_patient&protocolVersionId=${seeded.protocolId}&subjectKey=${seeded.patient}`),
    "protocol-ineligible.json": await read(`direction=trial_to_patient&protocolVersionId=${seeded.protocolId}&verdict=ineligible`),
  };
  // What the shapes promise, before they are written down.
  const running = pages["patient-running.json"];
  // Seven trials were asked for; the study's own protocol was judged for her as well, and stands in the same list as the study's.
  assert.deepEqual([running.progress.total, running.progress.finished, running.progress.failed, running.progress.waiting, running.progress.state], [8, 5, 2, 1, "running"]);
  assert.deepEqual(running.trials.map((trial) => trial.registryId ?? trial.id), [trialId(1), seeded.protocolId, trialId(7), trialId(3), trialId(2)]);
  const opened = pages["patient-running.json"].selected;
  const sentences = sentencesOf();
  // The record is read again under the reader, and its sentences stand where the job found them: the note is the one stored, and the first clause cites its first sentence.
  assert.equal(opened.clauses[0].evidence[0].text, sentences[0].text);
  assert.equal(NOTE.slice(opened.clauses[0].evidence[0].start, opened.clauses[0].evidence[0].end), opened.clauses[0].evidence[0].text);
  assert.equal(opened.withheld, 0, "nothing the reader may not be shown");
  const protocol = pages["protocol.json"];
  assert.deepEqual(protocol.tallies, { eligible: 5, possible: 2, insufficient: 2, ineligible: 4 });
  assert.equal(protocol.progress.total, 16);
  assert.equal(protocol.failed.count, 1);
  assert.deepEqual(protocol.clauses.rows.slice(0, 2).map((row) => [row.number, row.against]), [[5, 3], [8, 1]], "brain metastasis loses the most people, then recent chemotherapy");

  const write = process.env.VCR_VIEWS_WRITE_FIXTURES === "1";
  if (write) mkdirSync(FIXTURES, { recursive: true });
  for (const [file, page] of Object.entries(pages)) {
    const text = normalize(page, names);
    if (write) writeFileSync(new URL(file, FIXTURES), text);
    else assert.equal(text, readFileSync(new URL(file, FIXTURES), "utf8"), `${file} differs from what the service now sends; regenerate with VCR_VIEWS_WRITE_FIXTURES=1 and read the diff`);
  }
});
