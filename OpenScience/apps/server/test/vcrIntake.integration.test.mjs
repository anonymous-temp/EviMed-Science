// Real patient data, from a file to an engine input, on real parts (contract
// 2026-09-29 §3.2 and §6; plan §8.1, §6.5; findings PA-9, PA-10, PB-10, CS-10,
// CS-39, CS-40, CS-41, CS-49, PA-35, PA-36, AC-03/06/22/26/32).
//
// Nothing between the file and the engine is a double: the composed module
// (`composeVcr`) on a scratch PostgreSQL, a scratch data-plane directory, the
// real profiler script, and — for the last step — the real `run_job.R` on the
// inputs the control plane resolved. The only thing replaced is the recording
// model gateway, and that only records what the runtime would have read.
//
// Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { VCR_ENGINE_METHODS, VCR_ENGINE_PROTOCOL_VERSION, validateEngineJob } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VCR_DATA_PLANE_CODES, sha256OfFile } from "../src/vcrDataPlane.mjs";
import { VCR_READ_WHATS } from "../src/vcrService.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import {
  COHORT_SIZE, FIELD_MAP, cohortCsv, dictionaryCsv, fingerprints, streamOf, visitsCsv,
} from "./helpers/vcrIntakeData.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 120_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(HERE, "../../../../项目代码/vcr-engine");
// The R library is the machine's to name (`scripts/vcr/r-library.sh`); there is no path baked in here.
const R_LIBS = process.env.VCR_R_LIBS ?? "";
// CI runs this file with `VCR_ENGINE_TESTS=required`: a box without R or its library is then a red run with
// the reason; without it the engine step says why it did not run.
const ENGINE_REQUIRED = process.env.VCR_ENGINE_TESTS === "required";

/** What this machine lacks of what the real engine needs: `{ code, message }`, or null. */
function engineProblem() {
  if (spawnSync("Rscript", ["--version"]).status !== 0) return { code: "rscript", message: "Rscript is not installed (or not on PATH)" };
  if (!R_LIBS) return { code: "library_unset", message: "VCR_R_LIBS is not set: it names the R library the engine runs on (scripts/vcr/r-library.sh installs it)" };
  if (!existsSync(R_LIBS)) return { code: "library_missing", message: `VCR_R_LIBS names a directory that does not exist: ${R_LIBS}` };
  return null;
}

/** @type {any} */ let isolated = null;
/** @type {any} */ let database = null;
/** @type {any} */ let vcr = null;
/** @type {string} */ let plane;
let counter = 0;

const OWNER = "intake-owner";
const MANAGER = "intake-manager";
const ANALYST = "intake-analyst";
const STRANGER = "intake-stranger";

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrintake");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  plane = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-intake-"));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrDataPlaneDir: plane, vcrAudience: "all" }, productDatabase: database });
  await vcr.store.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
  if (plane) await fs.rm(plane, { recursive: true, force: true });
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

/**
 * A study owned by OWNER with a data manager and an analyst, at a data tier and
 * intended use.
 * @param {{ intendedUse?: string, dataTier?: string, owner?: string }} [entry]
 */
async function seedStudy({ intendedUse = "specified_analysis", dataTier = "T2", owner = OWNER } = {}) {
  counter += 1;
  const study = await vcr.store.createStudy({ userId: owner, projectId: `prj_intake_${counter}_${Math.random().toString(36).slice(2, 8)}`,
    name: `外部对照 ${counter}`, dataTier, intendedUse });
  await vcr.dataStore.addMember({ studyId: study.id, userId: MANAGER, role: "data_manager", invitedBy: owner, actor: owner });
  await vcr.dataStore.addMember({ studyId: study.id, userId: ANALYST, role: "statistical_reviewer", invitedBy: owner, actor: owner });
  return study;
}

/** Upload a file the way a route does. @param {any} study @param {string} sourceId @param {string} name @param {string | Buffer} body @param {Record<string, any>} [extra] */
async function upload(study, sourceId, name, body, extra = {}) {
  return vcr.dataPlane.storeUpload({
    actor: extra.actor ?? OWNER, studyId: study.id, sourceId, name, stream: streamOf(body), declaredLength: Buffer.byteLength(body), ...extra,
  });
}

/**
 * A source with the cohort and visits files uploaded and the field map
 * confirmed — everything short of the freeze.
 * @param {any} study @param {{ actor?: string, map?: unknown }} [entry]
 */
async function seedSource(study, { actor = OWNER, map = FIELD_MAP } = {}) {
  const source = await vcr.dataPlane.registerSource({ userId: actor, studyId: study.id, name: "合作方外部对照", ownerParty: "合作方医院",
    allowedUses: ["vcr"], valueSource: "observed" });
  const cohort = await upload(study, source.id, "cohort.csv", cohortCsv(), { actor });
  const visits = await upload(study, source.id, "visits.csv", visitsCsv(), { actor });
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor, studyId: study.id, sourceId: source.id, columns: map });
  return { source, cohort: cohort.file, visits: visits.file, proposed };
}

/** @param {any} study @param {{ actor?: string }} [entry] */
async function seedFrozen(study, { actor = OWNER } = {}) {
  const seeded = await seedSource(study, { actor });
  assert.deepEqual(seeded.proposed.entryIssues, [], JSON.stringify(seeded.proposed.entryIssues));
  assert.deepEqual(seeded.proposed.mapIssues, [], JSON.stringify(seeded.proposed.mapIssues));
  await vcr.dataPlane.confirmFieldMap({ actor, studyId: study.id, sourceId: seeded.source.id, hash: seeded.proposed.hash });
  const frozen = await vcr.dataPlane.freezeSnapshot({ userId: actor, studyId: study.id, sourceId: seeded.source.id });
  return { ...seeded, ...frozen };
}

/** Read a plane file. @param {string} location */
const readPlane = (location) => fs.readFile(path.join(plane, location), "utf8");

// ---------------------------------------------------------------------------
// The intake flow
// ---------------------------------------------------------------------------

