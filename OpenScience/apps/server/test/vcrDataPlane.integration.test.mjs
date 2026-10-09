// 「虚拟临床研究」's data plane against a real PostgreSQL and real files: what a frozen
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
import { VCR_DATA_PLANE_CODES, VcrDataPlane, parseTable, pseudonymOf, sha256OfBytes, snapshotView, studyPseudonymKey, tableView } from "../src/vcrDataPlane.mjs";
import { VcrDataStore } from "../src/vcrDataStore.mjs";
import { VcrMembers } from "../src/vcrMembers.mjs";
import { vcrMatchingExecutor, vcrSubjectTableSeam } from "../src/vcrComposition.mjs";
import { vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { COHORT_SIZE, FIELD_MAP, cohortCsv, dictionaryCsv, fingerprints, patientNo, streamOf, survivalOf, visitsCsv } from "./helpers/vcrIntakeData.mjs";

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

// ---------------------------------------------------------------------------
// A snapshot's as-of and a column's own value source reach what the engine reads
// ---------------------------------------------------------------------------

/** People 1..VISIBLE were visible to the platform by 10 January; the rest only on 1 March. */
const VISIBLE = 25;
const SHARED_EARLY = "2026-01-10";
const SHARED_LATE = "2026-03-01";
/** The replay date: after the early people were shared, before the late ones. */
const REPLAY_AS_OF = "2026-02-01T00:00:00Z";

/** The baseline and visits files with the column that says when each row became visible. */
function replayFiles() {
  const cohort = cohortCsv().trimEnd().split("\n").map((line, index) => {
    if (index === 0) return `${line},SHARED`;
    return `${line},${index <= VISIBLE ? SHARED_EARLY : SHARED_LATE}`;
  }).join("\n");
  // Two visits per person, in person order: row 1 and 2 belong to person 1.
  const visits = visitsCsv().trimEnd().split("\n").map((line, index) => {
    if (index === 0) return `${line},SHARED`;
    return `${line},${Math.ceil(index / 2) <= VISIBLE ? SHARED_EARLY : SHARED_LATE}`;
  }).join("\n");
  return { "cohort.csv": `${cohort}\n`, "visits.csv": `${visits}\n` };
}

/** The intake map plus the two columns that carry the platform's own clock. */
const REPLAY_FIELD_MAP = [
  ...FIELD_MAP,
  { table: "cohort.csv", column: "SHARED", role: "other", timeKind: "visible_at" },
  { table: "visits.csv", column: "SHARED", role: "other", timeKind: "visible_at" },
];

/**
 * A source with the replay files uploaded and the map confirmed, not yet frozen.
 * @param {string} studyId @param {{ map?: any[], files?: Record<string, string>, valueSource?: string }} [entry]
 */
async function seedConfirmed(studyId, { map = REPLAY_FIELD_MAP, files = replayFiles(), valueSource = "observed" } = {}) {
  const source = await plane.registerSource({ userId: OWNER, studyId, name: "合作方回放导出", ownerParty: "合作方医院", allowedUses: ["vcr"], valueSource });
  for (const [name, body] of Object.entries(files)) await plane.storeUpload({ actor: OWNER, studyId, sourceId: source.id, name, stream: streamOf(body) });
  const proposed = await plane.proposeFieldMap({ actor: OWNER, studyId, sourceId: source.id, columns: map });
  assert.deepEqual([proposed.entryIssues, proposed.mapIssues], [[], []]);
  await plane.confirmFieldMap({ actor: OWNER, studyId, sourceId: source.id, hash: proposed.hash });
  return source;
}

/** The rows of a table the plane holds, read from its file. @param {string} location */
async function planeTable(location) {
  return parseTable(await fs.readFile(path.join(dataPlaneDir, location), "utf8"));
}

test("AC-15 a snapshot frozen as of a date hands the engine only the rows visible then, in every table and every raw file", options, async () => {
  const studyId = await seedStudy();
  const source = await seedConfirmed(studyId);
  const everyone = await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id });
  const replay = await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id, asOf: REPLAY_AS_OF });

  // The date is on the snapshot, where every later derivation reads it back.
  const stored = await store.getSnapshot(replay.snapshot.id);
  assert.equal(stored.profile.frozen.asOf, "2026-02-01T00:00:00.000Z");
  assert.equal(snapshotView(stored).asOf, "2026-02-01T00:00:00.000Z");
  assert.equal("asOf" in snapshotView(await store.getSnapshot(everyone.snapshot.id)), false, "a snapshot with no date says nothing about one");
  assert.equal((await plane.snapshotProfileForModel({ studyId, snapshotId: replay.snapshot.id, principal: OWNER })).asOf, "2026-02-01T00:00:00.000Z");
  const freezes = await store.auditTrail({ studyId, action: "snapshot.freeze" });
  assert.deepEqual(freezes.map((row) => row.detail.asOf).sort((a, b) => String(a).localeCompare(String(b))), ["2026-02-01T00:00:00.000Z", null], "the ledger says which snapshot replays which instant");

  // Row counts: what the profiler counted is what was derived is what the engine reads.
  assert.equal(replay.snapshot.rowCount, VISIBLE + 2 * VISIBLE, "the profiler's count of the replay");
  assert.equal(everyone.snapshot.rowCount, COHORT_SIZE + 2 * COHORT_SIZE);
  const byShape = (/** @type {any} */ result) => Object.fromEntries(result.tables.registered.map((/** @type {any} */ table) => [table.shape, table]));
  assert.equal(byShape(everyone).subject.rowCount, COHORT_SIZE);
  assert.equal(byShape(replay).subject.rowCount, VISIBLE);
  assert.equal(byShape(replay).events.rowCount, VISIBLE);
  assert.equal(byShape(replay).longitudinal.rowCount, 2 * VISIBLE);
  assert.equal(replay.tables.dropped.not_yet_visible, (COHORT_SIZE - VISIBLE) * 3, "each hidden person's cohort row and two visits, counted");
  assert.equal(tableView(byShape(replay).subject).asOf, "2026-02-01T00:00:00.000Z");
  assert.equal(replay.tables.asOf.files.find((/** @type {any} */ file) => file.file === "cohort.csv").hidden, COHORT_SIZE - VISIBLE);

  // The bytes: the people the platform could see, and not one value of anybody it could not.
  const key = await studyPseudonymKey(dataPlaneDir, studyId);
  const visibleIds = new Set(Array.from({ length: VISIBLE }, (_, index) => pseudonymOf(key, patientNo(index + 1))));
  const events = await planeTable(byShape(replay).events.location);
  assert.equal(events.rows.length, VISIBLE);
  assert.ok(events.rows.every((row) => visibleIds.has(row[0])), "every person in the events table was visible on the replay date");
  const eventsText = await fs.readFile(path.join(dataPlaneDir, byShape(replay).events.location), "utf8");
  for (let n = 1; n <= COHORT_SIZE; n += 1) {
    assert.equal(eventsText.includes(survivalOf(n)), n <= VISIBLE, `person ${n}'s survival time ${n <= VISIBLE ? "is" : "is not"} in the replay's events table`);
  }
  const identity = await fs.readFile(path.join(dataPlaneDir, "studies", studyId, "identity", `${replay.snapshot.id}.csv`), "utf8");
  assert.equal(parseTable(identity).rows.length, VISIBLE, "a hidden person is not in the way back from a pseudonym either");

  // The inputs the control plane builds for a job are these very files, under their own hash.
  const inputs = await plane.resolveEngineInputs({ studyId, snapshotId: replay.snapshot.id, principal: OWNER, purpose: "vcr",
    kind: "rmst", method: "comparator.rmst", endpointType: "time_to_event" });
  assert.deepEqual(inputs.map((input) => input.shape).sort(), ["events", "subject"]);
  for (const input of inputs) {
    const bytes = await fs.readFile(path.join(dataPlaneDir, input.location));
    assert.equal(sha256OfBytes(bytes), input.hash);
    assert.equal(parseTable(bytes.toString("utf8")).rows.length, VISIBLE, `the ${input.shape} table the engine opens`);
  }
  // A raw-file input is cut the same way.
  const raw = await plane.resolveSnapshotInputs({ studyId, snapshotId: replay.snapshot.id, principal: OWNER, purpose: "vcr", include: ["files"] });
  const rawRows = await Promise.all(raw.inputs.filter((input) => input.kind === "snapshot_file").map(async (input) => (await planeTable(input.location)).rows.length));
  assert.deepEqual(rawRows.sort((a, b) => a - b), [VISIBLE, 2 * VISIBLE]);
  const fullRaw = await plane.resolveSnapshotInputs({ studyId, snapshotId: everyone.snapshot.id, principal: OWNER, purpose: "vcr", include: ["files"] });
  assert.deepEqual((await Promise.all(fullRaw.inputs.map(async (input) => (await planeTable(input.location)).rows.length))).sort((a, b) => a - b), [COHORT_SIZE, 2 * COHORT_SIZE]);

  // Derived again a week later, it is the same tables: the date was frozen with the snapshot.
  const again = await plane.deriveAnalysisTables({ userId: OWNER, studyId, snapshotId: replay.snapshot.id });
  assert.deepEqual(again.registered.map((/** @type {any} */ table) => table.sha256).sort(), replay.tables.registered.map((/** @type {any} */ table) => table.sha256).sort());
});

