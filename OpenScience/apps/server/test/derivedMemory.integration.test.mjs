// Memory derived from a knowledge-base document, or from a project, goes when
// they go (plan 2026-09-23 §5.6, 修漏洞).
//
// On 2026-09-23 production held 62 「来自资料」 memories whose documents had
// long been deleted. The source deletion did try to retire what it had
// derived, but matched a capsule entry only by an exact
// `{ type: "source", id: "src_<32 hex>" }` — and the library writes the id of a
// span, `src_<32 hex>#<start>-<end>`, or, for an entry whose understanding
// carried no anchor, no provenance at all. A project deletion did not look.
//
// These tests publish through the real library path into a real capsule, so
// the entries have the shape production writes, and delete through the real
// source service and the real HTTP routes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CapsuleService } from "../src/capsuleService.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { findOrphanedDerivedMemory, withdrawDerivedMemory, withdrawOrphanedDerivedMemory } from "../src/derivedMemory.mjs";
import { LibraryService, PUBLICATION_RECORD_TYPE, PUBLICATION_RULE } from "../src/libraryService.mjs";
import { republishSourceMemory } from "../../../scripts/ops/republish-source-memory.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { SourceService } from "../src/sourceService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops/withdraw-orphan-memory.mjs");
const republishScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops/republish-source-memory.mjs");

/**
 * What the source-understanding capability yields for one document: a
 * summary — whose capsule entry has no provenance, so only the publication
 * ledger knows where it came from — and a claim anchored to a span, whose
 * entry names `src_…#10-26`. The slot is a column of the understanding and is
 * not published (2026-09-24).
 * @param {string} label
 */
const understandingFor = (label) => ({
  generation: 1,
  summary: `${label}：一项随机对照试验的结论。`,
  slots: { design: { state: "known", value: `${label}随机对照试验`, evidence: [{ quote: "randomised controlled trial" }] } },
  claims: [{ id: "c1", statement: `${label}推荐 20 mg 每日一次`, evidence: [{ quote: "20 mg once daily", start: 10, end: 26 }] }],
  methods: [],
});

/** A document registered in a project, as an upload registers it. */
async function register(sources, userId, projectId, sha256) {
  const { source } = await sources.register(userId, { projectId, connector: { type: "upload", id: "library" },
    path: `knowledge-base/${sha256.slice(0, 8)}.txt`, sha256, size: 10, mimeType: "text/plain", mtime: "2026-09-06T00:00:00Z" });
  return source;
}

/** The capsule entries one document's publication lists, from its ledger. */
async function publishedEntries(documents, userId, sourceId) {
  const ledger = await documents.get(userId, "preferences", `source-publication:${sourceId}`);
  return Object.values(ledger?.payload.entries ?? {});
}

/** @param {ProductDocuments} documents @param {string} userId @param {string} id */
const entry = (documents, userId, id) => documents.get(userId, "fact", id, { includeDeleted: true });

async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  const owner = `derived_${randomUUID()}`;
  const other = `derived_${randomUUID()}`;
  t.after(async () => {
    await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[owner, other]]);
    await database.close();
  });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Owner','development'),($2,'Other','development')", [owner, other]);
  await database.query(`INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes)
    VALUES($1,'default','Default',1048576),($1,'trial','Trial',1048576),($2,'default','Default',1048576)`, [owner, other]);
  const documents = new ProductDocuments(database);
  const jobs = new ProductJobs(database);
  const sources = new SourceService(documents, jobs);
  const capsules = new CapsuleService(documents);
  /** @type {Map<string, any>} */
  const understandings = new Map();
  const library = new LibraryService({ documents, capsules, libraryDir: () => "/nonexistent/library",
    sources: { get: (userId, id) => sources.get(userId, id), getUnderstanding: async (_userId, id) => ({ current: understandings.get(id) ?? null }) } });
  const publish = async (userId, source, label) => {
    understandings.set(source.id, understandingFor(label));
    return library.publishSourceUnderstanding(userId, source.id);
  };
  return { database, documents, jobs, sources, capsules, library, publish, owner, other };
}