test("PA-10 a source is registered, files are taken in under their own hash, and the map is proposed then confirmed by a person", options, async () => {
  const study = await seedStudy();
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "合作方外部对照", ownerParty: "合作方医院",
    allowedUses: ["vcr", "matching"], visibleWindow: { start: "2020-01-01" }, retention: { until: "2030-01-01", note: "五年" } });
  assert.equal(source.status, "registered");
  assert.equal(source.fieldMapState, "none");
  assert.deepEqual(source.allowedUses, ["vcr", "matching"]);

  const first = await upload(study, source.id, "cohort.csv", cohortCsv());
  assert.equal(first.created, true);
  assert.equal(first.file.rowCount, COHORT_SIZE);
  assert.equal(first.file.columnCount, 8);
  // Stored under the sha256 of its own bytes, inside the study's directory, not under the name it was uploaded as.
  assert.match(first.file.location, new RegExp(`^studies/${study.id}/sources/${source.id}/[a-f0-9]{64}\\.csv$`));
  assert.equal(first.file.sha256, await sha256OfFile(path.join(plane, first.file.location)));
  // The same bytes again are the same file.
  const again = await upload(study, source.id, "cohort-copy.csv", cohortCsv());
  assert.equal(again.created, false);
  assert.equal(again.file.id, first.file.id);
  assert.equal((await vcr.dataStore.listSourceFiles(source.id)).length, 1);

  await upload(study, source.id, "visits.csv", visitsCsv());
  const dictionary = await upload(study, source.id, "dictionary.csv", dictionaryCsv(), { role: "dictionary" });
  assert.equal(dictionary.file.detail.dictionary.length, 6);
  assert.equal(dictionary.file.detail.dictionary[4].label, "死亡(1=是)");
  assert.equal((await vcr.dataStore.getSource(OWNER, source.id)).status, "profiled");

  // Proposed: the run's proposal and a person's are the same call, and nothing is confirmed by it.
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, columns: FIELD_MAP, by: "run" });
  assert.deepEqual(proposed.entryIssues, []);
  assert.deepEqual(proposed.mapIssues, []);
  assert.equal(proposed.source.fieldMapState, "proposed");
  assert.equal(proposed.source.fieldMapBy, "run");
  await assert.rejects(() => vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: source.id }),
    (error) => error.code === VCR_DATA_PLANE_CODES.fieldMapUnconfirmed, "a snapshot is not frozen from a map nobody confirmed");
  // A confirmation is of the map the person read: a stale hash is refused.
  await assert.rejects(() => vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, hash: "0".repeat(64) }),
    (error) => error.code === VCR_DATA_PLANE_CODES.fieldMapChanged);
  const confirmed = await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, hash: proposed.hash });
  assert.equal(confirmed.source.fieldMapState, "confirmed");
  assert.equal(confirmed.source.fieldMapConfirmedBy, OWNER);
  // An edit withdraws the confirmation.
  const edited = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id,
    columns: FIELD_MAP.map((entry) => (entry.column === "AGE" ? { ...entry, unit: "years" } : entry)) });
  assert.equal(edited.source.fieldMapState, "proposed");
  assert.notEqual(edited.hash, proposed.hash);
  // Every step is on the record.
  const trail = (await vcr.dataStore.auditTrail({ studyId: study.id, limit: 100 })).map((row) => row.action);
  for (const action of ["source.register", "source.file", "fieldmap.propose", "fieldmap.confirm"]) assert.ok(trail.includes(action), `${action} is audited`);
});

test("CS-40 the map is validated as a whole before anything is frozen: a bad map leaves no snapshot, and two freezes never race for a version", options, async () => {
  const study = await seedStudy();
  const seeded = await seedSource(study);
  // A column the files do not have, an outcome with only its time, a subject key nowhere.
  const bad = [
    ...FIELD_MAP.filter((entry) => entry.column !== "OS_DEAD" && entry.column !== "PATIENT_NO"),
    { table: "cohort.csv", column: "NO_SUCH_COLUMN", role: "covariate", alias: "ghost" },
  ];
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, columns: bad });
  const codes = proposed.mapIssues.map((/** @type {any} */ issue) => issue.code).sort();
  assert.ok(codes.includes("column_unknown"), codes.join());
  assert.ok(codes.includes("subject_key_missing"), codes.join());
  assert.ok(codes.includes("outcome_pair_incomplete"), codes.join());
  await assert.rejects(() => vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, hash: proposed.hash }),
    (error) => error.code === VCR_DATA_PLANE_CODES.fieldMapInvalid && error.vcrDetail.issues.length >= 3);
  assert.deepEqual(await vcr.dataStore.listSnapshots({ studyId: study.id }), [], "no snapshot came of a map that was refused");

  // Entries are checked one at a time, closed vocabularies and all; the good ones are kept.
  const mixed = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, columns: [
    { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age" },
    { table: "cohort.csv", column: "SEX", role: "wizard" },
    { table: "cohort.csv", column: "ECOG", role: "covariate", alias: "1bad-name" },
    { table: "cohort.csv", column: "ARM", role: "arm", alias: "arm", expression: "system('x')" },
  ] });
  assert.deepEqual(mixed.entryIssues.map((/** @type {any} */ issue) => `${issue.index}:${issue.code}`).sort(),
    ["1:role_unknown", "2:alias_invalid", "3:field_unknown"]);
  assert.equal(mixed.source.fieldMap.columns.length, 1, "the one entry that held was stored");

  // The good map, frozen twice at once: two versions, no unique-index failure after the work was done.
  const good = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, columns: FIELD_MAP });
  await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, hash: good.hash });
  const both = await Promise.all([1, 2].map(() => vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: seeded.source.id, derive: false })));
  assert.deepEqual(both.map((result) => result.snapshot.version).sort(), [1, 2]);
});

test("PA-10 uploads are refused by name: format, size, encoding, and a column named twice", options, async () => {
  const study = await seedStudy();
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "上传检查" });
  const refused = async (/** @type {string} */ name, /** @type {string | Buffer} */ body, /** @type {string} */ code, /** @type {Record<string, any>} */ extra = {}) => {
    await assert.rejects(() => upload(study, source.id, name, body, extra), (error) => error.code === code, `${name}: expected ${code}`);
  };
  await refused("cohort.parquet", "x", VCR_DATA_PLANE_CODES.formatUnsupported);
  await refused("cohort.exe", "x", VCR_DATA_PLANE_CODES.formatUnsupported);
  await refused("../../etc/passwd.csv.zip", "x", VCR_DATA_PLANE_CODES.formatUnsupported);
  await refused("", "a,b\n1,2\n", VCR_DATA_PLANE_CODES.fileNameInvalid);
  await refused("noext", "a,b\n1,2\n", VCR_DATA_PLANE_CODES.fileNameInvalid);
  await refused("dup.csv", "id,id\n1,2\n", VCR_DATA_PLANE_CODES.fileUnreadable);
  await refused("empty.csv", "", VCR_DATA_PLANE_CODES.fileUnreadable);
  await refused("binary.csv", Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x00, 0x01, 0x02]), VCR_DATA_PLANE_CODES.fileUnreadable);
  await refused("array.json", '{"not":"a list"}', VCR_DATA_PLANE_CODES.fileUnreadable);
  // A ceiling: declared up front, and enforced on the stream when a client lies about its length.
  await assert.rejects(() => upload(study, source.id, "big.csv", "a,b\n1,2\n", { declaredLength: 10 ** 9 }), (error) => error.code === VCR_DATA_PLANE_CODES.fileTooLarge);
  const capped = new (await import("../src/vcrDataPlane.mjs")).VcrDataPlane({ store: vcr.dataStore, config: { vcrDataPlaneDir: plane, vcrDataMaxBytes: 64 }, access: vcr.access });
  await assert.rejects(() => capped.storeUpload({ actor: OWNER, studyId: study.id, sourceId: source.id, name: "long.csv",
    stream: streamOf(`a,b\n${"1,2\n".repeat(100)}`), declaredLength: null }), (error) => error.code === VCR_DATA_PLANE_CODES.fileTooLarge);
  // Nothing was left half-written.
  const incoming = path.join(plane, "studies", study.id, "incoming");
  assert.deepEqual(await fs.readdir(incoming).catch(() => []), [], "a refused upload leaves no scratch file");

  // A Chinese Excel's "CSV" is GBK; JSON is a list of records; a blank header cell is named, not lost.
  const gbk = spawnSync("python3", ["-c", "import sys; sys.stdout.buffer.write('姓名,年龄\\n张三,54\\n李四,61\\n'.encode('gb18030'))"]).stdout;
  const gbkFile = await upload(study, source.id, "gbk.csv", gbk);
  assert.equal(gbkFile.file.detail.encoding, "gb18030");
  const stored = await readPlane(gbkFile.file.location);
  assert.match(stored, /姓名,年龄\n张三,54/, "the stored copy is UTF-8");
  const fromJson = await upload(study, source.id, "records.json", JSON.stringify([{ a: 1, b: "x" }, { a: 2, b: "y", c: true }]));
  assert.equal(fromJson.file.columnCount, 3);
  const blank = await upload(study, source.id, "blank-header.csv", ",b\n1,2\n");
  assert.equal(blank.file.detail.renamedBlankHeaders, 1);
  assert.deepEqual((await readPlane(blank.file.location)).split("\n")[0], "col_1,b");
  // A file no snapshot names can be removed; its bytes go with it.
  const removed = await vcr.dataPlane.removeUpload({ actor: OWNER, studyId: study.id, fileId: blank.file.id });
  assert.equal(removed.removed, true);
  await assert.rejects(() => fs.stat(path.join(plane, blank.file.location)));
});