test("AC-15 a replay date needs a visibility column in every file that derives rows, and a bad date is the caller's mistake", options, async () => {
  const studyId = await seedStudy();
  const source = await seedConfirmed(studyId, { map: FIELD_MAP });
  await assert.rejects(() => plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id, asOf: REPLAY_AS_OF }), (error) => {
    assert.equal(error.code, VCR_DATA_PLANE_CODES.fieldMapInvalid);
    assert.equal(error.status, 422);
    assert.deepEqual(error.vcrDetail.issues.map((/** @type {any} */ issue) => [issue.code, issue.table]).sort(),
      [["as_of_needs_visible_at", "cohort.csv"], ["as_of_needs_visible_at", "visits.csv"]]);
    return true;
  });
  for (const asOf of ["next tuesday", "2026-13-45", "yesterday-ish"]) {
    await assert.rejects(() => plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id, asOf }),
      (error) => error.status === 400 && error.code === VCR_DATA_PLANE_CODES.payloadInvalid, `${asOf} is refused by name, not with a crash`);
  }
  assert.deepEqual(await store.listSnapshots({ studyId }), [], "nothing was frozen by any of them");
  // The same source, frozen with no date, is still a snapshot.
  assert.equal((await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id })).snapshot.version, 1);
});

test("AC-03 a column that says it was imputed keeps the table it is in from reading observed, down to the input the engine gets", options, async () => {
  const studyId = await seedStudy(OWNER, "specified_analysis");
  const map = REPLAY_FIELD_MAP.map((entry) => {
    if (entry.column === "AGE") return { ...entry, valueSource: "imputed", outcome: true };
    if (entry.column === "SBP") return { ...entry, valueSource: "calculated" };
    return entry;
  });
  const source = await seedConfirmed(studyId, { map });
  const { snapshot, tables } = await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id });
  assert.equal(snapshot.valueSource, "observed", "the source is what it was registered as");
  const held = Object.fromEntries((await store.listAnalysisTables({ studyId })).map((table) => [table.shape, table]));
  assert.deepEqual(Object.keys(held).sort(), ["events", "longitudinal", "subject"]);
  assert.equal(held.subject.valueSource, "imputed");
  assert.equal(held.events.valueSource, "observed");
  assert.equal(held.longitudinal.valueSource, "calculated");
  assert.deepEqual(held.subject.derivedFrom.columnSources, { age: "imputed", arm: "observed", ecog: "observed", sex: "observed" });
  assert.deepEqual(held.longitudinal.derivedFrom.columnSources, { ADT: "observed", AVAL: "calculated" });
  assert.deepEqual(tableView(held.subject).columnSources, held.subject.derivedFrom.columnSources, "and the page can say which column is which");
  assert.deepEqual(held.subject.derivedFrom.columns.find((/** @type {any} */ column) => column.source === "AGE"), { source: "AGE", name: "age", valueSource: "imputed" });
  assert.deepEqual((await store.getSnapshot(snapshot.id)).profile.frozen.columnSources.map((/** @type {any} */ column) => `${column.table}:${column.column}:${column.valueSource}`).sort(),
    ["cohort.csv:AGE:imputed", "visits.csv:SBP:calculated"]);
  assert.equal(tables.registered.length, 3);

  // What the control plane hands the engine carries the same labels. The seal holds
  // AGE (it was declared an outcome) back from the subject table, and a table
  // without the imputed column is no longer labelled by it.
  const inputs = await plane.resolveEngineInputs({ studyId, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", kind: "rmst", method: "comparator.entropy_balance", endpointType: "binary" });
  const subject = inputs.find((input) => input.shape === "subject");
  assert.ok(subject);
  assert.equal(subject.valueSource, "observed", "the view without AGE holds only observed columns");
  assert.ok(!(await fs.readFile(path.join(dataPlaneDir, subject.location), "utf8")).split("\n")[0].includes("age"));
  const longitudinal = await plane.resolveEngineInputs({ studyId, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", include: ["longitudinal"] });
  assert.equal(longitudinal[0].valueSource, "calculated");
});

test("AC-03 a column cannot claim a source its file is not: a synthetic file has no observed columns", options, async () => {
  const studyId = await seedStudy();
  const map = REPLAY_FIELD_MAP.map((entry) => (entry.column === "AGE" ? { ...entry, valueSource: "observed" } : entry));
  const source = await seedConfirmed(studyId, { map, valueSource: "synthetic" });
  await assert.rejects(() => plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id }), (error) => {
    assert.equal(error.code, VCR_DATA_PLANE_CODES.fieldMapInvalid);
    assert.deepEqual(error.vcrDetail.issues.map((/** @type {any} */ issue) => issue.code), ["column_source_on_non_individual_source"]);
    return true;
  });
  assert.deepEqual(await store.listSnapshots({ studyId }), []);
});

