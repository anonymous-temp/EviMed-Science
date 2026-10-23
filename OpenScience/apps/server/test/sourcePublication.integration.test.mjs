import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { databaseUrl, signedIn } from "./helpers/knowledgeBaseApp.mjs";

const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60000 };
const post = async (ctx, route, body, method = "POST") => {
  const response = await fetch(`${ctx.base}${route}`, { method, headers: ctx.headers, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result.data;
};

test("note A-B-A restores identity, preserves old bytes, and independent equal notes remain separate", options, async () => {
  const ctx = await signedIn();
  try {
    const first = await post(ctx, "/api/sources/notes", { projectId: ctx.project.id, title: "Identity", body: "A" });
    const independent = await post(ctx, "/api/sources/notes", { projectId: ctx.project.id, title: "Identity", body: "A" });
    assert.notEqual(independent.source.id, first.source.id);
    const next = await post(ctx, `/api/sources/${first.source.id}/note`, { title: "Identity", body: "B" }, "PUT");
    assert.equal(await readFile(path.join(ctx.project.baseDir, first.source.payload.paths[0]), "utf8"), "# Identity\n\nA\n");
    const restored = await post(ctx, `/api/sources/${next.source.id}/note`, { title: "Identity", body: "A" }, "PUT");
    assert.equal(restored.source.id, first.source.id);
    assert.ok(restored.source.payload.generation > first.source.payload.generation);
    assert.equal(restored.source.payload.version, 3);
    assert.equal(restored.source.payload.deletion, null);
    const inventory = await ctx.app.sourceService.documents.list(ctx.user.id, "source", { projectId: ctx.project.id });
    assert.equal(inventory.items.length, 2);
  } finally { await ctx.close(); }
});

test("concurrent note saves leave one current version whose registered digest matches its immutable file", options, async () => {
  const ctx = await signedIn();
  try {
    const first = await post(ctx, "/api/sources/notes", { projectId: ctx.project.id, title: "Concurrent", body: "A" });
    const versions = await Promise.all(["B", "C"].map(body => post(ctx, `/api/sources/${first.source.id}/note`, { title: "Concurrent", body }, "PUT")));
    const live = await ctx.app.sourceService.documents.list(ctx.user.id, "source", { projectId: ctx.project.id });
    assert.equal(live.items.length, 1);
    assert.ok(versions.some(version => version.source.id === live.items[0].id));
    const bytes = await readFile(path.join(ctx.project.baseDir, live.items[0].payload.paths[0]));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), live.items[0].payload.fingerprint.sha256);
  } finally { await ctx.close(); }
});

test("publication guard serializes independent Node processes through PostgreSQL", options, async () => {
  const ctx = await signedIn();
  try {
    const id = `publication-${randomUUID()}`;
    await ctx.app.sourceService.documents.put(ctx.user.id, "preferences", id, { count: 0 }, { expectedRevision: 0 });
    const code = `
      import { ControlPlaneDatabase } from './src/controlPlaneDatabase.mjs';
      import { ProductDocuments } from './src/productStore.mjs';
      import { SourceService } from './src/sourceService.mjs';
      import { migrateProductStore } from './src/productPersistence.mjs';
      import { writeFile, access } from 'node:fs/promises';
      const db = new ControlPlaneDatabase({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
      const docs = new ProductDocuments(db);
      const sources = new SourceService(docs, {});
      await migrateProductStore(db);
      await writeFile(process.env.PUBLICATION_READY_SELF, 'ready');
      for (let attempt = 0; ; attempt++) {
        try { await access(process.env.PUBLICATION_READY_PEER); break; }
        catch (error) { if (attempt > 500) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      await sources.withRegistrationLocks([process.env.PUBLICATION_TEST_ID], async () => {
        const row = await docs.get(process.env.PUBLICATION_TEST_USER, 'preferences', process.env.PUBLICATION_TEST_ID);
        await new Promise(resolve => setTimeout(resolve, 100));
        await docs.put(process.env.PUBLICATION_TEST_USER, 'preferences', row.id, { count: row.payload.count + 1 }, { expectedRevision: row.revision });
      });
      await db.close();`;
    await Promise.all([0, 1].map(index => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
      cwd: new URL("..", import.meta.url), env: { ...process.env, PUBLICATION_TEST_ID: id, PUBLICATION_TEST_USER: ctx.user.id,
        PUBLICATION_READY_SELF: path.join(ctx.project.baseDir, `ready-${index}`),
        PUBLICATION_READY_PEER: path.join(ctx.project.baseDir, `ready-${1 - index}`) },
    })));
    assert.equal((await ctx.app.sourceService.documents.get(ctx.user.id, "preferences", id)).payload.count, 2);
  } finally { await ctx.close(); }
});

