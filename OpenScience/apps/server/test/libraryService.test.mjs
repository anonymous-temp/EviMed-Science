import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { CAPSULE_WORK_STYLE_FACT_KINDS } from "../src/capsuleMethods.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { DOCUMENT_MEMORY_MAX_ENTRIES, LibraryService, createLibraryRoutes, describeLibrarySource, libraryCapsuleEntries, userLibraryDir } from "../src/libraryService.mjs";

const SOURCE = `src_${"a".repeat(32)}`;
const anchor = (quote, start = 10) => ({ sourceId: SOURCE, generation: 1, unitId: `${SOURCE}:g1:u1`, start, end: start + quote.length, quote });

const understanding = {
  generation: 1,
  summary: "非瓣膜性房颤患者口服抗凝的临床指南。",
  slots: {
    design: { state: "known", value: "多中心随机对照试验", evidence: [anchor("随机对照", 3)] },
    population: { state: "unknown", reason: "文中没有写" },
  },
  claims: [
    { id: "c1", statement: "利伐沙班推荐剂量为 20 mg 每日一次", evidence: [anchor("推荐剂量为20 mg", 40), anchor("每日一次", 52)] },
    { id: "c2", statement: "利伐沙班推荐剂量为 20 mg 每日一次", evidence: [anchor("推荐剂量为20 mg", 40)] },
    { id: "c3", statement: "文中没有给出锚点的说法", evidence: [] },
  ],
  methods: [{ id: "m1", title: "按肾功能调整剂量", description: "先算肌酐清除率，再查表。", whenToUse: "开始抗凝前",
    steps: ["计算 CrCl", "对照说明书减量"], checks: ["复核体重"], pitfalls: [], evidence: [anchor("肌酐清除率", 80)], status: "draft" }],
};

test("an understanding becomes its summary and its quote-anchored claims, each saying whose words it holds", () => {
  const entries = libraryCapsuleEntries({ title: "房颤抗凝指南", sourceId: SOURCE, understanding });
  // 2026-09-24: a template field is a column of the understanding, not a
  // memory — one product-test PDF put thirty 「研究设计：本文档没有…」 rows in
  // the capsule — and a method draft is the document's procedure, not the
  // researcher's. The repeated claim and the unanchored one add nothing.
  assert.deepEqual(entries.map((entry) => entry.content), [
    "资料《房颤抗凝指南》的摘要：非瓣膜性房颤患者口服抗凝的临床指南。",
    "据资料《房颤抗凝指南》：利伐沙班推荐剂量为 20 mg 每日一次",
  ]);
  assert.ok(entries.every((entry) => entry.factKind === "project_fact"));
  assert.deepEqual(entries[0].provenance, [], "the summary rests on the whole document, not on a quote");
  // The quotes travel with the entry, verbatim, pointing into the document.
  assert.deepEqual(entries[1].provenance, [
    { type: "source", id: `${SOURCE}#40-50`, excerpt: "推荐剂量为20 mg" },
    { type: "source", id: `${SOURCE}#52-56`, excerpt: "每日一次" },
  ]);
  // Never a preference, never something a method mount could load.
  for (const entry of entries) {
    assert.ok(CAPSULE_FACT_KINDS.includes(entry.factKind));
    assert.ok(!CAPSULE_WORK_STYLE_FACT_KINDS.includes(entry.factKind), entry.factKind);
    assert.ok(!["profile", "preference", "stance", "expertise", "writing_style"].includes(entry.factKind));
  }
  // Keyed by content: the same understanding keys the same way twice, a changed claim does not.
  assert.deepEqual(libraryCapsuleEntries({ title: "房颤抗凝指南", sourceId: SOURCE, understanding }).map((entry) => entry.key), entries.map((entry) => entry.key));
  const changed = libraryCapsuleEntries({ title: "房颤抗凝指南", sourceId: SOURCE,
    understanding: { ...understanding, claims: [{ id: "c1", statement: "利伐沙班推荐剂量为 15 mg", evidence: [anchor("15 mg", 60)] }] } });
  assert.equal(changed.filter((entry) => entries.some((old) => old.key === entry.key)).length, 1, "the summary is unchanged");
});

