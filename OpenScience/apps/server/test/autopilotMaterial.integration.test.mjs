import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { SourceService } from "../src/sourceService.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const sha = (text) => createHash("sha256").update(text).digest("hex");

async function fixture(t) {
  const isolated = await createGeoTestDatabase(databaseUrl, "automaterial");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  t.after(async () => { await database.close(); await isolated.drop(); });
  const owner = `mat_${randomUUID()}`; const other = `mat_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Material owner','development'),($2,'Other','development')", [owner, other]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'one','One',1048576),($1,'two','Two',1048576),($2,'one','Theirs',1048576)", [owner, other]);
  const documents = new ProductDocuments(database); const jobs = new ProductJobs(database);
  const service = new AutopilotService({ documents, jobs });
  const sources = new SourceService(documents, jobs);
  const input = { title: "Question", topics: ["research"], taskTypes: ["evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: "UTC" };
  const agenda = await service.create(owner, { ...input, projectId: "one" });
  const second = await service.create(owner, { ...input, projectId: "one", title: "A different question" });
  const elsewhere = await service.create(owner, { ...input, projectId: "two", title: "Another project" });
  /** What the knowledge-base upload does: write a file, register it by path and digest. */
  const upload = (userId, projectId, name, body) => sources.register(userId, { projectId, connector: { type: "upload", id: `${projectId}-library` },
    path: `knowledge-base/${name}`, size: body.length, mtime: new Date().toISOString(), mimeType: "text/csv", sha256: sha(body) });
  return { database, documents, service, sources, owner, other, agenda, second, elsewhere, upload };
}

test("Postgres: the digest of an upload names the source it became, and only this question's project can have it", options, async (t) => {
  const f = await fixture(t);
  const registered = await f.upload(f.owner, "one", "ages.csv", "age,n\n40,12\n");
  await f.upload(f.owner, "two", "other.csv", "x,y\n1,2\n");
  await f.upload(f.other, "one", "theirs.csv", "p,q\n3,4\n");

  const added = await f.service.addMaterials(f.owner, f.agenda.id, { sha256: [sha("age,n\n40,12\n")] });
  assert.deepEqual(added.payload.materials.map((item) => item.sourceId), [registered.source.id], "register and the digest agree on the id");
  for (const body of ["x,y\n1,2\n", "p,q\n3,4\n", "never uploaded"]) {
    await assert.rejects(() => f.service.addMaterials(f.owner, f.agenda.id, { sha256: [sha(body)] }), { code: "autopilot_material_not_found" }, body);
  }
  await assert.rejects(() => f.service.addMaterials(f.other, f.agenda.id, { sha256: [sha("age,n\n40,12\n")] }), { code: "autopilot_agenda_not_found" }, "another account has no such question");
  // Another project of the same account is another scope: the same bytes are another source there.
  await assert.rejects(() => f.service.addMaterials(f.owner, f.elsewhere.id, { sha256: [sha("age,n\n40,12\n")] }), { code: "autopilot_material_not_found" });
});

test("Postgres: the researcher's reading names the material of its own question, as the ledger says it is now, and survives a removed source", options, async (t) => {
  const f = await fixture(t);
  const registered = await f.upload(f.owner, "one", "ages.csv", "age,n\n40,12\n");
  await f.service.addMaterials(f.owner, f.agenda.id, { sha256: [sha("age,n\n40,12\n")] });
  let state = await f.service.researchState(f.owner, f.agenda.id);
  assert.deepEqual(state.materials.map((item) => [item.sourceId, item.name, item.state]), [[registered.source.id, "ages.csv", "reading"]], "the ledger's own state: the file is queued, not yet readable");
  assert.deepEqual((await f.service.researchState(f.owner, f.second.id)).materials, [], "a different question in the same project has none of it");

  // The source was read: the page's reading follows the ledger, not what was said when it was added.
  const current = await f.documents.get(f.owner, "source", registered.source.id);
  await f.documents.put(f.owner, "source", current.id, { ...current.payload, status: "complete" }, { expectedRevision: current.revision, projectId: "one" });
  state = await f.service.researchState(f.owner, f.agenda.id);
  assert.equal(state.materials[0].state, "ready");

  // Removed from the knowledge base, it is no longer material; the question carries on.
  const latest = await f.documents.get(f.owner, "source", registered.source.id);
  await f.documents.remove(f.owner, "source", latest.id, latest.revision);
  state = await f.service.researchState(f.owner, f.agenda.id);
  assert.deepEqual(state.materials, []);
});

test("Postgres: a new version of a document takes the old version's place in the material, and a full list admits it without room", options, async (t) => {
  const f = await fixture(t);
  const logicalPath = "knowledge-base/databases/public.cohort-1a2b3c4d.csv";
  const version = (body) => f.sources.register(f.owner, { projectId: "one", connector: { type: "upload", id: "one-library" }, logicalPath,
    path: `knowledge-base/databases/.evimed-revisions/${sha(body)}/public.cohort-1a2b3c4d.csv`, size: body.length, mtime: new Date().toISOString(), mimeType: "text/csv", sha256: sha(body) });
  const materials = async (agendaId = f.agenda.id) => (await f.service.get(f.owner, agendaId)).payload.materials.map((item) => item.sourceId);
  const first = await version("id\n1\n");
  await f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: [first.source.id] }, { replacingLogicalPath: logicalPath });
  await f.service.addMaterials(f.owner, f.second.id, { sourceIds: [first.source.id] });
  assert.deepEqual(await materials(), [first.source.id]);

  // The second version: the first is retired by the registry, and the question points at the new one, not at both.
  const second = await version("id\n1\n2\n");
  assert.notEqual(second.source.id, first.source.id); assert.equal(second.source.payload.version, 2);
  await f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: [second.source.id] }, { replacingLogicalPath: logicalPath });
  assert.deepEqual(await materials(), [second.source.id]);
  assert.deepEqual(await materials(f.second.id), [first.source.id], "another question keeps what it added: nothing here rewrites it");
  // Without the path of the document a new source simply joins, as it always did.
  const plain = await f.upload(f.owner, "one", "ages.csv", "age,n\n40,12\n");
  await f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: [plain.source.id] });
  assert.deepEqual(await materials(), [second.source.id, plain.source.id]);
  // The same bytes again change nothing, and the list is not rewritten.
  const revision = (await f.service.get(f.owner, f.agenda.id)).revision;
  await f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: [second.source.id] }, { replacingLogicalPath: logicalPath });
  assert.equal((await f.service.get(f.owner, f.agenda.id)).revision, revision);

  // A full list: a new document is refused, a new version of a document it holds is admitted, and the room is asked for before the work.
  const filler = [];
  for (let index = 0; index < 18; index += 1) filler.push((await f.upload(f.owner, "one", `room-${index}.csv`, `x\n${index}\n`)).source.id);
  await f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: filler.slice(0, 9) });
  await f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: filler.slice(9) });
  assert.equal((await materials()).length, 20);
  await assert.rejects(() => f.service.assertMaterialRoom(f.owner, f.agenda.id, "knowledge-base/databases/public.other-aaaaaaaa.csv"), { code: "autopilot_materials_full" });
  await f.service.assertMaterialRoom(f.owner, f.agenda.id, logicalPath);
  const extra = await f.upload(f.owner, "one", "one-more.csv", "x\nmore\n");
  await assert.rejects(() => f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: [extra.source.id] }), { code: "autopilot_materials_full" });
  const third = await version("id\n1\n2\n3\n");
  await f.service.addMaterials(f.owner, f.agenda.id, { sourceIds: [third.source.id] }, { replacingLogicalPath: logicalPath });
  const after = await materials();
  assert.equal(after.length, 20); assert(after.includes(third.source.id)); assert(!after.includes(second.source.id), "the new version took the old one's place");
  // A question that is not this account's has no room to ask about.
  await assert.rejects(() => f.service.assertMaterialRoom(f.other, f.agenda.id, logicalPath), { code: "autopilot_agenda_not_found" });
});

test("Postgres: a registered table keeps the facts of its import, refuses facts that are not ours, and brings them up to date for the same bytes", options, async (t) => {
  const f = await fixture(t);
  const body = "id\n1\n";
  const input = (extra) => ({ projectId: "one", connector: { type: "upload", id: "one-library" }, logicalPath: "knowledge-base/databases/public.cohort-1a2b3c4d.csv",
    path: `knowledge-base/databases/.evimed-revisions/${sha(body)}/public.cohort-1a2b3c4d.csv`, size: body.length, mtime: new Date().toISOString(), mimeType: "text/csv",
    sha256: sha(body), title: "public.cohort（前 1 行，共 9 行）", ...extra });
  const facts = (extra = {}) => ({ kind: "research-database-snapshot", partial: true, truncated: true, rowCount: 1, totalRows: 9, ...extra });
  const registered = await f.sources.register(f.owner, input({ snapshot: facts() }));
  assert.deepEqual(registered.source.payload.snapshot, facts());
  assert.equal(registered.source.payload.title, "public.cohort（前 1 行，共 9 行）");
  for (const bad of [{ kind: "other" }, [], "text", { kind: "research-database-snapshot", note: "x".repeat(20_000) }]) {
    await assert.rejects(() => f.sources.register(f.owner, input({ snapshot: bad })), { code: "source_payload_invalid" });
  }
  // The same bytes read again after the table grew: the source is the same, and what it says about the table is the newer.
  const again = await f.sources.register(f.owner, input({ snapshot: facts({ totalRows: 12 }), title: "public.cohort（前 1 行，共 12 行）" }));
  assert.equal(again.source.id, registered.source.id); assert.equal(again.duplicate, true);
  assert.equal(again.source.payload.snapshot.totalRows, 12); assert.equal(again.source.payload.title, "public.cohort（前 1 行，共 12 行）");
  // A source registered without them has none.
  const plain = await f.upload(f.owner, "one", "ages.csv", "age,n\n40,12\n");
  assert.equal("snapshot" in plain.source.payload, false);
});