// ---------------------------------------------------------------------------
// Matching from the subject table: a cohort that arrived as one uploaded table
// ---------------------------------------------------------------------------

const MATCH_CRITERIA = [
  { id: "crt_age", ordinal: 1, kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "age", comparator: "gte", value: 60, unit: "year" } },
  { id: "crt_sex", ordinal: 2, kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "sex", comparator: "eq", value: "female" } },
  { id: "crt_ecog", ordinal: 3, kind: "inclusion", criterionType: "performance_status", requirement: { op: "compare", variable: "performance_status", comparator: "lte", value: 1 } },
  { id: "crt_hb", ordinal: 4, kind: "inclusion", criterionType: "lab", requirement: { op: "compare", variable: "hemoglobin", comparator: "gte", value: 100, unit: "g/L" } },
];
const matchStoreOver = (criteria) => ({
  async listCriteria() { return criteria; }, async listFacts() { return []; }, async latestLanguageJudgments() { return new Map(); },
});
const runMatching = (principal, criteria = MATCH_CRITERIA) => {
  const run = vcrMatchingExecutor({ matchStore: matchStoreOver(criteria), store: { async studyById() { return { id: STUDY_FOR_MATCH, userId: principal }; } },
    subjectTable: vcrSubjectTableSeam({ dataPlane: plane }) });
  return run({ job: { id: "job_m", studyId: STUDY_FOR_MATCH, scenarioHash: "e".repeat(64), seed: 1,
    inputs: [{ kind: "evidence", id: "matching:asof:2026-10-05T00:00:00.000Z" }, { kind: "evidence", id: "matching:protocol:prt_1" }, { kind: "evidence", id: "matching:facts:0123456789abcdef" }],
    scenario: { criteria: criteria.map((criterion) => ({ id: criterion.id, kind: criterion.kind, type: criterion.criterionType, state: "unknown" })) } }, onProgress: async () => {} });
};
/** @type {string} */ let STUDY_FOR_MATCH = "";