test("one document puts at most twelve entries in the capsule: its summary and its first claims", () => {
  const claims = Array.from({ length: 40 }, (_, index) => ({ id: `c${index}`, statement: `第 ${index + 1} 条结论`, evidence: [anchor(`结论${index}`, 100 + index * 10)] }));
  const entries = libraryCapsuleEntries({ title: "长指南", sourceId: SOURCE, understanding: { summary: "一份很长的指南。", claims } });
  assert.equal(entries.length, DOCUMENT_MEMORY_MAX_ENTRIES);
  assert.equal(entries[0].content, "资料《长指南》的摘要：一份很长的指南。");
  assert.equal(entries.at(-1).content, `据资料《长指南》：第 ${DOCUMENT_MEMORY_MAX_ENTRIES - 1} 条结论`, "the claims the run put first");
  assert.equal(libraryCapsuleEntries({ title: "空", sourceId: SOURCE, understanding: { summary: " ", claims: [] } }).length, 0);
});

test("an entry is bounded to what a capsule entry holds, and a quote to what provenance holds", () => {
  const long = "长".repeat(30_000);
  const [entry] = libraryCapsuleEntries({ title: "t", sourceId: SOURCE, understanding: { claims: [{ id: "c", statement: long,
    evidence: [anchor("引".repeat(2_500))] }] } });
  assert.equal(entry.content.length, 20_000);
  assert.ok(entry.content.endsWith("…"));
  assert.equal(entry.provenance[0].excerpt.length, 2_000);
});

test("the library's directory is the account's, where the runtime mounts it from", () => {
  assert.equal(userLibraryDir({ dataDir: "/data" }, "user-1"), path.join("/data", "users", "user-1", "library"));
  assert.throws(() => userLibraryDir({ dataDir: "/data" }, "../other"), { code: "invalid_id" });
});

test("a document is described from its record: metadata when parsed, the file name when not", () => {
  const described = describeLibrarySource({ id: SOURCE, payload: {
    paths: ["knowledge-base/指南.pdf"], docType: "review-guideline",
    metadata: { title: " 房颤指南 ", authors: ["张三", " ", "李四"], doi: "10.1/x", doiCheck: { status: "unconfirmed" } },
    analysis: { pageCount: 12, tokenEstimate: 3_000, textSha256: "b".repeat(64), parserRevision: "evimed-extract@0.5.0" },
  } });
  assert.deepEqual(described, { title: "房颤指南", authors: ["张三", "李四"], doi: "10.1/x", doiStatus: "unconfirmed",
    kind: "review-guideline", format: "pdf", name: "指南.pdf", pageCount: 12, tokens: 3_000,
    index: { parserRevision: "evimed-extract@0.5.0", textSha256: "b".repeat(64) } });
  const bare = describeLibrarySource({ id: SOURCE, payload: { paths: ["knowledge-base/notes.md"], analysis: {} } });
  assert.equal(bare.title, "notes.md");
  assert.equal(bare.doi, null);
  assert.equal(bare.index, null);
});

test("the routes answer only their own paths, and a switched-off library says so", async () => {
  const store = { async ensureSessionUser() { return { user: { id: "user-1" } }; }, async assertCsrf() {} };
  const handler = createLibraryRoutes({ store, service: null, maxJsonBytes: 1024 });
  assert.equal(await handler({ url: "/api/sources", method: "GET" }, {}), false);
  await assert.rejects(handler({ url: "/api/library", method: "GET" }, {}), { code: "library_unavailable", status: 503 });
  const served = createLibraryRoutes({ store, service: {}, maxJsonBytes: 1024 });
  await assert.rejects(served({ url: "/api/library/not-a-source", method: "DELETE" }, {}), { code: "not_found", status: 404 });
  await assert.rejects(served({ url: `/api/library/${SOURCE}/publish-to-capsule`, method: "GET" }, {}), { code: "not_found" });
});

/**
 * A real `pg.Pool` over a stand-in wire: every statement takes a few
 * milliseconds, and `pg_advisory_xact_lock` blocks until the holder's
 * transaction ends, as PostgreSQL's does. The source lookup answers with one
 * readable source; every other statement answers with no rows.
 * @param {{ max: number, connectionTimeoutMillis: number, source: Record<string, any> }} options
 */
