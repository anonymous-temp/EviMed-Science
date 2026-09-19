import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const fixture = JSON.parse(await readFile(new URL("./fixtures/kb-regression.json", import.meta.url), "utf8"));
const DIMENSION = 1024;

/** A deterministic stand-in for the embedding model: one dimension per concept
 *  group, counted, plus a small constant so no vector is zero. It is what makes
 *  "a paraphrase sharing no term with its answer" a checkable property here. */
function conceptVector(text) {
  const lower = String(text).toLowerCase();
  const vector = new Array(DIMENSION).fill(0);
  fixture.concepts.forEach((group, index) => {
    for (const term of group) vector[index] += lower.split(term).length - 1;
  });
  vector[DIMENSION - 1] = 0.05;
  return vector;
}
const cosine = (left, right) => {
  let dot = 0; let a = 0; let b = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2; }
  return dot / Math.sqrt(a * b);
};
const fakeEmbedder = {
  configured: true, modelKey: `concepts@${DIMENSION}`, counters: {},
  async embedDocuments(texts) { return texts.map(conceptVector); },
  async embedQuery(text) { return conceptVector(text); },
};

/** The corpus as the parser would return it: the pages joined, with a page map. */
function parsedDocument(name) {
  const document = fixture.documents.find((entry) => entry.name === name);
  let content = "";
  const pages = document.pages.map((page, index) => {
    const start = content.length;
    content += page;
    return { index: index + 1, start, end: content.length, status: "ok" };
  });
  return { title: document.title, content, pages };
}

async function signedIn(overrides = {}) {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-kb-app-"));
  const documentParserFetch = async (_url, init) => {
    const name = init.body.get("filename");
    const { title, content, pages } = parsedDocument(name);
    return new Response(JSON.stringify({ code: 200, message: "success", uuid: "U", timestamp: 1, elapsed_ms: 1,
      data: { title, content, pages } }), { status: 200 });
  };
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    sourceIngestionEnabled: true, sourceIngestionPollMs: 100, sourceIngestionLeaseMs: 1000,
    documentParserUrl: "http://parser.test", documentParserToken: "sk-test-only", documentParserFetch,
    sourceMetadataFetch: async () => new Response("{}", { status: 404 }),
    kbEmbedder: fakeEmbedder, kbSmallLibraryTokens: 1, ...overrides });
  const username = `kb${randomUUID().slice(0, 8)}`;
  const user = await app.store.createUser(username, "test-only-kb-password", "KB fixture");
  const project = await app.store.defaultProject(await app.store.userById(user.id));
  const address = await app.listen(0, "127.0.0.1");
  await app.sourceWorker.close();
  await app.kbIndex.close();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "test-only-kb-password" }) });
  const auth = await login.json();
  const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0],
    "x-open-science-csrf": auth.data.csrfToken, "x-open-science-project": project.id };
  const close = async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { app, user, project, base, headers, close };
}

/** Upload the corpus and drive each document to a finished, indexed source. */
async function ingestCorpus({ app, user, base, headers }) {
  const sources = [];
  for (const document of fixture.documents) {
    const bytes = Buffer.from(`%PDF-1.4\n${document.name}\n`);
    const uploaded = await fetch(`${base}/api/files/upload`, { method: "POST", headers,
      body: JSON.stringify({ root: "base", path: `knowledge-base/${document.name}`, data: bytes.toString("base64"), encoding: "base64" }) });
    assert.equal(uploaded.status, 200);
    const registered = (await uploaded.json()).data.source;
    const current = await app.sourceService.get(user.id, registered.id);
    await app.sourceService.override(user.id, current.id, { expectedRevision: current.revision, docType: current.payload.docType,
      depth: "index_only", reason: "Knowledge-base search fixture." });
    let settled;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await app.sourceWorker.tick();
      settled = await app.sourceService.get(user.id, current.id);
      if (settled.payload.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(settled.payload.status, "complete", document.name);
    sources.push(settled);
  }
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await app.kbIndex.sync({ userId: user.id, limit: 20 });
    if (!result.indexed && !result.embedded) break;
  }
  const indexed = await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_kb.documents WHERE user_id=$1", [user.id]);
  assert.equal(indexed.rows[0].n, fixture.documents.length);
  return sources;
}

const titleOf = (name) => fixture.documents.find((entry) => entry.name === name).title;

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
      assert.match(hit.path, /^\.evimed-knowledge\/\.evimed-derived\/src_[a-f0-9]{32}\/generation-\d+-.+\/index\.md$/);
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