test("PA-10 an .xlsx is converted at the door with the standard library only: cached values, dates as dates, the first sheet with data", options, async () => {
  const study = await seedStudy();
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "Excel 导出" });
  const workbook = path.join(plane, `fixture-${Math.random().toString(36).slice(2)}.xlsx`);
  const made = spawnSync("python3", ["-c", `
import zipfile, sys
ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
wb = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="说明" sheetId="1" r:id="rId1"/><sheet name="病例" sheetId="2" r:id="rId2"/></sheets></workbook>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'
ss = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>PATIENT_NO</t></si><si><t>AGE</t></si><si><t>DIAG_DATE</t></si><si><t>HZ-1</t></si><si><t>HZ-2</t></si><si><t>发病日期</t></si></sst>'
st = '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>'
s1 = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
s2 = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>5</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>54</v></c><c r="C2" s="1"><v>45658</v></c><c r="D2" s="2"><v>45660</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>61.5</v></c><c r="C3" s="1"><v>45659</v></c></row></sheetData></worksheet>'
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for name, body in [('[Content_Types].xml', ct), ('xl/workbook.xml', wb), ('xl/_rels/workbook.xml.rels', rels), ('xl/sharedStrings.xml', ss), ('xl/styles.xml', st), ('xl/worksheets/sheet1.xml', s1), ('xl/worksheets/sheet2.xml', s2)]:
        z.writestr(name, body)
`, workbook]);
  assert.equal(made.status, 0, String(made.stderr));
  const file = await upload(study, source.id, "cases.xlsx", await fs.readFile(workbook));
  await fs.rm(workbook, { force: true });
  assert.equal(file.file.format, "xlsx");
  assert.deepEqual(file.file.detail.sheets, ["说明", "病例"]);
  assert.equal(file.file.detail.sheetUsed, "病例");
  assert.equal(await readPlane(file.file.location), "PATIENT_NO,AGE,DIAG_DATE,发病日期\nHZ-1,54,2025-01-01,2025-01-03\nHZ-2,61.5,2025-01-02,\n", "a custom date format is a date, a built-in one is a date, a blank stays blank");
  // A file that is not a workbook is refused, not passed to the profiler.
  await assert.rejects(() => upload(study, source.id, "fake.xlsx", "PK not really"), (error) => error.code === VCR_DATA_PLANE_CODES.fileUnreadable);
});

test("PA-36 the profiler absorbs small vocabulary entries instead of dropping them, and the stored profile carries no level under the floor", options, async () => {
  const study = await seedStudy();
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "小格子" });
  // 340 on arm A and 5 on arm B: hiding only B and printing `filled: 345, distinct: 2` would give B away.
  const rows = ["PATIENT_NO,ARM,GRADE"];
  for (let n = 1; n <= 345; n += 1) rows.push(`P${n},${n <= 340 ? "A" : "B"},${n % 3 === 0 ? "high" : n % 3 === 1 ? "mid" : "low"}`);
  const { file } = await upload(study, source.id, "arms.csv", `${rows.join("\n")}\n`);
  const arm = file.profile.tables[0].columns.find((/** @type {any} */ column) => column.name === "ARM");
  assert.equal(arm.vocabulary.complete, false);
  assert.ok(arm.vocabulary.suppressedValues >= 2, "at least two entries are hidden together");
  assert.ok(arm.vocabulary.values.every((/** @type {any[]} */ pair) => pair[1] >= 10));
  assert.ok(!JSON.stringify(arm).includes('"B"'), "the small arm's label is not in the profile");
  const grade = file.profile.tables[0].columns.find((/** @type {any} */ column) => column.name === "GRADE");
  assert.deepEqual(grade.vocabulary.values.map((/** @type {any[]} */ pair) => pair[0]).sort(), ["high", "low", "mid"], "categories that many people share stay");
  // For a model the fill counts that would give a small group away are withheld with their complement.
  const forModel = await vcr.dataPlane.sourceProfileForModel({ studyId: study.id, sourceId: source.id, principal: OWNER });
  const armForModel = forModel.files[0].columns.find((/** @type {any} */ column) => column.name === "ARM");
  assert.ok(armForModel.levels.every((/** @type {any} */ level) => level.n >= 10));
});

// ---------------------------------------------------------------------------
// Freeze, the three tables, the pseudonym
// ---------------------------------------------------------------------------

