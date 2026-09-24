// A knowledge-base document can be used as soon as it is read (2026-09-24).
//
// Until then a PDF — structured depth by default — stayed `parsing` for the
// whole understanding run that follows its few-second parse: one to four
// minutes, one document at a time per account. Its text was captured after the
// parse but written out, and so searchable, only once the understanding ended;
// every stage showed the same spinner. These tests drive the real worker, the
// real source service, the real index and the real routes over PostgreSQL,
// with the understanding run held back, and read what the page and the search
// see in between.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { databaseUrl, signedIn } from "./helpers/knowledgeBaseApp.mjs";

const skip = !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured";
const GUIDELINE = "房颤抗凝指南.pdf";

/** @param {string} base @param {Record<string, string>} headers @param {string} projectId @param {string} state */
async function listed(base, headers, projectId, state) {
  const response = await fetch(`${base}/api/sources?projectId=${encodeURIComponent(projectId)}&state=${state}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).data.items;
}

/** Upload one document of the corpus, as the page does, at its default depth. */
async function upload(/** @type {{ base: string, headers: Record<string, string> }} */ { base, headers }, /** @type {string} */ name) {
  const bytes = Buffer.from(`%PDF-1.4\n${name}\n`);
  const response = await fetch(`${base}/api/files/upload`, { method: "POST", headers,
    body: JSON.stringify({ root: "base", path: `knowledge-base/${name}`, data: bytes.toString("base64"), encoding: "base64" }) });
  assert.equal(response.status, 200);
  return (await response.json()).data.source;
}

test("a document is searchable and listed as read while its understanding still runs", { skip, timeout: 60_000 }, async () => {
  const context = await signedIn();
  try {
    const { app, user, project, base, headers } = context;
    // The understanding waits for a runtime: the document must not.
    app.sourceWorker.understandingRuns = { execute: async () => { throw Object.assign(new Error("busy"), { code: "runtime_busy" }); } };
    const registered = await upload(context, GUIDELINE);
    assert.equal(registered.payload.depth, "structured", "a PDF is understood by default");
    assert.deepEqual((await listed(base, headers, project.id, "reading")).map((item) => item.id), [registered.id]);
    assert.equal((await listed(base, headers, project.id, "reading"))[0].readable, false);

    let source;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await app.sourceWorker.tick();
      source = await app.sourceService.get(user.id, registered.id);
      if (source.payload.analysis?.readAt) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(source.payload.status, "parsing", "the pipeline still has the understanding to do");
    assert.equal(typeof source.payload.analysis.readAt, "string");
    assert.match(source.payload.outputs.artifactPath, /^knowledge-base\/\.evimed-derived\/src_[a-f0-9]{32}\/read-1-.+\/index\.md$/);
    await access(path.join(project.baseDir, source.payload.outputs.artifactPath));

    // The page: no longer 「读取中」, and usable.
    assert.deepEqual(await listed(base, headers, project.id, "reading"), []);
    const ready = await listed(base, headers, project.id, "ready");
    assert.deepEqual(ready.map((item) => [item.id, item.readable]), [[registered.id, true]]);
    assert.deepEqual(await listed(base, headers, project.id, "attention"), []);
    const bad = await fetch(`${base}/api/sources?projectId=${encodeURIComponent(project.id)}&state=understanding`, { headers });
    assert.equal(bad.status, 400);

    // The search: indexed and answered from the text the run reads.
    for (let pass = 0; pass < 10; pass += 1) {
      const synced = await app.kbIndex.sync({ userId: user.id, limit: 10 });
      if (!synced.indexed && !synced.embedded) break;
    }
    const found = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: "利伐沙班", limit: 3 });
    assert.deepEqual(found.waiting, [], "nothing is still waiting to be read");
    assert.equal(found.hits[0]?.sourceId, registered.id, JSON.stringify(found));
    assert.match(found.hits[0].path, /\/read-1-.+\/index\.md$/);

    // The understanding fails for good: the document was read, and stays usable.
    app.sourceWorker.understandingRuns = { execute: async () => { throw Object.assign(new Error("invalid"), { code: "source_understanding_invalid" }); } };
    await app.store.database.query(`UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND kind='ingest' AND status='queued'`, [user.id]);
    let failed;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await app.sourceWorker.tick();
      failed = await app.sourceService.get(user.id, registered.id);
      if (failed.payload.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(failed.payload.status, "failed");
    assert.equal(failed.payload.error.code, "source_understanding_invalid");
    assert.deepEqual((await listed(base, headers, project.id, "ready")).map((item) => item.id), [registered.id]);
    assert.deepEqual(await listed(base, headers, project.id, "attention"), [], "a failed understanding is not a document that needs the researcher");
    await access(path.join(project.baseDir, failed.payload.outputs.artifactPath));
    const still = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: "利伐沙班", limit: 3 });
    assert.equal(still.hits[0]?.sourceId, registered.id);

    // Read again: a new generation is 「读取中」 until it is read in turn.
    const retried = await app.sourceService.retry(user.id, registered.id, { expectedRevision: failed.revision });
    assert.equal(retried.payload.status, "queued");
    assert.deepEqual((await listed(base, headers, project.id, "reading")).map((item) => item.id), [registered.id]);
    assert.deepEqual(await listed(base, headers, project.id, "ready"), []);
  } finally { await context.close(); }
});