test("deleting a document withdraws every memory it yielded, in the same transaction, and nothing else", options, async (t) => {
  const f = await fixture(t);
  const guideline = await register(f.sources, f.owner, "default", "a".repeat(64));
  const protocol = await register(f.sources, f.owner, "default", "b".repeat(64));
  assert.equal((await f.publish(f.owner, guideline, "抗凝指南")).added, 2);
  await f.publish(f.owner, protocol, "研究方案");
  // The same file in another account is another account's memory.
  const theirs = await register(f.sources, f.other, "default", "a".repeat(64));
  assert.equal(theirs.id, guideline.id, "a source id is per project and file, so the other account's collides by design");
  await f.publish(f.other, theirs, "抗凝指南");
  const capsule = await f.capsules.ownCapsule(f.owner);
  const stated = await f.capsules.addEntry(f.owner, capsule.id, { factKind: "preference", content: "证据先用表格", origin: "explicit",
    provenance: [{ type: "user", id: f.owner }] });
  const note = await f.capsules.note(f.owner, "trial", { factKind: "project_fact", content: "试验队列 500 人" });

  const withdrawn = await publishedEntries(f.documents, f.owner, guideline.id);
  assert.equal(withdrawn.length, 2);
  const provenances = await Promise.all(withdrawn.map(async (id) => (await entry(f.documents, f.owner, id)).payload.provenance));
  assert.deepEqual(provenances.map((items) => items.length).sort(), [0, 1], "one entry has no provenance at all; only the ledger knows it");
  assert.match(provenances.find((items) => items.length)[0].id, new RegExp(`^${guideline.id}#10-26$`), "the other names a span, not the document");
  const kept = [...await publishedEntries(f.documents, f.owner, protocol.id), stated.id, note.id];
  const theirsKept = await publishedEntries(f.documents, f.other, theirs.id);
  // A document's facts are recalled in its own project (2026-09-24).
  assert.equal((await f.capsules.recall(f.owner, { query: "抗凝指南推荐", projectId: "default" })).items.length, 1, "recalled before the deletion");

  const current = await f.sources.get(f.owner, guideline.id);
  await f.sources.remove(f.owner, guideline.id, { expectedRevision: current.revision });

  for (const id of withdrawn) {
    const row = await entry(f.documents, f.owner, id);
    assert.ok(row.deletedAt, "soft-deleted: no list, recall or share reads it");
    assert.equal(row.payload.status, "retired");
    assert.equal(row.payload.withdrawn.reason, "source_deleted");
    assert.equal(row.payload.withdrawn.sourceId, guideline.id);
    assert.ok(Number.isFinite(Date.parse(row.payload.withdrawn.at)));
    assert.match(row.payload.content, /抗凝指南/, "the text stays for the audit trail");
    assert.equal(await f.documents.get(f.owner, "fact", id), null);
    // One revision, recorded like every other, and the index told through the
    // same outbox a forget uses.
    const history = await f.documents.history(f.owner, "fact", id, { limit: 1 });
    assert.equal(history[0].revision, row.revision);
    assert.ok(history[0].deletedAt);
    const indexJob = await f.database.query(`SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND kind='memory-index'
      AND payload->>'documentId'=$2 AND payload->>'revision'=$3 AND payload->>'capsuleId'=$4`, [f.owner, id, String(row.revision), capsule.id]);
    assert.equal(indexJob.rowCount, 1, "the capsule's index rebuild is queued");
  }
  const ledger = await f.documents.get(f.owner, "preferences", `source-publication:${guideline.id}`);
  assert.equal(ledger.payload.recordType, PUBLICATION_RECORD_TYPE);
  assert.deepEqual(ledger.payload.entries, {}, "an emptied ledger, so a later publication of the same document starts over");
  assert.equal(ledger.payload.withdrawn.reason, "source_deleted");
  assert.equal(ledger.payload.withdrawn.entries, 2);

  for (const id of kept) assert.equal((await entry(f.documents, f.owner, id)).deletedAt, null, `${id} was not derived from the deleted document`);
  for (const id of theirsKept) assert.equal((await entry(f.documents, f.other, id)).payload.status, "approved", "another account's memory is untouched");
  assert.equal((await f.capsules.mine(f.owner)).entries.some((item) => withdrawn.includes(item.id)), false);
  assert.equal((await f.capsules.recall(f.owner, { query: "抗凝指南推荐", projectId: "default" })).items.length, 0, "no longer recalled");
  assert.equal((await f.capsules.recall(f.owner, { query: "研究方案推荐", projectId: "default" })).items.length, 1);

  // Idempotent: a second withdrawal finds nothing.
  assert.deepEqual(await f.database.transaction((client) => withdrawDerivedMemory(client, f.owner,
    { sourceIds: [guideline.id], reason: "source_deleted" })), { entries: 0, ledgers: 0 });
});