test("PA-35 CS-40 a snapshot keeps every file's hash, the tables are derived in code, and the subject key is the study's own pseudonym", options, async () => {
  const study = await seedStudy();
  const frozen = await seedFrozen(study);
  const { snapshot } = frozen;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.fileHashes.length, 2);
  assert.deepEqual(snapshot.fileHashes.map((/** @type {any} */ file) => file.sha256).sort(), [frozen.cohort.sha256, frozen.visits.sha256].sort());
  assert.equal(snapshot.fieldMapHash, frozen.source.fieldMapHash ?? frozen.proposed.hash);
  assert.equal(snapshot.rowCount, COHORT_SIZE * 3);
  assert.equal((await vcr.dataStore.listFieldMaps(snapshot.id)).length, FIELD_MAP.length);

  assert.deepEqual(frozen.tables.registered.map((/** @type {any} */ table) => table.shape).sort(), ["events", "longitudinal", "subject"]);
  assert.deepEqual(frozen.tables.refused, []);
  const tables = Object.fromEntries((await vcr.dataStore.listAnalysisTables({ snapshotId: snapshot.id })).map((table) => [table.shape, table]));
  assert.equal(tables.subject.rowCount, COHORT_SIZE);
  assert.deepEqual(tables.subject.columns, ["USUBJID", "age", "arm", "ecog", "sex"], "in the order of the source columns' names, so the same map gives the same bytes");
  assert.equal(tables.subject.outcomeBearing, false);
  assert.equal(tables.events.outcomeBearing, true, "a table holding an outcome says so");
  assert.equal(tables.longitudinal.rowCount, COHORT_SIZE * 2);
  assert.equal(tables.subject.valueSource, "observed");

  const subject = (await readPlane(tables.subject.location)).trim().split("\n");
  assert.equal(subject.length, COHORT_SIZE + 1);
  assert.match(subject[1], /^P[a-f0-9]{16},/, "the person is a per-study pseudonym");
  for (const table of Object.values(tables)) {
    const body = await readPlane(table.location);
    assert.ok(!/HZ-3\d{4}/.test(body), `${table.shape} carries no source subject id`);
  }
  const events = (await readPlane(tables.events.location)).trim().split("\n");
  assert.equal(events[0], "USUBJID,PARAMCD,AVAL,CNSR,STARTDT");
  // CNSR is 1 when censored: the person with OS_DEAD 0 is censored.
  const censored = events.slice(1).filter((line) => line.split(",")[3] === "1").length;
  assert.equal(censored, COHORT_SIZE / 5, "OS_DEAD 0 is CNSR 1");
  // The same person keys every file; a second study keys the same source id differently.
  const visitIds = new Set((await readPlane(tables.longitudinal.location)).trim().split("\n").slice(1).map((line) => line.split(",")[0]));
  const subjectIds = new Set(subject.slice(1).map((line) => line.split(",")[0]));
  assert.deepEqual([...visitIds].sort(), [...subjectIds].sort(), "the visits and the baseline join on the pseudonym");
  const other = await seedStudy();
  const otherFrozen = await seedFrozen(other);
  const otherTables = await vcr.dataStore.listAnalysisTables({ snapshotId: otherFrozen.snapshot.id });
  const otherSubject = (await readPlane(otherTables.find((table) => table.shape === "subject").location)).trim().split("\n");
  assert.notEqual(otherSubject[1].split(",")[0], subject[1].split(",")[0], "two studies never see one person under one key");
  // The way back exists, is audited, and needs manage_data.
  const first = subject[1].split(",")[0];
  const back = await vcr.dataPlane.identityOf({ studyId: study.id, snapshotId: snapshot.id, pseudonym: first, actor: OWNER });
  assert.match(back.sourceSubjectId, /^HZ-3\d{4}$/);
  await assert.rejects(() => vcr.dataPlane.identityOf({ studyId: study.id, snapshotId: snapshot.id, pseudonym: first, actor: ANALYST }),
    (error) => error.status === 403);
  assert.ok((await vcr.dataStore.auditTrail({ studyId: study.id, action: "identity.lookup" })).length >= 1);
});

test("C2-23 a table that is not what it says it is is refused by name and the snapshot stands", options, async () => {
  const study = await seedStudy({ intendedUse: "exploratory" });
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "重复受试者" });
  // Two baseline rows for one patient: a subject table is one row per person.
  await upload(study, source.id, "dup.csv", "PATIENT_NO,ARM,AGE\nA1,TRT,50\nA1,CTL,51\nA2,TRT,60\n");
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, columns: [
    { table: "dup.csv", column: "PATIENT_NO", role: "subject_key", identifier: true },
    { table: "dup.csv", column: "ARM", role: "arm", alias: "arm" }, { table: "dup.csv", column: "AGE", role: "covariate", alias: "age" }] });
  await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: source.id, hash: proposed.hash });
  const frozen = await vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: source.id });
  assert.equal(frozen.snapshot.version, 1);
  assert.deepEqual(frozen.tables.registered, []);
  assert.deepEqual(frozen.tables.refused.map((/** @type {any} */ entry) => entry.shape), ["subject"]);
  assert.ok(frozen.tables.refused[0].issues.some((/** @type {any} */ issue) => issue.issue === "duplicate-subject-id"));
  assert.equal((await vcr.dataStore.auditTrail({ studyId: study.id, action: "analysis_table.refused" })).length, 1);
});

// ---------------------------------------------------------------------------
// The seal (CS-10, PA-9, PB-10, AC-32)
// ---------------------------------------------------------------------------

test("AC-32 outcome fields are sealed at freeze under a confirmatory use, withheld from the engine until the plan is frozen, and the two timestamps are in order", options, async () => {
  const study = await seedStudy({ intendedUse: "specified_analysis" });
  const { snapshot } = await seedFrozen(study);
  assert.deepEqual(snapshot.sealedFields, ["OS_DEAD", "OS_MONTHS"], "the outcome pair is sealed the moment the snapshot exists");
  assert.equal(snapshot.sealedUntil, null);
  const sealRow = (await vcr.dataStore.auditTrail({ studyId: study.id, action: "snapshot.seal" }))[0];
  assert.ok(sealRow, "the seal is its own row in the ledger");

  // Before the plan is frozen: a cohort is given the subject table only, and a time-to-event comparison is given the
  // subject table and refused the events table, because its outcome columns are sealed.
  const cohort = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", jobKind: "build_cohort" });
  assert.deepEqual(cohort.inputs.map((input) => input.shape), ["subject"], "a cohort reads no outcome, so it is handed none");
  assert.deepEqual(cohort.withheld, []);
  const before = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", jobKind: "rmst" });
  assert.deepEqual(before.inputs.map((input) => input.shape), ["subject"], "the table with no sealed column");
  assert.deepEqual(before.withheld.map((item) => `${item.shape}:${item.reason}`), ["events:sealed"]);
  assert.deepEqual(before.outcomeFieldsRead, []);
  // The queue's own call answers the inputs alone, as an array.
  const asArray = await vcr.dataPlane.resolveEngineInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", kind: "rmst", method: "comparator.rmst", endpointType: "time_to_event", fields: ["age", "arm"] });
  assert.ok(Array.isArray(asArray));
  assert.deepEqual(asArray.map((input) => input.shape), ["subject"]);
  // A scenario names analysis columns (`age`); the seal is about the source's (`OS_MONTHS`). The alias of a sealed outcome is judged as its source.
  await assert.rejects(() => vcr.dataPlane.resolveEngineInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", kind: "rmst", fields: ["AVAL"], include: ["events"] }),
    (error) => error.status === 403);
  await assert.rejects(() => vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", include: ["events"] }),
    (error) => error.status === 403 && [VCR_DATA_PLANE_CODES.snapshotWithheld, "vcr_field_sealed"].includes(error.code));
  await assert.rejects(() => vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", fields: ["OS_MONTHS"], include: ["events"] }),
    (error) => error.status === 403, "asking for a sealed column by name is not how it is read");
  const wide = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", fields: ["OS_MONTHS", "AGE"], include: ["subject"] });
  assert.equal(wide.inputs.length, 1, "the refused field is dropped, the rest is served");
  assert.equal((await vcr.store.studyById(study.id)).outcomeSeal.outcomeFirstReadAt, undefined, "a refused read is not a read");
  // The profile a model may see names the sealed columns and says nothing about them.
  const profile = await vcr.dataPlane.snapshotProfileForModel({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER });
  assert.deepEqual(profile.sealedFields, ["OS_DEAD", "OS_MONTHS"]);
  assert.deepEqual(profile.columns.find((column) => column.name === "OS_MONTHS"), { table: "cohort.csv", name: "OS_MONTHS", sealed: true });

  // The plan is frozen: the seal lifts as of that instant and records planFrozenAt.
  const plan = { estimand: { population: "二线 NSCLC", variable: "OS" }, endpoint: { type: "time_to_event" }, analysis: { method: "comparator.rmst" }, intendedUse: "specified_analysis" };
  const frozenPlan = await vcr.seal.freezePlan({ studyId: study.id, plan, actor: OWNER });
  assert.ok(frozenPlan.planFrozenAt);
  assert.equal(frozenPlan.outcomeFirstReadAt, null);
  assert.equal(frozenPlan.ordered, true);
  const lifted = await vcr.dataStore.getSnapshot(snapshot.id);
  assert.equal(lifted.sealedUntil, frozenPlan.planFrozenAt, "the seal lifted as of the freeze instant");
  assert.deepEqual(lifted.sealedFields, ["OS_DEAD", "OS_MONTHS"], "what was sealed stays a fact");
  assert.ok((await vcr.dataStore.auditTrail({ studyId: study.id, action: "snapshot.unseal" })).length >= 1);

  // The first job that reads an outcome column records the second timestamp.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const after = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", jobKind: "rmst" });
  assert.deepEqual(after.inputs.map((input) => input.shape).sort(), ["events", "subject"]);
  assert.deepEqual(after.outcomeFieldsRead, ["OS_DEAD", "OS_MONTHS"]);
  const state = (await vcr.seal.sealState(study.id));
  assert.ok(state.outcomeFirstReadAt);
  assert.ok(Date.parse(state.outcomeFirstReadAt) > Date.parse(state.planFrozenAt), "the plan came first");
  assert.equal(state.ordered, true);
  const first = state.outcomeFirstReadAt;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", include: ["events"] });
  assert.equal((await vcr.seal.sealState(study.id)).outcomeFirstReadAt, first, "only the first read sets the timestamp");
  // Freezing the same plan again does not move the plan's time.
  const again = await vcr.seal.freezePlan({ studyId: study.id, plan, actor: OWNER });
  assert.equal(again.unchanged, true);
  assert.equal(again.planFrozenAt, frozenPlan.planFrozenAt);
});

