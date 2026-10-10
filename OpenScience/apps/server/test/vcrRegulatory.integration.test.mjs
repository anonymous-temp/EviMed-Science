// The regulatory-contact log on a real PostgreSQL (review gap G10): the rows a write leaves, the identical repeat, the cap, the order, what
// the runtime reads back and what the report model carries. Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { VCR_REGULATORY_LIMITS } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { HttpError } from "../src/security.mjs";
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
/** @type {VcrService} */
let service;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "reg");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
  service = new VcrService({ store, config: { vcrEnabled: true, vcrAudience: "all", vcrMinCellSize: 10 } });
});

after(async () => {
  await database?.close().catch(() => {});
  await isolated?.drop();
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

let counter = 0;
/** A study to keep a log for. */
async function furnish() {
  counter += 1;
  const study = await store.createStudy({ userId: `u_reg_${counter}`, projectId: `prj_reg_${counter}`, name: `EV-201 ${counter}`, question: "q", dataTier: "T0" });
  return { study };
}

test("the migration gives regulatory_contacts the columns the writes need, and runs again without complaint", options, async () => {
  const columns = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'evimed_vcr' AND table_name = 'regulatory_contacts'")).map((row) => row.column_name);
  for (const name of ["summary", "attachments", "recorded_by", "source_ref", "conclusion", "meeting"]) assert.ok(columns.includes(name), `regulatory_contacts.${name}`);
  const { vcrSchemaSql } = await import("../src/vcrPersistence.mjs");
  await database.transaction(async (client) => { await client.query(vcrSchemaSql()); });
});

test("a contact is added as written, the date stays the date, an exact repeat is the same record, and a correction is another", options, async () => {
  const { study } = await furnish();
  const input = { studyId: study.id, userId: study.userId, actor: study.userId, date: "2026-08-14", agency: "NMPA-CDE", type: "Pre-IND 沟通交流",
    summary: "讨论单臂加外部对照", outcome: "同意以外部对照作支持性证据", attachments: ["minutes.pdf", "briefing/package.zip"] };
  const first = await store.addRegulatoryContact(input);
  assert.deepEqual([first.date, first.agency, first.type, first.summary, first.outcome, first.attachments, first.source, first.existing],
    ["2026-08-14", "NMPA-CDE", "Pre-IND 沟通交流", "讨论单臂加外部对照", "同意以外部对照作支持性证据", ["minutes.pdf", "briefing/package.zip"], "researcher", false]);
  assert.match(first.id, /^reg_[0-9a-f]{22}$/);
  assert.equal((await q("SELECT source_ref FROM evimed_vcr.regulatory_contacts WHERE id = $1", [first.id]))[0].source_ref, "minutes.pdf", "the first reference also lives in source_ref");
  const repeat = await store.addRegulatoryContact(input);
  assert.deepEqual([repeat.id, repeat.existing], [first.id, true], "the run that retried after a timeout did not write it twice");
  const corrected = await store.addRegulatoryContact({ ...input, outcome: "更正：需补充外部对照的可比性评估" });
  assert.notEqual(corrected.id, first.id);
  const byRun = await store.addRegulatoryContact({ ...input, actor: "ai_set", date: "2026-09-01", agency: "FDA", type: "", summary: "", outcome: "", attachments: [] });
  assert.equal(byRun.source, "ai_set");
  assert.deepEqual([byRun.type, byRun.attachments], ["", []]);
  // the latest date first; one with no date after the dated ones
  await q("INSERT INTO evimed_vcr.regulatory_contacts (id, study_id, user_id, agency, occurred_on) VALUES ('reg_legacy', $1, $2, 'EMA', NULL)", [study.id, study.userId]);
  await q("INSERT INTO evimed_vcr.regulatory_contacts (id, study_id, user_id, agency, source_ref, occurred_on) VALUES ('reg_ref', $1, $2, 'PMDA', 'letter.pdf', '2026-01-02')", [study.id, study.userId]);
  const log = await store.regulatoryContacts(study.id);
  assert.deepEqual(log.map((entry) => [entry.date, entry.agency]), [["2026-09-01", "FDA"], ["2026-08-14", "NMPA-CDE"], ["2026-08-14", "NMPA-CDE"], ["2026-01-02", "PMDA"], [null, "EMA"]]);
  assert.deepEqual(log.find((entry) => entry.agency === "PMDA").attachments, ["letter.pdf"], "a row written with only a source_ref still reads as an attachment");
  assert.deepEqual(await store.regulatoryContacts("std_does_not_exist"), []);
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.regulatory.add'", [study.id]))[0].n, 3, "the repeat wrote no audit row");
});

test("a study keeps at most the contacts the cap names; a contact already in the log is still answered", options, async () => {
  const { study } = await furnish();
  await q(`INSERT INTO evimed_vcr.regulatory_contacts (id, study_id, user_id, agency, occurred_on)
    SELECT 'reg_fill_' || n, $1, $2, 'FDA', DATE '2020-01-01' + n FROM generate_series(1, $3::int) AS n`, [study.id, study.userId, VCR_REGULATORY_LIMITS.contacts]);
  await assert.rejects(store.addRegulatoryContact({ studyId: study.id, userId: study.userId, actor: "ai_set", date: "2026-08-14", agency: "EMA" }),
    (error) => error instanceof HttpError && error.status === 409 && /最多 500 条/.test(error.message));
  const known = await store.addRegulatoryContact({ studyId: study.id, userId: study.userId, actor: "ai_set", date: "2020-01-02", agency: "FDA" });
  assert.equal(known.existing, true);
});

test("the runtime reads the log, the latest first and a page at a time; nothing in it is a small cell", options, async () => {
  const { study } = await furnish();
  for (const index of [1, 2, 3]) await store.addRegulatoryContact({ studyId: study.id, userId: study.userId, actor: "ai_set", date: `2026-08-0${index}`, agency: `A${index}` });
  const log = await service.runtimeRead(study, "regulatory_contacts", { limit: 2 });
  assert.deepEqual(log.contacts.map((entry) => entry.agency), ["A3", "A2"]);
  assert.equal(log.more, true);
  assert.equal((await service.runtimeRead(study, "regulatory_contacts")).more, false);
  const empty = await furnish();
  assert.deepEqual(await service.runtimeRead(empty.study, "regulatory_contacts"), { contacts: [], more: false });
});

test("the report model carries the log, so a package freezes it", options, async () => {
  const { study } = await furnish();
  await store.addRegulatoryContact({ studyId: study.id, userId: study.userId, actor: study.userId, date: "2026-08-14", agency: "NMPA-CDE", outcome: "同意" });
  const model = await service.reportModel(study);
  assert.deepEqual(model.regulatoryContacts.map((entry) => [entry.date, entry.agency, entry.outcome]), [["2026-08-14", "NMPA-CDE", "同意"]]);
  const bare = await furnish();
  assert.deepEqual((await service.reportModel(bare.study)).regulatoryContacts, []);
});

test("deleting a study takes its regulatory log with it", options, async () => {
  const { study } = await furnish();
  await store.addRegulatoryContact({ studyId: study.id, userId: study.userId, actor: study.userId, date: "2026-08-14", agency: "FDA" });
  await database.transaction((client) => deleteVcrStudyRows(client, study.id));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.regulatory_contacts WHERE study_id = $1", [study.id]))[0].n, 0);
});