test("a study whose subjects arrived as one cohort table is matched from the subject table: every row a candidate, judged for the owner, nothing written", options, async (t) => {
  const studyId = await seedStudy();
  STUDY_FOR_MATCH = studyId;
  await seedSnapshot(studyId);
  const before = (await q("SELECT count(*)::int AS n FROM evimed_vcr.matching_facts")).at(0).n;
  // Wall-clock seconds such as 43.830 can coincide with a cohort fingerprint (43.83).
  // Keep the full privacy scan deterministic, including the executor's timestamps.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-05T00:00:00.000Z") });
  const result = await runMatching(OWNER);
  assert.equal(result.assessments.length, COHORT_SIZE, "one candidate per row of the subject table");
  // Independently of the evaluator: the fixture's own rule for each person.
  const expected = { age: { satisfied: 0, not_satisfied: 0 }, sex: { satisfied: 0, not_satisfied: 0 }, ecog: { satisfied: 0, not_satisfied: 0 } };
  for (let n = 1; n <= COHORT_SIZE; n += 1) {
    expected.age[41 + ((n * 3) % 30) >= 60 ? "satisfied" : "not_satisfied"] += 1;
    expected.sex[n % 3 === 0 ? "satisfied" : "not_satisfied"] += 1;
    expected.ecog[(n % 4) <= 1 ? "satisfied" : "not_satisfied"] += 1;
  }
  const tally = (id) => result.assessments.reduce((acc, assessment) => { const state = assessment.judgments.find((/** @type {any} */ judgment) => judgment.criterionId === id).state; acc[state] = (acc[state] ?? 0) + 1; return acc; }, /** @type {Record<string, number>} */ ({}));
  assert.deepEqual(tally("crt_age"), { satisfied: expected.age.satisfied, not_satisfied: expected.age.not_satisfied });
  assert.deepEqual(tally("crt_sex"), { satisfied: expected.sex.satisfied, not_satisfied: expected.sex.not_satisfied });
  assert.deepEqual(tally("crt_ecog"), { satisfied: expected.ecog.satisfied, not_satisfied: expected.ecog.not_satisfied }, "ECOG is the column the field map called performance_status");
  assert.deepEqual(tally("crt_hb"), { unknown: COHORT_SIZE }, "the table holds no haemoglobin: unknown for everyone, not 'not satisfied'");
  assert.ok(result.assessments.every((/** @type {any} */ assessment) => /^P[0-9a-f]{16}$/.test(assessment.subjectKey) && assessment.source === "subject_table"), "the keys are the study's pseudonyms");
  const note = result.diagnostics.subjectTable;
  assert.deepEqual(note.variablesUnmapped, ["hemoglobin"]);
  assert.deepEqual(note.variablesMapped.map((/** @type {any} */ item) => [item.variable, item.column]).sort(), [["age", "age"], ["performance_status", "ecog"], ["sex", "sex"]]);
  // No cell of the cohort is in what was produced, and nothing patient-level reached the schema.
  const text = JSON.stringify(result);
  for (const value of fingerprints()) assert.equal(text.includes(value), false, `${value} is a cell of the partner's file`);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.matching_facts")).at(0).n, before, "no fact was written for any row");
  assert.ok(result.assessments.every((/** @type {any} */ assessment) => JSON.stringify(assessment.judgments).includes("snapshot_cell")), "evidence says the cell it stands on, by column");
  assert.equal(JSON.stringify(result.assessments).includes("\"quote\":\"age = "), false);
  // It was read as every patient-level read is: audited, as this operation.
  const audit = await q("SELECT action, outcome, actor FROM evimed_vcr.audit WHERE study_id=$1 AND detail::text LIKE '%match_criteria%' ORDER BY id", [studyId]);
  assert.ok(audit.length >= 1, "the read is on the audit trail");
});