test("a publication that finishes after its document was deleted withdraws what it wrote", options, async (t) => {
  const f = await fixture(t);
  const source = await register(f.sources, f.owner, "default", "c".repeat(64));
  // The document goes while its understanding is being published: the
  // deletion sees nothing yet, and the publication finds the source gone only
  // when it is done.
  const racing = new LibraryService({ documents: f.documents, capsules: f.capsules, libraryDir: () => "/nonexistent/library",
    sources: {
      get: async (userId, id) => {
        const found = await f.sources.get(userId, id, { includeDeleted: true });
        if (found.deletedAt) throw Object.assign(new Error("gone"), { code: "source_not_found" });
        return found;
      },
      getUnderstanding: async (userId, id) => {
        const current = await f.sources.get(userId, id);
        await f.sources.remove(userId, id, { expectedRevision: current.revision });
        return { current: understandingFor("旧方案") };
      },
    } });
  await racing.publishSourceUnderstanding(f.owner, source.id);
  const listed = await f.documents.get(f.owner, "preferences", `source-publication:${source.id}`);
  assert.deepEqual(listed.payload.entries, {});
  assert.equal(listed.payload.withdrawn.entries, 2);
  const live = await f.database.query(`SELECT count(*)::integer AS count FROM evimed_product.documents
    WHERE user_id=$1 AND kind='fact' AND deleted_at IS NULL`, [f.owner]);
  assert.equal(live.rows[0].count, 0);
});

