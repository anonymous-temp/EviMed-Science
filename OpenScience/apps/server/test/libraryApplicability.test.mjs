// Which projects a library document applies to (2026-10-28): the record's `projects`, the one check every scope asks, and the
// per-project directories a runtime mounts. Over in-memory doubles and a real temporary directory, so what it asserts about the
// files is what a runtime would find; the same behaviour over PostgreSQL is `library.integration.test.mjs`.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { LibraryService, createLibraryRoutes, userLibraryDir } from "../src/libraryService.mjs";
import {
  assertOrdinaryProject, effectiveProjects, libraryRecordCovers, libraryRecordProjects, libraryViewsRoot, ordinaryHolderProjects,
  parseLibraryProjects, projectLibraryViewDir,
} from "../src/libraryScope.mjs";
import { HttpError } from "../src/security.mjs";

const USER = "alice";
const sourceId = (letter) => `src_${letter.repeat(32)}`;
const SHA = (letter) => letter.repeat(64);
const PROJECTS = ["a", "b", "c"];

/** An in-memory product ledger: just the calls the library makes, with the revision check the real one has. */
function ledger() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  const key = (/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id) => `${user}\u0000${kind}\u0000${id}`;
  const view = (/** @type {any} */ row) => ({ ...row, payload: structuredClone(row.payload) });
  const documents = {
    database: {
      /** @param {string} sql @param {any[]} values */
      async query(sql, values) {
        if (/count\(\*\)/.test(sql)) {
          return { rows: [{ count: [...rows.values()].filter((row) => row.userId === values[0] && row.kind === "preferences" && !row.deletedAt).length }] };
        }
        if (/kind='source'/.test(sql)) {
          const wanted = new Set(values[1]);
          return { rows: [...rows.values()].filter((row) => row.userId === values[0] && row.kind === "source" && !row.deletedAt && wanted.has(row.payload.fingerprint?.sha256))
            .map((row) => ({ id: row.id, project_id: row.projectId, payload: structuredClone(row.payload), revision: row.revision })) };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
    async get(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id, { includeDeleted = false } = {}) {
      const row = rows.get(key(user, kind, id));
      return row && (includeDeleted || !row.deletedAt) ? view(row) : null;
    },
    async list(/** @type {string} */ user, /** @type {string} */ kind, { filter = {} } = {}) {
      const items = [...rows.values()].filter((row) => row.userId === user && row.kind === kind && !row.deletedAt
        && Object.entries(filter).every(([field, value]) => row.payload[field] === value)).map(view);
      return { items, nextCursor: null };
    },
    async put(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id, /** @type {any} */ payload, { expectedRevision, projectId = null } = {}) {
      const existing = rows.get(key(user, kind, id));
      if ((existing?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("revision"), { code: "product_revision_conflict", status: 409 });
      const row = { id, kind, userId: user, projectId: existing?.projectId ?? projectId, revision: (existing?.revision ?? 0) + 1, payload: structuredClone(payload), deletedAt: null };
      rows.set(key(user, kind, id), row);
      return view(row);
    },
    async remove(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id) {
      const row = rows.get(key(user, kind, id));
      row.deletedAt = "2026-10-28T00:00:00Z";
      row.revision += 1;
      return view(row);
    },
    async restore(/** @type {string} */ user, /** @type {string} */ kind, /** @type {string} */ id) {
      const row = rows.get(key(user, kind, id));
      row.deletedAt = null;
      row.revision += 1;
      return view(row);
    },
  };
  /** @param {string} letter @param {string} projectId @param {string} text */
  const addSource = (letter, projectId, text = `# ${letter}\n\nbody of ${letter}\n`) => {
    rows.set(key(USER, "source", sourceId(letter)), { id: sourceId(letter), kind: "source", userId: USER, projectId, revision: 1, deletedAt: null, text,
      payload: { status: "complete", paths: [`knowledge-base/${letter}.md`], fingerprint: { sha256: SHA(letter) }, generation: 1,
        connector: { type: "upload" }, metadata: { title: `Doc ${letter}` }, analysis: { textSha256: SHA("f"), parserRevision: "p1", tokenEstimate: 10 } } });
  };
  return { rows, documents, addSource, key };
}

/** @param {{ rows: Map<string, any>, documents: any, key: (user: string, kind: string, id: string) => string }} store */
async function fixture(store) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "library-applies-"));
  const config = { dataDir };
  const guarded = [];
  const sources = {
    withRegistrationLocks: async (/** @type {string[]} */ _keys, /** @type {() => Promise<any>} */ work) => work(),
    loadCapture: async (/** @type {string} */ user, /** @type {any} */ source) => ({ input: { text: store.rows.get(store.key(user, "source", source.id)).text },
      extractor: { name: "test", version: "1", parser: "plain" }, pageMap: null, metadata: source.payload.metadata }),
  };
  const service = new LibraryService({ documents: store.documents, sources, libraryDir: (user) => userLibraryDir(config, user), viewsDir: (user) => libraryViewsRoot(config, user),
    projectGuard: async (_user, projectId) => {
      guarded.push(projectId);
      if (!PROJECTS.includes(projectId)) throw new HttpError(400, "library_project_invalid", "Choose an ordinary project.");
    } });
  /** The documents a project's directory holds, by source id. @param {string} projectId */
  const viewOf = async (projectId) => (await readdir(projectLibraryViewDir(config, USER, projectId)).catch(() => /** @type {string[]} */ ([]))).sort();
  return { dataDir, config, service, guarded, viewOf, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test("a record with no `projects` is every record written before the field: it means all projects, and nothing unreadable ever widens one", () => {
  assert.equal(libraryRecordProjects({}), "all");
  assert.equal(libraryRecordProjects({ projects: "all" }), "all");
  assert.deepEqual(libraryRecordProjects({ projects: ["a", "a", "b"] }), ["a", "b"]);
  // A stored value this code cannot understand reads as an empty list: fail closed.
  for (const odd of [null, 7, "a", {}, [1, {}]]) assert.deepEqual(libraryRecordProjects({ projects: odd }), [], JSON.stringify(odd));
  assert.equal(libraryRecordCovers({}, "z"), true);
  assert.equal(libraryRecordCovers({ projects: "all" }, "z"), true, "a project made later is covered by the marker");
  assert.equal(libraryRecordCovers({ projects: ["a"] }, "a"), true);
  assert.equal(libraryRecordCovers({ projects: ["a"] }, "b"), false);
  assert.equal(libraryRecordCovers({ projects: [] }, "a"), false);
  assert.equal(libraryRecordCovers({}, ""), false, "no project, no scope");
  assert.equal(libraryRecordCovers({}, undefined), false);
});

test("a document applies to the projects that hold it plus what its record adds", () => {
  assert.deepEqual(effectiveProjects({ holders: ["b", "a"], record: null }), ["a", "b"], "no record: only where it lives");
  assert.deepEqual(effectiveProjects({ holders: ["a"], record: { projects: ["c"] } }), ["a", "c"]);
  assert.deepEqual(effectiveProjects({ holders: [], record: { projects: [] } }), [], "a personal document listed nowhere applies nowhere");
  assert.equal(effectiveProjects({ holders: ["a"], record: { projects: "all" } }), "all");
  assert.equal(effectiveProjects({ holders: ["a"], record: {} }), "all", "an old record");
  assert.deepEqual(ordinaryHolderProjects(["b", "evimed-library", "evimed-learning", "a", "b"]), ["a", "b"], "personal storage and platform projects hold documents but are not projects");
});

test("the request's `projects` is \"all\" or a list of ids, in the order given and without repeats", () => {
  assert.equal(parseLibraryProjects("all"), "all");
  assert.deepEqual(parseLibraryProjects(["b", "a", "b"]), ["b", "a"]);
  assert.deepEqual(parseLibraryProjects([]), []);
  for (const bad of [undefined, null, "a", "ALL", 1, {}, [1], [null], [""], ["a/b"], ["../x"], Array.from({ length: 201 }, (_, index) => `p${index}`)]) {
    assert.throws(() => parseLibraryProjects(bad), { status: 400, code: "library_projects_invalid" }, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("a document may apply only to an existing, unarchived, ordinary project of the account: every other answer is the same refusal", async () => {
  const known = new Map([["a", {}], ["old", { archivedAt: "2026-01-01T00:00:00Z" }], ["geo-1", {}], ["study-1", {}]]);
  const rule = {
    store: { requireProject: async (_user, id) => {
      if (!known.has(id)) throw new HttpError(404, "project_not_found", "Project not found.");
      return { id, ...known.get(id) };
    } },
    moduleProject: async (_user, id) => id === "geo-1" || id === "study-1",
  };
  const user = { id: USER };
  assert.equal((await assertOrdinaryProject(rule, user, "a")).id, "a");
  for (const id of ["evimed-library", "evimed-learning", "eval-paper-x", "nope", "old", "geo-1", "study-1", "", undefined, 7]) {
    await assert.rejects(assertOrdinaryProject(rule, user, id), { status: 400, code: "library_project_invalid" }, String(id));
  }
  // A store that fails for another reason is not turned into a refusal.
  await assert.rejects(assertOrdinaryProject({ store: { requireProject: async () => { throw new Error("database down"); } } }, user, "a"), /database down/);
});

test("a document limited to project B is in B's directory and search scope and in no other project's, and \"all\" covers a project made afterwards", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, viewOf, config, cleanup } = await fixture(store);
  t.after(cleanup);
  // The runtimes of a, b and c have each been launched once: each has its directory, and nothing is in it.
  for (const project of PROJECTS) await service.ensureProjectView(USER, project);
  assert.deepEqual([await viewOf("a"), await viewOf("b"), await viewOf("c")], [[], [], []]);

  const made = await service.setProjects(USER, sourceId("a"), ["b"]);
  assert.equal(made.created, true);
  assert.deepEqual(made.item.libraryProjects, ["b"]);
  assert.deepEqual(made.item.appliesTo, ["a", "b"], "the project that holds it, and the one the record names");
  assert.ok(Number.isSafeInteger(made.item.revision) && made.item.revision >= 1, "the entry says the revision a change is sent back against");
  assert.deepEqual([await viewOf("a"), await viewOf("b"), await viewOf("c")], [[], [sourceId("a")], []],
    "the call has answered, and B's directory holds the document; A holds it itself and C is not told of it");
  assert.match(await readFile(path.join(projectLibraryViewDir(config, USER, "b"), sourceId("a"), "index.md"), "utf8"), /body of a/);

  assert.deepEqual((await service.searchScope(USER, "b")).map((entry) => entry.sourceId), [sourceId("a")]);
  assert.deepEqual(await service.searchScope(USER, "c"), []);
  assert.deepEqual(await service.searchScope(USER, "a"), [], "the holder reads its own copy, not the library's");
  assert.equal(await service.readCopyText(USER, sourceId("a"), { projectId: "c" }), null, "read as C reads it, it is not there");
  assert.match(await service.readCopyText(USER, sourceId("a"), { projectId: "b" }), /body of a/);
  assert.match(await service.readCopyText(USER, sourceId("a")), /body of a/, "the account's own read is not a project's");

  // Every project: the marker, not a list, so a project that did not exist yet is covered when it appears.
  const widened = await service.setProjects(USER, sourceId("a"), "all", { expectedRevision: made.item.revision });
  assert.equal(widened.created, false);
  assert.equal(widened.item.libraryProjects, "all");
  assert.equal(widened.item.appliesTo, "all");
  assert.deepEqual([await viewOf("a"), await viewOf("b"), await viewOf("c")], [[sourceId("a")], [sourceId("a")], [sourceId("a")]]);
  assert.deepEqual((await service.searchScope(USER, "d-made-later")).map((entry) => entry.sourceId), [sourceId("a")]);
  assert.deepEqual(await service.ensureProjectView(USER, "d-made-later").then(async () => viewOf("d-made-later")), [sourceId("a")]);
});

test("narrowing a document takes it out of the other projects' directories before the call answers, and a refused change changes nothing", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, viewOf, guarded, cleanup } = await fixture(store);
  t.after(cleanup);
  for (const project of PROJECTS) await service.ensureProjectView(USER, project);
  const wide = await service.setProjects(USER, sourceId("a"), "all");
  assert.deepEqual([await viewOf("b"), await viewOf("c")], [[sourceId("a")], [sourceId("a")]]);

  const narrowed = await service.setProjects(USER, sourceId("a"), ["c"], { expectedRevision: wide.item.revision });
  assert.deepEqual(narrowed.item.libraryProjects, ["c"]);
  assert.deepEqual([await viewOf("b"), await viewOf("c")], [[], [sourceId("a")]], "B lost it with the answer, not at the next pass");
  assert.deepEqual(await service.searchScope(USER, "b"), []);

  // A stale revision, a project the account cannot use, and a shape that is not one: refused, and the directories stay as they were.
  const revision = narrowed.item.revision;
  await assert.rejects(service.setProjects(USER, sourceId("a"), ["b"], { expectedRevision: revision - 1 }), { status: 409, code: "product_revision_conflict" });
  await assert.rejects(service.setProjects(USER, sourceId("a"), ["b", "evimed-library"]), { status: 400, code: "library_project_invalid" });
  await assert.rejects(service.setProjects(USER, sourceId("a"), "none"), { status: 400, code: "library_projects_invalid" });
  await assert.rejects(service.setProjects(USER, sourceId("a"), ["b"], { expectedRevision: 0 }), { status: 400, code: "library_payload_invalid" });
  await assert.rejects(service.setProjects(USER, `src_${"0".repeat(32)}`, ["b"]), { status: 404, code: "library_source_invalid" });
  assert.deepEqual([await viewOf("b"), await viewOf("c")], [[], [sourceId("a")]]);
  assert.ok(guarded.includes("evimed-library"), "every named project went through the account's project rule");
  assert.deepEqual((await service.list(USER)).items[0].libraryProjects, ["c"]);

  // An empty list is allowed: the document is kept and applies to no project beyond the one that holds it.
  const none = await service.setProjects(USER, sourceId("a"), [], { expectedRevision: revision });
  assert.deepEqual(none.item.appliesTo, ["a"]);
  assert.deepEqual([await viewOf("b"), await viewOf("c")], [[], []]);
});

test("DELETE returns a document to the project that holds it: out of every directory, and the copy goes", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, viewOf, dataDir, cleanup } = await fixture(store);
  t.after(cleanup);
  for (const project of PROJECTS) await service.ensureProjectView(USER, project);
  await service.setProjects(USER, sourceId("a"), "all");
  assert.deepEqual(await viewOf("b"), [sourceId("a")]);
  assert.deepEqual(await service.remove(USER, sourceId("a")), { sourceId: sourceId("a"), removed: true });
  assert.deepEqual([await viewOf("a"), await viewOf("b"), await viewOf("c")], [[], [], []]);
  await assert.rejects(stat(path.join(userLibraryDir({ dataDir }, USER), sourceId("a"))), { code: "ENOENT" });
  assert.deepEqual(await service.searchScope(USER, "b"), []);
});