test("a member with no grant on the source cannot have its table matched, and the refusal is the result's, not a crash", options, async () => {
  const studyId = await seedStudy();
  STUDY_FOR_MATCH = studyId;
  await seedSnapshot(studyId);
  const result = await runMatching(PARTNER);
  assert.equal(result.assessments.length, 0, "no candidates from a table the principal may not read");
  assert.equal(result.diagnostics.subjectTable.available, false);
  assert.match(String(result.diagnostics.subjectTable.reason), /^vcr_/, "named by its code");
});

test("a column the seal holds is not in what matching reads, so the criterion that needs it is unknown", options, async () => {
  const studyId = await seedStudy(OWNER, "specified_analysis");
  STUDY_FOR_MATCH = studyId;
  const map = FIELD_MAP.map((entry) => (entry.column === "AGE" ? { ...entry, outcome: true } : entry));
  const source = await plane.registerSource({ userId: OWNER, studyId, name: "合作方基线导出", ownerParty: "合作方医院", allowedUses: ["vcr"] });
  for (const [name, body] of [["cohort.csv", cohortCsv()], ["visits.csv", visitsCsv()]]) await plane.storeUpload({ actor: OWNER, studyId, sourceId: source.id, name, stream: streamOf(body) });
  const proposed = await plane.proposeFieldMap({ actor: OWNER, studyId, sourceId: source.id, columns: map });
  await plane.confirmFieldMap({ actor: OWNER, studyId, sourceId: source.id, hash: proposed.hash });
  await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id });
  const result = await runMatching(OWNER);
  assert.equal(result.assessments.length, COHORT_SIZE);
  assert.ok(result.assessments.every((/** @type {any} */ assessment) => assessment.judgments.find((/** @type {any} */ judgment) => judgment.criterionId === "crt_age").state === "unknown"),
    "AGE is sealed: nobody is judged on it");
  assert.ok(result.diagnostics.subjectTable.variablesUnmapped.includes("age"));
  assert.equal(result.assessments.some((/** @type {any} */ assessment) => assessment.judgments.find((/** @type {any} */ judgment) => judgment.criterionId === "crt_sex").state !== "unknown"), true, "what is released still decides");
});