test("the orphan sweep finds what an earlier deletion left, reports before it changes anything, and is idempotent", options, async (t) => {
  const f = await fixture(t);
  const capsule = await f.capsules.ownCapsule(f.owner, { create: true });
  // 1. A document whose project was deleted before this fix: its source row
  //    went with the project, its entries and ledger stayed.
  const vanished = `src_${"d".repeat(32)}`;
  const anchored = await f.capsules.addEntry(f.owner, capsule.id, { factKind: "project_fact", layer: "sources", origin: "inferred",
    content: "据资料《kb-probe》：解析实测", provenance: [{ type: "source", id: `${vanished}#1-9`, excerpt: "kb-probe" }] });
  const unanchored = await f.capsules.addEntry(f.owner, capsule.id, { factKind: "project_fact", layer: "sources", origin: "inferred",
    content: "据资料《kb-probe》，研究设计：解析实测" });
  await f.documents.put(f.owner, "preferences", `source-publication:${vanished}`, { recordType: PUBLICATION_RECORD_TYPE, sourceId: vanished,
    capsuleId: capsule.id, generation: 1, entries: { k1: anchored.id, k2: unanchored.id } }, { expectedRevision: 0 });
  // 2. A document deleted before this fix: soft-deleted, its entries in force.
  const deleted = await register(f.sources, f.owner, "default", "e".repeat(64));
  await f.publish(f.owner, deleted, "解析实测");
  const deletedEntries = await publishedEntries(f.documents, f.owner, deleted.id);
  await f.database.query("UPDATE evimed_product.documents SET deleted_at=clock_timestamp() WHERE user_id=$1 AND kind='source' AND id=$2", [f.owner, deleted.id]);
  // 3. A note naming a project that no longer exists, left without a project row.
  await f.documents.put(f.owner, "fact", "note-of-a-gone-project", { capsuleId: capsule.id, factKind: "project_fact", layer: "knowledge",
    content: "已删除项目的笔记", origin: "inferred", status: "approved", provenance: [{ type: "source", id: "runtime-project:gone" }] }, { expectedRevision: 0 });
  // What must survive: a live document's entries, the researcher's own words,
  // a live project's note, and another account's orphan (swept for that account).
  const live = await register(f.sources, f.owner, "default", "f".repeat(64));
  await f.publish(f.owner, live, "现行指南");
  const kept = [...await publishedEntries(f.documents, f.owner, live.id),
    (await f.capsules.addEntry(f.owner, capsule.id, { factKind: "preference", content: "结论先行", origin: "explicit",
      provenance: [{ type: "user", id: f.owner }] })).id,
    (await f.capsules.note(f.owner, "trial", { factKind: "project_fact", content: "试验队列 500 人" })).id];
  const orphanIds = [anchored.id, unanchored.id, ...deletedEntries, "note-of-a-gone-project"];

  const found = await findOrphanedDerivedMemory(f.database, { userId: f.owner });
  assert.deepEqual(found.sources.map((item) => item.sourceId).sort(), [vanished, deleted.id].sort());
  assert.deepEqual(found.projects, [{ userId: f.owner, projectId: "gone" }]);

  const report = await withdrawOrphanedDerivedMemory(f.database, { userId: f.owner, apply: false });
  assert.equal(report.applied, false);
  assert.deepEqual({ sources: report.sources, projects: report.projects, entries: report.entries, ledgers: report.ledgers },
    { sources: 2, projects: 1, entries: 5, ledgers: 2 });
  for (const id of orphanIds) assert.equal((await entry(f.documents, f.owner, id)).deletedAt, null, "a report changes nothing");

  const swept = await withdrawOrphanedDerivedMemory(f.database, { userId: f.owner });
  assert.deepEqual({ sources: swept.sources, projects: swept.projects, entries: swept.entries, ledgers: swept.ledgers },
    { sources: 2, projects: 1, entries: 5, ledgers: 2 });
  for (const id of orphanIds) {
    const row = await entry(f.documents, f.owner, id);
    assert.ok(row.deletedAt, `${id} was withdrawn`);
    assert.match(row.payload.withdrawn.reason, /^(source|project)_missing$/);
  }
  assert.equal((await entry(f.documents, f.owner, "note-of-a-gone-project")).payload.withdrawn.projectId, "gone");
  for (const id of kept) assert.equal((await entry(f.documents, f.owner, id)).deletedAt, null, `${id} still stands`);

  const again = await withdrawOrphanedDerivedMemory(f.database, { userId: f.owner });
  assert.deepEqual({ sources: again.sources, projects: again.projects, entries: again.entries, ledgers: again.ledgers, orphans: again.orphans },
    { sources: 0, projects: 0, entries: 0, ledgers: 0, orphans: [] }, "a second sweep finds nothing");
});

test("the operator script reports, then withdraws, then finds nothing", options, async (t) => {
  const f = await fixture(t);
  const capsule = await f.capsules.ownCapsule(f.owner, { create: true });
  const orphan = await f.capsules.addEntry(f.owner, capsule.id, { factKind: "project_fact", layer: "sources", origin: "inferred",
    content: "据资料《已删除》：旧结论", provenance: [{ type: "source", id: `src_${"9".repeat(32)}#3-7` }] });
  const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [script, "--user", f.owner, ...args], {
    env: { ...process.env, OPEN_SCIENCE_DATABASE_URL: databaseUrl, OPEN_SCIENCE_DATABASE_URL_FILE: "" },
  })).stdout);
  const report = await run();
  assert.equal(report.applied, false);
  assert.equal(report.entries, 1);
  assert.equal((await entry(f.documents, f.owner, orphan.id)).deletedAt, null, "the default is a report");
  const applied = await run("--apply");
  assert.equal(applied.applied, true);
  assert.equal(applied.entries, 1);
  assert.deepEqual(applied.orphans, [{ userId: f.owner, sourceId: `src_${"9".repeat(32)}`, entries: 1, ledgers: 0 }]);
  assert.ok((await entry(f.documents, f.owner, orphan.id)).deletedAt);
  const after = await run("--apply");
  assert.equal(after.entries, 0);
  assert.deepEqual(after.orphans, []);
});

