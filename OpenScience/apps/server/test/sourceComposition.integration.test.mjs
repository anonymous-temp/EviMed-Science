// The composition of a project's library, counted in SQL over the account's documents (knowledge base P0, 资料组成).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { projectComposition } from "../src/sourceComposition.mjs";
import { SourceService } from "../src/sourceService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const durable = { timeout: 30_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("the library is counted over this account's documents of this project: not a deleted one, a compiled page, another project or another account", durable, async (t) => {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  const owner = `source_composition_${randomUUID()}`;
  const stranger = `source_composition_${randomUUID()}`;
  const sources = new SourceService(new ProductDocuments(database), new ProductJobs(database));
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1)", [[owner, stranger]]);
    await database.close();
  });
  for (const id of [owner, stranger]) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Composition','development')", [id]);
    for (const project of ["default", "study"]) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,$2,1048576)", [id, project]);
  }
  let counter = 0;
  const add = async (userId, projectId, name, metadata) => {
    counter += 1;
    const { source } = await sources.register(userId, { projectId, connector: { type: "upload", id: `${projectId}-library` }, path: `knowledge-base/${name}`,
      sha256: counter.toString(16).padStart(64, "0"), size: 1000 + counter, mimeType: "application/pdf", mtime: "2026-09-06T00:00:00.000Z" });
    return metadata === undefined ? source : sources.documents.put(userId, "source", source.id, { ...source.payload, metadata }, { expectedRevision: source.revision, projectId });
  };
  await add(owner, "default", "a.pdf", { publicationDate: "2021-03-05", keywords: ["Atrial Fibrillation", "Warfarin"] });
  await add(owner, "default", "b.pdf", { publicationDate: "2021", keywords: ["atrial fibrillation"] });
  await add(owner, "default", "c.pdf", { publicationDate: "2019", keywords: ["Warfarin", "Stroke"] });
  await add(owner, "default", "no-metadata.pdf");
  await add(owner, "default", "bad-metadata.pdf", { keywords: "not a list", publicationDate: 2020 });
  await add(owner, "default", "wiki/atrial-fibrillation.md", { publicationDate: "2024", keywords: ["Atrial Fibrillation"] });
  const gone = await add(owner, "default", "deleted.pdf", { publicationDate: "2000", keywords: ["Deleted"] });
  const created = (await database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [owner])).rows[0].generation;
  await sources.remove(owner, gone.id, { expectedRevision: gone.revision, accountCreatedAt: created });
  await add(owner, "study", "elsewhere.pdf", { publicationDate: "2010", keywords: ["Elsewhere"] });
  await add(stranger, "default", "strangers.pdf", { publicationDate: "2005", keywords: ["Stranger"] });

  const library = await projectComposition(database, owner, "default");
  assert.deepEqual(library, {
    total: 5, dated: 4, keyworded: 3,
    // A year recorded as a number is a year; keywords recorded as anything but a list are none.
    years: [{ year: 2021, count: 2 }, { year: 2020, count: 1 }, { year: 2019, count: 1 }],
    keywords: [{ keyword: "Atrial Fibrillation", count: 2 }, { keyword: "Warfarin", count: 2 }, { keyword: "Stroke", count: 1 }],
  });
  assert.equal((await projectComposition(database, owner, "study")).total, 1);
  assert.deepEqual(await projectComposition(database, owner, "nowhere"), { total: 0, dated: 0, keyworded: 0, years: [], keywords: [] });
});
