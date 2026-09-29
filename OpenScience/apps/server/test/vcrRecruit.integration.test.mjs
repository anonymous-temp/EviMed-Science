// The matching and referral tables against a real PostgreSQL: an assessment and
// its judgments land together or not at all, the contact gate holds on the
// locked row, a screen failure is tied to a criterion by a foreign key, and
// deleting a study takes its ledger with it.
//
// Its own database (test/helpers/geoTestDatabase.mjs creates one beside the
// configured test database): this suite counts across the schema, which no
// suite sharing a database may do.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_SCHEMA } from "../src/vcrPersistence.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { deleteVcrStudyRows } from "../src/vcrStoreBase.mjs";
import { decideReferralTransition } from "../src/vcrRecruit.mjs";
import { assessSubject } from "../src/vcrMatching.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase | null} */
let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrMatchStore | null} */
let store = null;
const run = randomBytes(4).toString("hex");
const USER = `u-${run}`;
const STUDY = `std-${run}`;
const PROTOCOL = `prt-${run}`;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrmatch");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new VcrMatchStore({ database });
  await store.ready();
  await database.query(
    `INSERT INTO ${VCR_SCHEMA}.studies (id, user_id, project_id, name) VALUES ($1, $2, $3, $4)`,
    [STUDY, USER, `prj-${run}`, "匹配与招募集成测试"]);
  await database.query(
    `INSERT INTO ${VCR_SCHEMA}.protocol_versions (id, study_id, user_id, version, title) VALUES ($1, $2, $3, 1, $4)`,
    [PROTOCOL, STUDY, USER, "v1"]);
});

after(async () => {
  if (database) await database.close?.().catch(() => {});
  await database?.pool?.end?.().catch(() => {});
  if (isolated) await isolated.drop();
});

test("criteria are written once per ordinal and re-structuring replaces rather than duplicates", options, async () => {
  const saved = await store.saveCriteria({
    studyId: STUDY, protocolVersionId: PROTOCOL, userId: USER,
    criteria: [
      { id: "crt-age", ordinal: 1, kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 18 岁",
        requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
      { id: "crt-mi", ordinal: 2, kind: "exclusion", criterionType: "time_window", sourceText: "近 6 个月内心梗者除外",
        requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } },
    ],
  });
  assert.equal(saved.length, 2);
  assert.equal(saved[1].requirement.window.months, 6);
  await store.saveCriteria({
    studyId: STUDY, protocolVersionId: PROTOCOL, userId: USER,
    criteria: [{ id: "crt-age", ordinal: 1, kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 20 岁",
      requirement: { op: "compare", variable: "age", comparator: "gte", value: 20 } }],
  });
  const listed = await store.listCriteria({ studyId: STUDY, protocolVersionId: PROTOCOL });
  assert.equal(listed.length, 2, "the second save updated line 1 rather than adding a third");
  assert.equal(listed[0].sourceText, "年龄 ≥ 20 岁");
});

test("an assessment and its judgments are written together, and re-assessing replaces the set", options, async () => {
  const assessment = assessSubject({
    studyId: STUDY, protocolVersionId: PROTOCOL, subjectKey: "S1", asOf: "2026-09-28T00:00:00Z",
    criteria: [
      { id: "crt-age", kind: "inclusion", criterionType: "demographic",
        requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
      { id: "crt-mi", kind: "exclusion", criterionType: "time_window",
        requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } },
    ],
    facts: [{ id: "age", variable: "age", value: 62, polarity: "affirmed", extractedBy: "structured", snapshot: { id: "snp-1", field: "age" } }],
  });
  assert.equal(assessment.summary, "insufficient_evidence");
  const saved = await store.saveAssessment({ assessment, userId: USER });
  const read = await store.getAssessment(saved.id);
  assert.equal(read.judgments.length, 2);
  assert.equal(read.summary, "insufficient_evidence");
  assert.equal(read.judgments.find((item) => item.criterionId === "crt-age").state, "satisfied");
  assert.equal(read.judgments.find((item) => item.criterionId === "crt-mi").state, "unknown");

  const again = await store.saveAssessment({ assessment: { ...assessment, id: saved.id, judgments: assessment.judgments.slice(0, 1) }, userId: USER });
  const reread = await store.getAssessment(again.id);
  assert.equal(reread.judgments.length, 1, "judgments are replaced, never merged");

  // A human's re-judgment sits beside the platform's, not on top of it.
  const overridden = await store.overrideJudgment({
    assessmentId: saved.id, criterionId: "crt-age", state: "not_satisfied",
    by: "dr-wang", note: "病历年龄与身份证不符", userId: USER, studyId: STUDY,
  });
  assert.equal(overridden.state, "satisfied", "the platform's own answer is still there");
  assert.equal(overridden.overrideState, "not_satisfied");
  const pairs = await store.overriddenJudgments({ studyId: STUDY });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].subjectKey, "S1");
  assert.equal(pairs[0].criterionType, "demographic");
});

