import assert from "node:assert/strict";
import test from "node:test";
import { readKnowledgeSourceInput, readKnowledgeSourceInputs, knowledgeSourceSetDigest } from "../src/knowledgeGeneration.mjs";
import { sourceRendition } from "../src/openVikingSourceSync.mjs";
import { databaseUrl, ingestCorpus, signedIn } from "./helpers/knowledgeBaseApp.mjs";

test("a generation uses canonical PostgreSQL captures and excludes compiled aliases without rewriting originals", {
  skip: !databaseUrl && "Disposable PostgreSQL required",
}, async () => {
  const f = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, user, project } = f;
    const sources = await ingestCorpus(f, { names: ["房颤抗凝指南.pdf", "肾功能与抗凝.pdf"] });
    const request = { sources: app.sourceService, ownerId: user.id, projectId: project.id };
    const inputs = await readKnowledgeSourceInputs(request);
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
      const capture = await app.sourceService.loadCapture(user.id, input.source);
      assert.equal(input.text, sourceRendition(input.source, capture));
      assert.equal(input.receipt.textSha256, input.source.payload.analysis.textSha256);
      assert.ok(input.receipt.pageMapDigest);
    }
    const before = knowledgeSourceSetDigest({ revision: 1 }, inputs);
    const source = await app.sourceService.get(user.id, sources[0].id);
    await app.sourceService.documents.put(user.id, "source", source.id, { ...source.payload,
      paths: [...source.payload.paths, "knowledge-base/wiki/alias.md"] }, { projectId: project.id, expectedRevision: source.revision });
    assert.equal(await readKnowledgeSourceInput({ ...request, sourceId: source.id }), null);
    const remaining = await readKnowledgeSourceInputs(request);
    assert.equal(remaining.length, 1);
    assert.notEqual(knowledgeSourceSetDigest({ revision: 1 }, remaining), before);
    const original = await app.sourceService.get(user.id, source.id);
    assert.ok(await app.sourceService.loadCapture(user.id, original), "the original capture remains available");
    assert.deepEqual(original.payload.analysis, source.payload.analysis);
    const held = remaining[0].source;
    assert.ok(held.payload.analysis.pageCount > 0);
    const sourceRevision = held.revision;
    await app.store.database.query(`UPDATE evimed_product.documents SET deleted_at=clock_timestamp()
      WHERE user_id=$1 AND project_id=$2 AND kind='knowledge' AND payload->>'recordType'='source-page-map'
      AND payload->>'sourceId'=$3`, [user.id, project.id, held.id]);
    await assert.rejects(readKnowledgeSourceInput({ ...request, sourceId: held.id }), { code: "knowledge_source_capture_invalid" });
    const current = await app.sourceService.get(user.id, held.id);
    assert.equal(current.revision, sourceRevision);
    assert.ok((await app.sourceService.loadCapture(user.id, current)).input.text,
      "an unavailable certification does not withhold the captured original text");
    await assert.rejects(readKnowledgeSourceInputs({ ...request, sources: { list: async () => { throw Object.assign(new Error("unavailable"), { code: "ledger_unavailable" }); } } }),
      { code: "ledger_unavailable" });
  } finally { await f.close(); }
});
