// 「虚拟临研」's data plane against a real PostgreSQL and real files: what a frozen
// snapshot leaves in `evimed_vcr` (metadata, never a row), what a correction is,
// what the judge decides on the real store exactly as it does on its double, and
// what deleting a study takes with it. The intake flow end to end, the seal's
// lifecycle and the real engine are in `vcrIntake.integration.test.mjs`.
//
// Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { VCR_QUALITY_CATEGORIES } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_ACCESS_CODES, VcrAccess } from "../src/vcrAccess.mjs";
import { VCR_DATA_PLANE_CODES, VcrDataPlane } from "../src/vcrDataPlane.mjs";
import { VcrDataStore } from "../src/vcrDataStore.mjs";
import { VcrMembers } from "../src/vcrMembers.mjs";
import { vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { FIELD_MAP, cohortCsv, fingerprints, streamOf, visitsCsv } from "./helpers/vcrIntakeData.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */ let database = null;
/** @type {any} */ let isolated = null;
/** @type {VcrDataStore} */ let store;
/** @type {VcrDataPlane} */ let plane;
/** @type {VcrAccess} */ let access;
/** @type {VcrMembers} */ let members;
/** @type {string} */ let dataPlaneDir;

const OWNER = "vcr-owner";
const PARTNER = "vcr-partner";

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrdp");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new VcrDataStore({ database });
  await store.ready();
  // The data plane's own directory: outside any workspace, never mounted.
  dataPlaneDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-plane-"));
  access = new VcrAccess({ store });
  plane = new VcrDataPlane({ store, config: { vcrDataPlaneDir: dataPlaneDir }, access });
  members = new VcrMembers({ store, access });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
  if (dataPlaneDir) await fs.rm(dataPlaneDir, { recursive: true, force: true });
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

/** A study row. The study writer belongs to the orchestration package; this is its shape. */
async function seedStudy(userId = OWNER, intendedUse = "design_support") {
  const id = vcrId("study");
  await q(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, question, data_tier, intended_use)
    VALUES ($1, $2, $3, 'EV-201 二线 NSCLC', '单臂能否用外部对照', 'T1', $4)`, [id, userId, `prj_${id}`, intendedUse]);
  return id;
}

/**
 * A source of the study registered by `userId`, with the cohort and visits files
 * uploaded and the map confirmed and frozen.
 * @param {string} studyId @param {{ userId?: string, cohort?: string }} [entry]
 */
async function seedSnapshot(studyId, { userId = OWNER, cohort = cohortCsv() } = {}) {
  const source = await plane.registerSource({ userId, studyId, name: "合作方基线导出", ownerParty: "合作方医院", allowedUses: ["vcr"] });
  for (const [name, body] of [["cohort.csv", cohort], ["visits.csv", visitsCsv()]]) {
    await plane.storeUpload({ actor: userId, studyId, sourceId: source.id, name, stream: streamOf(body) });
  }
  const proposed = await plane.proposeFieldMap({ actor: userId, studyId, sourceId: source.id, columns: FIELD_MAP });
  await plane.confirmFieldMap({ actor: userId, studyId, sourceId: source.id, hash: proposed.hash });
  const frozen = await plane.freezeSnapshot({ userId, studyId, sourceId: source.id });
  return { source, ...frozen };
}

// ---------------------------------------------------------------------------
// AC-03 / AC-26: what is in the schema, and what is not
// ---------------------------------------------------------------------------

test("AC-03 a frozen snapshot holds metadata and no patient row reaches evimed_vcr", options, async () => {
  const studyId = await seedStudy();
  const { source, snapshot, profile } = await seedSnapshot(studyId);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.sha256.length, 64);
  assert.equal(snapshot.rowCount, 120);
  assert.equal(snapshot.columnCount, 11);
  assert.equal(profile.counts.findings >= 1, true, "the quality profile ran and its findings travel with the snapshot");
  assert.equal((await store.getSource(OWNER, source.id)).status, "frozen");

  // The real check: every text and json column of every table in the schema,
  // scanned for a value that only exists inside the file. A patient row one
  // join away from the model is the thing the data plane exists to prevent.
  const columns = await q(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'evimed_vcr' AND data_type IN ('text', 'jsonb', 'ARRAY') ORDER BY 1, 2`);
  assert.ok(columns.length > 50, "the scan must actually have columns to scan");
  const distinctive = fingerprints().map((value) => new RegExp(`(?<![\\w.])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`));
  let scanned = 0;
  for (const column of columns) {
    const rows = await q(`SELECT "${column.column_name}"::text AS body FROM evimed_vcr."${column.table_name}" WHERE "${column.column_name}" IS NOT NULL`);
    for (const row of rows) {
      scanned += 1;
      assert.ok(!distinctive.some((pattern) => pattern.test(String(row.body))), `${column.table_name}.${column.column_name} carries a patient-level value`);
    }
  }
  assert.ok(scanned > 100, `the scan read ${scanned} values`);
  // The bytes are in the data plane, where the metadata points, named by their hash.
  assert.match(snapshot.location, new RegExp(`^studies/${studyId}/sources/${source.id}/[a-f0-9]{64}\\.csv\\nstudies/`));
  const onDisk = path.join(dataPlaneDir, snapshot.location.split("\n")[0]);
  assert.ok((await fs.stat(onDisk)).isFile());
  assert.ok(!onDisk.includes("/workspace/") && !onDisk.includes("knowledge-base"));
});