test("an entry written before the field behaves as all, in the scope, the list and every directory", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, viewOf, cleanup } = await fixture(store);
  t.after(cleanup);
  await service.add(USER, sourceId("a"));
  const record = store.rows.get(store.key(USER, "preferences", `library:${SHA("a")}`));
  delete record.payload.projects;
  const [item] = (await service.list(USER)).items;
  assert.equal(item.libraryProjects, "all");
  assert.equal(item.appliesTo, "all");
  assert.deepEqual((await service.searchScope(USER, "anything")).map((entry) => entry.sourceId), [sourceId("a")]);
  await service.ensureProjectView(USER, "b");
  assert.deepEqual(await viewOf("b"), [sourceId("a")]);
  assert.equal(await service.appliesWhole(USER, "b"), true);
  // A call that forgot its project gets an error, not every document the account keeps.
  await assert.rejects(service.searchScope(USER), TypeError);
  await assert.rejects(service.searchScope(USER, ""), TypeError);
  assert.equal((await service.accountScope(USER)).length, 1, "the account's own page names the whole library as such");
});

test("a directory that holds anything it should not is brought right, and a stale copy is rewritten", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  store.addSource("b", "a");
  const { service, viewOf, config, cleanup } = await fixture(store);
  t.after(cleanup);
  await service.ensureProjectView(USER, "c");
  await service.setProjects(USER, sourceId("a"), ["c"]);
  const view = projectLibraryViewDir(config, USER, "c");
  const { mkdir, writeFile } = await import("node:fs/promises");
  // Another document's folder, a stray file and a corrupted copy: what a crash or a hand edit could leave.
  await mkdir(path.join(view, sourceId("b")), { recursive: true });
  await writeFile(path.join(view, sourceId("b"), "index.md"), "limited elsewhere");
  await writeFile(path.join(view, "notes.txt"), "stray");
  await writeFile(path.join(view, sourceId("a"), "index.md"), "tampered");
  await service.ensureProjectView(USER, "c");
  assert.deepEqual(await viewOf("c"), [sourceId("a")]);
  assert.match(await readFile(path.join(view, sourceId("a"), "index.md"), "utf8"), /body of a/);
});

