// The data tab's intake half, as the browser reads it (contract 2026-09-29 §5).
//
// A study is walked through the real intake — source, upload, field map,
// snapshot, tables, grant — on a scratch PostgreSQL and a scratch data-plane
// directory, and what `GET …/data` would send is compared, byte for byte after
// ids are numbered and clocks pinned, with the JSON files under
// `test/fixtures/vcr-views/intake/`. The web tests render the real DataTab from
// the same files through the real readers, so the server cannot change the page
// without the fixture changing and the fixture cannot change without the browser
// being shown what it will now receive.
//
//   VCR_VIEWS_WRITE_FIXTURES=1 node --test test/vcrIntakeView.integration.test.mjs
//
// rewrites only these files.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { FIXTURE_DIR } from "./vcrViewsFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { FIELD_MAP, cohortCsv, dictionaryCsv, streamOf, visitsCsv } from "./helpers/vcrIntakeData.mjs";

const WRITE = process.env.VCR_VIEWS_WRITE_FIXTURES === "1";
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const NOW = new Date("2026-09-29T08:00:00.000Z");
const OWNER = "view-owner";
const MANAGER = "view-manager";
const VIEWER = "view-viewer";

/** @type {any} */ let isolated = null;
/** @type {any} */ let database = null;
/** @type {any} */ let vcr = null;
/** @type {any} */ let service = null;
/** @type {string} */ let plane;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrview");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 3_000 });
  plane = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-intake-view-"));
  const config = { vcrEnabled: true, vcrDataPlaneDir: plane, vcrAudience: "all" };
  vcr = composeVcr({ config, productDatabase: database });
  await vcr.store.ready();
  // The people the page names are shown by name, from the control plane's users: three accounts, so the page can be read the way a person reads it.
  await database.query(`INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, '视图负责人', 'development'), ($2, '视图数据管理', 'development'), ($3, '视图查看者', 'development')`,
    [OWNER, MANAGER, VIEWER]);
  service = new VcrService({
    store: vcr.store, config, jobs: vcr.jobs, access: vcr.access, dataPlane: vcr.dataPlaneSeam, seal: vcr.seal,
    matchStore: vcr.matchStore, evidenceStore: vcr.evidenceStore, now: () => NOW,
  });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
  if (plane) await fs.rm(plane, { recursive: true, force: true });
});

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

/** A fixture's text: generated ids replaced by run-independent numbers. @param {unknown} value */
function normalize(value) {
  return `${JSON.stringify(value, null, 2).replace(/\b(std|src|snp|sfl|grt|atb|fmp)_[0-9a-f]{22}\b/g, (match) => number(match))}\n`;
}

/** @param {string} name @param {unknown} value */
function check(name, value) {
  const file = path.join(FIXTURE_DIR, "intake", name);
  const body = normalize(value);
  if (WRITE) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    return;
  }
  assert.equal(body, readFileSync(file, "utf8"), `${name} differs from what the service now sends; regenerate with VCR_VIEWS_WRITE_FIXTURES=1 and read the diff`);
}

/**
 * Pin every clock the intake wrote, so a fixture does not depend on when it ran —
 * and keep each table's own order, one minute apart, so the page lists things in
 * the order they were made and not in the order of their random ids.
 * @param {string} studyId
 */