test("AC-03 the field map records the three clocks and the missing reason, and the reader sees no path", options, async () => {
  const studyId = await seedStudy();
  const { snapshot } = await seedSnapshot(studyId);
  const maps = await store.listFieldMaps(snapshot.id);
  assert.equal(maps.length, FIELD_MAP.length);
  const byColumn = Object.fromEntries(maps.filter((map) => map.tableName === "cohort.csv").map((map) => [map.columnName, map]));
  assert.equal(byColumn.DIAG_DATE.timeKind, "occurred_at");
  assert.equal(byColumn.ARM.missingReason, "not_recorded");
  assert.equal(byColumn.PATIENT_NO.identifier, true);
  assert.equal(byColumn.PATIENT_NO.role, "subject_key");
  assert.equal(byColumn.OS_MONTHS.outcome, true);
  assert.equal(byColumn.AGE.reviewState, "reviewed", "a map a person confirmed is labelled so");
  const forModel = await plane.snapshotProfileForModel({ studyId, snapshotId: snapshot.id, principal: OWNER });
  assert.deepEqual(forModel.clocks.occurred_at, ["DIAG_DATE", "VISIT_DT"]);
  assert.equal(forModel.fieldMap.length, FIELD_MAP.length);
  assert.deepEqual(Object.keys(forModel.quality.categories).sort(), [...VCR_QUALITY_CATEGORIES].sort());
  assert.ok(!JSON.stringify(forModel).includes(dataPlaneDir), "no path of the server");
});

test("AC-03 a correction is a new snapshot, never a rewrite of the old one", options, async () => {
  const studyId = await seedStudy();
  const { source, snapshot } = await seedSnapshot(studyId);
  // The corrected file is the same name with different bytes: a new version of that file.
  const corrected = cohortCsv().replace("HZ-30003,TRT,50,F,3,", "HZ-30003,TRT,50,F,2,");
  assert.notEqual(corrected, cohortCsv());
  await plane.storeUpload({ actor: OWNER, studyId, sourceId: source.id, name: "cohort.csv", stream: streamOf(corrected) });
  const files = await store.listSourceFiles(source.id);
  assert.deepEqual(files.map((file) => file.name).sort(), ["cohort.csv", "cohort.csv", "visits.csv"]);
  // Frozen again, the snapshot takes the latest of each name and the confirmed map still means the same tables.
  const second = await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id });
  assert.equal(second.snapshot.version, 2);
  assert.notEqual(second.snapshot.sha256, snapshot.sha256);
  const named = second.snapshot.fileHashes.find((/** @type {any} */ file) => file.name === "cohort.csv");
  assert.equal(named.sha256, files.filter((file) => file.name === "cohort.csv")[1].sha256, "the corrected version");
  // Two versions of one file cannot be chosen for one snapshot.
  await assert.rejects(() => plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id, fileIds: files.filter((file) => file.name === "cohort.csv").map((file) => file.id) }),
    (error) => error.code === VCR_DATA_PLANE_CODES.payloadInvalid);
  const still = await store.getSnapshot(snapshot.id);
  assert.equal(still.sha256, snapshot.sha256, "the first snapshot is untouched");
  assert.equal((await store.listSnapshots({ sourceId: source.id })).length, 2);
  // A file a snapshot names cannot be forgotten: its bytes are that snapshot's record.
  await assert.rejects(() => plane.removeUpload({ actor: OWNER, studyId, fileId: files.find((file) => file.name === "cohort.csv").id }),
    (error) => error.code === VCR_DATA_PLANE_CODES.fileFrozen);
});