test("the real routes: deleting a document, then a project, withdraws what each put in the capsule", options, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-derived-memory-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl });
  const username = `derived${randomUUID().slice(0, 8)}`;
  let user;
  try {
    user = await app.store.createUser(username, "test-only-derived-password", "Derived fixture");
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-only-derived-password" }) });
    assert.equal(login.status, 200);
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    assert.equal((await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id: "trial", name: "试验项目" }) })).status, 200);

    const documents = new ProductDocuments(app.store.database);
    const capsules = new CapsuleService(documents);
    /** @type {Map<string, any>} */
    const understandings = new Map();
    // The understanding pipeline is not what is under test; its output is.
    app.sourceService.getUnderstanding = async (_userId, id) => ({ current: understandings.get(id) ?? null });
    const publish = async (source, label) => {
      understandings.set(source.id, understandingFor(label));
      await app.libraryService.publishSourceUnderstanding(user.id, source.id);
      return publishedEntries(documents, user.id, source.id);
    };
    await app.store.defaultProject(await app.store.userById(user.id));
    const removed = await register(app.sourceService, user.id, "default", "1".repeat(64));
    const stays = await register(app.sourceService, user.id, "default", "2".repeat(64));
    const inTrial = await register(app.sourceService, user.id, "trial", "3".repeat(64));
    const removedEntries = await publish(removed, "删除的资料");
    const stayingEntries = await publish(stays, "保留的资料");
    const trialEntries = await publish(inTrial, "试验资料");
    const note = await capsules.note(user.id, "trial", { factKind: "project_fact", content: "试验队列 500 人" });
    const capsule = await capsules.ownCapsule(user.id);
    const stated = await capsules.addEntry(user.id, capsule.id, { factKind: "preference", content: "证据先用表格", origin: "explicit",
      provenance: [{ type: "user", id: user.id }] });

    // DELETE /api/sources/:id — the knowledge base's delete.
    const source = await app.sourceService.get(user.id, removed.id);
    const deletion = await fetch(`${base}/api/sources/${encodeURIComponent(removed.id)}`, { method: "DELETE", headers,
      body: JSON.stringify({ expectedRevision: source.revision }) });
    assert.equal(deletion.status, 200);
    for (const id of removedEntries) {
      const row = await entry(documents, user.id, id);
      assert.ok(row.deletedAt);
      assert.equal(row.payload.withdrawn.reason, "source_deleted");
    }
    for (const id of [...stayingEntries, ...trialEntries, note.id, stated.id]) assert.equal((await entry(documents, user.id, id)).deletedAt, null);

    // DELETE /api/projects/:id — the project and what its documents and runs
    // put in the account's own capsule go together.
    const projectDeletion = await fetch(`${base}/api/projects/trial`, { method: "DELETE", headers, body: JSON.stringify({ confirm: "trial" }) });
    assert.equal(projectDeletion.status, 200);
    for (const id of trialEntries) {
      const row = await entry(documents, user.id, id);
      assert.ok(row?.deletedAt, "an account-level entry from the project's document is withdrawn, not left behind");
      assert.equal(row.payload.withdrawn.reason, "project_deleted");
      assert.equal(row.payload.withdrawn.projectId, "trial");
    }
    assert.equal(await entry(documents, user.id, note.id), null, "the project's own notes went with the project");
    const ledger = await documents.get(user.id, "preferences", `source-publication:${inTrial.id}`);
    assert.deepEqual(ledger.payload.entries, {});
    for (const id of [...stayingEntries, stated.id]) assert.equal((await entry(documents, user.id, id)).deletedAt, null, "the rest of the capsule stands");
    assert.deepEqual((await withdrawOrphanedDerivedMemory(app.store.database, { userId: user.id, apply: false })).orphans, [],
      "nothing is left for the sweep");
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/**
 * An entry the way the library wrote it before 2026-09-24: in the document
 * layer, listed on the document's ledger, and saying nothing of its project.
 * @param {any} f @param {any} capsule @param {any} source @param {Record<string, string>} contents key → content
 */