async function pinClocks(studyId) {
  const at = (/** @type {number} */ hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
  const q = (/** @type {string} */ sql, /** @type {unknown[]} */ values) => database.query(sql, values);
  /** @param {string} table @param {string} column @param {number} hours */
  const spread = (table, column, hours) => q(`WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM evimed_vcr.${table} WHERE study_id = $1)
    UPDATE evimed_vcr.${table} t SET ${column} = $2::timestamptz + (ordered.rn * interval '1 minute') FROM ordered WHERE t.id = ordered.id`, [studyId, at(hours)]);
  await spread("sources", "created_at", 52);
  await spread("source_files", "created_at", 51);
  await spread("grants", "created_at", 47);
  await q("UPDATE evimed_vcr.sources SET updated_at = created_at, field_map_at = CASE WHEN field_map_at IS NULL THEN NULL ELSE $2::timestamptz END, field_map_confirmed_at = CASE WHEN field_map_confirmed_at IS NULL THEN NULL ELSE $3::timestamptz END WHERE study_id = $1",
    [studyId, at(50), at(49)]);
  await q("UPDATE evimed_vcr.snapshots SET frozen_at = $2, sealed_until = CASE WHEN sealed_until IS NULL THEN NULL ELSE $3::timestamptz END WHERE study_id = $1", [studyId, at(48), at(30)]);
  await q("UPDATE evimed_vcr.grants SET revoked_at = CASE WHEN revoked_at IS NULL THEN NULL ELSE $2::timestamptz END WHERE study_id = $1", [studyId, at(40)]);
  await q("UPDATE evimed_vcr.analysis_tables SET created_at = $2 WHERE study_id = $1", [studyId, at(48)]);
}

/** The scene: a confirmatory study with a frozen, sealed snapshot, a second source still being mapped, and a grant each way. */
async function scene() {
  const study = await vcr.store.createStudy({ userId: OWNER, projectId: `prj_view_${Math.random().toString(36).slice(2, 10)}`, name: "外部对照研究",
    question: "二线 NSCLC 的总生存期", dataTier: "T2", intendedUse: "specified_analysis" });
  await vcr.dataStore.addMember({ studyId: study.id, userId: MANAGER, role: "data_manager", invitedBy: OWNER, actor: OWNER });
  await vcr.dataStore.addMember({ studyId: study.id, userId: VIEWER, role: "viewer", invitedBy: OWNER, actor: OWNER });
  const first = await vcr.dataPlane.registerSource({ userId: MANAGER, studyId: study.id, name: "合作方基线", ownerParty: "合作方医院",
    allowedUses: ["vcr", "matching"], visibleWindow: { start: "2020-01-01" }, retention: { until: "2030-01-01", note: "五年" } });
  for (const [name, body, role] of [["cohort.csv", cohortCsv(), "data"], ["visits.csv", visitsCsv(), "data"], ["dictionary.csv", dictionaryCsv(), "dictionary"]]) {
    await vcr.dataPlane.storeUpload({ actor: MANAGER, studyId: study.id, sourceId: first.id, name, role, stream: streamOf(body) });
  }
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: MANAGER, studyId: study.id, sourceId: first.id, by: "run",
    columns: FIELD_MAP.map((entry) => (entry.column === "ARM" ? { ...entry, codes: { treated: ["TRT"], control: ["CTL"] } } : entry)) });
  await vcr.dataPlane.confirmFieldMap({ actor: MANAGER, studyId: study.id, sourceId: first.id, hash: proposed.hash });
  await vcr.dataPlane.freezeSnapshot({ userId: MANAGER, studyId: study.id, sourceId: first.id });
  await vcr.dataPlane.createGrant({ actor: MANAGER, studyId: study.id, sourceId: first.id, grantee: OWNER, role: "lead", fields: ["AGE", "ARM", "SEX"], purposes: ["vcr"] });
  const gone = await vcr.dataPlane.createGrant({ actor: MANAGER, studyId: study.id, sourceId: first.id, grantee: "role:viewer", purposes: ["vcr"] });
  await vcr.dataPlane.revokeGrant({ actor: MANAGER, studyId: study.id, grantId: gone.id });
  // A second source: one file, a map with problems, nothing frozen.
  const second = await vcr.dataPlane.registerSource({ userId: OWNER, studyId: study.id, name: "医院随访表", valueSource: "extracted" });
  await vcr.dataPlane.storeUpload({ actor: OWNER, studyId: study.id, sourceId: second.id, name: "followup.csv", stream: streamOf("PATIENT_NO,ARM,DEAD\nA1,TRT,1\nA2,CTL,0\n") });
  await vcr.dataPlane.proposeFieldMap({ actor: OWNER, studyId: study.id, sourceId: second.id, columns: [
    { table: "followup.csv", column: "ARM", role: "arm", alias: "arm" }, { table: "followup.csv", column: "DEAD", role: "outcome_event", parameter: "OS" }] });
  await pinClocks(study.id);
  return study;
}

