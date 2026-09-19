// A signed-in hosted app with a knowledge base the parser stand-in fills from
// the regression corpus: what the knowledge-base search and the personal
// library integration tests both start from.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createWebApiApp } from "../../src/server.mjs";

export const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
export const fixture = JSON.parse(await readFile(new URL("../fixtures/kb-regression.json", import.meta.url), "utf8"));
export const DIMENSION = 1024;

/** A deterministic stand-in for the embedding model: one dimension per concept
 *  group, counted, plus a small constant so no vector is zero. It is what makes
 *  "a paraphrase sharing no term with its answer" a checkable property here.
 * @param {string} text */
export function conceptVector(text) {
  const lower = String(text).toLowerCase();
  const vector = new Array(DIMENSION).fill(0);
  fixture.concepts.forEach((/** @type {string[]} */ group, /** @type {number} */ index) => {
    for (const term of group) vector[index] += lower.split(term).length - 1;
  });
  vector[DIMENSION - 1] = 0.05;
  return vector;
}

/** @param {number[]} left @param {number[]} right */
export function cosine(left, right) {
  let dot = 0; let a = 0; let b = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2; }
  return dot / Math.sqrt(a * b);
}

export const fakeEmbedder = {
  configured: true, modelKey: `concepts@${DIMENSION}`, counters: {},
  /** @param {string[]} texts */
  async embedDocuments(texts) { return texts.map(conceptVector); },
  /** @param {string} text */
  async embedQuery(text) { return conceptVector(text); },
};

/** The corpus as the parser would return it: the pages joined, with a page map.
 * @param {string} name */
export function parsedDocument(name) {
  const document = fixture.documents.find((/** @type {any} */ entry) => entry.name === name);
  let content = "";
  const pages = document.pages.map((/** @type {string} */ page, /** @type {number} */ index) => {
    const start = content.length;
    content += page;
    return { index: index + 1, start, end: content.length, status: "ok" };
  });
  return { title: document.title, content, pages };
}

/** @param {string} name */
export const titleOf = (name) => fixture.documents.find((/** @type {any} */ entry) => entry.name === name).title;

/** @param {Record<string, any>} [overrides] */
export async function signedIn(overrides = {}) {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-kb-app-"));
  const documentParserFetch = async (/** @type {any} */ _url, /** @type {any} */ init) => {
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
  await app.kbIndex?.close();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "test-only-kb-password" }) });
  const auth = await login.json();
  const headers = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0],
    "x-open-science-csrf": auth.data.csrfToken, "x-open-science-project": project.id };
  const close = async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { app, user, project, base, headers, dataDir, close };
}

/**
 * Upload documents of the corpus into one project and drive each to a
 * finished, indexed source.
 * @param {{ app: any, user: any, base: string, headers: Record<string, string> }} context
 * @param {{ names?: string[], projectId?: string }} [options]
 */
export async function ingestCorpus({ app, user, base, headers }, { names = fixture.documents.map((/** @type {any} */ entry) => entry.name), projectId = headers["x-open-science-project"] } = {}) {
  const sources = [];
  for (const name of names) {
    const bytes = Buffer.from(`%PDF-1.4\n${name}\n`);
    const uploaded = await fetch(`${base}/api/files/upload`, { method: "POST", headers: { ...headers, "x-open-science-project": projectId },
      body: JSON.stringify({ root: "base", path: `knowledge-base/${name}`, data: bytes.toString("base64"), encoding: "base64" }) });
    assert.equal(uploaded.status, 200);
    const registered = (await uploaded.json()).data.source;
    const current = await app.sourceService.get(user.id, registered.id);
    await app.sourceService.override(user.id, current.id, { expectedRevision: current.revision, docType: current.payload.docType,
      depth: "index_only", reason: "Knowledge-base fixture." });
    let settled;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await app.sourceWorker.tick();
      settled = await app.sourceService.get(user.id, current.id);
      if (settled.payload.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(settled.payload.status, "complete", name);
    sources.push(settled);
  }
  if (app.kbIndex) {
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await app.kbIndex.sync({ userId: user.id, limit: 20 });
      if (!result.indexed && !result.embedded) break;
    }
    for (const source of sources) {
      const indexed = await app.store.database.query(`SELECT 1 FROM evimed_kb.documents WHERE user_id=$1 AND sha256=$2 AND text_sha256=$3`,
        [user.id, source.payload.fingerprint.sha256, source.payload.analysis.textSha256]);
      assert.equal(indexed.rowCount, 1, `${source.id} is indexed`);
    }
  }
  return sources;
}