test("a launch's directory is right or absent: it follows the master, and one that cannot be brought right is removed rather than mounted", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, dataDir, viewOf, cleanup } = await fixture(store);
  t.after(cleanup);
  await service.ensureProjectView(USER, "b");
  await service.setProjects(USER, sourceId("a"), ["b"]);
  assert.deepEqual(await viewOf("b"), [sourceId("a")]);
  // The master vanishes between the record and the launch (a half-removed library): the directory is rebuilt without the document.
  await rm(path.join(userLibraryDir({ dataDir }, USER), sourceId("a")), { recursive: true });
  await service.ensureProjectView(USER, "b");
  assert.deepEqual(await viewOf("b"), []);
  // `onlyIfMissing` takes an existing directory as current and makes one that is not there.
  assert.equal(await service.ensureProjectView(USER, "c", { onlyIfMissing: true }), projectLibraryViewDir({ dataDir }, USER, "c"));
  assert.equal((await stat(projectLibraryViewDir({ dataDir }, USER, "c"))).isDirectory(), true);
  assert.equal(await new LibraryService({ documents: store.documents, sources: {}, libraryDir: () => "/x" }).ensureProjectView(USER, "b"), null, "a library that keeps no views makes none");

  // The records cannot be read at launch: a directory that might still show a document it must not is removed, and the launch has none.
  await service.setProjects(USER, sourceId("a"), ["b"]);
  assert.deepEqual(await viewOf("b"), [sourceId("a")]);
  store.documents.list = async () => { throw new Error("database down"); };
  assert.equal(await service.ensureProjectView(USER, "b"), null);
  await assert.rejects(stat(projectLibraryViewDir({ dataDir }, USER, "b")), { code: "ENOENT" });
});