test("failed publication leaves the previous source and its original bytes unchanged", options, async () => {
  const ctx = await signedIn();
  try {
    const first = await post(ctx, "/api/sources/notes", { projectId: ctx.project.id, title: "Failure", body: "A" });
    const enqueue = ctx.app.sourceService.jobs.enqueue.bind(ctx.app.sourceService.jobs);
    ctx.app.sourceService.jobs.enqueue = async () => { throw new Error("Injected publication failure"); };
    const response = await fetch(`${ctx.base}/api/sources/${first.source.id}/note`, { method: "PUT", headers: ctx.headers,
      body: JSON.stringify({ title: "Failure", body: "B" }) });
    assert.equal(response.status, 500);
    ctx.app.sourceService.jobs.enqueue = enqueue;
    const current = await ctx.app.sourceService.documents.get(ctx.user.id, "source", first.source.id);
    assert.equal(current.revision, first.source.revision);
    assert.equal(await readFile(path.join(ctx.project.baseDir, current.payload.paths[0]), "utf8"), "# Failure\n\nA\n");
    assert.equal(await readFile(path.join(ctx.project.baseDir, current.payload.logicalPath), "utf8"), "# Failure\n\nA\n");
    const live = await ctx.app.sourceService.documents.list(ctx.user.id, "source", { projectId: ctx.project.id });
    assert.equal(live.items.length, 1);
  } finally { await ctx.close(); }
});

test("delete and reupload of the same file restores the source and fences the old deletion job", options, async () => {
  const ctx = await signedIn();
  try {
    const upload = () => post(ctx, "/api/files/upload", { root: "base", path: "knowledge-base/restore.txt", data: "Preserved bytes", encoding: "utf8" });
    const first = (await upload()).source;
    const deleted = await post(ctx, `/api/sources/${first.id}`, { expectedRevision: first.revision }, "DELETE");
    const tombstone = await ctx.app.sourceService.documents.get(ctx.user.id, "source", first.id, { includeDeleted: true });
    const oldJob = await ctx.app.sourceService.jobs.claim(["ingest"], "restore-test", { leaseMs: 60000 });
    assert.equal(oldJob.payload.action, "source-delete");
    const again = (await upload()).source;
    assert.equal(again.id, first.id);
    assert.ok(again.payload.generation > tombstone.payload.generation);
    assert.equal(again.deletedAt, null);
    assert.equal(again.payload.deletion, null);
    await assert.rejects(ctx.app.sourceService.consumeDeletion(oldJob, async () => { throw new Error("Stale cleanup ran"); }), { code: "source_generation_stale" });
    assert.equal(await readFile(path.join(ctx.project.baseDir, again.payload.paths[0]), "utf8"), "Preserved bytes");
    const history = await ctx.app.sourceService.documents.history(ctx.user.id, "source", first.id, {});
    assert.ok(history.some(row => row.deletedAt), "historical deletion remains recorded");
    assert.ok(deleted);
  } finally { await ctx.close(); }
});