async function publishedTheOldWay(f, capsule, source, contents) {
  /** @type {Record<string, string>} */
  const entries = {};
  for (const [key, content] of Object.entries(contents)) {
    const written = await f.capsules.addEntry(f.owner, capsule.id, { factKind: "project_fact", layer: "sources", origin: "inferred", content });
    entries[key] = (await f.capsules.updateEntry(f.owner, capsule.id, written.id, { status: "approved", expectedRevision: written.revision })).id;
  }
  await f.documents.put(f.owner, "preferences", `source-publication:${source.id}`, { recordType: PUBLICATION_RECORD_TYPE, sourceId: source.id,
    capsuleId: capsule.id, generation: 1, facts: Object.keys(entries).length, methods: 0, entries }, { expectedRevision: 0 });
  return Object.values(entries);
}

test("a document's facts are recalled in its own project, those published before they carried it placed by their ledger", options, async (t) => {
  const f = await fixture(t);
  const capsule = await f.capsules.ownCapsule(f.owner, { create: true });
  const inDefault = await register(f.sources, f.owner, "default", "7".repeat(64));
  const inTrial = await register(f.sources, f.owner, "trial", "8".repeat(64));
  await f.publish(f.owner, inTrial, "试验方案");
  const [old] = await publishedTheOldWay(f, capsule, inDefault, { k1: "据资料《旧指南》，研究设计：抗凝随机对照" });
  const stated = await f.capsules.addEntry(f.owner, capsule.id, { factKind: "preference", content: "抗凝证据先看指南", origin: "explicit" });
  const recalled = async (/** @type {string | null} */ projectId) => (await f.capsules.recall(f.owner, { query: "抗凝", projectId })).items.map((item) => item.id).sort();
  assert.deepEqual(await recalled("default"), [old, stated.id].sort(), "the old entry is placed by its ledger in its document's project");
  assert.deepEqual(await recalled("trial"), [stated.id], "and is not recalled in another");
  assert.deepEqual(await recalled(null), [stated.id]);
  const trialEntries = await publishedEntries(f.documents, f.owner, inTrial.id);
  const trialRecall = (await f.capsules.recall(f.owner, { query: "试验方案", projectId: "trial" })).items.map((item) => item.id);
  assert.deepEqual(trialRecall.sort(), [...trialEntries].sort(), "a stamped entry is placed by its own stamp");
  assert.deepEqual((await f.capsules.recall(f.owner, { query: "试验方案", projectId: "default" })).items, []);
  // Neither is a memory the capsule page lists.
  assert.deepEqual((await f.capsules.mine(f.owner)).entries.map((item) => item.id), [stated.id]);
});