test("AC-32 the first outcome read is the first, whatever the interleaving: the seal is written under a lock", options, async () => {
  const study = await seedStudy({ intendedUse: "specified_analysis" });
  await vcr.seal.freezePlan({ studyId: study.id, plan: { endpoint: { type: "time_to_event" }, intendedUse: "specified_analysis" }, actor: OWNER });
  const readers = ["OS_MONTHS", "OS_DEAD", "PFS_TIME", "PFS_EVENT", "OS_RATE", "OS_SITE"];
  await Promise.all(readers.map((field, index) => vcr.seal.recordOutcomeAccess({ studyId: study.id, fields: [field], actor: `runner-${index}` })));
  const state = await vcr.seal.sealState(study.id);
  assert.deepEqual(state.outcomeFieldsRead, [...readers].sort(), "no reader's field was lost to another's write");
  const stamps = await q("SELECT count(*)::int AS n FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.seal.outcome_read'", [study.id]);
  assert.equal(stamps[0].n, readers.length, "every read is on the ledger");
  const firstAudit = await q("SELECT detail->>'first' AS first FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.seal.outcome_read'", [study.id]);
  assert.equal(new Set(firstAudit.map((row) => row.first)).size, 1, "every reader saw the same first timestamp");
  assert.equal(state.outcomeFirstReadAt, firstAudit[0].first);
});

test("AC-32 a study raised to a confirmatory use after its snapshot was frozen is sealed by the next read; an exploratory one is never sealed", options, async () => {
  const exploratory = await seedStudy({ intendedUse: "exploratory" });
  const frozen = await seedFrozen(exploratory);
  assert.deepEqual(frozen.snapshot.sealedFields, [], "exploratory: nothing is sealed");
  const open = await vcr.dataPlane.resolveSnapshotInputs({ studyId: exploratory.id, snapshotId: frozen.snapshot.id, principal: OWNER, purpose: "vcr", include: ["events"] });
  assert.equal(open.inputs.length, 1);
  assert.deepEqual(open.outcomeFieldsRead, ["OS_DEAD", "OS_MONTHS"], "an exploratory read of the outcome is still recorded");
  assert.ok((await vcr.seal.sealState(exploratory.id)).outcomeFirstReadAt);

  // Fresh study, frozen while exploratory, then raised: sealed by the next judgment with nobody sealing it.
  const raised = await seedStudy({ intendedUse: "exploratory" });
  const snap = (await seedFrozen(raised)).snapshot;
  await vcr.store.updateStudy(raised.id, { intendedUse: "submission_preparation" }, OWNER);
  // The page says so at once, before anything has read the snapshot.
  const shown = (await vcr.dataPlane.tabFor(await vcr.store.studyById(raised.id), { id: OWNER })).snapshots[0];
  assert.equal(shown.sealed, true);
  assert.deepEqual(shown.sealedFields, ["OS_DEAD", "OS_MONTHS"]);
  assert.deepEqual((await vcr.dataStore.getSnapshot(snap.id)).sealedFields, [], "…though nobody has written the seal yet");
  await assert.rejects(() => vcr.dataPlane.resolveSnapshotInputs({ studyId: raised.id, snapshotId: snap.id, principal: OWNER, purpose: "vcr", include: ["events"] }),
    (error) => error.status === 403);
  const judged = await vcr.access.judge({ actor: OWNER, studyId: raised.id, snapshotId: snap.id, ability: "read_patient_level", fields: ["OS_MONTHS", "AGE"] });
  assert.deepEqual(judged.fields.denied.map((entry) => `${entry.field}:${entry.code}`), ["OS_MONTHS:vcr_field_sealed"]);
  assert.ok((await vcr.dataStore.getSnapshot(snap.id)).sealedFields.includes("OS_MONTHS"), "and the seal is written, not only judged");
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test("CS-41 CS-49 the snapshot must be the study's and the source the study's: another account's, another study's and a study-less source are 404 alike", options, async () => {
  const study = await seedStudy();
  const { snapshot, source } = await seedFrozen(study);
  const other = await seedStudy({ owner: STRANGER });
  // A caller cannot resolve, freeze against or read into a study that is not theirs.
  for (const call of [
    () => vcr.dataPlane.resolveSnapshotInputs({ studyId: other.id, snapshotId: snapshot.id, principal: STRANGER, purpose: "vcr" }),
    () => vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: STRANGER, purpose: "vcr" }),
    () => vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: "snp_nothing", principal: OWNER, purpose: "vcr" }),
    () => vcr.dataPlane.freezeSnapshot({ userId: STRANGER, studyId: study.id, sourceId: source.id }),
    () => vcr.dataPlane.freezeSnapshot({ userId: STRANGER, studyId: other.id, sourceId: source.id }),
    () => vcr.dataPlane.registerSource({ userId: STRANGER, studyId: study.id, name: "偷偷登记" }),
    () => vcr.dataPlane.snapshotProfileForModel({ studyId: other.id, snapshotId: snapshot.id, principal: STRANGER }),
    () => vcr.dataPlane.sourceProfileForModel({ studyId: other.id, sourceId: source.id, principal: STRANGER }),
    () => vcr.dataPlane.deriveAnalysisTables({ userId: STRANGER, studyId: other.id, snapshotId: snapshot.id }),
  ]) {
    await assert.rejects(call, (error) => error.status === 404, "reads exactly like something that does not exist");
  }
  // The owner of the other study, with the right study id but this study's snapshot.
  await assert.rejects(() => vcr.dataPlane.resolveSnapshotInputs({ studyId: other.id, snapshotId: snapshot.id, principal: STRANGER, purpose: "vcr" }),
    (error) => error.code === VCR_DATA_PLANE_CODES.snapshotNotFound);
  // A study-less source of another account is the same 404, whatever the caller holds in this study.
  const stray = await vcr.dataStore.createSource({ userId: STRANGER, name: "无研究的源", studyId: null });
  const judged = await vcr.access.judge({ actor: MANAGER, studyId: study.id, sourceId: stray.id, ability: "read_patient_level" });
  assert.equal(judged.code, "vcr_source_not_found", "not `vcr_no_grant`: that would say the source exists");
  const foreign = await vcr.access.judge({ actor: MANAGER, studyId: study.id, sourceId: source.id, ability: "read_patient_level" });
  assert.equal(foreign.code, "vcr_no_grant", "inside the study a missing grant is told plainly");
  // A data manager in the study who is not the source's owner needs a grant to read its rows.
  await assert.rejects(() => vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: MANAGER, purpose: "vcr" }),
    (error) => error.status === 403 && error.code === "vcr_no_grant");
});

