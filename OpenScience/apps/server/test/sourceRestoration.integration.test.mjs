import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrl, signedIn } from "./helpers/knowledgeBaseApp.mjs";

test("restoring previously ingested bytes creates a new extraction generation and does not reuse a finished job", {
  skip: !databaseUrl && "Dedicated local PostgreSQL required", timeout: 60000,
}, async () => {
  const { app, user, project, base, headers, close } = await signedIn();
  try {
    const original = { title: "Restored note", body: "Original captured wording." };
    const send = (route, method, body) => fetch(`${base}${route}`, { method, headers, body: JSON.stringify(body) });
    const first = await send("/api/sources/notes", "POST", { projectId: project.id, ...original });
    assert.equal(first.status, 201);
    let source = (await first.json()).data.source;
    source = await app.sourceService.get(user.id, source.id);
    await app.sourceService.override(user.id, source.id, { expectedRevision: source.revision, docType: source.payload.docType,
      depth: "index_only", reason: "Local restoration regression" });
    const complete = async id => {
      for (let attempt = 0; attempt < 30; attempt++) {
        await app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='ingest' AND status='queued'", [user.id]);
        await app.sourceWorker.tick();
        const row = await app.sourceService.get(user.id, id);
        if (row.payload.status === "complete") return row;
      }
      assert.fail("the current extraction did not complete");
    };
    const captured = await complete(source.id);
    const oldJob = (await app.store.database.query("SELECT id,status FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND payload->>'sourceId'=$2 AND payload->>'sourceGeneration'=$3",
      [user.id, source.id, String(captured.payload.generation)])).rows[0];
    assert.equal(oldJob.status, "succeeded");
    const changed = await send(`/api/sources/${source.id}/note`, "PUT", { title: original.title, body: "Changed wording." });
    assert.equal(changed.status, 200);
    const next = (await changed.json()).data.source;
    assert.equal((await fetch(`${base}/api/sources/${source.id}`, { headers })).status, 404);
    const restored = await send(`/api/sources/${next.id}/note`, "PUT", original);
    assert.equal(restored.status, 200);
    const revived = (await restored.json()).data.source;
    assert.equal(revived.id, source.id);
    assert.ok(revived.payload.generation > captured.payload.generation, "a revived row must advance its extraction identity");
    assert.ok(revived.payload.version > captured.payload.version);
    const freshJob = (await app.store.database.query("SELECT id,status FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND payload->>'sourceId'=$2 AND payload->>'sourceGeneration'=$3",
      [user.id, revived.id, String(revived.payload.generation)])).rows[0];
    assert.notEqual(freshJob.id, oldJob.id);
    assert.equal(freshJob.status, "queued");
    const settled = await complete(revived.id);
    assert.equal(settled.payload.analysis.generation, revived.payload.generation);
    assert.match((await app.sourceService.loadCapture(user.id, settled)).input.text, /Original captured wording/);
  } finally { await close(); }
});