test("AC-03 the bytes a snapshot froze are the bytes it reads: a stored file changed on disk is refused by name", options, async () => {
  const studyId = await seedStudy();
  const source = await plane.registerSource({ userId: OWNER, studyId, name: "被改动的导出" });
  const { file } = await plane.storeUpload({ actor: OWNER, studyId, sourceId: source.id, name: "cohort.csv", stream: streamOf(cohortCsv()) });
  const proposed = await plane.proposeFieldMap({ actor: OWNER, studyId, sourceId: source.id, columns: FIELD_MAP.filter((entry) => entry.table === "cohort.csv") });
  await plane.confirmFieldMap({ actor: OWNER, studyId, sourceId: source.id, hash: proposed.hash });
  await fs.appendFile(path.join(dataPlaneDir, file.location), "HZ-99999,TRT,50,F,1,9.99,1,2025-01-10\n");
  await assert.rejects(() => plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id }), (error) => error.code === VCR_DATA_PLANE_CODES.fileChanged);
  assert.deepEqual(await store.listSnapshots({ studyId }), [], "nothing was frozen");
  // A snapshot needs at least one file, and a map.
  const empty = await plane.registerSource({ userId: OWNER, studyId, name: "空的" });
  await assert.rejects(() => plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: empty.id }), (error) => error.code === VCR_DATA_PLANE_CODES.fieldMapUnconfirmed);
});

test("C2-23 a batch of only bad tables refuses the call and registers nothing", options, async () => {
  const studyId = await seedStudy();
  const source = await plane.registerSource({ userId: OWNER, studyId, name: "重复受试者" });
  await plane.storeUpload({ actor: OWNER, studyId, sourceId: source.id, name: "dup.csv", stream: streamOf("PATIENT_NO,ARM\nS001,A\nS001,B\n") });
  const proposed = await plane.proposeFieldMap({ actor: OWNER, studyId, sourceId: source.id, columns: [
    { table: "dup.csv", column: "PATIENT_NO", role: "subject_key" }, { table: "dup.csv", column: "ARM", role: "arm", alias: "arm" }] });
  await plane.confirmFieldMap({ actor: OWNER, studyId, sourceId: source.id, hash: proposed.hash });
  const frozen = await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id });
  assert.deepEqual(frozen.tables.registered, []);
  await assert.rejects(() => plane.deriveAnalysisTables({ userId: OWNER, studyId, snapshotId: frozen.snapshot.id }),
    (error) => error.code === VCR_DATA_PLANE_CODES.analysisTableInvalid);
  assert.deepEqual(await store.listAnalysisTables({ studyId }), []);
  await assert.rejects(() => plane.deriveAnalysisTables({ userId: OWNER, studyId, snapshotId: "snp_nope" }), (error) => error.code === VCR_DATA_PLANE_CODES.snapshotNotFound);
});

// ---------------------------------------------------------------------------
// AC-22 / AC-32: what the model is shown of a sealed snapshot
// ---------------------------------------------------------------------------