test("CS-39 access is judged at now: a past asOf selects rows and opens nothing", options, async () => {
  const study = await seedStudy({ intendedUse: "exploratory" });
  const seeded = await seedSource(study);
  await vcr.dataPlane.confirmFieldMap({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, hash: seeded.proposed.hash });
  const { snapshot } = await vcr.dataPlane.freezeSnapshot({ userId: OWNER, studyId: study.id, sourceId: seeded.source.id });
  const grant = await vcr.dataPlane.createGrant({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, grantee: MANAGER, role: "data_manager",
    windowStart: "2020-01-01T00:00:00Z", windowEnd: "2021-01-01T00:00:00Z", purposes: ["vcr"] });
  // The window closed years ago. Asking as of a date inside it does not reopen it.
  const inside = await vcr.access.judge({ actor: MANAGER, studyId: study.id, snapshotId: snapshot.id, ability: "read_patient_level", purpose: "vcr", asOf: "2020-06-01T00:00:00Z" });
  assert.equal(inside.allowed, false);
  assert.equal(inside.code, "vcr_outside_window");
  assert.equal(inside.asOf, "2020-06-01T00:00:00.000Z", "the ledger says what was asked about");
  await vcr.dataStore.revokeGrant({ grantId: grant.id, studyId: study.id, actor: OWNER });
  const open = await vcr.dataPlane.createGrant({ actor: OWNER, studyId: study.id, sourceId: seeded.source.id, grantee: MANAGER, role: "data_manager", purposes: ["vcr"], fields: ["AGE", "SEX", "ECOG", "ARM"] });
  const now = await vcr.access.judge({ actor: MANAGER, studyId: study.id, snapshotId: snapshot.id, ability: "read_patient_level", purpose: "vcr", asOf: "1999-01-01T00:00:00Z" });
  assert.equal(now.allowed, true, "a live grant is live whatever date the replay is about");
  assert.equal(now.grantId, open.id);
});

test("PB-10 grants: only the source's own account grants; a grantee is a study member; revoking keeps the row; a field-limited grant serves a projected table", options, async () => {
  const study = await seedStudy({ intendedUse: "exploratory" });
  const { source, snapshot } = await seedFrozen(study, { actor: OWNER });
  await assert.rejects(() => vcr.dataPlane.createGrant({ actor: MANAGER, studyId: study.id, sourceId: source.id, grantee: MANAGER }),
    (error) => error.code === VCR_DATA_PLANE_CODES.grantOwnerOnly, "a data manager cannot grant themselves the owner's rows");
  for (const grantee of ["someone-who-is-not-a-member", "role:wizard", "study:std_other"]) {
    await assert.rejects(() => vcr.dataPlane.createGrant({ actor: OWNER, studyId: study.id, sourceId: source.id, grantee }), (error) => error.code === VCR_DATA_PLANE_CODES.grantInvalid, grantee);
  }
  const grant = await vcr.dataPlane.createGrant({ actor: OWNER, studyId: study.id, sourceId: source.id, grantee: MANAGER, fields: ["AGE", "SEX", "ARM"], purposes: ["vcr"] });
  const served = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: MANAGER, purpose: "vcr", jobKind: "build_cohort" });
  assert.deepEqual(served.inputs.map((input) => input.shape), ["subject"], "the subject table, projected to the columns the grant names");
  const view = (await readPlane(served.inputs[0].location)).split("\n")[0];
  assert.equal(view, "USUBJID,age,arm,sex", "ECOG was not granted, so it is not in the file the engine reads");
  assert.equal(served.inputs[0].hash, await sha256OfFile(path.join(plane, served.inputs[0].location)));
  assert.equal(served.grantId, grant.id);
  assert.deepEqual(served.withheld, [], "a cohort asks for the subject table only");
  const rmst = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: MANAGER, purpose: "vcr", jobKind: "rmst" });
  assert.deepEqual(rmst.withheld.map((item) => `${item.shape}:${item.reason}`), ["events:not_granted"], "the grant names no outcome column, so the events table is not handed over");
  const revoked = await vcr.dataPlane.revokeGrant({ actor: OWNER, studyId: study.id, grantId: grant.id });
  assert.ok(revoked.revokedAt);
  assert.equal((await vcr.dataStore.listGrants(source.id)).length, 1, "the revoked grant is kept");
  await assert.rejects(() => vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: MANAGER, purpose: "vcr" }), (error) => error.code === "vcr_no_grant");
  await assert.rejects(() => vcr.dataPlane.revokeGrant({ actor: MANAGER, studyId: study.id, grantId: grant.id }), (error) => error.code === VCR_DATA_PLANE_CODES.grantOwnerOnly);
});

// ---------------------------------------------------------------------------
// The profiler is a bounded process
// ---------------------------------------------------------------------------

test("CS-40 the profiler runs under a clock and an output ceiling", options, async () => {
  const { runSnapshotProfiler } = await import("../src/vcrDataPlane.mjs");
  const script = path.join(plane, "slow-profiler.py");
  await fs.writeFile(script, "import time\ntime.sleep(30)\n");
  await assert.rejects(() => runSnapshotProfiler({ files: [], fieldMap: {}, sealedFields: [], asOf: null, script, timeoutMs: 400 }),
    (error) => error.code === VCR_DATA_PLANE_CODES.profilerTimeout);
  const loud = path.join(plane, "loud-profiler.py");
  await fs.writeFile(loud, "import sys\nsys.stdout.write('x' * 5000000)\n");
  await assert.rejects(() => runSnapshotProfiler({ files: [], fieldMap: {}, sealedFields: [], asOf: null, script: loud, maxOutputBytes: 1000 }),
    (error) => error.code === VCR_DATA_PLANE_CODES.profilerTooLarge);
  const broken = path.join(plane, "broken-profiler.py");
  await fs.writeFile(broken, "import sys\nsys.stderr.write('boom')\nsys.exit(3)\n");
  await assert.rejects(() => runSnapshotProfiler({ files: [], fieldMap: {}, sealedFields: [], asOf: null, script: broken }),
    (error) => error.code === VCR_DATA_PLANE_CODES.profilerFailed && /boom/.test(error.message));
});

// ---------------------------------------------------------------------------
// AC-26: no row reaches the model
// ---------------------------------------------------------------------------

