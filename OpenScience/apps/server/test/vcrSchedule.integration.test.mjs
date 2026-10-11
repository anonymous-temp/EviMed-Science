// The schedule of activities on a real PostgreSQL (review gap G10): the rows a write leaves, a visit replaced and removed by name, the
// schedule a new protocol version starts with, the cap, what the runtime reads back and what the report model carries. Skipped when
// OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { VCR_SOA_LIMITS } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { HttpError } from "../src/security.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { deleteVcrStudyRows } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrStore} */
let store;
/** @type {VcrMatchStore} */
let matchStore;
/** @type {VcrService} */
let service;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "soa");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  matchStore = new VcrMatchStore({ database });
  await store.ready();
  service = new VcrService({ store, config: { vcrEnabled: true, vcrAudience: "all", vcrMinCellSize: 10 }, matchStore });
});

after(async () => {
  await database?.close().catch(() => {});
  await isolated?.drop();
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

let counter = 0;
/** A study with a first protocol version, so a schedule has something to belong to. */
async function furnish() {
  counter += 1;
  const study = await store.createStudy({ userId: `u_soa_${counter}`, projectId: `prj_soa_${counter}`, name: `EV-201 ${counter}`, question: "q", dataTier: "T0" });
  const protocol = await store.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "EV-201 v1", criteria: [] });
  return { study, protocol };
}

const visit = (name, day, activities, extra = {}) => ({ visit: name, day, windowDays: 3, note: "", procedures: activities.map((entry) => (typeof entry === "string" ? { name: entry } : entry)), ...extra });
const save = (study, protocol, visits) => store.saveScheduleVisits({ studyId: study.id, userId: study.userId, protocolVersionId: protocol.id, actor: "ai_set", visits });