test("AC-22 what the model is shown of a sealed snapshot is the column name and nothing else", options, async () => {
  const studyId = await seedStudy(OWNER, "specified_analysis");
  const { snapshot } = await seedSnapshot(studyId);
  assert.deepEqual(snapshot.sealedFields, ["OS_DEAD", "OS_MONTHS"]);
  const forModel = await plane.snapshotProfileForModel({ studyId, snapshotId: snapshot.id, principal: OWNER });
  const byName = Object.fromEntries(forModel.columns.filter((column) => column.table === "cohort.csv").map((column) => [column.name, column]));
  assert.deepEqual(byName.OS_MONTHS, { table: "cohort.csv", name: "OS_MONTHS", sealed: true });
  assert.equal(byName.OS_DEAD.filled, undefined, "a sealed outcome's fill rate is an event rate");
  assert.equal(byName.AGE.sealed, false);
  assert.equal(byName.AGE.densityCompleteness, 1);
  assert.deepEqual(byName.PATIENT_NO.levels, [], "the subject key is an identifier and carries no values");
  assert.deepEqual(forModel.sealedFields, ["OS_DEAD", "OS_MONTHS"]);
  for (const value of fingerprints()) assert.ok(!JSON.stringify(forModel).includes(value), `${value} reached what the model is shown`);
});

// ---------------------------------------------------------------------------
// AC-17: the judge against the real store (the double's ground truth)
// ---------------------------------------------------------------------------

test("AC-17 the real store judges cross-account, grant, window and seal exactly as the double does", options, async () => {
  const studyId = await seedStudy(OWNER, "specified_analysis");
  const otherStudy = await seedStudy("vcr-stranger");
  await members.add({ actor: OWNER, studyId, userId: PARTNER, role: "data_manager" });
  const { source, snapshot } = await seedSnapshot(studyId, { userId: PARTNER });

  // Another account's study, and one that never existed, are the same refusal.
  const real = await access.judge({ actor: "vcr-outsider", studyId: otherStudy, ability: "read" });
  const imaginary = await access.judge({ actor: "vcr-outsider", studyId: "std_nope", ability: "read" });
  assert.equal(real.code, VCR_ACCESS_CODES.studyNotFound);
  assert.equal(real.code, imaginary.code);

  // The owner is a lead; a data manager needs a grant from the partner.
  assert.equal((await access.judge({ actor: OWNER, studyId, ability: "manage_members" })).allowed, true);
  await members.add({ actor: OWNER, studyId, userId: "vcr-dm", role: "data_manager" });
  const noGrant = await access.judge({
    actor: "vcr-dm", studyId, sourceId: source.id, ability: "read_patient_level", purpose: "vcr",
  });
  assert.equal(noGrant.code, VCR_ACCESS_CODES.noGrant);

  const grant = await plane.createGrant({
    actor: PARTNER, studyId, sourceId: source.id, grantee: "role:data_manager", role: "data_manager",
    fields: ["AGE", "ARM", "OS_MONTHS", "VISIT_DT"], purposes: ["vcr"],
    windowStart: "2026-01-01T00:00:00Z", windowEnd: "2999-12-31T00:00:00Z",
  });
  const granted = await access.judge({
    actor: "vcr-dm", studyId, snapshotId: snapshot.id, ability: "read_patient_level",
    fields: ["AGE", "ARM", "OS_MONTHS", "SEX", "PATIENT_NO"], purpose: "vcr",
  });
  assert.equal(granted.allowed, true);
  assert.equal(granted.grantId, grant.id);
  assert.deepEqual(granted.fields.allowed, ["AGE", "ARM"]);
  const denied = Object.fromEntries(granted.fields.denied.map((entry) => [entry.field, entry.code]));
  assert.equal(denied.OS_MONTHS, VCR_ACCESS_CODES.fieldSealed);
  assert.equal(denied.PATIENT_NO, VCR_ACCESS_CODES.fieldIdentifying);
  assert.equal(denied.SEX, VCR_ACCESS_CODES.fieldNotGranted);

  assert.equal((await access.judge({
    actor: "vcr-dm", studyId, sourceId: source.id, ability: "read_patient_level", purpose: "geo",
  })).code, VCR_ACCESS_CODES.purposeNotGranted);

  await plane.revokeGrant({ actor: PARTNER, studyId, grantId: grant.id });
  assert.equal((await access.judge({
    actor: "vcr-dm", studyId, sourceId: source.id, ability: "read_patient_level", purpose: "vcr",
  })).code, VCR_ACCESS_CODES.noGrant, "a revoked grant authorises nothing");
  assert.equal((await store.listGrants(source.id)).length, 1, "the revoked grant is kept for the record");
  assert.ok((await store.listGrants(source.id))[0].revokedAt);
  assert.deepEqual(await store.liveGrants({ sourceId: source.id }), []);
});