function lockingPool({ max, connectionTimeoutMillis, source }) {
  /** @type {Map<string, { holder: any, waiters: { client: any, resolve: () => void }[] }>} */
  const locks = new Map();
  class Wire extends EventEmitter {
    constructor() { super(); this._queryable = true; this._ending = false; /** @type {Set<string>} */ this.held = new Set(); }
    /** @param {(error: Error | null) => void} callback */
    connect(callback) { setImmediate(() => callback(null)); }
    /** @param {() => void} [callback] */
    end(callback) { this._ending = true; if (callback) setImmediate(callback); return Promise.resolve(); }
    ref() {}
    unref() {}
    /** @param {any} text @param {any} values @param {any} [callback] */
    query(text, values, callback) {
      if (typeof values === "function") { callback = values; values = undefined; }
      const run = this.#run(String(text?.text ?? text), values ?? []);
      if (callback) { run.then((result) => callback(null, result), (error) => callback(error)); return undefined; }
      return run;
    }
    /** @param {string} text @param {unknown[]} values */
    async #run(text, values) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (/pg_advisory_xact_lock/.test(text)) {
        const key = String(values[0] ?? text);
        const lock = locks.get(key);
        if (!lock) { locks.set(key, { holder: this, waiters: [] }); this.held.add(key); }
        else if (lock.holder !== this) await new Promise((resolve) => lock.waiters.push({ client: this, resolve: () => resolve(undefined) }));
        return { rows: [{}], rowCount: 1 };
      }
      if (/^\s*(COMMIT|ROLLBACK)/i.test(text)) {
        for (const key of this.held) {
          const lock = locks.get(key);
          const next = lock?.waiters.shift();
          if (next && lock) { lock.holder = next.client; next.client.held.add(key); next.resolve(); } else locks.delete(key);
        }
        this.held.clear();
      }
      if (/kind='source'/.test(text)) return { rows: [source], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  }
  return new pg.Pool({ max, connectionTimeoutMillis, Client: /** @type {any} */ (Wire) });
}

/** How a promise stands after `ms`: settled, or still waiting — so a
 *  regression reads as a failed assertion rather than a hung suite.
 * @param {Promise<any>} promise @param {number} ms */
async function within(promise, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const waiting = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "waiting" }), ms); });
  const outcome = await Promise.race([promise.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })), waiting]);
  clearTimeout(timer);
  return /** @type {{ status: string, value?: any, reason?: any }} */ (outcome);
}

