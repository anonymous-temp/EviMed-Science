import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LIBRARY_ITEM_STATUSES } from "@evimed/domain";
import { createRebuildIndex } from "../../../scripts/ops/rebuild-kb-index.mjs";
import { KB_INDEX_METHOD, tsvectorLiteral } from "../src/kbChunker.mjs";
import { userLibraryDir } from "../src/libraryService.mjs";
import { projectLibraryViewDir } from "../src/libraryScope.mjs";
import { databaseUrl, ingestCorpus, signedIn, titleOf } from "./helpers/knowledgeBaseApp.mjs";
import { makePack } from "./helpers/capsuleFixtures.mjs";

const GUIDELINE = "房颤抗凝指南.pdf";
const skip = !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured";

/** @param {string} base @param {Record<string, string>} headers */
function api(base, headers) {
  return async (/** @type {string} */ route, /** @type {{ method?: string, body?: unknown }} */ { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

/** @param {any} app @param {string} userId @param {string} sha256 */
async function indexDocuments(app, userId, sha256) {
  const result = await app.store.database.query("SELECT count(*)::integer AS n FROM evimed_kb.documents WHERE user_id=$1 AND sha256=$2", [userId, sha256]);
  return result.rows[0].n;
}

/** Give a source the understanding a deep source reading would have delivered,
 *  quoting its captured text exactly.
 * @param {any} app @param {any} user @param {{ id: string }} source @param {{ statement: string, quote: string }} claim */
async function giveUnderstanding(app, user, source, claim) {
  const current = await app.sourceService.get(user.id, source.id);
  const capture = await app.sourceService.loadCapture(user.id, current);
  const text = capture.input.text;
  const anchorOf = (/** @type {string} */ quote) => {
    const start = text.indexOf(quote);
    assert.ok(start >= 0, quote);
    const unit = capture.input.units.find((/** @type {any} */ item) => item.start <= start && start + quote.length <= item.end);
    return { sourceId: current.id, generation: current.payload.generation, unitId: unit.id, start, end: start + quote.length, quote };
  };
  const generation = current.payload.generation;
  const output = {
    schemaVersion: 1, sourceId: current.id, generation, docType: current.payload.docType, depth: "deep", summary: "房颤抗凝治疗指南。",
    slots: { purpose: { state: "known", value: "规范非瓣膜性房颤患者的抗凝治疗", evidence: [anchorOf("卒中预防以口服抗凝为基础")] },
      limitations: { state: "unknown", reason: "文中没有写" } },
    claims: [{ id: "c1", statement: claim.statement, evidence: [anchorOf(claim.quote)] }],
    methods: [{ id: "m1", title: "抗凝期间的随访", description: "定期复查并记录不良事件。", whenToUse: "长期口服抗凝期间",
      steps: ["每三个月复查血常规", "复查肝肾功能"], checks: ["记录不良事件"], pitfalls: [],
      evidence: [anchorOf("每三个月复查血常规与肝肾功能")], status: "draft" }],
    omissionAudit: { status: "not_run", reason: "fixture", omissionRate: null },
  };
  const id = `understanding:${current.id}:g${generation}`;
  const documents = app.sourceService.documents;
  const existing = await documents.get(user.id, "knowledge", id);
  await documents.put(user.id, "knowledge", id, { recordType: "source-understanding", sourceId: current.id, generation, status: "current",
    output, run: null, usage: null, units: [] }, { expectedRevision: existing?.revision ?? 0, projectId: current.projectId });
  if (current.payload.currentUnderstandingId !== id) {
    await documents.put(user.id, "source", current.id, { ...current.payload, currentUnderstandingId: id },
      { expectedRevision: current.revision, projectId: current.projectId });
  }
}

test("one document added from two projects is one entry, read from a third, and outlives both", { skip }, async () => {
  const context = await signedIn({ kbSmallLibraryTokens: 150_000 });
  try {
    const { app, user, project: reader, base, headers, dataDir } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    await app.store.createProject(owner, "papers-a", "资料 A");
    await app.store.createProject(owner, "papers-b", "资料 B");
    const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
    const [inB] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-b" });
    const sha256 = inA.payload.fingerprint.sha256;
    assert.equal(inB.payload.fingerprint.sha256, sha256);
    assert.notEqual(inA.id, inB.id, "two projects, two sources");

    const added = await call("/api/library", { method: "POST", body: { sourceId: inA.id } });
    assert.equal(added.status, 201);
    assert.equal(added.body.data.sourceId, inA.id);
    assert.equal(added.body.data.title, titleOf(GUIDELINE));
    assert.equal(added.body.data.format, "pdf");
    assert.equal(added.body.data.pageCount, 3);
    assert.equal(added.body.data.status, "ready");
    assert.deepEqual(added.body.data.projects, ["papers-a", "papers-b"]);
    assert.deepEqual(added.body.data.sourceIds, [inA.id, inB.id].sort(), "each project's source card can find its document");
    assert.ok(Date.parse(added.body.data.addedAt));
    const again = await call("/api/library", { method: "POST", body: { sourceId: inB.id } });
    assert.equal(again.status, 200, "the same document from another project is the entry it already is");
    assert.equal(again.body.data.sourceId, inA.id);
    assert.equal((await call("/api/library")).body.data.items.length, 1);
    assert.equal((await call("/api/library", { method: "POST", body: { sourceId: inA.id, extra: 1 } })).body.code, "library_payload_invalid");
    assert.equal((await call("/api/library", { method: "POST", body: { sourceId: `src_${"0".repeat(32)}` } })).status, 404);

    // The library's own copy, where the runtime mounts it from.
    const libraryDir = userLibraryDir({ dataDir }, user.id);
    assert.equal(libraryDir, path.join(dataDir, "users", user.id, "library"));
    const copy = await readFile(path.join(libraryDir, inA.id, "index.md"), "utf8");
    assert.ok(copy.startsWith(`# ${titleOf(GUIDELINE)}\n`));
    assert.match(copy, /<!-- page 2 -->\n第二章 药物选择/);

    // A project with no documents of its own reads it through the library;
    // a project holding it reads its own copy, listed once.
    const fromReader = await app.kbIndex.search({ userId: user.id, projectId: reader.id, query: "达比加群" });
    assert.equal(fromReader.mode, "small-library");
    assert.deepEqual(fromReader.files.map((file) => [file.sourceId, file.path, file.origin]), [[inA.id, `library/${inA.id}/index.md`, "library"]]);
    const fromA = await app.kbIndex.search({ userId: user.id, projectId: "papers-a", query: "达比加群" });
    assert.deepEqual(fromA.files.map((file) => [file.sourceId, file.origin]), [[inA.id, "project"]]);
    app.kbIndex.smallLibraryTokens = 1;
    const searched = await app.kbIndex.search({ userId: user.id, projectId: reader.id, query: "达比加群", limit: 3 });
    assert.equal(searched.hits[0].sourceId, inA.id);
    assert.equal(searched.hits[0].origin, "library");
    assert.equal(searched.hits[0].path, `library/${inA.id}/index.md`);
    assert.equal(searched.hits[0].page, 2);
    assert.ok(copy.includes(searched.hits[0].snippet), "the snippet is in the file the run reads");

    // The project it was added from goes: the entry follows the other copy.
    const deleted = await call("/api/projects/papers-a", { method: "DELETE", body: { confirm: "papers-a" } });
    assert.equal(deleted.status, 200);
    let [entry] = (await call("/api/library")).body.data.items;
    assert.deepEqual(entry.projects, ["papers-b"]);
    assert.deepEqual(entry.sourceIds, [inB.id]);
    // The deletion converges the library at once (2026-10-28: it also releases what only the project held and takes the project's
    // directory away), so the copy is already rewritten from the remaining project and the next pass has nothing left to write.
    assert.equal(entry.status, "ready", "its copy is rewritten from the remaining project");
    assert.ok((await readFile(path.join(libraryDir, inA.id, "index.md"), "utf8")).startsWith(`# ${titleOf(GUIDELINE)}\n`));
    const pass = await app.kbIndex.sync({ userId: user.id });
    assert.equal(pass.library.written, 0);
    [entry] = (await call("/api/library")).body.data.items;
    assert.equal(entry.status, "ready");
    assert.equal(entry.sourceId, inA.id, "the entry keeps its name and its directory");

    // An entry from before 2026-10-28, whose last document went without releasing it (a deletion now releases the entry with the
    // last document: see "deleting the last document..." below): the library keeps the document, readable and searchable.
    await app.store.database.query("UPDATE evimed_product.documents SET deleted_at=clock_timestamp() WHERE user_id=$1 AND kind='source' AND id=$2", [user.id, inB.id]);
    [entry] = (await call("/api/library")).body.data.items;
    assert.equal(entry.status, "detached");
    assert.ok(["ready", "processing", "detached"].every((status) => LIBRARY_ITEM_STATUSES.includes(status)), "the statuses seen here are the vocabulary's");
    assert.deepEqual(entry.projects, []);
    assert.equal(entry.title, titleOf(GUIDELINE));
    await app.kbIndex.sync({ userId: user.id });
    assert.equal(await indexDocuments(app, user.id, sha256), 1, "the library holds its index document");
    await app.kbIndex.rebuild({ userIds: [user.id] });
    assert.equal(await indexDocuments(app, user.id, sha256), 1, "a rebuild cannot re-derive it, so it keeps it");
    // Both application and operator rebuild retain and sanitize a detached legacy index
    // locally; the copy's metadata header is not a new captured-content input.
    await app.store.database.query("UPDATE evimed_kb.documents SET index_method=NULL,embedding_input_sha256=NULL,title='privatecanary' WHERE user_id=$1 AND sha256=$2", [user.id,sha256]);
    await app.store.database.query("UPDATE evimed_kb.chunks SET context_prefix='privatecanary',heading_path='privatecanary',lexemes=(lexemes || $3::tsvector) WHERE user_id=$1 AND sha256=$2", [user.id,sha256,tsvectorLiteral("privatecanary")]);
    const cli = await createRebuildIndex({ database:app.store.database,config:{ dataDir,libraryMaxItems:1000,kbEmbeddingDimension:1024 },embedder:{ configured:false,counters:{} } });
    cli.sources.loadCapture = async () => { throw new Error("detached repair must not parse a new capture"); };
    const cliResult = await cli.rebuild({ userIds:[user.id] });
    assert.equal(cliResult.repaired,1); assert.equal(cliResult.unproven,0); assert.equal(cliResult.failed,0);
    assert.equal((await app.store.database.query("SELECT index_method FROM evimed_kb.documents WHERE user_id=$1 AND sha256=$2",[user.id,sha256])).rows[0].index_method,KB_INDEX_METHOD);
    assert.equal(await indexDocuments(app,user.id,sha256),1);
    const detached = await app.kbIndex.search({ userId: user.id, projectId: reader.id, query: "达比加群", limit: 3 });
    assert.equal(detached.hits[0]?.sourceId, inA.id);
    await access(path.join(libraryDir, inA.id, "index.md"));
    // A document no project holds any more can still be read from the library's
    // own copy, and its understanding went with the last project that held it —
    // so there is nothing left for the automatic publication to carry.
    await assert.rejects(app.libraryService.publishSourceUnderstanding(user.id, inA.id),
      (error) => error?.code === "library_source_removed");

    // Taken out of the library: its copy and its index go.
    const removed = await call(`/api/library/${inA.id}`, { method: "DELETE" });
    assert.deepEqual(removed.body.data, { sourceId: inA.id, removed: true });
    await assert.rejects(access(path.join(libraryDir, inA.id)), { code: "ENOENT" });
    assert.deepEqual((await call("/api/library")).body.data.items, []);
    assert.equal((await call(`/api/library/${inA.id}`, { method: "DELETE" })).body.code, "library_item_not_found");
    await app.kbIndex.sync({ userId: user.id });
    assert.equal(await indexDocuments(app, user.id, sha256), 0);
  } finally { await context.close(); }
});

test("understanding a document writes its summary and key claims into the researcher's own capsule, labelled, stamped and once", { skip }, async () => {
  const context = await signedIn();
  try {
    const { app, user, base, headers } = context;
    const call = api(base, headers);
    const publish = () => app.libraryService.publishSourceUnderstanding(user.id, source.id);
    const [source] = await ingestCorpus(context, { names: [GUIDELINE] });
    // Nothing read yet: there is nothing to carry, and it says so by name
    // rather than writing an empty publication.
    await assert.rejects(publish(), (error) => error?.code === "library_understanding_missing");

    // A reference capsule already active for the account stays active beside the one made.
    const reference = await makePack(app.capsuleService, user.id, { title: "同事的胶囊" });
    await app.capsuleService.activate(user.id, reference.id);
    await giveUnderstanding(app, user, source, { statement: "利伐沙班推荐 20 mg 每日一次，随餐服用", quote: "推荐剂量为20 mg，每日一次，随餐服用" });
    // This is what the source worker calls when an understanding is published:
    // no route, no button, and the researcher is not asked.
    const result = await publish();
    // The summary and the one claim: the template field and the method draft
    // are the understanding's, shown with the document, not memories.
    assert.deepEqual({ facts: result.facts, methods: result.methods, added: result.added, kept: result.kept, retired: result.retired },
      { facts: 2, methods: 0, added: 2, kept: 0, retired: 0 });
    assert.equal(result.capsuleTitle, "我的记忆胶囊");
    const active = await app.capsuleService.active(user.id);
    assert.deepEqual(active.items.map((item) => [item.capsuleId, item.mode]).sort(),
      [[result.capsuleId, "own"], [reference.id, "guest"]].sort());

    const entries = (await app.capsuleService.entries(user.id, result.capsuleId)).items;
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.payload.layer, "sources", "never a layer a method mount or a share reads");
      assert.equal(entry.payload.status, "approved", "in effect at once, without a confirmation");
      assert.equal(entry.payload.origin, "inferred");
      assert.equal(entry.payload.factKind, "project_fact");
      // Stamped with its document and that document's project: recalled there only.
      assert.equal(entry.payload.sourceId, source.id);
      assert.equal(entry.payload.projectId, source.projectId);
    }
    const summary = entries.find((entry) => entry.payload.content.startsWith("资料《"));
    assert.equal(summary.payload.content, `资料《${titleOf(GUIDELINE)}》的摘要：房颤抗凝治疗指南。`);
    const claim = entries.find((entry) => entry.payload.content.includes("20 mg"));
    assert.equal(claim.payload.content, `据资料《${titleOf(GUIDELINE)}》：利伐沙班推荐 20 mg 每日一次，随餐服用`);
    assert.equal(claim.payload.provenance[0].type, "source", "what the row reads 「来自资料」 from");
    assert.ok(claim.payload.provenance[0].id.startsWith(`${source.id}#`));
    assert.equal(claim.payload.provenance[0].excerpt, "推荐剂量为20 mg，每日一次，随餐服用");
    assert.equal(entries.some((entry) => /方法草稿|规范非瓣膜性房颤患者的抗凝治疗/.test(entry.payload.content)), false);
    // And none of it is listed among the researcher's memories.
    assert.deepEqual((await app.capsuleService.mine(user.id)).entries, []);

    // Idempotent, so the worker may call it more than once for one generation.
    const repeated = await publish();
    assert.deepEqual({ added: repeated.added, kept: repeated.kept, retired: repeated.retired }, { added: 0, kept: 2, retired: 0 });
    assert.equal(repeated.capsuleId, result.capsuleId);

    // More publications at once than the pool has connections: each one runs or
    // is refused as busy, none waits holding a connection, and nothing is
    // published twice (security review 2026-09-20: this starved every tenant).
    const burst = await Promise.allSettled(Array.from({ length: 12 }, () => publish()));
    for (const outcome of burst) {
      assert.ok(outcome.status === "fulfilled" || outcome.reason?.code === "library_publish_busy",
        JSON.stringify(outcome.reason?.code ?? outcome.status));
    }
    assert.equal((await app.capsuleService.entries(user.id, result.capsuleId)).items.length, 2);
    assert.equal((await call("/api/library")).status, 200, "the account is served again at once");

    // The document read again says something else: that one fact is replaced,
    // the old one kept as retired.
    await giveUnderstanding(app, user, source, { statement: "达比加群酯剂量 150 mg，每日两次", quote: "剂量150 mg，每日两次" });
    const changed = await publish();
    assert.deepEqual({ added: changed.added, kept: changed.kept, retired: changed.retired }, { added: 1, kept: 1, retired: 1 });
    const retired = await app.sourceService.documents.get(user.id, "fact", claim.id);
    assert.equal(retired.payload.status, "retired");
  } finally { await context.close(); }
});

/** The documents a project's directory of the library holds, as a runtime would list /workspace/library.
 * @param {string} dataDir @param {string} userId @param {string} projectId */
const viewOf = async (dataDir, userId, projectId) => (await readdir(projectLibraryViewDir({ dataDir }, userId, projectId)).catch(() => /** @type {string[]} */ ([]))).sort();

/** Launch a project's runtime as far as the library is concerned: its directory is made and brought to what applies to it.
 * @param {any} app @param {string} userId @param {string[]} projects */
async function launch(app, userId, projects) {
  for (const project of projects) await app.libraryService.ensureProjectView(userId, project);
}

test("a document limited to project B is found in B and nowhere else: search, selection and the workspace directory; \"all\" covers a project made later", { skip }, async () => {
  const context = await signedIn({ kbSmallLibraryTokens: 150_000 });
  try {
    const { app, user, base, headers, dataDir } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    for (const [id, name] of [["papers-a", "资料 A"], ["papers-b", "资料 B"], ["papers-c", "资料 C"]]) await app.store.createProject(owner, id, name);
    const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
    await launch(app, user.id, ["papers-a", "papers-b", "papers-c"]);
    const asked = (/** @type {string} */ projectId) => app.kbIndex.search({ userId: user.id, projectId, query: "达比加群" });
    const selectable = async (/** @type {string} */ projectId) => (await fetch(`${base}/api/research-sessions/ses_${projectId.replace("-", "_")}/source-scope`, { method: "PUT",
      headers: { ...headers, "x-open-science-project": projectId }, body: JSON.stringify({ sourceIds: [inA.id] }) })).status;

    // With no entry a document applies to the project that holds it, and nowhere else.
    assert.equal((await asked("papers-b")).mode, "empty");
    assert.equal(await selectable("papers-b"), 404);

    const created = await call(`/api/library/${inA.id}`, { method: "PUT", body: { projects: ["papers-b"] } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.data.libraryProjects, ["papers-b"]);
    assert.deepEqual(created.body.data.appliesTo, ["papers-a", "papers-b"]);

    // Search: found in B through the library, in A through its own copy, and in C not at all.
    assert.deepEqual((await asked("papers-b")).files.map((file) => [file.sourceId, file.path, file.origin]), [[inA.id, `library/${inA.id}/index.md`, "library"]]);
    assert.deepEqual((await asked("papers-a")).files.map((file) => [file.sourceId, file.origin]), [[inA.id, "project"]]);
    const inC = await asked("papers-c");
    assert.equal(inC.mode, "empty");
    assert.equal(inC.library.documents, 0);
    app.kbIndex.smallLibraryTokens = 1;
    assert.equal((await asked("papers-b")).hits[0]?.sourceId, inA.id);
    assert.deepEqual((await asked("papers-c")).hits, []);
    app.kbIndex.smallLibraryTokens = 150_000;

    // The workspace: B's directory holds the copy, C's holds nothing.
    assert.deepEqual([await viewOf(dataDir, user.id, "papers-b"), await viewOf(dataDir, user.id, "papers-c")], [[inA.id], []]);
    assert.match(await readFile(path.join(projectLibraryViewDir({ dataDir }, user.id, "papers-b"), inA.id, "index.md"), "utf8"), /第二章 药物选择/);

    // A conversation of B may select it; one of C may not, and nor may one of a project the account made after.
    assert.equal(await selectable("papers-b"), 200);
    assert.equal(await selectable("papers-c"), 404);
    assert.equal(await app.sourceService.appliesTo(user.id, await app.sourceService.get(user.id, inA.id), "papers-c"), false);
    assert.equal(await app.sourceService.appliesTo(user.id, await app.sourceService.get(user.id, inA.id), "papers-b"), true);

    // Every project: a marker, so a project made afterwards has it too.
    const everywhere = await call(`/api/library/${inA.id}`, { method: "PUT", body: { projects: "all", expectedRevision: created.body.data.revision } });
    assert.equal(everywhere.status, 200);
    assert.equal(everywhere.body.data.appliesTo, "all");
    assert.deepEqual([await viewOf(dataDir, user.id, "papers-b"), await viewOf(dataDir, user.id, "papers-c")], [[inA.id], [inA.id]]);
    await app.store.createProject(owner, "papers-late", "后来的项目");
    assert.deepEqual((await asked("papers-late")).files.map((file) => file.sourceId), [inA.id]);
    assert.equal(await selectable("papers-late"), 200);
    await launch(app, user.id, ["papers-late"]);
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-late"), [inA.id]);

    // Narrowed again: gone from the other projects' directories when the call has answered, and from their search and selection.
    const narrowed = await call(`/api/library/${inA.id}`, { method: "PUT", body: { projects: ["papers-c"] } });
    assert.equal(narrowed.status, 200);
    assert.deepEqual([await viewOf(dataDir, user.id, "papers-b"), await viewOf(dataDir, user.id, "papers-c"), await viewOf(dataDir, user.id, "papers-late")], [[], [inA.id], []]);
    assert.equal((await asked("papers-b")).mode, "empty");
    assert.equal((await asked("papers-late")).mode, "empty");
    assert.equal(await selectable("papers-b"), 404);

    // Taking it out returns it to the project that holds it.
    assert.equal((await call(`/api/library/${inA.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-c"), []);
    assert.equal((await asked("papers-c")).mode, "empty");
    assert.deepEqual((await asked("papers-a")).files.map((file) => file.origin), ["project"]);
  } finally { await context.close(); }
});

test("a document may be applied only to the account's own ordinary projects, and a bad request names what is wrong", { skip }, async () => {
  const context = await signedIn();
  try {
    const { app, user, base, headers, dataDir } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    await app.store.createProject(owner, "papers-a", "资料 A");
    const stranger = await app.store.createUser(`kb${Math.random().toString(16).slice(2, 10)}`, "test-only-kb-password", "Stranger");
    try {
      await app.store.createProject(await app.store.userById(stranger.id), "theirs", "Theirs");
      const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
      const route = `/api/library/${inA.id}`;
      for (const [projects, code] of [
        [["theirs"], "library_project_invalid"], [["no-such-project"], "library_project_invalid"], [["evimed-library"], "library_project_invalid"],
        [["evimed-learning"], "library_project_invalid"], [["papers-a", "theirs"], "library_project_invalid"],
        ["none", "library_projects_invalid"], [[7], "library_projects_invalid"], [["a/b"], "library_projects_invalid"], [null, "library_projects_invalid"],
      ]) {
        const refused = await call(route, { method: "PUT", body: { projects } });
        assert.equal(refused.status, 400, JSON.stringify(projects));
        assert.equal(refused.body.code, code, JSON.stringify(projects));
      }
      assert.equal((await call(route, { method: "PUT", body: {} })).body.code, "library_projects_invalid");
      assert.equal((await call(route, { method: "PUT", body: { projects: "all", extra: 1 } })).body.code, "library_payload_invalid");
      assert.equal((await call("/api/library", { method: "POST", body: { sourceId: inA.id, projects: ["theirs"] } })).body.code, "library_project_invalid");
      assert.equal((await call(`/api/library/src_${"0".repeat(32)}`, { method: "PUT", body: { projects: "all" } })).status, 404);
      // Nothing of any of it was written.
      assert.deepEqual((await call("/api/library")).body.data.items, []);
      assert.deepEqual(await viewOf(dataDir, user.id, "theirs"), []);
      // An archived project is not a place either; an empty list and the account's own project are.
      await app.store.createProject(owner, "papers-old", "Old");
      assert.equal((await call("/api/projects/papers-old/archive", { method: "POST", body: { archived: true } })).status, 200);
      const archived = await call(route, { method: "PUT", body: { projects: ["papers-old"] } });
      assert.deepEqual([archived.status, archived.body.code], [400, "library_project_invalid"]);
      const placed = await call(route, { method: "PUT", body: { projects: [] } });
      assert.equal(placed.status, 201);
      assert.deepEqual(placed.body.data.appliesTo, ["papers-a"]);
    } finally { await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [stranger.id]); }
  } finally { await context.close(); }
});

test("a project's deletion takes its id out of every entry's list, so a project made again under that id inherits nothing", { skip }, async () => {
  const context = await signedIn({ kbSmallLibraryTokens: 150_000 });
  try {
    const { app, user, base, headers, dataDir } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    for (const id of ["papers-a", "papers-b", "papers-c"]) await app.store.createProject(owner, id, id);
    const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
    await launch(app, user.id, ["papers-b", "papers-c"]);
    await call(`/api/library/${inA.id}`, { method: "PUT", body: { projects: ["papers-b", "papers-c"] } });
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-b"), [inA.id]);

    assert.equal((await call("/api/projects/papers-b", { method: "DELETE", body: { confirm: "papers-b" } })).status, 200);
    const [entry] = (await call("/api/library")).body.data.items;
    assert.deepEqual(entry.libraryProjects, ["papers-c"], "the deleted project's id is out of the list");
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-b"), [], "and its directory is gone");
    await assert.rejects(access(projectLibraryViewDir({ dataDir }, user.id, "papers-b")), { code: "ENOENT" });
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-c"), [inA.id], "the other projects keep it");

    await app.store.createProject(owner, "papers-b", "again");
    await launch(app, user.id, ["papers-b"]);
    assert.equal((await app.kbIndex.search({ userId: user.id, projectId: "papers-b", query: "达比加群" })).mode, "empty", "made again, it has nothing");
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-b"), []);

    // The project that holds the only copy goes: the entry goes with the document, and so does every directory's copy of it.
    assert.equal((await call("/api/projects/papers-a", { method: "DELETE", body: { confirm: "papers-a" } })).status, 200);
    assert.deepEqual((await call("/api/library")).body.data.items, []);
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-c"), []);
    await assert.rejects(access(path.join(userLibraryDir({ dataDir }, user.id), inA.id)), { code: "ENOENT" });
  } finally { await context.close(); }
});

test("deleting the last document that holds a file releases its entry and its copies; a replacement carries the entry to the new bytes", { skip }, async () => {
  const context = await signedIn({ kbSmallLibraryTokens: 150_000 });
  try {
    const { app, user, base, headers, dataDir } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    for (const id of ["papers-a", "papers-b"]) await app.store.createProject(owner, id, id);
    const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
    await launch(app, user.id, ["papers-b"]);
    await call(`/api/library/${inA.id}`, { method: "PUT", body: { projects: ["papers-b"] } });

    // A new version of the file in project A: the entry follows it, with the same list.
    const replacement = Buffer.from(`%PDF-1.4\n${GUIDELINE}\nsecond edition\n`);
    const uploaded = await fetch(`${base}/api/files/upload`, { method: "POST", headers: { ...headers, "x-open-science-project": "papers-a" },
      body: JSON.stringify({ root: "base", path: `knowledge-base/${GUIDELINE}`, data: replacement.toString("base64"), encoding: "base64" }) });
    assert.equal(uploaded.status, 200);
    const next = (await uploaded.json()).data.source;
    assert.notEqual(next.id, inA.id);
    let carried = null;
    for (let attempt = 0; attempt < 60 && !carried; attempt += 1) {
      await app.sourceWorker.tick();
      const current = await app.sourceService.get(user.id, next.id);
      if (current.payload.status !== "complete" && current.payload.analysis?.readAt === undefined) {
        await app.sourceService.override(user.id, current.id, { expectedRevision: current.revision, docType: current.payload.docType, depth: "index_only", reason: "Library fixture." }).catch(() => {});
      }
      const [item] = (await call("/api/library")).body.data.items;
      if (item?.sourceId === next.id) carried = item;
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(carried, "the entry of the new bytes exists");
    assert.deepEqual(carried.libraryProjects, ["papers-b"], "it applies where the old version did");
    assert.equal((await call("/api/library")).body.data.items.length, 1, "and the old version's entry is released");

    // The last document that holds those bytes goes: the entry, its copy and B's copy go with it.
    await app.libraryService.ensureProjectView(user.id, "papers-b");
    const source = await app.sourceService.get(user.id, next.id);
    assert.equal((await call(`/api/sources/${next.id}`, { method: "DELETE", body: { expectedRevision: source.revision } })).status, 200);
    assert.deepEqual((await call("/api/library")).body.data.items, []);
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-b"), []);
    await assert.rejects(access(path.join(userLibraryDir({ dataDir }, user.id), next.id)), { code: "ENOENT" });
  } finally { await context.close(); }
});

test("the all list is every document once, with the projects that hold it and where it applies", { skip }, async () => {
  const context = await signedIn();
  try {
    const { app, user, base, headers } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    for (const [id, name] of [["papers-a", "资料 A"], ["papers-b", "资料 B"], ["papers-c", "资料 C"]]) await app.store.createProject(owner, id, name);
    const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
    const [inB] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-b" });
    assert.notEqual(inA.id, inB.id);
    await call(`/api/library/${inB.id}`, { method: "PUT", body: { projects: ["papers-c"] } });

    const listed = (await call("/api/sources?scope=all")).body.data;
    const rows = listed.items.filter((item) => item.payload.fingerprint.sha256 === inA.payload.fingerprint.sha256);
    assert.equal(rows.length, 1, "two projects hold the file; it is one document");
    assert.equal(listed.counts.all, 1);
    assert.deepEqual(rows[0].holders, [{ id: "papers-a", name: "资料 A" }, { id: "papers-b", name: "资料 B" }]);
    assert.deepEqual(rows[0].libraryProjects, ["papers-c"]);
    assert.deepEqual(rows[0].appliesTo, ["papers-a", "papers-b", "papers-c"]);
    assert.equal(rows[0].id, inB.id, "the entry's own source stands for the document");
    assert.equal(rows[0].display.shared, true);

    // Asked for a project: the documents that apply to it, marked when it only has them through the library.
    const inC = (await call("/api/sources?scope=all&projectId=papers-c")).body.data;
    assert.deepEqual(inC.items.map((item) => [item.id, item.viaLibrary]), [[inB.id, true]]);
    const inA2 = (await call("/api/sources?scope=all&projectId=papers-a")).body.data;
    assert.deepEqual(inA2.items.map((item) => item.viaLibrary), [false]);
    assert.equal((await call("/api/sources?scope=all&projectId=no-such")).status, 404);

    // The reader's single read says the same.
    const one = (await call(`/api/sources/${inB.id}`)).body.data;
    // `shared` (whether the library holds the bytes) is what a row's `display` says; it is not a field of its own.
    assert.deepEqual([one.libraryProjects, one.appliesTo, one.holders.map((holder) => holder.id), one.display.shared], [["papers-c"], ["papers-a", "papers-b", "papers-c"], ["papers-a", "papers-b"], true]);
    const plain = (await call(`/api/sources/${inA.id}`)).body.data;
    assert.deepEqual(plain.libraryProjects, ["papers-c"], "the same bytes are the same document, whichever project's copy is read");
  } finally { await context.close(); }
});

test("a project put away after it was chosen stays on the entry, and the dialog's question about a project's deletion is answered from the real ledger", { skip }, async () => {
  const context = await signedIn({ kbSmallLibraryTokens: 150_000 });
  try {
    const { app, user, base, headers } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    for (const id of ["papers-a", "papers-b", "papers-old", "papers-other"]) await app.store.createProject(owner, id, id);
    const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
    const [kept] = await ingestCorpus(context, { names: ["肾功能与抗凝.pdf"], projectId: "papers-a" });
    const route = `/api/library/${inA.id}`;
    assert.equal((await call(route, { method: "PUT", body: { projects: ["papers-old", "papers-b"] } })).status, 201);
    assert.equal((await call("/api/projects/papers-old/archive", { method: "POST", body: { archived: true } })).status, 200);

    // Saving the list back is not refused for the project that was put away since; a newly named archived one still is.
    const saved = await call(route, { method: "PUT", body: { projects: ["papers-old", "papers-b", "papers-other"] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data.libraryProjects, ["papers-old", "papers-b", "papers-other"]);
    await app.store.createProject(owner, "papers-older", "older");
    assert.equal((await call("/api/projects/papers-older/archive", { method: "POST", body: { archived: true } })).status, 200);
    const refused = await call(route, { method: "PUT", body: { projects: ["papers-old", "papers-older"] } });
    assert.deepEqual([refused.status, refused.body.code], [400, "library_project_invalid"]);
    assert.deepEqual((await call("/api/library")).body.data.items[0].libraryProjects, ["papers-old", "papers-b", "papers-other"], "the refused change changed nothing");

    // What deleting papers-a would take from the others: the document only it holds, which was sent to b and other (and the archived one).
    await call(`/api/library/${kept.id}`, { method: "PUT", body: { projects: ["papers-a"] } });
    const loss = await call("/api/library/project-loss?projectId=papers-a");
    assert.equal(loss.status, 200);
    assert.deepEqual(loss.body.data.items.map((item) => [item.sourceId, item.projects]), [[inA.id, ["papers-old", "papers-b", "papers-other"]]],
      "the document sent only to its own project costs no one anything");
    assert.deepEqual((await call("/api/library/project-loss?projectId=papers-b")).body.data.items, []);
    assert.equal((await call("/api/library/project-loss?projectId=nobody")).status, 404);
    assert.equal((await call("/api/library/project-loss")).status, 400);
  } finally { await context.close(); }
});

test("deleting a file from the knowledge base removes every project's copy of it, its library entry and every directory's copy — one request", { skip }, async () => {
  const context = await signedIn({ kbSmallLibraryTokens: 150_000 });
  try {
    const { app, user, base, headers, dataDir } = context;
    const call = api(base, headers);
    const owner = await app.store.userById(user.id);
    for (const id of ["papers-a", "papers-b", "papers-c"]) await app.store.createProject(owner, id, id);
    const [inA] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-a" });
    const [inB] = await ingestCorpus(context, { names: [GUIDELINE], projectId: "papers-b" });
    const [other] = await ingestCorpus(context, { names: ["肾功能与抗凝.pdf"], projectId: "papers-a" });
    assert.notEqual(inA.id, inB.id);
    await call(`/api/library/${inA.id}`, { method: "PUT", body: { projects: ["papers-c"] } });
    await launch(app, user.id, ["papers-a", "papers-b", "papers-c"]);
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-c"), [inA.id]);
    const listed = (await call("/api/sources?scope=all")).body.data;
    const row = listed.items.find((item) => item.payload.fingerprint.sha256 === inA.payload.fingerprint.sha256);
    assert.deepEqual(row.holders.map((holder) => holder.id).sort(), ["papers-a", "papers-b"]);

    const deleted = await call(`/api/sources/${row.id}`, { method: "DELETE", body: { expectedRevision: row.revision, everywhere: true } });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(deleted.body.data.copies.map((copy) => copy.id).sort(), [inA.id, inB.id].sort());
    for (const id of [inA.id, inB.id]) assert.equal(await app.sourceService.documents.get(user.id, "source", id), null, id);
    assert.ok(await app.sourceService.documents.get(user.id, "source", other.id), "another document is kept");
    assert.deepEqual((await call("/api/library")).body.data.items, [], "the entry went with the last copy");
    assert.deepEqual(await viewOf(dataDir, user.id, "papers-c"), [], "so did the copy in the project it had been sent to");
    await assert.rejects(access(path.join(userLibraryDir({ dataDir }, user.id), inA.id)), { code: "ENOENT" });
    const after = (await call("/api/sources?scope=all")).body.data;
    assert.deepEqual(after.items.map((item) => item.id), [other.id], "the list no longer shows the file from another project's copy");
    // A one-source delete is still a one-source delete.
    const [again] = await ingestCorpus(context, { names: ["出血处理共识.pdf"], projectId: "papers-a" });
    const [again2] = await ingestCorpus(context, { names: ["出血处理共识.pdf"], projectId: "papers-b" });
    const single = await call(`/api/sources/${again.id}`, { method: "DELETE", body: { expectedRevision: (await app.sourceService.get(user.id, again.id)).revision } });
    assert.equal(single.status, 200);
    assert.ok(await app.sourceService.documents.get(user.id, "source", again2.id), "the other project's copy stays");
  } finally { await context.close(); }
});