test("the republication script reports, publishes every understood document again under the current rule, and then finds nothing", options, async (t) => {
  const f = await fixture(t);
  const capsule = await f.capsules.ownCapsule(f.owner, { create: true });
  const source = await register(f.sources, f.owner, "default", "6".repeat(64));
  // Its current understanding, as the source service reads it back.
  const id = `understanding:${source.id}:g1`;
  const output = { schemaVersion: 1, sourceId: source.id, generation: 1, docType: source.payload.docType, depth: "structured",
    summary: "产品测评记录：记录了一次医学问答产品的测试。",
    slots: { purpose: { state: "unknown", reason: "原文未涉及" }, keyInformation: { state: "unknown", reason: "原文未涉及" }, limitations: { state: "unknown", reason: "原文未涉及" } },
    claims: [{ id: "c1", statement: "测试覆盖 30 个问题", evidence: [{ sourceId: source.id, generation: 1, unitId: `${source.id}:g1:u1`, start: 0, end: 4, quote: "测试覆盖" }] }],
    methods: [], omissionAudit: { status: "not_run", reason: "fixture", omissionRate: null } };
  await f.documents.put(f.owner, "knowledge", id, { recordType: "source-understanding", sourceId: source.id, generation: 1, status: "current",
    output, run: null, usage: null, units: [] }, { expectedRevision: 0, projectId: "default" });
  const current = await f.sources.get(f.owner, source.id);
  await f.documents.put(f.owner, "source", source.id, { ...current.payload, currentUnderstandingId: id }, { expectedRevision: current.revision, projectId: "default" });
  // What the library published before: a template field per entry, unstamped.
  const old = await publishedTheOldWay(f, capsule, source, {
    k1: "据资料《8.11医学测评.pdf》，研究设计：本文档没有研究设计——它不是研究报告",
    k2: "据资料《8.11医学测评.pdf》，效应估计：文档没有报告效应量",
  });
  const corrected = await f.capsules.updateEntry(f.owner, capsule.id, old[1], { content: "我改过的一句", expectedRevision: (await entry(f.documents, f.owner, old[1])).revision });
  assert.ok(corrected.payload.correctedAt);

  const report = await republishSourceMemory(f.database, { apply: false, userId: f.owner, limit: 100 });
  assert.deepEqual({ documents: report.documents, withdrawn: report.withdrawn, corrected: report.corrected, published: report.published, failed: report.failed },
    { documents: 1, withdrawn: 2, corrected: 1, published: 2, failed: 0 }, "the summary and the one anchored claim, and the correction it would take");
  for (const entryId of old) assert.equal((await entry(f.documents, f.owner, entryId)).deletedAt, null, "a report changes nothing");

  const applied = await republishSourceMemory(f.database, { apply: true, userId: f.owner, limit: 100 });
  assert.deepEqual({ documents: applied.documents, withdrawn: applied.withdrawn, published: applied.published, failed: applied.failed },
    { documents: 1, withdrawn: 2, published: 2, failed: 0 });
  for (const entryId of old) {
    const row = await entry(f.documents, f.owner, entryId);
    assert.ok(row.deletedAt);
    assert.equal(row.payload.withdrawn.reason, "source_republished");
  }
  const ledger = await f.documents.get(f.owner, "preferences", `source-publication:${source.id}`);
  assert.equal(ledger.payload.rule, PUBLICATION_RULE);
  assert.equal(ledger.payload.projectId, "default");
  const fresh = await Promise.all(Object.values(ledger.payload.entries).map((entryId) => entry(f.documents, f.owner, String(entryId))));
  assert.deepEqual(fresh.map((row) => row.payload.content).sort(), [
    "据资料《66666666.txt》：测试覆盖 30 个问题", "资料《66666666.txt》的摘要：产品测评记录：记录了一次医学问答产品的测试。"].sort());
  for (const row of fresh) {
    assert.equal(row.payload.sourceId, source.id);
    assert.equal(row.payload.projectId, "default");
    assert.equal(row.payload.status, "approved");
  }

  const again = await republishSourceMemory(f.database, { apply: true, userId: f.owner, limit: 100 });
  assert.equal(again.documents, 0, "a document already under the current rule is left alone");
  // The command line an operator runs: a report by default.
  const cli = JSON.parse((await promisify(execFile)(process.execPath, [republishScript, "--user", f.owner], {
    env: { ...process.env, OPEN_SCIENCE_DATABASE_URL: databaseUrl, OPEN_SCIENCE_DATABASE_URL_FILE: "" },
  })).stdout);
  assert.deepEqual({ applied: cli.applied, documents: cli.documents }, { applied: false, documents: 0 });
});