test("publishes one account fires at once never starve another tenant's queries, and a second one is refused, not queued", { timeout: 30_000 }, async () => {
  // Security review 2026-09-20: publishing held a pooled connection in a
  // transaction waiting on a per-account advisory lock while the publication
  // took connections of its own, so as many concurrent publishes as the pool
  // has connections left every connection waiting and every other tenant's
  // query failing with "timeout exceeded when trying to connect".
  const POOL = 4;
  const sha256 = "b".repeat(64);
  const pool = lockingPool({ max: POOL, connectionTimeoutMillis: 400, source: {
    id: SOURCE, project_id: "papers", revision: 1, payload: { status: "complete", fingerprint: { sha256 }, paths: ["knowledge-base/指南.pdf"] } } });
  const database = new ControlPlaneDatabase({ databaseUrl: "postgres://unused", databasePoolMax: POOL, databaseConnectionTimeoutMs: 400 }, { pool });
  await database.migrate();
  // The publication ledger is keyed by the document, not by a library entry:
  // this happens to every document the platform reads, not only to the ones a
  // researcher chose to keep across projects.
  const entry = { id: `source-publication:${SOURCE}`, revision: 0, payload: { recordType: "source-publication", sourceId: SOURCE, entries: {} } };
  // Every read and write is a pooled statement, as ProductDocuments' are.
  const documents = {
    database,
    async list() {
      await database.query("SELECT 1");
      return { items: [], nextCursor: null };
    },
    async get(/** @type {string} */ userId, /** @type {string} */ kind, /** @type {string} */ id) {
      await database.query("SELECT 1");
      return userId === "user-a" && kind === "preferences" && id === entry.id && entry.revision > 0 ? entry : null;
    },
    async put(/** @type {string} */ _userId, /** @type {string} */ _kind, /** @type {string} */ _id, /** @type {any} */ payload) {
      await database.query("SELECT 1");
      entry.payload = payload;
      entry.revision += 1;
      return entry;
    },
  };
  /** @type {() => void} */
  let finishReading = () => {};
  const reading = new Promise((resolve) => { finishReading = () => resolve(undefined); });
  let understandingReads = 0;
  /** @type {{ get: (userId: string, id: string) => Promise<any>, getUnderstanding: () => Promise<any> }} */
  const sources = {
    async get(userId, id) {
      await database.query("SELECT 1");
      if (userId !== "user-a" || id !== SOURCE) throw Object.assign(new Error("gone"), { code: "source_not_found" });
      return { id: SOURCE, projectId: "papers", payload: { status: "complete", fingerprint: { sha256 }, paths: ["knowledge-base/指南.pdf"] } };
    },
    async getUnderstanding() {
      understandingReads += 1;
      await reading;
      return { current: { generation: 1, summary: "房颤抗凝指南。", claims: [{ id: "c1", statement: "利伐沙班推荐 20 mg 每日一次", evidence: [] }] } };
    },
  };
  let added = 0;
  const capsule = { id: "account-capsule:a", payload: { title: "我的记忆胶囊" } };
  const capsules = {
    async active() { await database.query("SELECT 1"); return { items: [{ capsuleId: capsule.id, mode: "own" }] }; },
    async get() { return capsule; },
    async ownCapsule() { return capsule; },
    async addEntry() { await database.query("SELECT 1"); added += 1; return { id: `fact-${added}`, revision: 1, payload: { status: "approved" } }; },
  };
  const library = new LibraryService({ documents, sources, capsules, libraryDir: () => "/nonexistent/library" });
  try {
    const first = library.publishSourceUnderstanding("user-a", SOURCE);
    first.catch(() => {}); // awaited below; a failed assertion must not surface as its rejection instead
    for (let waited = 0; understandingReads === 0 && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(understandingReads, 1, "the first publication is under way");
    // The account fires a pool's worth more while its first one is running.
    const more = await Promise.all(Array.from({ length: POOL }, () => within(library.publishSourceUnderstanding("user-a", SOURCE), 1_000)));
    assert.deepEqual(more.map((outcome) => outcome.status === "rejected" ? [outcome.reason.status, outcome.reason.code] : outcome.status),
      Array(POOL).fill([409, "library_publish_busy"]), "refused at once rather than waiting for the first");
    // A document this account does not have is refused, and so is a malformed
    // id — both before anything is held.
    const strangers = await Promise.all([
      library.publishSourceUnderstanding("user-b", SOURCE),
      library.publishSourceUnderstanding("user-a", "src_not-an-id"),
    ].map((attempt) => within(attempt, 1_000)));
    assert.deepEqual(strangers.map((outcome) => outcome.status === "rejected" ? outcome.reason.code : outcome.status),
      ["library_source_removed", "library_payload_invalid"],
      "another account has its own guard, and a document it does not hold is refused by the lookup");
    // Another tenant is served at once while the publication is still running.
    const tenant = await within(database.query("SELECT 1 -- another tenant"), 1_000);
    assert.equal(tenant.status, "fulfilled", tenant.reason?.message ?? tenant.status);
    assert.equal(understandingReads, 1, "only the first publication did any work");

    finishReading();
    const result = await first;
    assert.deepEqual({ facts: result.facts, added: result.added }, { facts: 1, added: 1 });
    // The guard goes with the publication: the next one runs, and adds nothing twice.
    const again = await library.publishSourceUnderstanding("user-a", SOURCE);
    assert.deepEqual({ added: again.added, kept: again.kept }, { added: 0, kept: 1 });
    // A publication that fails releases it too.
    sources.getUnderstanding = async () => { throw Object.assign(new Error("understanding unreadable"), { code: "source_unreadable" }); };
    await assert.rejects(library.publishSourceUnderstanding("user-a", SOURCE), { code: "source_unreadable" });
    sources.getUnderstanding = async () => ({ current: null });
    await assert.rejects(library.publishSourceUnderstanding("user-a", SOURCE), { code: "library_understanding_missing" });
  } finally {
    finishReading();
    await within(pool.end(), 1_000);
  }
});