test("AC-18 the contact gate holds on the locked row, and the refusal is audited", options, async () => {
  const created = await store.createReferral({
    referral: { studyId: STUDY, subjectKey: "S1", state: "candidate", actor: "coordinator-li" }, userId: USER,
  });
  const guard = (role) => (referral) => decideReferralTransition({ referral, to: "contacted", role });

  const toContactable = await store.transitionReferral({
    referralId: created.id, studyId: STUDY, to: "contactable", actor: "coordinator-li", userId: USER,
    guard: (referral) => decideReferralTransition({ referral, to: "contactable", role: "recruiter" }),
  });
  assert.equal(toContactable.ok, true);

  const refused = await store.transitionReferral({
    referralId: created.id, studyId: STUDY, to: "contacted", actor: "coordinator-li", userId: USER, guard: guard("recruiter"),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "vcr_contact_not_approved");
  const stillContactable = await store.getReferral(created.id);
  assert.equal(stillContactable.state, "contactable", "a refused transition writes nothing");

  const audited = await database.query(
    `SELECT outcome, reason FROM ${VCR_SCHEMA}.audit WHERE study_id = $1 AND action = 'vcr.referral.transition' AND outcome = 'refused'`,
    [STUDY]);
  assert.equal(audited.rows.length, 1, "the refusal is in the record, not only in the reply");
  assert.equal(audited.rows[0].reason, "vcr_contact_not_approved");

  const approved = await store.approveContact({ referralId: created.id, studyId: STUDY, approvedBy: "coordinator-li", userId: USER });
  assert.equal(approved.contactApprovedBy, "coordinator-li");
  assert.ok(approved.contactApprovedAt);
  const allowed = await store.transitionReferral({
    referralId: created.id, studyId: STUDY, to: "contacted", actor: "coordinator-li", userId: USER, guard: guard("recruiter"),
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.referral.state, "contacted");
  assert.equal(allowed.referral.contactApprovedBy, "coordinator-li");

  const events = await store.listReferralEvents(created.id);
  assert.deepEqual(events.map((event) => event.toState), ["candidate", "contactable", "contacted"]);
  assert.equal(events[2].fromState, "contactable");
});

test("CS-29 the store never writes an approver from a transition: only approveContact does, from a session's name", options, async () => {
  const referral = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-forge", actor: "x" }, userId: USER });
  await store.transitionReferral({
    referralId: referral.id, studyId: STUDY, to: "contactable", actor: "x", userId: USER,
    guard: (row) => decideReferralTransition({ referral: row, to: "contactable", role: "recruiter" }),
  });
  // A guard that lets the move through and slips an approver into its patch:
  // the state moves (the guard said so) and the name does not travel.
  const slipped = await store.transitionReferral({
    referralId: referral.id, studyId: STUDY, to: "contacted", actor: "x", userId: USER,
    guard: () => ({ ok: true, patch: { contactApprovedBy: "forged-approver" } }),
  }).catch((error) => error);
  // The schema is the second lock: a contact state without an approver is refused by the CHECK.
  assert.match(String(slipped?.message ?? ""), /vcr_referrals_contact_needs_approval|violates check/i);
  assert.equal((await store.getReferral(referral.id)).state, "contactable");
  assert.equal((await store.getReferral(referral.id)).contactApprovedBy, null);
});

test("CS-29 a referral is created at the start of the ledger whatever state the caller names", options, async () => {
  for (const state of ["contacted", "interested", "referred", "enrolled", "teleported", undefined]) {
    const created = await store.createReferral({
      referral: { studyId: STUDY, subjectKey: `S-entry-${String(state)}`, state, actor: "import" }, userId: USER,
    });
    assert.equal(created.state, "candidate", `${String(state)} is not a way in`);
    assert.equal(created.contactApprovedBy, null);
  }
  const needs = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-entry-needs", state: "needs_evidence" }, userId: USER });
  assert.equal(needs.state, "needs_evidence", "the other entry state is honoured");
  // A subject with a live referral gets it back, in the state it is in.
  const again = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-entry-needs", state: "candidate" }, userId: USER });
  assert.equal(again.id, needs.id);
  assert.equal(again.state, "needs_evidence", "creating again never resets a referral");
});

test("CS-29 approveContact is study-scoped, state-guarded and idempotent", options, async () => {
  const referral = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-approve", actor: "x" }, userId: USER });
  assert.equal(await store.approveContact({ referralId: referral.id, studyId: "std-of-another-study", approvedBy: "li", userId: USER }), null,
    "another study's id finds nothing");
  const first = await store.approveContact({ referralId: referral.id, studyId: STUDY, approvedBy: "li", userId: USER });
  assert.equal(first.contactApprovedBy, "li");
  const stamp = String(first.contactApprovedAt);
  const second = await store.approveContact({ referralId: referral.id, studyId: STUDY, approvedBy: "wang", userId: USER });
  assert.equal(second.contactApprovedBy, "li", "the first name stands");
  assert.equal(String(second.contactApprovedAt), stamp, "and its timestamp does not move");
  const approvals = await database.query(
    `SELECT count(*)::int AS n FROM ${VCR_SCHEMA}.audit WHERE object = $1 AND action = 'vcr.referral.contact_approved'`, [referral.id]);
  assert.equal(approvals.rows[0].n, 1, "one act, one audit row");
  await assert.rejects(() => store.approveContact({ referralId: referral.id, studyId: STUDY, approvedBy: "  ", userId: USER }), TypeError);

  // A withdrawn referral has no approval to record.
  const gone = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-approve-gone", actor: "x" }, userId: USER });
  await store.transitionReferral({
    referralId: gone.id, studyId: STUDY, to: "withdrawn", actor: "x", userId: USER,
    guard: (row) => decideReferralTransition({ referral: row, to: "withdrawn", role: "recruiter" }),
  });
  await assert.rejects(() => store.approveContact({ referralId: gone.id, studyId: STUDY, approvedBy: "li", userId: USER }),
    { status: 409, code: "vcr_referral_transition_invalid" });
});

test("a transition finds a referral inside its own study only", options, async () => {
  const referral = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-scope", actor: "x" }, userId: USER });
  const wrong = await store.transitionReferral({
    referralId: referral.id, studyId: "std-of-another-study", to: "contactable", actor: "x", userId: USER, guard: () => ({ ok: true }),
  });
  assert.deepEqual([wrong.ok, wrong.code], [false, "vcr_referral_not_found"]);
  assert.equal((await store.getReferral(referral.id)).state, "candidate");
  await assert.rejects(() => store.transitionReferral({ referralId: referral.id, to: "contactable", actor: "x", userId: USER, guard: () => ({ ok: true }) }),
    TypeError, "a move with no study named is a programming error, not a lookup by id alone");
});

test("PB-32 the schema refuses a contact state without a named approver", options, async () => {
  const referral = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-check", actor: "x" }, userId: USER });
  for (const state of ["contacted", "interested", "referred", "site_responded", "screening", "enrolled", "screen_failed"]) {
    await assert.rejects(
      () => database.query(`UPDATE ${VCR_SCHEMA}.referrals SET state = $2 WHERE id = $1`, [referral.id, state]),
      /vcr_referrals_contact_needs_approval/, `${state} without an approver`);
  }
  // Every state that needs no approval is untouched by it.
  for (const state of ["needs_evidence", "contactable", "withdrawn", "candidate"]) {
    await database.query(`UPDATE ${VCR_SCHEMA}.referrals SET state = $2 WHERE id = $1`, [referral.id, state]);
  }
  await database.query(`UPDATE ${VCR_SCHEMA}.referrals SET state = 'contacted', contact_approved_by = 'li' WHERE id = $1`, [referral.id]);
});

test("a screen failure is tied to a criterion by a foreign key and counted by it", options, async () => {
  const referral = await store.createReferral({
    referral: { studyId: STUDY, subjectKey: "S2", state: "candidate", actor: "coordinator-li" }, userId: USER,
  });
  for (const to of ["contactable", "contacted", "interested", "referred", "site_responded", "screening"]) {
    if (to === "contacted") await store.approveContact({ referralId: referral.id, studyId: STUDY, approvedBy: "coordinator-li", userId: USER });
    const moved = await store.transitionReferral({
      referralId: referral.id, studyId: STUDY, to, actor: "coordinator-li", userId: USER,
      guard: (current) => decideReferralTransition({ referral: current, to, role: "recruiter" }),
    });
    assert.equal(moved.ok, true, `${to}: ${moved.code ?? ""}`);
  }
  const failed = await store.transitionReferral({
    referralId: referral.id, studyId: STUDY, to: "screen_failed", actor: "site-a", userId: USER, note: "中心复核不通过",
    guard: (current) => decideReferralTransition({
      referral: current, to: "screen_failed", role: "recruiter",
      patch: { screenFailCriterionId: "crt-mi", screenFailReason: "近 3 个月心梗" },
    }),
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.referral.screenFailCriterionId, "crt-mi");

  const counts = await store.screenFailureCounts(STUDY);
  assert.equal(counts.length, 1);
  assert.equal(counts[0].criterionId, "crt-mi");
  assert.equal(counts[0].failures, 1);
  assert.equal(counts[0].sourceText, "近 6 个月内心梗者除外");

  // A criterion id that is not in the protocol cannot be written at all.
  await assert.rejects(
    () => database.query(`UPDATE ${VCR_SCHEMA}.referrals SET screen_fail_criterion_id = 'crt-nowhere' WHERE id = $1`, [referral.id]),
    /foreign key|violates/i);
});

test("PA-42 a second attempt after a screen failure is a new referral, not an overwrite of the failed one", options, async () => {
  const first = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-retry", actor: "x" }, userId: USER });
  await database.query(
    `UPDATE ${VCR_SCHEMA}.referrals SET state = 'screen_failed', contact_approved_by = 'li', screen_fail_reason = '首次筛选未通过' WHERE id = $1`, [first.id]);
  const second = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-retry", actor: "x" }, userId: USER });
  assert.notEqual(second.id, first.id, "the failed row is history, and the new attempt is its own row");
  assert.equal(second.state, "candidate");
  const failed = await store.getReferral(first.id);
  assert.equal(failed.state, "screen_failed");
  assert.equal(failed.screenFailReason, "首次筛选未通过");
  const listed = await store.listReferrals({ studyId: STUDY });
  assert.equal(listed.filter((row) => row.subjectKey === "S-retry").length, 2);
  // Two live referrals for one subject are still refused.
  await assert.rejects(() => database.query(
    `INSERT INTO ${VCR_SCHEMA}.referrals (id, study_id, user_id, subject_key) VALUES ('ref-dup-${run}', $1, $2, 'S-retry')`, [STUDY, USER]),
  /vcr_referrals_live_subject|unique/i);
});

test("sites, the funnel and follow-up episodes read back the way they were written", options, async () => {
  const site = await store.upsertSite({
    site: { studyId: STUDY, name: "某三甲医院", capacity: { slots: 12, used: 2 }, competing: ["NCT0000001"],
      accrualPrior: { alpha: 1, beta: 1, history: { enrolled: 7, monthsOpen: 9 } },
      activatedOn: "2026-05-01", verifiedAt: "2026-09-01T00:00:00Z" },
    userId: USER,
  });
  assert.equal(site.capacity.slots, 12);
  assert.equal(site.accrualPrior.history.enrolled, 7);
  const sites = await store.listSites(STUDY);
  assert.equal(sites.length, 1);

  const funnel = await store.siteFunnel(STUDY);
  assert.ok(funnel.reduce((sum, row) => sum + row.total, 0) >= 2, "the referrals so far are in the funnel");

  const episode = await store.saveFollowupEpisode({
    episode: {
      studyId: STUDY, subjectKey: "S1", kind: "study_specific",
      windowStart: "2026-03-01T00:00:00Z", windowEnd: "2026-08-14T00:00:00Z",
      observations: [{ kind: "visit", at: "2026-05-02" }],
      restricted: { treatment: { visible: false, reason: "restricted_in_trial" } },
      exitReason: "受试者要求退出",
    },
    userId: USER,
  });
  assert.equal(episode.exitReason, "受试者要求退出");
  assert.equal(episode.restricted.treatment.visible, false);
  const episodes = await store.listFollowupEpisodes({ studyId: STUDY, subjectKey: "S1" });
  assert.equal(episodes.length, 1);
});

test("CS-35 a site belongs to a study: another study never lists it and cannot overwrite it by naming its id", options, async () => {
  const other = `std-other-${run}`;
  await database.query(
    `INSERT INTO ${VCR_SCHEMA}.studies (id, user_id, project_id, name) VALUES ($1, $2, $3, $4)`, [other, `u2-${run}`, `prj2-${run}`, "另一个账号的研究"]);
  const mine = await store.upsertSite({ site: { studyId: STUDY, id: `ste-mine-${run}`, name: "我的中心" }, userId: USER });
  // Rows that used to be visible to every account: a site with no study at all.
  await database.query(
    `INSERT INTO ${VCR_SCHEMA}.sites (id, study_id, user_id, name) VALUES ($1, NULL, $2, '无研究的中心')`, [`ste-orphan-${run}`, `u2-${run}`]);
  assert.deepEqual((await store.listSites(other)).map((site) => site.name), [], "another study lists none of mine, and no study-less rows");
  assert.ok(!(await store.listSites(STUDY)).some((site) => site.id === `ste-orphan-${run}`), "a study-less row is nobody's");

  const hijack = await store.upsertSite({ site: { studyId: other, id: mine.id, name: "被改写", capacity: { slots: 999 } }, userId: `u2-${run}` });
  assert.equal(hijack, null, "naming another study's site id updates nothing and hands nothing back");
  const kept = (await store.listSites(STUDY)).find((site) => site.id === mine.id);
  assert.equal(kept.name, "我的中心");
  assert.notEqual(kept.capacity.slots, 999);
  await assert.rejects(() => store.upsertSite({ site: { name: "无研究" }, userId: USER }), TypeError, "a site names its study");
  assert.equal(await store.upsertSite({ site: { studyId: other, name: "别人的研究里的中心" }, userId: USER }), null,
    "a study that is not the caller's is not somewhere the caller writes a site");
  assert.deepEqual((await store.listSites(other)).map((site) => site.name), []);
  // A referral and a transition may name only this study's site.
  await assert.rejects(() => store.createReferral({ referral: { studyId: other, subjectKey: "S-x", siteId: mine.id }, userId: USER }),
    { status: 400, code: "vcr_payload_invalid" });
  const referral = await store.createReferral({ referral: { studyId: STUDY, subjectKey: "S-site-ok", siteId: mine.id }, userId: USER });
  assert.equal(referral.siteId, mine.id);
});

test("deleting a study takes its matching and referral rows and leaves the audit behind", options, async () => {
  const before = await database.query(
    `SELECT (SELECT count(*) FROM ${VCR_SCHEMA}.referrals WHERE study_id = $1) AS referrals,
            (SELECT count(*) FROM ${VCR_SCHEMA}.criterion_judgments j JOIN ${VCR_SCHEMA}.matching_assessments a ON a.id = j.assessment_id WHERE a.study_id = $1) AS judgments,
            (SELECT count(*) FROM ${VCR_SCHEMA}.audit WHERE study_id = $1) AS audit`, [STUDY]);
  assert.ok(Number(before.rows[0].referrals) > 0 && Number(before.rows[0].judgments) > 0 && Number(before.rows[0].audit) > 0);

  await database.transaction((client) => deleteVcrStudyRows(client, STUDY));
  const after = await database.query(
    `SELECT (SELECT count(*) FROM ${VCR_SCHEMA}.referrals WHERE study_id = $1) AS referrals,
            (SELECT count(*) FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id = $1) AS assessments,
            (SELECT count(*) FROM ${VCR_SCHEMA}.criteria WHERE study_id = $1) AS criteria,
            (SELECT count(*) FROM ${VCR_SCHEMA}.followup_episodes WHERE study_id = $1) AS episodes,
            (SELECT count(*) FROM ${VCR_SCHEMA}.audit WHERE study_id = $1) AS audit`, [STUDY]);
  assert.equal(Number(after.rows[0].referrals), 0);
  assert.equal(Number(after.rows[0].assessments), 0);
  assert.equal(Number(after.rows[0].criteria), 0);
  assert.equal(Number(after.rows[0].episodes), 0);
  assert.ok(Number(after.rows[0].audit) > 0, "the audit outlives the object it describes");
});
