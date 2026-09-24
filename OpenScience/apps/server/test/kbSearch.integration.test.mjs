import assert from "node:assert/strict";
import test from "node:test";
import { DIMENSION, conceptVector, cosine, databaseUrl, fixture, ingestCorpus, signedIn, titleOf } from "./helpers/knowledgeBaseApp.mjs";

/** The concept stand-in as a reranker: it orders by the same concepts the
 *  stand-in embedder counts, which is what a real reranker does better. */
const conceptRerank = {
  configured: true, lastError: null,
  async order(query, documents) {
    const target = conceptVector(query);
    return documents.map((text, index) => ({ index, score: cosine(target, conceptVector(text)) }))
      .sort((left, right) => right.score - left.score || left.index - right.index).map((entry) => entry.index);
  },
};

test("every term question is answered first by the keyword leg alone, with its page and an exact snippet", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, user, project } = context;
    const sources = await ingestCorpus(context);
    const capabilities = app.kbIndex.capabilities;
    let asked = 0;
    for (const question of fixture.questions) {
      if (question.needs === "vector") continue;
      // Capability-gated: without pg_trgm (this dev database has none) the
      // misspelling has no leg to reach it; production's image has the module.
      if (question.needs && !capabilities[question.needs]) continue;
      asked += 1;
      const result = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: question.query, limit: 5 });
      assert.equal(result.mode, "keyword");
      const [hit] = result.hits;
      assert.equal(hit?.title, titleOf(question.expect.document), `${question.id}: ${JSON.stringify(result.hits.map((item) => [item.title, item.page]))}`);
      assert.equal(hit.page, question.expect.page, question.id);
      // The snippet is the captured text at start–end, byte for byte.
      const source = sources.find((entry) => entry.id === hit.sourceId);
      const capture = await app.sourceService.loadCapture(user.id, source);
      assert.equal(capture.input.text.slice(hit.start, hit.end), hit.snippet, question.id);
      // The attempt's read copy, beside (never inside) its understanding run's directory.
      assert.match(hit.path, /^\.evimed-knowledge\/\.evimed-derived\/src_[a-f0-9]{32}\/read-\d+-.+\/index\.md$/);
    }
    assert.ok(asked >= 4, `only ${asked} questions ran`);
  } finally { await context.close(); }
});

test("with the vector leg every answer stays in the top three, and the reranked paraphrase comes first", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async (t) => {
  const context = await signedIn();
  try {
    const { app, user, project } = context;
    await ingestCorpus(context);
    if (!app.kbIndex.capabilities.vector) {
      t.skip("this database has no pgvector; the vector leg is exercised where the extension exists");
      return;
    }
    for (const question of fixture.questions) {
      if (question.needs && !app.kbIndex.capabilities[question.needs]) continue;
      const result = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: question.query, limit: 5 });
      assert.equal(result.mode, "hybrid");
      const position = result.hits.findIndex((hit) => hit.title === titleOf(question.expect.document) && hit.page === question.expect.page);
      assert.ok(position >= 0 && position < 3, `${question.id}: ${JSON.stringify(result.hits.map((hit) => [hit.title, hit.page]))}`);
    }
    // The paraphrase shares no term with its answer: only the vector leg can
    // bring it in, and the reranker puts it first.
    const paraphrase = fixture.questions.find((question) => question.needs === "vector");
    const unranked = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: paraphrase.query, limit: 5 });
    assert.ok(unranked.legs.vector > 0, "the vector leg ran");
    app.kbIndex.rerank = conceptRerank;
    const reranked = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: paraphrase.query, limit: 3 });
    assert.equal(reranked.reranked, true);
    assert.equal(reranked.hits[0].title, titleOf(paraphrase.expect.document));
  } finally { await context.close(); }
});

test("a small library is answered with the files to read, and a deleted source leaves the index", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const context = await signedIn({ kbSmallLibraryTokens: 150_000 });
  try {
    const { app, user, project, base, headers } = context;
    const sources = await ingestCorpus(context);
    const small = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: "利伐沙班" });
    assert.equal(small.mode, "small-library");
    assert.deepEqual(small.hits, []);
    assert.equal(small.files.length, fixture.documents.length);
    assert.ok(small.files.every((file) => file.path.startsWith(".evimed-knowledge/.evimed-derived/") && file.tokens > 0));
    assert.match(small.note, /read the listed files directly/);
    // Only the named sources are in scope when the run names them.
    const narrowed = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: "x", sourceIds: [sources[0].id] });
    assert.deepEqual(narrowed.files.map((file) => file.sourceId), [sources[0].id]);

    // Deleting a source removes its index document on the next pass.
    const removal = await fetch(`${base}/api/sources/${sources[0].id}`, { method: "DELETE", headers,
      body: JSON.stringify({ expectedRevision: sources[0].revision }) });
    assert.equal(removal.status, 200);
    const before = await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_kb.documents WHERE user_id=$1", [user.id]);
    const pass = await app.kbIndex.sync({ userId: user.id });
    const after = await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_kb.documents WHERE user_id=$1", [user.id]);
    assert.equal(pass.removed, 1);
    assert.equal(after.rows[0].n, before.rows[0].n - 1);

    // The index is derived: emptied and rebuilt, it holds what the sources hold.
    const rebuilt = await app.kbIndex.rebuild({ userIds: [user.id] });
    assert.equal(rebuilt.indexed, fixture.documents.length - 1);
    const chunks = await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_kb.chunks WHERE user_id=$1", [user.id]);
    assert.ok(chunks.rows[0].n >= fixture.documents.length - 1);
  } finally { await context.close(); }
});

test("an embedding outage leaves the keyword index standing", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const failing = { configured: true, modelKey: `broken@${DIMENSION}`, counters: {},
    async embedDocuments() { throw Object.assign(new Error("down"), { code: "kb_embedding_unavailable" }); },
    async embedQuery() { throw Object.assign(new Error("down"), { code: "kb_embedding_unavailable" }); } };
  const context = await signedIn({ kbEmbedder: failing });
  try {
    const { app, user, project } = context;
    await ingestCorpus(context);
    const result = await app.kbIndex.search({ userId: user.id, projectId: project.id, query: "达比加群" });
    assert.equal(result.mode, "keyword", "no vector leg answered");
    assert.equal(result.hits[0].title, fixture.documents[0].title);
    if (app.kbIndex.capabilities.vector) assert.equal(result.vectorSkipped, "kb_embedding_unavailable");
  } finally { await context.close(); }
});