test("concurrent web refreshes leave exactly one version with matching preserved bytes", options, async () => {
  let revision = 0;
  const ctx = await signedIn({ webReadHostIntervalMs: 0, webReadTransport: async ({ url }) => {
    if (url.pathname === "/robots.txt") return { status: 404, headers: {}, body: Buffer.alloc(0) };
    revision += 1;
    return { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(
      `<html><head><title>Web revision ${revision}</title></head><body><main><h1>Web revision ${revision}</h1><p>${"Public source material. ".repeat(30)}</p></main></body></html>`) };
  } });
  try {
    const first = await post(ctx, "/api/sources/links", { projectId: ctx.project.id, url: "https://example.org/publication" });
    await Promise.all([0, 1].map(() => post(ctx, `/api/sources/${first.source.id}/refetch`, {})));
    const live = await ctx.app.sourceService.documents.list(ctx.user.id, "source", { projectId: ctx.project.id });
    assert.equal(live.items.length, 1);
    const bytes = await readFile(path.join(ctx.project.baseDir, live.items[0].payload.paths[0]));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), live.items[0].payload.fingerprint.sha256);
    assert.equal(live.items[0].payload.version, 3);
  } finally { await ctx.close(); }
});

async function seedLegacyNote(ctx) {
  const created = await post(ctx, "/api/sources/notes", { projectId: ctx.project.id, title: "Legacy", body: "A" });
  const { sourceIdFor } = await import("../src/sourceService.mjs");
  const id = sourceIdFor(ctx.project.id, created.source.payload.fingerprint.sha256);
  const { logicalPath, ...payload } = created.source.payload;
  const source = await ctx.app.sourceService.documents.put(ctx.user.id, "source", id, { ...payload, paths: [logicalPath] }, { expectedRevision: 0, projectId: ctx.project.id });
  await ctx.app.sourceService.documents.database.query("DELETE FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND id=$2", [ctx.user.id, created.source.id]);
  return source;
}

test("editing a seeded legacy note preserves its historical bytes and unchanged-save logical identity", options, async () => {
  const ctx = await signedIn();
  try {
    const legacy = await seedLegacyNote(ctx);
    const same = await post(ctx, `/api/sources/${legacy.id}/note`, { title: "Legacy", body: "A" }, "PUT");
    assert.equal(same.source.id, legacy.id);
    assert.equal(same.source.payload.logicalPath, legacy.payload.paths[0]);
    const next = await post(ctx, `/api/sources/${same.source.id}/note`, { title: "Legacy", body: "B" }, "PUT");
    assert.equal(next.source.payload.logicalPath, legacy.payload.paths[0]);
    assert.equal(next.source.payload.familyId, legacy.payload.familyId);
    const old = await ctx.app.sourceService.documents.get(ctx.user.id, "source", legacy.id, { includeDeleted: true });
    const original = await readFile(path.join(ctx.project.baseDir, old.payload.paths[0]));
    assert.equal(createHash("sha256").update(original).digest("hex"), legacy.payload.fingerprint.sha256);
    const live = await ctx.app.sourceService.documents.list(ctx.user.id, "source", { projectId: ctx.project.id });
    assert.equal(live.items.length, 1);
  } finally { await ctx.close(); }
});

test("post-registration retirement failure rolls the ledger back without changing the old alias", options, async () => {
  const ctx = await signedIn();
  try {
    const legacy = await seedLegacyNote(ctx);
    ctx.app.sourceService.remove = async () => { throw new Error("Injected retirement failure"); };
    const response = await fetch(`${ctx.base}/api/sources/${legacy.id}/note`, { method: "PUT", headers: ctx.headers,
      body: JSON.stringify({ title: "Legacy", body: "B" }) });
    assert.equal(response.status, 500);
    assert.equal(await readFile(path.join(ctx.project.baseDir, legacy.payload.paths[0]), "utf8"), "# Legacy\n\nA\n");
    const current = await ctx.app.sourceService.documents.get(ctx.user.id, "source", legacy.id);
    assert.equal(current.payload.fingerprint.sha256, legacy.payload.fingerprint.sha256);
  } finally { await ctx.close(); }
});