test("the migration gives soa_items the columns the writes need, and runs again without complaint", options, async () => {
  const columns = async (table) => (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'evimed_vcr' AND table_name = $1", [table])).map((row) => row.column_name);
  for (const name of ["ordinal", "position", "visit_note", "note", "burden"]) assert.ok((await columns("soa_items")).includes(name), `soa_items.${name}`);
  const { vcrSchemaSql } = await import("../src/vcrPersistence.mjs");
  await database.transaction(async (client) => { await client.query(vcrSchemaSql()); });
});

test("visits are written by name: a visit replaces the visit of that name, whatever its case and spacing, and the others stand", options, async () => {
  const { study, protocol } = await furnish();
  const first = await save(study, protocol, [
    visit("第 4 周", 29, ["血常规", { name: "肿瘤评估", note: "RECIST 1.1" }]), visit("基线", 1, ["体格检查", "血常规"], { note: "首次给药" }), visit("筛选期", -14, ["知情同意"]),
  ]);
  assert.deepEqual(first.map((entry) => [entry.visit, entry.activities, entry.replaced, entry.removed]), [["第 4 周", 2, false, false], ["基线", 2, false, false], ["筛选期", 1, false, false]]);
  assert.ok(first.every((entry) => /^soa_[0-9a-f]{22}$/.test(entry.id)));
  const read = await store.schedule(protocol.id);
  assert.deepEqual(read.map((entry) => entry.visit), ["筛选期", "基线", "第 4 周"], "by day, not in the order they were written");
  assert.deepEqual(read[2].procedures, [{ name: "血常规", note: "" }, { name: "肿瘤评估", note: "RECIST 1.1" }], "each visit's activities in the order they were written");
  assert.equal(read[1].note, "首次给药");

  const again = await save(study, protocol, [visit("  第 4  周 ", 28, ["血常规"], { windowDays: 2 }), visit("第 2 周", 15, ["血常规"])]);
  assert.deepEqual(again.map((entry) => [entry.visit, entry.replaced]), [["  第 4  周 ", true], ["第 2 周", false]]);
  const after = await store.schedule(protocol.id);
  assert.deepEqual(after.map((entry) => [entry.visit, entry.day]), [["筛选期", -14], ["基线", 1], ["第 2 周", 15], ["  第 4  周 ", 28]], "the new spelling and day, the new place by day");
  assert.deepEqual(after[3].procedures, [{ name: "血常规", note: "" }], "the visit was replaced, not added to");
  assert.equal(after[3].windowDays, 2);
  assert.deepEqual(after[1].procedures.map((entry) => entry.name), ["体格检查", "血常规"], "a visit that was not mentioned is untouched");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.soa_items WHERE protocol_version_id = $1", [protocol.id]))[0].n, 5, "one row per activity at a visit: 1 + 2 + 1 + 1");
  // a visit with no planned day goes last, however it was written
  await save(study, protocol, [visit("提前终止", null, ["不良事件评估"], { windowDays: null })]);
  assert.equal((await store.schedule(protocol.id)).at(-1).visit, "提前终止");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.soa.save'", [study.id]))[0].n, 3, "every write is audited, once");
});

test("remove takes a visit out; removing one the schedule does not have changes nothing and says so", options, async () => {
  const { study, protocol } = await furnish();
  await save(study, protocol, [visit("基线", 1, ["体格检查"]), visit("第 2 周", 15, ["血常规"])]);
  const done = await save(study, protocol, [{ visit: "第 2 周", remove: true, procedures: [] }, { visit: "第 9 周", remove: true, procedures: [] }]);
  assert.deepEqual(done.map((entry) => [entry.visit, entry.removed, entry.id]), [["第 2 周", true, null], ["第 9 周", false, null]]);
  assert.deepEqual((await store.schedule(protocol.id)).map((entry) => entry.visit), ["基线"]);
});

test("two runs writing at once both land; a protocol version of another study is refused; the cap holds", options, async () => {
  const { study, protocol } = await furnish();
  await Promise.all(Array.from({ length: 6 }, (_, index) => save(study, protocol, [visit(`并发 ${index}`, index * 7, ["血常规"])])));
  assert.equal((await store.schedule(protocol.id)).length, 6);
  assert.deepEqual((await q("SELECT DISTINCT ordinal FROM evimed_vcr.soa_items WHERE protocol_version_id = $1 ORDER BY ordinal", [protocol.id])).map((row) => row.ordinal).length, 6, "six places, no two the same");

  const other = await furnish();
  await assert.rejects(save(other.study, protocol, [visit("a", 1, ["x"])]), (error) => error instanceof HttpError && error.status === 404, "another study's version is not this study's");

  const full = await furnish();
  await database.transaction(async (client) => {
    for (let index = 0; index < VCR_SOA_LIMITS.visits; index += 1) {
      await client.query(`INSERT INTO evimed_vcr.soa_items (id, protocol_version_id, user_id, visit, day, procedure, ordinal, position)
        VALUES ($1, $2, $3, $4, $5, 'x', $6, 0)`, [`soa_fill_${index}`, full.protocol.id, full.study.userId, `v${index}`, index, index + 1]);
    }
  });
  await assert.rejects(save(full.study, full.protocol, [visit("one too many", 999, ["x"])]),
    (error) => error instanceof HttpError && error.status === 409 && /最多写 80 次访视/.test(error.message));
  assert.equal((await store.schedule(full.protocol.id)).length, VCR_SOA_LIMITS.visits, "nothing was written");
  const replaced = await save(full.study, full.protocol, [visit("v3", 3, ["y"])]);
  assert.equal(replaced[0].replaced, true, "a full schedule can still correct a visit");
  await save(full.study, full.protocol, [{ visit: "v0", remove: true, procedures: [] }, visit("fits now", 999, ["x"])]);
  assert.equal((await store.schedule(full.protocol.id)).length, VCR_SOA_LIMITS.visits);
});

test("a new protocol version starts with the schedule the one before it had, whichever store writes it, and the old version keeps its own", options, async () => {
  const { study, protocol: v1 } = await furnish();
  await save(study, v1, [visit("基线", 1, ["体格检查", "血常规"], { note: "首次给药" }), visit("第 4 周", 29, ["肿瘤评估"])]);
  const v2 = await store.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "EV-201 v2", criteria: [] });
  assert.equal(v2.version, 2);
  assert.deepEqual(await store.schedule(v2.id), await store.schedule(v1.id), "the same visits, activities, windows and notes");
  assert.notDeepEqual((await q("SELECT id FROM evimed_vcr.soa_items WHERE protocol_version_id = $1", [v2.id])).map((row) => row.id).sort(),
    (await q("SELECT id FROM evimed_vcr.soa_items WHERE protocol_version_id = $1", [v1.id])).map((row) => row.id).sort(), "copies, not the same rows");
  await save(study, v2, [visit("第 4 周", 28, ["肿瘤评估", "影像"])]);
  assert.equal((await store.schedule(v1.id)).at(-1).day, 29, "an edit of the new version leaves the old one as it was");
  assert.equal((await store.latestSchedule(study.id)).protocol.version, 2, "a schedule is read from the current version");
  // the matching store writes versions too (the criteria write and the page's card edit)
  const v3 = await matchStore.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "EV-201 v3", criteria: [{ kind: "inclusion", criterionType: "other", requirement: { op: "language", key: "k", text: "t" } }] });
  assert.equal(v3.version, 3);
  assert.deepEqual((await store.schedule(v3.id)).map((entry) => [entry.visit, entry.day, entry.procedures.length]), [["基线", 1, 2], ["第 4 周", 28, 2]]);
  const audit = await q("SELECT detail FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.protocol.save' ORDER BY id", [study.id]);
  assert.deepEqual(audit.map((row) => row.detail.schedule), [0, 3, 4], "the audit says how many rows came along: none, then v1's three, then v2's four");
  // another study's schedule does not follow a version it did not write
  const other = await furnish();
  assert.deepEqual(await store.schedule(other.protocol.id), []);
  const next = await store.saveProtocolVersion({ studyId: other.study.id, userId: other.study.userId, title: "v2", criteria: [] });
  assert.deepEqual(await store.schedule(next.id), []);
  assert.equal(await store.latestSchedule("std_does_not_exist"), null);
});

