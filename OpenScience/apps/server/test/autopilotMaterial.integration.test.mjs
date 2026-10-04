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