test("PA-10 the data tab's intake block: sources with their files, map, grants and snapshots, the seal standing, no path and no row", options, async () => {
  const study = await scene();
  const page = await service.tab({ id: OWNER }, study.id, "data");
  const intake = page.intake;
  assert.equal(intake.available, true);
  assert.equal(intake.canManage, true);
  assert.equal(intake.sources.length, 2);
  const [first, second] = intake.sources;
  assert.equal(first.fieldMap.state, "confirmed");
  assert.equal(first.fieldMap.by, "AI 提议");
  assert.equal(first.files.filter((/** @type {any} */ file) => file.role === "data").length, 2);
  assert.equal(first.grants.length, 2);
  assert.equal(first.grants.filter((/** @type {any} */ grant) => grant.revoked).length, 1);
  assert.equal(first.canGrant, false, "the owner of the study is not the source's own account");
  assert.equal(second.fieldMap.state, "proposed");
  assert.ok(second.fieldMap.issues.some((/** @type {any} */ issue) => issue.code === "subject_key_missing"), "the map's problems are told with the map");
  assert.equal(intake.snapshots.length, 1);
  assert.deepEqual(intake.snapshots[0].sealedFields, ["OS_DEAD", "OS_MONTHS"]);
  assert.equal(intake.snapshots[0].sealed, true);
  assert.deepEqual(intake.snapshots[0].tables.map((/** @type {any} */ table) => table.shape), ["events", "longitudinal", "subject"]);
  assert.equal(intake.seal.required, true);
  assert.match(intake.seal.note, /尚未冻结/);
  const text = JSON.stringify(page);
  assert.equal(text.includes(plane), false, "no path of the server");
  assert.equal(text.includes("HZ-30001"), false, "no subject id of the partner's");
  assert.equal(text.includes("11.10"), false, "and no outcome value");
  check("data-sealed.json", page);

  // The plan freezes and an outcome is read: the seal lifts as of the freeze, the two timestamps show in order.
  await database.query("UPDATE evimed_vcr.studies SET outcome_seal = $2::jsonb WHERE id = $1", [study.id, JSON.stringify({
    planFrozenAt: "2026-09-28T08:00:00.000Z", planHash: "c".repeat(64), planVersion: 1, outcomeFirstReadAt: "2026-09-28T09:30:00.000Z", outcomeFieldsRead: ["OS_DEAD", "OS_MONTHS"] })]);
  await database.query("UPDATE evimed_vcr.snapshots SET sealed_until = $2 WHERE study_id = $1", [study.id, "2026-09-28T08:00:00.000Z"]);
  const lifted = await service.tab({ id: OWNER }, study.id, "data");
  assert.equal(lifted.intake.seal.ordered, true);
  assert.equal(lifted.intake.snapshots[0].sealed, false);
  assert.ok(lifted.intake.seal.planFrozenAt && lifted.intake.seal.outcomeFirstReadAt);
  check("data-lifted.json", lifted);
});

test("AC-17 a member who may read the study but was granted nothing sees the sources' names and states, and none of their columns", options, async () => {
  const study = await scene();
  const page = await service.tab({ id: VIEWER }, study.id, "data");
  assert.equal(page.intake.available, true);
  assert.equal(page.intake.canManage, false);
  for (const source of page.intake.sources) {
    assert.equal(source.readable, false);
    assert.deepEqual(source.fieldMap.columns, []);
    assert.deepEqual(source.files, [], "a source's files, its grants and its map are not told to someone with no grant");
    assert.deepEqual(source.grants, []);
  }
  check("data-viewer.json", page);
  // And the tab of a study with the plane composed but nothing uploaded.
  const bare = await vcr.store.createStudy({ userId: OWNER, projectId: `prj_bare_${Math.random().toString(36).slice(2, 10)}`, name: "还没有数据", dataTier: "T1" });
  check("data-none.json", await service.tab({ id: OWNER }, bare.id, "data"));
});