test("a replaced document carries its entry to the new bytes, once, and never widens an entry the new bytes already have", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, viewOf, cleanup } = await fixture(store);
  t.after(cleanup);
  for (const project of PROJECTS) await service.ensureProjectView(USER, project);
  await service.setProjects(USER, sourceId("a"), ["b"]);
  assert.deepEqual(await viewOf("b"), [sourceId("a")]);

  // Project a's document is replaced: the old row is retired (no longer current), a new one with new bytes takes its place.
  const old = store.rows.get(store.key(USER, "source", sourceId("a")));
  old.payload.publication = { current: false };
  store.addSource("d", "a", "# d\n\nthe new version\n");
  const event = { projectId: "a", replaced: { sourceId: sourceId("a"), sha256: SHA("a"), version: 1 }, by: { sourceId: sourceId("d") } };
  assert.deepEqual(await service.carryOver(USER, event), { carried: true, released: true });
  const [item] = (await service.list(USER)).items;
  assert.equal(item.sourceId, sourceId("d"));
  assert.deepEqual(item.libraryProjects, ["b"], "the new version applies where the old one did");
  assert.deepEqual(await viewOf("b"), [sourceId("d")], "and B now holds the new version in place of the old");
  assert.equal((await service.list(USER)).items.length, 1, "the old entry is released");
  // Again: nothing more to do.
  assert.deepEqual(await service.carryOver(USER, event), { carried: false, released: false });

  // The new bytes already had an entry of their own, limited to c: it stays as it was; the old one still goes.
  store.addSource("e", "a");
  await service.setProjects(USER, sourceId("e"), ["c"]);
  store.addSource("f", "a");
  await service.setProjects(USER, sourceId("f"), ["b"]);
  const oldF = store.rows.get(store.key(USER, "source", sourceId("f")));
  oldF.payload.publication = { current: false };
  store.addSource("g", "a");
  // `g`'s bytes are `e`'s: the new version is a document the library already holds.
  store.rows.get(store.key(USER, "source", sourceId("g"))).payload.fingerprint.sha256 = SHA("e");
  const merged = await service.carryOver(USER, { projectId: "a", replaced: { sourceId: sourceId("f"), sha256: SHA("f"), version: 1 }, by: { sourceId: sourceId("g") } });
  assert.deepEqual(merged, { carried: false, released: true });
  const held = (await service.list(USER)).items.find((entry) => entry.sourceId === sourceId("e"));
  assert.deepEqual(held.libraryProjects, ["c"], "a scope someone set is never widened by a replacement");
  // Personal storage carries its own entries.
  assert.deepEqual(await service.carryOver(USER, { ...event, projectId: "evimed-library" }), { carried: false, released: false });
});

