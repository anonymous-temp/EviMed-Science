// 「虚拟临研」's data plane against a real PostgreSQL and real files: a snapshot
// is frozen with its hash and its profile and **no patient row reaches
// `evimed_vcr`**; the three analysis tables are registered or refused by name;
// a seal is two timestamps in the ledger; and the access judgments the unit
// tests make against a double are replayed here against the real store, which
// is what binds the double to the thing it stands in for.
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
import { VCR_DATA_PLANE_CODES, VcrDataPlane, sha256OfFile } from "../src/vcrDataPlane.mjs";
import { VcrDataStore } from "../src/vcrDataStore.mjs";
import { VcrMembers } from "../src/vcrMembers.mjs";
import { vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

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
  plane = new VcrDataPlane({ store, config: { vcrDataPlaneDir: dataPlaneDir } });
  access = new VcrAccess({ store });
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
async function seedStudy(userId = OWNER) {
  const id = vcrId("study");
  await q(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, question, data_tier, intended_use)
    VALUES ($1, $2, $3, 'EV-201 二线 NSCLC', '单臂能否用外部对照', 'T1', 'design_support')`, [id, userId, `prj_${id}`]);
  return id;
}

/** Write a file into the data plane and return its path relative to the root. */
async function place(relative, body) {
  const file = path.join(dataPlaneDir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
  return relative;
}

const COHORT = [
  "USUBJID,AGE,ECOG,TRT,OS_TIME,OS_EVENT,VISIT_DATE,ENTERED,SHARED",
  "S001,54,1,A,410,1,2026-01-05,2026-01-07,2026-01-12",
  "S002,61,0,B,377,0,2026-01-06,2026-01-08,2026-01-13",
  "S003,58,2,,289,1,2026-01-07,2026-01-09,2026-02-20",
  "",
].join("\n");

const FIELD_MAP = {
  USUBJID: { concept: "subject", subjectKey: true, identifier: true },
  AGE: { concept: "age", unit: "year", range: [0, 120] },
  ECOG: { concept: "performance_status" },
  TRT: { concept: "treatment", missingReason: "restricted_in_trial" },
  OS_TIME: { concept: "overall_survival", unit: "day" },
  OS_EVENT: { concept: "overall_survival_event" },
  VISIT_DATE: { timeKind: "occurred_at" },
  ENTERED: { timeKind: "recorded_at" },
  SHARED: { timeKind: "visible_at" },
};

/** A registered source frozen into one snapshot. */
async function seedSnapshot(studyId, { sealedFields = [], sealedUntil = null } = {}) {
  const source = await plane.registerSource({
    userId: PARTNER, studyId, name: "合作方基线导出", ownerParty: "合作方医院",
    allowedUses: ["vcr"], format: "csv",
  });
  const relative = await place(`${studyId}/cohort.csv`, COHORT);
  const frozen = await plane.freezeSnapshot({
    userId: PARTNER, sourceId: source.id, studyId, files: [relative],
    fieldMap: FIELD_MAP, sealedFields, sealedUntil,
  });
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
  assert.equal(snapshot.rowCount, 3);
  assert.equal(snapshot.columnCount, 9);
  assert.equal(profile.counts.findings >= 1, true);
  assert.equal((await store.getSource(PARTNER, source.id)).status, "frozen");

  // The real check: every text and json column of every table in the schema,
  // scanned for a value that only exists inside the file. A patient row one
  // join away from the model is the thing the data plane exists to prevent.
  const columns = await q(`SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'evimed_vcr' AND data_type IN ('text', 'jsonb', 'ARRAY') ORDER BY 1, 2`);
  assert.ok(columns.length > 50, "the scan must actually have columns to scan");
  let scanned = 0;
  for (const column of columns) {
    const rows = await q(`SELECT ${column.data_type === "jsonb" ? `"${column.column_name}"::text` : `"${column.column_name}"::text`} AS body
      FROM evimed_vcr."${column.table_name}" WHERE "${column.column_name}" IS NOT NULL`);
    for (const row of rows) {
      scanned += 1;
      // `410` and `377` are this cohort's survival times; `54`/`61` its ages.
      assert.ok(!/\b410\b|\b377\b|\b289\b/.test(String(row.body)),
        `${column.table_name}.${column.column_name} carries a patient-level value`);
    }
  }
  assert.ok(scanned > 20, `the scan read ${scanned} values`);
  // The bytes are in the data plane, where the metadata points.
  assert.equal(snapshot.location, `${studyId}/cohort.csv`);
  const onDisk = path.join(dataPlaneDir, snapshot.location);
  assert.ok((await fs.stat(onDisk)).isFile());
  assert.ok(!onDisk.includes("/workspace/") && !onDisk.includes("knowledge-base"));
});

test("AC-03 the field map records the three clocks and the missing reason", options, async () => {
  const studyId = await seedStudy();
  const { snapshot } = await seedSnapshot(studyId);
  const maps = await store.listFieldMaps(snapshot.id);
  assert.equal(maps.length, 9);
  const byColumn = Object.fromEntries(maps.map((map) => [map.columnName, map]));
  assert.equal(byColumn.VISIT_DATE.timeKind, "occurred_at");
  assert.equal(byColumn.ENTERED.timeKind, "recorded_at");
  assert.equal(byColumn.SHARED.timeKind, "visible_at");
  assert.equal(byColumn.TRT.missingReason, "restricted_in_trial");
  assert.equal(byColumn.USUBJID.identifier, true);
  assert.equal(byColumn.AGE.reviewState, "ai_set", "an AI-drafted map is labelled until somebody countersigns it");
  const forModel = await plane.snapshotProfileForModel({ snapshotId: snapshot.id });
  assert.deepEqual(forModel.clocks.occurred_at, ["VISIT_DATE"]);
  assert.deepEqual(forModel.clocks.visible_at, ["SHARED"]);
  assert.equal(forModel.fieldMap.length, 9);
  assert.deepEqual(Object.keys(forModel.quality.categories).sort(), [...VCR_QUALITY_CATEGORIES].sort());
});

test("AC-03 a correction is a new snapshot, never a rewrite of the old one", options, async () => {
  const studyId = await seedStudy();
  const { source, snapshot } = await seedSnapshot(studyId);
  const corrected = await place(`${studyId}/cohort-v2.csv`, COHORT.replace("S003,58,2,,289,1", "S003,58,1,,289,1"));
  const second = await plane.freezeSnapshot({
    userId: PARTNER, sourceId: source.id, studyId, files: [corrected], fieldMap: FIELD_MAP,
  });
  assert.equal(second.snapshot.version, 2);
  assert.notEqual(second.snapshot.sha256, snapshot.sha256);
  const still = await store.getSnapshot(snapshot.id);
  assert.equal(still.sha256, snapshot.sha256, "the first snapshot is untouched");
  assert.equal((await store.listSnapshots({ sourceId: source.id })).length, 2);
});

test("AC-03 a snapshot file outside the data plane is refused by name", options, async () => {
  const studyId = await seedStudy();
  const source = await plane.registerSource({ userId: PARTNER, studyId, name: "越界导出", format: "csv" });
  await assert.rejects(
    () => plane.freezeSnapshot({ userId: PARTNER, sourceId: source.id, studyId, files: ["/etc/hostname"] }),
    (error) => error.code === VCR_DATA_PLANE_CODES.locationOutside);
  await assert.rejects(
    () => plane.freezeSnapshot({ userId: PARTNER, sourceId: source.id, studyId, files: ["missing.csv"] }),
    (error) => error.code === VCR_DATA_PLANE_CODES.locationMissing);
  await assert.rejects(
    () => plane.freezeSnapshot({ userId: OWNER, sourceId: source.id, studyId, files: ["x.csv"] }),
    (error) => error.code === VCR_DATA_PLANE_CODES.sourceNotFound,
    "another account's source does not exist");
});

// ---------------------------------------------------------------------------
// C2-23: the three analysis tables
// ---------------------------------------------------------------------------

test("C2-23 good analysis tables are registered and a bad ADTTE is refused and recorded", options, async () => {
  const studyId = await seedStudy();
  const { snapshot } = await seedSnapshot(studyId);
  const adsl = await place(`${studyId}/adsl.csv`, "USUBJID,TRT01P,AGE\nS001,A,54\nS002,B,61\n");
  const bds = await place(`${studyId}/bds.csv`, "USUBJID,PARAMCD,AVAL,AVISIT\nS001,ECOG,1,Baseline\nS002,ECOG,0,Baseline\n");
  const adtte = await place(`${studyId}/adtte.csv`,
    "USUBJID,PARAMCD,AVAL,CNSR,STARTDT,ADT\nS001,OS,410,0,2026-01-01,2027-02-15\nS002,OS,-3,7,2026-03-01,2026-02-01\n");

  const result = await plane.deriveAnalysisTables({
    userId: OWNER, studyId, snapshotId: snapshot.id,
    tables: [{ shape: "subject", file: adsl }, { shape: "longitudinal", file: bds }, { shape: "events", file: adtte }],
  });
  assert.deepEqual(result.registered.map((table) => table.shape).sort(), ["longitudinal", "subject"]);
  assert.deepEqual(result.refused.map((table) => table.shape), ["events"]);
  const named = result.refused[0].issues.filter((issue) => issue.blocking).map((issue) => issue.issue).sort();
  assert.deepEqual(named, ["adt-before-startdt", "aval-negative", "cnsr-not-binary"]);

  const stored = await store.listAnalysisTables({ studyId });
  assert.equal(stored.length, 2, "the bad table is not registered, so no engine can be pointed at it");
  const subject = stored.find((table) => table.shape === "subject");
  assert.equal(subject.rowCount, 2);
  assert.deepEqual(subject.columns, ["USUBJID", "TRT01P", "AGE"]);
  assert.equal(subject.sha256, await sha256OfFile(path.join(dataPlaneDir, adsl)));

  const trail = await store.auditTrail({ studyId, action: "analysis_table.refused" });
  assert.equal(trail.length, 1, "the refusal is traceable, not silent");
  assert.equal(trail[0].outcome, "denied");
  assert.match(trail[0].reason, /cnsr-not-binary/);
});

test("C2-23 a batch of only bad tables refuses the call and registers nothing", options, async () => {
  const studyId = await seedStudy();
  const { snapshot } = await seedSnapshot(studyId);
  const adsl = await place(`${studyId}/bad-adsl.csv`, "USUBJID,TRT01P\nS001,A\nS001,B\n");
  await assert.rejects(
    () => plane.deriveAnalysisTables({
      userId: OWNER, studyId, snapshotId: snapshot.id, tables: [{ shape: "subject", file: adsl }],
    }),
    (error) => error.code === VCR_DATA_PLANE_CODES.analysisTableInvalid);
  assert.deepEqual(await store.listAnalysisTables({ studyId }), []);
  await assert.rejects(
    () => plane.deriveAnalysisTables({ userId: OWNER, studyId, snapshotId: "snp_nope", tables: [] }),
    (error) => error.code === VCR_DATA_PLANE_CODES.snapshotNotFound);
});

// ---------------------------------------------------------------------------
// AC-22 / AC-32: the seal, and the two timestamps
// ---------------------------------------------------------------------------

test("AC-32 sealing and unsealing each leave a timestamped row in the ledger", options, async () => {
  const studyId = await seedStudy();
  const { snapshot } = await seedSnapshot(studyId);
  const sealed = await plane.sealFields({
    snapshotId: snapshot.id, fields: ["OS_TIME", "OS_EVENT"],
    until: "2027-01-01T00:00:00Z", actor: OWNER, reason: "分析计划冻结前结局不可读",
  });
  assert.deepEqual(sealed.snapshot.sealedFields, ["OS_EVENT", "OS_TIME"]);
  assert.equal(sealed.snapshot.sealedUntil, "2027-01-01T00:00:00.000Z");
  const sealRows = await store.auditTrail({ studyId, action: "snapshot.seal" });
  assert.equal(sealRows.length, 1);
  assert.equal(sealRows[0].actor, OWNER);
  assert.match(sealRows[0].reason, /分析计划冻结前/);
  assert.ok(sealRows[0].occurredAt, "the seal's own timestamp is what AC-32 compares against the plan's");

  const lifted = await plane.unsealFields({ snapshotId: snapshot.id, fields: ["OS_EVENT"], actor: OWNER });
  assert.deepEqual(lifted.snapshot.sealedFields, ["OS_TIME"]);
  const unsealRows = await store.auditTrail({ studyId, action: "snapshot.unseal" });
  assert.equal(unsealRows.length, 1);
  assert.ok(Date.parse(unsealRows[0].occurredAt) >= Date.parse(sealRows[0].occurredAt),
    "the two timestamps are in the order the study package has to prove");
  await assert.rejects(() => plane.sealFields({ snapshotId: "snp_nope", fields: [], actor: OWNER }),
    (error) => error.code === VCR_DATA_PLANE_CODES.snapshotNotFound);
});

test("AC-22 what the model is shown of a sealed snapshot is the column name and nothing else", options, async () => {
  const studyId = await seedStudy();
  const { snapshot } = await seedSnapshot(studyId, { sealedFields: ["OS_TIME", "OS_EVENT"], sealedUntil: "2027-01-01T00:00:00Z" });
  const forModel = await plane.snapshotProfileForModel({ snapshotId: snapshot.id });
  const byName = Object.fromEntries(forModel.columns.map((column) => [column.name, column]));
  assert.deepEqual(byName.OS_TIME, { table: "cohort.csv", name: "OS_TIME", sealed: true });
  assert.equal(byName.OS_EVENT.filled, undefined, "a sealed outcome's fill rate is an event rate");
  assert.equal(byName.AGE.sealed, false);
  assert.equal(byName.AGE.densityCompleteness, 1);
  assert.deepEqual(byName.USUBJID.vocabulary, [], "the subject key is an identifier and carries no values");
  assert.deepEqual(forModel.sealedFields, ["OS_EVENT", "OS_TIME"]);
  assert.ok(!JSON.stringify(forModel).includes("410"), "no sealed value reaches what the model is shown");
});

// ---------------------------------------------------------------------------
// AC-17: the judge against the real store (the double's ground truth)
// ---------------------------------------------------------------------------

test("AC-17 the real store judges cross-account, grant, window and seal exactly as the double does", options, async () => {
  const studyId = await seedStudy();
  const otherStudy = await seedStudy("vcr-stranger");
  const { source, snapshot } = await seedSnapshot(studyId, { sealedFields: ["OS_TIME"], sealedUntil: "2027-01-01T00:00:00Z" });

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

  const grant = await store.createGrant({
    sourceId: source.id, studyId, userId: PARTNER, grantee: "role:data_manager", role: "data_manager",
    fields: ["AGE", "ECOG", "OS_TIME"], purposes: ["vcr"],
    windowStart: "2026-01-01T00:00:00Z", windowEnd: "2027-12-31T00:00:00Z",
  });
  const granted = await access.judge({
    actor: "vcr-dm", studyId, snapshotId: snapshot.id, ability: "read_patient_level",
    fields: ["AGE", "ECOG", "OS_TIME", "TRT", "USUBJID"], purpose: "vcr",
  });
  assert.equal(granted.allowed, true);
  assert.equal(granted.grantId, grant.id);
  assert.deepEqual(granted.fields.allowed, ["AGE", "ECOG"]);
  const denied = Object.fromEntries(granted.fields.denied.map((entry) => [entry.field, entry.code]));
  assert.equal(denied.OS_TIME, VCR_ACCESS_CODES.fieldSealed);
  assert.equal(denied.USUBJID, VCR_ACCESS_CODES.fieldIdentifying);
  assert.equal(denied.TRT, VCR_ACCESS_CODES.fieldNotGranted);

  assert.equal((await access.judge({
    actor: "vcr-dm", studyId, sourceId: source.id, ability: "read_patient_level",
    purpose: "vcr", asOf: "2025-06-01T00:00:00Z",
  })).code, VCR_ACCESS_CODES.outsideWindow);
  assert.equal((await access.judge({
    actor: "vcr-dm", studyId, sourceId: source.id, ability: "read_patient_level", purpose: "geo",
  })).code, VCR_ACCESS_CODES.purposeNotGranted);

  await store.revokeGrant({ grantId: grant.id, actor: PARTNER });
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
  await plane.deriveAnalysisTables({
    userId: OWNER, studyId, snapshotId: snapshot.id,
    tables: [{ shape: "subject", file: await place(`${studyId}/adsl.csv`, "USUBJID\nS001\nS002\n") }],
  });
  await q("DELETE FROM evimed_vcr.studies WHERE id = $1", [studyId]);
  assert.equal(await store.getSnapshot(snapshot.id), null, "the snapshot row goes with its study");
  assert.deepEqual(await store.listAnalysisTables({ studyId }), []);
  assert.equal(await store.sourceFor(source.id), null);
  const trail = await store.auditTrail({ studyId });
  assert.ok(trail.length > 0, "the audit outlives the object it describes");
});