test("native upload registration failure cannot overwrite a seeded legacy original", options, async () => {
  const ctx = await signedIn();
  try {
    const legacy = await seedLegacyNote(ctx);
    ctx.app.sourceService.jobs.enqueue = async () => { throw new Error("Injected native registration failure"); };
    const response = await fetch(`${ctx.base}/api/commands/upload_file`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ root: "base", filename: legacy.payload.paths[0], data: "replacement", encoding: "utf8" }) });
    assert.equal(response.status, 500);
    assert.equal(await readFile(path.join(ctx.project.baseDir, legacy.payload.paths[0]), "utf8"), "# Legacy\n\nA\n");
  } finally { await ctx.close(); }
});

test("duplicate registration waits for a worker job lock before taking its source lock", options, async () => {
  const ctx = await signedIn();
  let registration;
  try {
    const created = await post(ctx, "/api/sources/notes", { projectId: ctx.project.id, title: "Lock order", body: "A" });
    const source = created.source;
    const database = ctx.app.sourceService.documents.database;
    await database.transaction(async client => {
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await client.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'sourceId'=$2 FOR UPDATE", [ctx.user.id, source.id]);
      registration = ctx.app.sourceService.register(ctx.user.id, { projectId: ctx.project.id, connector: source.payload.connector,
        path: `${path.posix.dirname(source.payload.paths[0])}/copy.md`, logicalPath: source.payload.logicalPath, ...source.payload.fingerprint, mtime: new Date().toISOString() });
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await database.query("SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%evimed_product.jobs%'", [pid]);
        if (result.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "registration reached the job-lock barrier");
      await client.query("SET LOCAL lock_timeout='500ms'");
      await client.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND id=$2 FOR UPDATE", [ctx.user.id, source.id]);
    });
    await registration;
  } finally { await registration?.catch(() => {}); await ctx.close(); }
});

test("native save-to-knowledge registration failure leaves no uncommitted logical alias", options, async () => {
  const ctx = await signedIn();
  try {
    await post(ctx, "/api/commands/add_text_to_workspace", { filename: "report/native.txt", content: "native output" });
    ctx.app.sourceService.jobs.enqueue = async () => { throw new Error("Injected native save failure"); };
    const response = await fetch(`${ctx.base}/api/commands/save_to_knowledge_base`, { method: "POST", headers: ctx.headers,
      body: JSON.stringify({ path: "report/native.txt" }) });
    assert.equal(response.status, 500);
    const digest = createHash("sha256").update("native output").digest("hex").slice(0, 8);
    await assert.rejects(readFile(path.join(ctx.project.baseDir, `knowledge-base/chat/native-${digest}.txt`)), { code: "ENOENT" });
    const live = await ctx.app.sourceService.documents.list(ctx.user.id, "source", { projectId: ctx.project.id });
    assert.equal(live.items.length, 0);
  } finally { await ctx.close(); }
});

test("native A-to-B uploads return version paths whose actual previews and downloads read B", options, async () => {
  const ctx = await signedIn();
  try {
    const upload = data => post(ctx, "/api/commands/upload_file", { root: "base", filename: "knowledge-base/native-current.txt", data, encoding: "utf8" });
    const first = await upload("A");
    const next = await upload("B");
    const preview = await fetch(`${ctx.base}/api/files/preview/${encodeURIComponent(next)}?root=base`, { headers: ctx.headers });
    assert.equal(preview.status, 200);
    assert.equal(await preview.text(), "B");
    const download = await fetch(`${ctx.base}/api/files/download/${encodeURIComponent(next)}?root=base`, { headers: ctx.headers });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "B");
    assert.match(download.headers.get("content-disposition"), /native-current\.txt/);
    assert.notEqual(next, first);
    assert.equal(await readFile(path.join(ctx.project.baseDir, first), "utf8"), "A");
    const source = await ctx.app.sourceService.documents.list(ctx.user.id, "source", { projectId: ctx.project.id });
    assert.ok(source.items.some(row => row.payload.paths.includes(next)));
  } finally { await ctx.close(); }
});