test("AC-26 what the runtime can read of real data carries no row: a fingerprint scan of every read path and of the recording gateway finds nothing", options, async () => {
  const study = await seedStudy({ intendedUse: "specified_analysis" });
  const { snapshot, source } = await seedFrozen(study);
  await vcr.seal.freezePlan({ studyId: study.id, plan: { endpoint: { type: "time_to_event" }, intendedUse: "specified_analysis" }, actor: OWNER });
  // A run that has produced a small result too: three people, distinctively.
  await vcr.store.recordResult({ studyId: study.id, userId: OWNER, kind: "population", conclusion: "estimable", counts: { realPatients: 3, events: 2 },
    measures: [{ name: "cohort_size", value: 3, source: "observed" }], diagnostics: { arms: [{ arm: "X", n: 2 }, { arm: "Y", n: 1 }] }, requestedUse: "exploratory" });

  /** What the model gateway would be handed: every string the runtime reads. @type {string[]} */
  const recorded = [];
  const read = async (/** @type {string} */ what, /** @type {Record<string, any>} */ filter = {}) => {
    const answer = await vcr.service.runtimeRead(study, what, filter);
    recorded.push(JSON.stringify(answer));
    return answer;
  };
  for (const what of VCR_READ_WHATS) {
    if (what === "snapshot_profile") continue;
    await read(what).catch(() => null);
  }
  const shown = await read("snapshot_profile", { snapshotId: snapshot.id });
  assert.equal(shown.available, true);
  assert.equal(shown.snapshotId, snapshot.id);
  const sourceShown = await read("snapshot_profile", { sourceId: source.id });
  assert.equal(sourceShown.available, true);
  // The same reads by the plane's own model-facing functions, and what the field-map proposal returns to the run.
  recorded.push(JSON.stringify(await vcr.dataPlane.snapshotProfileForModel({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER })));
  recorded.push(JSON.stringify(await vcr.dataPlane.sourceProfileForModel({ studyId: study.id, sourceId: source.id, principal: OWNER })));
  recorded.push(JSON.stringify(await vcr.dataPlaneSeam.proposeFieldMap(study, { sourceId: source.id, columns: FIELD_MAP })));

  const everything = recorded.join("\n");
  assert.ok(everything.length > 2_000, "the scan read what it should have");
  /** The scan itself: a value stands alone, not inside a longer number or word. @param {string} value */
  const finder = (value) => new RegExp(`(?<![\\w.])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
  for (const value of fingerprints()) assert.ok(finder(value).test(cohortCsv()), `${value} is in the source file, so the scan can find it`);
  for (const value of fingerprints()) assert.ok(!finder(value).test(everything), `${value} reached what the runtime can read`);
  // The small cells the runtime can read are suppressed at the one boundary (the domain's `suppressForModel`), whatever store shape they sit in.
  await vcr.store.savePopulation({ studyId: study.id, userId: OWNER, name: "外部对照人群", kind: "real", snapshotId: snapshot.id,
    counts: { realPatients: 3, events: 2 }, waterfall: [{ rule: "年龄", kept: 3, excluded: 37 }, { rule: "ECOG", kept: 2, excluded: 1 }] });
  const population = (await read("population")).populations[0];
  assert.equal(population.counts.realPatients, null, "a count of three people is not shown as three");
  assert.equal(population.counts.events, null);
  assert.deepEqual([...population.counts.suppressed].sort(), ["events", "realPatients"]);
  assert.ok(population.waterfall.every((/** @type {any} */ step) => step.kept === null && step.excluded === null), "the waterfall's small steps are hidden together with their complements");
});

// ---------------------------------------------------------------------------
// Patient documents (the matching side's data)
// ---------------------------------------------------------------------------

test("PB-24 a patient document is stored under the subject's pseudonym with the time it became visible, and read only through a judged, audited call", options, async () => {
  const study = await seedStudy({ intendedUse: "exploratory" });
  const source = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "病历文本", allowedUses: ["vcr", "matching"] });
  const text = "主诉：咳嗽三周。既往：2024 年确诊 EGFR 突变肺腺癌。\n";
  const stored = await upload(study, source.id, "HZ-30007-note.txt", text, { role: "document", subject: "HZ-30007", visibleAt: "2026-03-01" });
  assert.equal(stored.file.role, "document");
  assert.match(stored.file.detail.subjectKey, /^P[a-f0-9]{16}$/, "the subject is the study's pseudonym, not the partner's number");
  assert.equal(stored.file.detail.visibleAt, "2026-03-01T00:00:00.000Z");
  assert.ok(stored.file.location.startsWith(`studies/${study.id}/documents/`), "documents live in their own directory of the plane");
  assert.ok(!JSON.stringify(stored.file.detail).includes("HZ-30007"));
  await assert.rejects(() => upload(study, source.id, "bad.txt", "x", { role: "document", visibleAt: "not a date" }), (error) => error.code === VCR_DATA_PLANE_CODES.payloadInvalid);
  await assert.rejects(() => upload(study, source.id, "bad.csv", "a,b\n1,2\n", { role: "document" }), (error) => error.code === VCR_DATA_PLANE_CODES.formatUnsupported);

  const listed = await vcr.dataPlane.listDocuments({ studyId: study.id, principal: OWNER });
  assert.deepEqual(listed.map((entry) => [entry.id, entry.subjectKey, entry.chars]), [[stored.file.id, stored.file.detail.subjectKey, text.length]]);
  assert.ok(!("text" in listed[0]), "a listing carries no text");
  const read = await vcr.dataPlane.documentText({ studyId: study.id, documentId: stored.file.id, principal: OWNER, purpose: "matching" });
  assert.equal(read.text, text);
  assert.equal(read.subjectKey, stored.file.detail.subjectKey);
  // Judged: another account's read is a 404, a member without a grant is refused, and every read is on the ledger.
  await assert.rejects(() => vcr.dataPlane.documentText({ studyId: study.id, documentId: stored.file.id, principal: STRANGER }), (error) => error.status === 404);
  await assert.rejects(() => vcr.dataPlane.documentText({ studyId: study.id, documentId: stored.file.id, principal: MANAGER, purpose: "matching" }), (error) => error.code === "vcr_no_grant");
  await assert.rejects(() => vcr.dataPlane.documentText({ studyId: study.id, documentId: stored.file.id, principal: OWNER, purpose: "geo" }), (error) => error.code === "vcr_purpose_not_granted");
  await assert.rejects(() => vcr.dataPlane.documentText({ studyId: study.id, documentId: "sfl_none", principal: OWNER }), (error) => error.code === VCR_DATA_PLANE_CODES.documentNotFound);
  const trail = await vcr.dataStore.auditTrail({ studyId: study.id, action: "access.read_patient_level" });
  assert.ok(trail.length >= 4 && trail.some((row) => row.outcome === "ok" && row.detail.note === "document"), "allowed and refused reads are both recorded");
  // A document's bytes are checked against the hash they were stored under.
  await fs.appendFile(path.join(plane, stored.file.location), "篡改");
  await assert.rejects(() => vcr.dataPlane.documentText({ studyId: study.id, documentId: stored.file.id, principal: OWNER }), (error) => error.code === VCR_DATA_PLANE_CODES.fileChanged);
});

// ---------------------------------------------------------------------------
// The engine accepts what the control plane resolved (contract §3.2)
// ---------------------------------------------------------------------------

/**
 * Run one job through the real `run_job.R`, with the plane as the engine's data
 * root, and read its result.
 * @param {Record<string, any>} job
 */
async function runEngine(job) {
  const issues = validateEngineJob(job);
  assert.deepEqual(issues.map((issue) => `${issue.code}@${issue.field}`), [], "the job the control plane built is a valid job");
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-intake-job-"));
  try {
    const jobFile = path.join(work, "job.json");
    const out = path.join(work, "out");
    await fs.writeFile(jobFile, JSON.stringify(job));
    const child = spawn("Rscript", [path.join(ENGINE_ROOT, "service", "run_job.R"), jobFile, out], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, VCR_R_LIBS: R_LIBS, VCR_ENGINE_ROOT: ENGINE_ROOT, VCR_ENGINE_DATA_ROOT: plane,
        OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    const result = JSON.parse(await fs.readFile(path.join(out, "result.json"), "utf8"));
    return { code, result, stderr };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** @param {string} kind @param {string} method @param {Record<string, any>} scenario @param {any[]} inputs @param {string} studyId */
function jobOf(kind, method, scenario, inputs, studyId) {
  counter += 1;
  return { jobId: `job_intake_${counter}`, studyId, kind, method, methodVersion: VCR_ENGINE_METHODS[/** @type {keyof typeof VCR_ENGINE_METHODS} */ (method)].version,
    protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, seed: 11, cpuSecondsLimit: 120, inputs, scenario };
}

test("PA-10 the real engine reads the inputs the control plane resolved: a profile of the raw files, a cohort on the subject table, and RMST on the events", options, async (t) => {
  const problem = engineProblem();
  if (problem) {
    // Required, or Rscript itself gone: a red run that says what is missing. With no library named the step
    // reports why it did not run, and the rest of the file stands.
    assert.ok(ENGINE_REQUIRED === false && problem.code === "library_unset",
      `${ENGINE_REQUIRED ? "VCR_ENGINE_TESTS=required: " : ""}this test is the proof the real engine reads what the control plane resolved, and this machine cannot run it — ${problem.message}`);
    t.skip(`the real engine is not available here: ${problem.message}`);
    return;
  }
  const study = await seedStudy({ intendedUse: "specified_analysis" });
  const { snapshot } = await seedFrozen(study);
  await vcr.seal.freezePlan({ studyId: study.id, plan: { endpoint: { type: "time_to_event" }, analysis: { method: "comparator.rmst" }, intendedUse: "specified_analysis" }, actor: OWNER });

  await t.test("profile_snapshot on the raw files", async () => {
    const resolved = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", jobKind: "profile_snapshot" });
    assert.deepEqual(resolved.inputs.map((input) => input.kind), ["snapshot_file", "snapshot_file"]);
    for (const input of resolved.inputs) {
      assert.ok(!path.isAbsolute(input.location) && !input.location.includes(".."));
      assert.equal(input.hash, await sha256OfFile(path.join(plane, input.location)), "the hash is that of exactly that file");
      assert.equal(input.valueSource, "observed");
    }
    const { result } = await runEngine(jobOf("profile_snapshot", "profile.snapshot", {}, resolved.inputs, study.id));
    assert.equal(result.status, "succeeded", JSON.stringify(result.issues ?? result.diagnostics?.issues ?? result).slice(0, 400));
    assert.equal(result.counts.realPatients, COHORT_SIZE, "the first file is the baseline: forty people");
    const text = JSON.stringify(result);
    for (const value of fingerprints()) assert.ok(!text.includes(`"${value}"`), `${value} is in the engine's profile`);
  });

  await t.test("build_cohort on the subject table, by rule", async () => {
    const resolved = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", jobKind: "build_cohort", include: ["subject"] });
    assert.equal(resolved.inputs[0].shape, "subject");
    const rules = [{ name: "年龄 45 岁及以上", rule: { op: "compare", column: "age", comparator: "gte", value: 45 } },
      { name: "ECOG 0-1", rule: { op: "in", column: "ecog", values: [0, 1] } }];
    const { result } = await runEngine(jobOf("build_cohort", "cohort.build", { rules }, resolved.inputs, study.id));
    assert.equal(result.status, "succeeded", JSON.stringify(result).slice(0, 500));
    assert.equal(result.counts.realPatients, result.measures.find((/** @type {any} */ measure) => measure.name === "cohort_size").value);
    assert.equal(result.diagnostics.startingRows, COHORT_SIZE);
    // The engine counts what the pseudonymised table says, and the same rules on the source bytes agree.
    const expected = [...cohortCsv().trim().split("\n").slice(1)].filter((line) => { const cells = line.split(","); return Number(cells[2]) >= 45 && [0, 1].includes(Number(cells[4])); }).length;
    assert.equal(result.measures.find((/** @type {any} */ measure) => measure.name === "cohort_size").value, expected);
  });

  await t.test("rmst on the subject and events tables: the censoring polarity survives derivation, and the events are real patients'", async () => {
    const resolved = await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", jobKind: "rmst", include: ["subject", "events"] });
    assert.deepEqual(resolved.inputs.map((input) => input.shape).sort(), ["events", "subject"]);
    const scenario = { tau: 24, treatmentColumn: "arm", timeUnit: "months", parameterCode: "OS" };
    const { result } = await runEngine(jobOf("rmst", "comparator.rmst", scenario, resolved.inputs, study.id));
    assert.equal(result.status, "succeeded", JSON.stringify(result).slice(0, 600));
    assert.equal(result.counts.realPatients, COHORT_SIZE);
    assert.equal(result.counts.events, COHORT_SIZE - COHORT_SIZE / 5, "OS_DEAD 1 is an event; OS_DEAD 0 is censored");
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

test("CS-43 deleting a study's files removes every patient-level byte the plane holds for it, the pseudonym key and the identity map included", options, async () => {
  const study = await seedStudy();
  const { snapshot } = await seedFrozen(study);
  const stranger = await seedStudy({ owner: STRANGER });
  await upload(stranger, (await vcr.dataPlane.registerSource({ userId: STRANGER, studyId: stranger.id, name: "别人的" })).id, "theirs.csv", "a,b\n1,2\n", { actor: STRANGER });
  await vcr.dataPlane.resolveSnapshotInputs({ studyId: study.id, snapshotId: snapshot.id, principal: OWNER, purpose: "vcr", jobKind: "build_cohort" });
  const directory = path.join(plane, "studies", study.id);
  const before = await fs.readdir(directory);
  assert.ok(["identity", "sources", "tables", ".pseudonym-key"].every((entry) => before.includes(entry)), before.join());
  assert.deepEqual(await vcr.dataPlane.deleteStudyFiles(study.id), { removed: true });
  await assert.rejects(() => fs.stat(directory));
  assert.ok((await fs.stat(path.join(plane, "studies", stranger.id))).isDirectory(), "another study's files are untouched");
  assert.deepEqual(await vcr.dataPlane.deleteStudyFiles("../" + stranger.id), { removed: false }, "a path is not a study id");
  assert.deepEqual(await vcr.dataPlane.deleteStudyFiles(study.id), { removed: false }, "and deleting twice is not an error");
});
