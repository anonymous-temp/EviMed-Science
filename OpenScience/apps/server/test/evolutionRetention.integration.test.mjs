// Retention of the two high-frequency record types of 循证进化 against the real ledger (`evolutionRetention.mjs`): the rows, their revisions and the transaction are
// the database's, which a Map double has none of. What is folded is what no reader can ask for again; what a reader can ask for stays, whatever its age.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { EvolutionService } from "../src/evolutionService.mjs";
import { createEvolutionRetention, EVOLUTION_FOLDED_EVENT_TYPES } from "../src/evolutionRetention.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const owner = `retention_${randomUUID()}`;
const DAY = 86_400_000;
let isolated, database, documents, jobs;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "evoret");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Evolution operator','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576)", [owner]);
  documents = new ProductDocuments(database); jobs = new ProductJobs(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

/** The service, and the retention, over the shared ledger; time is `ageDays` ahead of when the rows were written so that they are that old. */
function engine(config = {}, ageDays = 20) {
  const service = new EvolutionService({ documents, jobs, ownerId: owner, now: () => new Date(Date.now() + ageDays * DAY), config });
  return { service, retention: createEvolutionRetention({ service, config: { evolutionRecordRetentionDays: 14, evolutionRetentionBatchRows: 5000, ...config } }) };
}
const count = async (recordType) => Number((await database.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'=$2", [owner, recordType])).rows[0].n);
const revisions = async (id) => Number((await database.query("SELECT count(*)::integer AS n FROM evimed_product.revisions WHERE user_id=$1 AND id=$2", [owner, id])).rows[0].n);
/** Make a row young again: written 19 days after the old ones, i.e. one day old at the retention's clock. */
const rejuvenate = (id) => database.query("UPDATE evimed_product.documents SET created_at=clock_timestamp()+interval '19 days', updated_at=clock_timestamp()+interval '19 days' WHERE user_id=$1 AND id=$2", [owner, id]);

test("old observations that counted no failure are folded into the count of their day; the ones that counted a failure, and the young, stay", options, async () => {
  const { service, retention } = engine();
  const run = randomUUID().slice(0, 8);
  const clean = [], failing = [];
  for (let index = 0; index < 5; index++) clean.push((await service.save("module-observation", `evolution-module-observation-${run}-clean-${index}`, { moduleId: "frontier", kind: "edit-verification", counts: { failed: 0, numbersChecked: 3, numberFailures: 0, unitMismatches: 0 }, policyRevisionId: "frontier-editor-1.abc" })).id);
  for (let index = 0; index < 3; index++) clean.push((await service.save("module-observation", `evolution-module-observation-${run}-screened-${index}`, { moduleId: "frontier", kind: "screened-out", counts: {}, policyRevisionId: "policy-x" })).id);
  failing.push((await service.save("module-observation", `evolution-module-observation-${run}-title-only`, { moduleId: "frontier", kind: "edit-verification", counts: { failed: 1, numbersChecked: 0 } })).id);
  failing.push((await service.save("module-observation", `evolution-module-observation-${run}-numbers`, { moduleId: "frontier", kind: "edit-verification", counts: { failed: 0, numberFailures: 2 } })).id);
  failing.push((await service.save("module-observation", `evolution-module-observation-${run}-units`, { moduleId: "frontier", kind: "edit-verification", counts: { unitMismatches: 1 } })).id);
  const young = (await service.save("module-observation", `evolution-module-observation-${run}-young`, { moduleId: "frontier", kind: "edit-verification", counts: { failed: 0 } })).id;
  await rejuvenate(young);
  // The same rows seen by the platform's own readers: each failing one is an evidence root, read again by id.
  const before = await count("evolution-module-observation");
  const result = await retention.compact();
  assert.equal(result.observations, 8, "the five clean edits and the three screened-out entries");
  assert.equal(await count("evolution-module-observation"), before - 8);
  for (const id of clean) { assert.equal(await service.get(id), null); assert.equal(await revisions(id), 0, "its revisions went with it"); }
  for (const id of [...failing, young]) assert.ok(await service.get(id), `${id} is kept`);
  // The day's counts: one record per module, kind and day, with what the rows carried.
  const days = await service.list("module-observation-daily");
  const edits = days.find((row) => row.payload.kind === "edit-verification" && row.payload.counts.numbersChecked === 15), screened = days.find((row) => row.payload.kind === "screened-out");
  assert.ok(edits && screened);
  assert.equal(edits.payload.rows, 5); assert.equal(edits.payload.counts["revision:frontier-editor-1.abc"], 5); assert.equal(screened.payload.rows, 3);
  assert.equal(screened.payload.moduleId, "frontier");
  // A daily record is not an observation: the opportunity collector lists observations by their own record type and never meets one.
  assert.ok(!(await service.list("module-observation")).some((row) => row.payload.recordType !== "evolution-module-observation" || row.id.includes("-daily-")));
  // A second pass has nothing to do and counts nothing twice.
  assert.deepEqual(await retention.compact(), { observations: 0, events: 0 });
  assert.equal((await service.get(edits.id)).payload.rows, 5);
  assert.equal(retention.counters.observationsFolded, 8);
});

test("only the platform's own processed events of the closed types are folded; a dataset, a queued event and any other type stay", options, async () => {
  const { service, retention } = engine();
  const run = randomUUID().slice(0, 8);
  const event = async (type, status, extra = {}) => {
    const row = await service.save("event", `evolution-event-${run}-${type}-${status}-${randomUUID().slice(0, 4)}`, { id: `${type}:${run}`, type, status, createdAt: new Date().toISOString(), ...extra });
    return row.id;
  };
  const folded = [await event("frontier-publication", "processed"), await event("frontier-publication", "processed"), await event("handbook-gap-scan", "processed"), await event("tool-ready", "processed")];
  const kept = [await event("dataset-ready", "processed"), await event("frontier-publication", "queued"), await event("prospective-registration", "processed"), await event("evaluation-gap", "processed")];
  const young = await event("frontier-publication", "processed"); await rejuvenate(young);
  for (const type of ["dataset-ready", "prospective-registration", "evaluation-gap"]) assert.ok(!EVOLUTION_FOLDED_EVENT_TYPES.includes(type), type);
  const result = await retention.compact();
  assert.equal(result.events, 4);
  for (const id of folded) assert.equal(await service.get(id), null);
  for (const id of [...kept, young]) assert.ok(await service.get(id), `${id} is kept`);
  const days = await service.list("event-daily");
  assert.equal(days.find((row) => row.payload.type === "frontier-publication").payload.rows, 2);
  assert.equal(days.find((row) => row.payload.type === "tool-ready").payload.rows, 1);
  assert.ok(days.every((row) => row.payload.recordType === "evolution-event-daily" && !("payload" in row.payload)), "a daily count carries counts and no event");
  // An event another owner holds is not this owner's to fold.
  assert.equal((await service.list("event")).filter((row) => EVOLUTION_FOLDED_EVENT_TYPES.includes(row.payload.type) && row.payload.status === "processed" && Date.parse(row.updatedAt) < Date.now() + 5 * DAY).length, 0);
});

test("a pass takes at most the batch, oldest first, and the next pass takes the rest", options, async () => {
  const { service, retention } = engine({ evolutionRetentionBatchRows: 3 });
  const run = randomUUID().slice(0, 8), ids = [];
  for (let index = 0; index < 7; index++) ids.push((await service.save("module-observation", `evolution-module-observation-${run}-b${index}`, { moduleId: "autopilot", kind: "screened-out", counts: {} })).id);
  assert.equal((await retention.compact()).observations, 3);
  assert.equal((await retention.compact()).observations, 3);
  assert.equal((await retention.compact()).observations, 1);
  assert.equal((await retention.compact()).observations, 0);
  const total = (await service.list("module-observation-daily")).filter((row) => row.payload.moduleId === "autopilot").reduce((sum, row) => sum + row.payload.rows, 0);
  assert.equal(total, 7, "the days' counts add up to what was folded, across the passes");
});

test("a pass that fails leaves every row where it was and never reaches the job that called it", options, async () => {
  const { service, retention } = engine();
  const run = randomUUID().slice(0, 8);
  const id = (await service.save("module-observation", `evolution-module-observation-${run}-fail`, { moduleId: "geo", kind: "screened-out", counts: {} })).id;
  const save = service.save.bind(service);
  service.save = async (type, ...rest) => { if (type === "module-observation-daily") throw new Error("ledger unavailable"); return save(type, ...rest); };
  assert.deepEqual(await retention.compact(), { observations: 0, events: 0, skipped: "failed" });
  assert.ok(await service.get(id), "the transaction rolled back");
  assert.equal(retention.counters.failures, 1);
  service.save = save;
  assert.equal((await retention.compact()).observations, 1, "and the next pass does it");
});

test("a deployment without a database, or with retention switched off, folds nothing", async () => {
  const bare = { config: {}, documents: {}, now: () => new Date(), owner: async () => "operator" };
  assert.deepEqual(await createEvolutionRetention({ service: bare }).compact(), { observations: 0, events: 0, skipped: "no-database" });
  const off = { ...bare, documents: { database: { query: async () => assert.fail("off means no query") } } };
  assert.deepEqual(await createEvolutionRetention({ service: off, config: { evolutionRecordRetentionDays: 0 } }).compact(), { observations: 0, events: 0, skipped: "retention-off" });
});
