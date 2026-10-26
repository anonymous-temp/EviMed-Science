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


test("fresh schema offers no recruitment writers or tables and retains historical followup storage", options, async () => {
 for(const method of ["createReferral","approveContact","transitionReferral","upsertSite","saveFollowupEpisode"])assert.equal(typeof store[method],"undefined");
 for(const table of ["sites","referrals","referral_events"])assert.equal((await database.query("SELECT to_regclass($1) AS table",[`evimed_vcr.${table}`])).rows[0].table,null);
 await database.query(`INSERT INTO evimed_vcr.followup_episodes(id,study_id,user_id,subject_key,kind,exit_date,exit_reason)
  VALUES ('fup_history',$1,$2,'S1','study_specific','2026-10-01','original reason')`,[STUDY,USER]);
 const episodes=await store.listFollowupEpisodes({studyId:STUDY});assert.equal(episodes[0].exitDate,"2026-10-01");assert.equal(episodes[0].exitReason,"original reason");
});
test("scientific study deletion works without retired tables and retains audit", options, async()=>{
 const before=await database.query(`SELECT count(*)::int AS n FROM evimed_vcr.audit WHERE study_id=$1`,[STUDY]);
 assert.ok(before.rows[0].n>0);await database.transaction(client=>deleteVcrStudyRows(client,STUDY,USER));
 assert.equal((await database.query(`SELECT count(*)::int AS n FROM evimed_vcr.matching_assessments WHERE study_id=$1`,[STUDY])).rows[0].n,0);
 assert.equal((await database.query(`SELECT count(*)::int AS n FROM evimed_vcr.audit WHERE study_id=$1`,[STUDY])).rows[0].n,before.rows[0].n);
});