test("a library entry that is still held by another project's copy of the old bytes is not released when one copy is replaced", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, cleanup } = await fixture(store);
  t.after(cleanup);
  await service.setProjects(USER, sourceId("a"), ["b"]);
  // Project c holds the same bytes as a current document of its own.
  store.addSource("h", "c");
  store.rows.get(store.key(USER, "source", sourceId("h"))).payload.fingerprint.sha256 = SHA("a");
  store.rows.get(store.key(USER, "source", sourceId("a"))).payload.publication = { current: false };
  store.addSource("d", "a");
  const result = await service.carryOver(USER, { projectId: "a", replaced: { sourceId: sourceId("a"), sha256: SHA("a"), version: 1 }, by: { sourceId: sourceId("d") } });
  assert.deepEqual(result, { carried: true, released: false });
  assert.equal((await service.list(USER)).items.length, 2, "the old bytes' entry and the new bytes' entry");
});

test("the routes: PUT sets where a document applies, POST takes the same field, and both name what is wrong", async (t) => {
  const store = ledger();
  store.addSource("a", "a");
  const { service, viewOf, cleanup } = await fixture(store);
  t.after(cleanup);
  await service.ensureProjectView(USER, "b");
  const routes = createLibraryRoutes({ store: { ensureSessionUser: async () => ({ user: { id: USER } }), assertCsrf: async () => {} }, service, maxJsonBytes: 4096 });
  const call = async (method, url, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url, method, headers: {} });
    const res = { status: 0, body: "", writeHead() {}, setHeader() {}, end(text) { this.body = text; } };
    res.writeHead = (status) => { res.status = status; };
    assert.equal(await routes(req, res), true);
    return { status: res.status, data: res.body ? JSON.parse(res.body).data : null };
  };
  const route = `/api/library/${sourceId("a")}`;

  const created = await call("PUT", route, { projects: ["b"] });
  assert.equal(created.status, 201);
  assert.deepEqual([created.data.libraryProjects, created.data.appliesTo, created.data.projects], [["b"], ["a", "b"], ["a"]]);
  assert.ok(created.data.revision > 1, "the copy written after the entry is its next revision, and the answer carries the latest");
  assert.deepEqual(await viewOf("b"), [sourceId("a")]);
  const changed = await call("PUT", route, { projects: "all", expectedRevision: created.data.revision });
  assert.equal(changed.status, 200);
  assert.deepEqual([changed.data.libraryProjects, changed.data.appliesTo], ["all", "all"]);

  for (const [body, code] of [
    [{}, "library_projects_invalid"], [{ projects: "b" }, "library_projects_invalid"], [{ projects: [7] }, "library_projects_invalid"],
    [{ projects: ["evimed-library"] }, "library_project_invalid"], [{ projects: ["unknown"] }, "library_project_invalid"],
    [{ projects: "all", extra: 1 }, "library_payload_invalid"], [{ projects: "all", expectedRevision: "1" }, "library_payload_invalid"],
  ]) {
    await assert.rejects(call("PUT", route, body), { status: 400, code }, JSON.stringify(body));
  }
  await assert.rejects(call("PUT", route, { projects: "all", expectedRevision: 1 }), { status: 409, code: "product_revision_conflict" });

  // POST without `projects` keeps what an entry says and adds a new one for every project; with it, it is the same change.
  assert.equal((await call("POST", "/api/library", { sourceId: sourceId("a") })).data.libraryProjects, "all");
  assert.deepEqual((await call("POST", "/api/library", { sourceId: sourceId("a"), projects: ["b"] })).data.libraryProjects, ["b"]);
  store.addSource("d", "a");
  const added = await call("POST", "/api/library", { sourceId: sourceId("d") });
  assert.equal(added.status, 201);
  assert.equal(added.data.libraryProjects, "all", "a new entry applies everywhere unless it is told otherwise");
  await assert.rejects(call("POST", "/api/library", { sourceId: sourceId("a"), projects: ["nope"] }), { code: "library_project_invalid" });
  await assert.rejects(call("POST", "/api/library", { sourceId: sourceId("a"), projects: "none" }), { code: "library_projects_invalid" });
});