test("AC-17 every judgment is on the record, allowed and refused alike", options, async () => {
  const studyId = await seedStudy();
  await access.judge({ actor: OWNER, studyId, ability: "read" });
  await access.judge({ actor: "vcr-outsider", studyId, ability: "read" });
  const trail = await store.auditTrail({ studyId, action: "access.read" });
  assert.equal(trail.length, 2);
  assert.deepEqual(trail.map((row) => row.outcome).sort(), ["denied", "ok"]);
  const refusal = trail.find((row) => row.outcome === "denied");
  assert.equal(refusal.reason, VCR_ACCESS_CODES.studyNotFound);
  assert.equal(refusal.actor, "vcr-outsider");
  assert.ok(refusal.detail.asOf, "the ledger records the instant the judgment was made for");
});

test("AC-17 members and their roles survive a round trip through the real schema", options, async () => {
  const studyId = await seedStudy();
  await members.add({ actor: OWNER, studyId, userId: "vcr-doc", role: "site" });
  await members.add({ actor: OWNER, studyId, userId: "vcr-doc", role: "clinical_reviewer" });
  const listed = await members.list({ actor: OWNER, studyId });
  const doctor = listed.find((person) => person.userId === "vcr-doc");
  assert.deepEqual(doctor.roles, ["clinical_reviewer", "site"]);
  assert.deepEqual(await store.rolesOf(studyId, "vcr-doc"), ["clinical_reviewer", "site"]);
  assert.equal((await members.remove({ actor: OWNER, studyId, userId: "vcr-doc", role: "site" })).removed, true);
  assert.deepEqual(await store.rolesOf(studyId, "vcr-doc"), ["clinical_reviewer"]);
  await assert.rejects(() => members.add({ actor: "vcr-doc", studyId, userId: "x", role: "viewer" }),
    (error) => error.status === 403);
  assert.equal((await store.auditTrail({ studyId, action: "member.add" })).length, 2);
});

test("AC-03 deleting the study takes the data-plane metadata with it and leaves the audit", options, async () => {
  const studyId = await seedStudy();
  const { source, snapshot } = await seedSnapshot(studyId);
  assert.equal((await store.listAnalysisTables({ studyId })).length, 3);
  assert.equal((await store.listSourceFiles(source.id)).length, 2);
  await q("DELETE FROM evimed_vcr.studies WHERE id = $1", [studyId]);
  assert.equal(await store.getSnapshot(snapshot.id), null, "the snapshot row goes with its study");
  assert.deepEqual(await store.listAnalysisTables({ studyId }), []);
  assert.deepEqual(await store.listSourceFiles(source.id), [], "and so do its uploaded files' rows");
  assert.equal(await store.sourceFor(source.id), null);
  const trail = await store.auditTrail({ studyId });
  assert.ok(trail.length > 0, "the audit outlives the object it describes");
  assert.ok((await fs.stat(path.join(dataPlaneDir, "studies", studyId))).isDirectory(), "the files go by the deletion path's own removal, after the rows commit");
  await plane.deleteStudyFiles(studyId);
  await assert.rejects(() => fs.stat(path.join(dataPlaneDir, "studies", studyId)));
});