test("deleting a study takes its schedule with it", options, async () => {
  const { study, protocol } = await furnish();
  await save(study, protocol, [visit("基线", 1, ["体格检查"])]);
  await database.transaction((client) => deleteVcrStudyRows(client, study.id));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.soa_items WHERE protocol_version_id = $1", [protocol.id]))[0].n, 0);
});

test("the runtime reads the schedule with the times a trajectory would take; nothing in it is a small cell", options, async () => {
  const { study, protocol: v1 } = await furnish();
  await save(study, v1, [visit("筛选期", -14, ["知情同意"]), visit("基线", 1, ["体格检查"]), visit("第 2 周", 15, ["血常规"]), visit("第 4 周", 29, ["血常规"])]);
  const v2 = await store.saveProtocolVersion({ studyId: study.id, userId: study.userId, title: "v2", criteria: [] });
  await save(study, v2, [visit("第 8 周", 57, ["血常规"])]);
  const read = await service.runtimeRead(study, "soa");
  assert.equal(read.protocol.version, 2);
  assert.deepEqual(read.visits.map((entry) => entry.visit), ["筛选期", "基线", "第 2 周", "第 4 周", "第 8 周"]);
  assert.deepEqual(read.totals, { visits: 5, activities: 3, entries: 5, firstDay: -14, lastDay: 57 }, "small counts of visits are not people and are not hidden");
  assert.deepEqual(read.visitTimes.weeks, [0, 2, 4, 8]);
  assert.equal(read.visitTimes.baselineDay, 1);
  const older = await service.runtimeRead(study, "soa", { protocolVersionId: v1.id });
  assert.equal(older.protocol.version, 1);
  assert.equal(older.visits.length, 4);
  const foreign = await service.runtimeRead(study, "soa", { protocolVersionId: (await furnish()).protocol.id });
  assert.deepEqual([foreign.protocol, foreign.visits, foreign.visitTimes], [null, [], null], "another study's version reads as no version");
});

test("the report model carries the schedule, so a package freezes it and a template may bind to it", options, async () => {
  const { study, protocol } = await furnish();
  await save(study, protocol, [visit("基线", 1, ["体格检查"]), visit("第 4 周", 29, ["血常规", "肿瘤评估"])]);
  const model = await service.reportModel(study);
  assert.equal(model.schedule.protocolVersion, 1);
  assert.deepEqual(model.schedule.totals, { visits: 2, activities: 3, entries: 3, firstDay: 1, lastDay: 29 });
  const bare = await furnish();
  assert.equal((await service.reportModel(bare.study)).schedule, null);
});