test("a unit the field map left out is the dictionary's, and a study with no subject table says so", options, async () => {
  const studyId = await seedStudy();
  const map = FIELD_MAP.map((entry) => (entry.column === "AGE" ? { ...entry, unit: undefined } : entry));
  const source = await plane.registerSource({ userId: OWNER, studyId, name: "合作方基线导出", ownerParty: "合作方医院", allowedUses: ["vcr"] });
  for (const [name, body, role] of [["cohort.csv", cohortCsv(), "data"], ["visits.csv", visitsCsv(), "data"], ["dictionary.csv", dictionaryCsv(), "dictionary"]]) {
    await plane.storeUpload({ actor: OWNER, studyId, sourceId: source.id, name, role, stream: streamOf(body) });
  }
  const proposed = await plane.proposeFieldMap({ actor: OWNER, studyId, sourceId: source.id, columns: map });
  await plane.confirmFieldMap({ actor: OWNER, studyId, sourceId: source.id, hash: proposed.hash });
  await plane.freezeSnapshot({ userId: OWNER, studyId, sourceId: source.id });
  const table = await plane.subjectTableForMatching({ studyId, principal: OWNER, purpose: "vcr" });
  assert.equal(table.available, true);
  assert.equal(table.columns.find((/** @type {any} */ column) => column.name === "age").unit, "岁", "the dictionary says what the map did not");
  assert.equal(table.rows.length, COHORT_SIZE);
  assert.equal(table.header[0], "USUBJID");
  assert.deepEqual(await plane.subjectTableIdentity(studyId), { snapshotId: (await store.listSnapshots({ studyId }))[0].id,
    sha256: (await store.listAnalysisTables({ studyId })).find((/** @type {any} */ item) => item.shape === "subject").sha256 });
  const bare = await seedStudy();
  assert.deepEqual(await plane.subjectTableForMatching({ studyId: bare, principal: OWNER, purpose: "vcr" }), { available: false, reason: "no_subject_table" });
  assert.equal(await plane.subjectTableIdentity(bare), null);
});
