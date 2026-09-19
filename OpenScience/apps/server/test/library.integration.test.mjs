import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LIBRARY_ITEM_STATUSES } from "@evimed/domain";
import { userLibraryDir } from "../src/libraryService.mjs";
import { databaseUrl, ingestCorpus, signedIn, titleOf } from "./helpers/knowledgeBaseApp.mjs";

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
    assert.equal(entry.status, "processing", "its copy is rewritten from the remaining project");
    const pass = await app.kbIndex.sync({ userId: user.id });
    assert.equal(pass.library.written, 1);
    [entry] = (await call("/api/library")).body.data.items;
    assert.equal(entry.status, "ready");
    assert.equal(entry.sourceId, inA.id, "the entry keeps its name and its directory");

    // The last project copy goes: the library keeps the document, readable and searchable.
    const source = await app.sourceService.get(user.id, inB.id);
    assert.equal((await call(`/api/sources/${inB.id}`, { method: "DELETE", body: { expectedRevision: source.revision } })).status, 200);
    [entry] = (await call("/api/library")).body.data.items;
    assert.equal(entry.status, "detached");
    assert.ok(["ready", "processing", "detached"].every((status) => LIBRARY_ITEM_STATUSES.includes(status)), "the statuses seen here are the vocabulary's");
    assert.deepEqual(entry.projects, []);
    assert.equal(entry.title, titleOf(GUIDELINE));
    await app.kbIndex.sync({ userId: user.id });
    assert.equal(await indexDocuments(app, user.id, sha256), 1, "the library holds its index document");
    await app.kbIndex.rebuild({ userIds: [user.id] });
    assert.equal(await indexDocuments(app, user.id, sha256), 1, "a rebuild cannot re-derive it, so it keeps it");
    const detached = await app.kbIndex.search({ userId: user.id, projectId: reader.id, query: "达比加群", limit: 3 });
    assert.equal(detached.hits[0]?.sourceId, inA.id);
    await access(path.join(libraryDir, inA.id, "index.md"));
    const publish = await call(`/api/library/${inA.id}/publish-to-capsule`, { method: "POST" });
    assert.equal(publish.status, 409);
    assert.equal(publish.body.code, "library_source_removed");

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

test("publishing writes the document's facts and method drafts into the researcher's own capsule, labelled and once", { skip }, async () => {
  const context = await signedIn();
  try {
    const { app, user, base, headers } = context;
    const call = api(base, headers);
    const [source] = await ingestCorpus(context, { names: [GUIDELINE] });
    assert.equal((await call("/api/library", { method: "POST", body: { sourceId: source.id } })).status, 201);
    const early = await call(`/api/library/${source.id}/publish-to-capsule`, { method: "POST" });
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "library_understanding_missing");

    // A reference capsule already active for the account stays active beside the one made.
    const reference = await app.capsuleService.create(user.id, { title: "同事的胶囊" });
    await app.capsuleService.activate(user.id, reference.id, { mode: "guest" });
    await giveUnderstanding(app, user, source, { statement: "利伐沙班推荐 20 mg 每日一次，随餐服用", quote: "推荐剂量为20 mg，每日一次，随餐服用" });
    const published = await call(`/api/library/${source.id}/publish-to-capsule`, { method: "POST" });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const result = published.body.data;
    assert.deepEqual({ facts: result.facts, methods: result.methods, added: result.added, kept: result.kept, retired: result.retired },
      { facts: 2, methods: 1, added: 3, kept: 0, retired: 0 });
    assert.equal(result.capsuleTitle, "我的记忆胶囊");
    const active = await app.capsuleService.active(user.id, null);
    assert.deepEqual(active.items.map((item) => [item.capsuleId, item.mode]).sort(),
      [[result.capsuleId, "own"], [reference.id, "guest"]].sort());

    const entries = (await app.capsuleService.entries(user.id, result.capsuleId)).items;
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.equal(entry.payload.layer, "sources", "never a layer a method mount or a share reads");
      assert.equal(entry.payload.status, "approved", "in effect at once, without a confirmation");
      assert.equal(entry.payload.origin, "inferred");
      assert.equal(entry.payload.provenance[0].type, "source");
      assert.ok(entry.payload.provenance[0].id.startsWith(`${source.id}#`));
    }
    const claim = entries.find((entry) => entry.payload.content.includes("20 mg"));
    assert.equal(claim.payload.factKind, "project_fact");
    assert.equal(claim.payload.content, `据资料《${titleOf(GUIDELINE)}》：利伐沙班推荐 20 mg 每日一次，随餐服用`);
    assert.equal(claim.payload.provenance[0].excerpt, "推荐剂量为20 mg，每日一次，随餐服用");
    const method = entries.find((entry) => entry.payload.factKind === "analysis");
    assert.match(method.payload.content, /^方法草稿（整理自资料《/);

    const repeated = (await call(`/api/library/${source.id}/publish-to-capsule`, { method: "POST" })).body.data;
    assert.deepEqual({ added: repeated.added, kept: repeated.kept, retired: repeated.retired }, { added: 0, kept: 3, retired: 0 });
    assert.equal(repeated.capsuleId, result.capsuleId);

    // More publishes at once than the pool has connections: each one runs or
    // is refused as busy, none waits holding a connection, and nothing is
    // published twice (security review 2026-09-20: this starved every tenant).
    const burst = await Promise.all(Array.from({ length: 12 }, () => call(`/api/library/${source.id}/publish-to-capsule`, { method: "POST" })));
    for (const response of burst) {
      assert.ok(response.status === 200 || (response.status === 409 && response.body.code === "library_publish_busy"), JSON.stringify(response));
    }
    assert.equal((await app.capsuleService.entries(user.id, result.capsuleId)).items.length, 3);
    assert.equal((await call("/api/library")).status, 200, "the account is served again at once");

    // The document read again says something else: that one fact is replaced,
    // the old one kept as retired.
    await giveUnderstanding(app, user, source, { statement: "达比加群酯剂量 150 mg，每日两次", quote: "剂量150 mg，每日两次" });
    const changed = (await call(`/api/library/${source.id}/publish-to-capsule`, { method: "POST" })).body.data;
    assert.deepEqual({ added: changed.added, kept: changed.kept, retired: changed.retired }, { added: 1, kept: 2, retired: 1 });
    const retired = await app.sourceService.documents.get(user.id, "fact", claim.id);
    assert.equal(retired.payload.status, "retired");
    const [item] = (await call("/api/library")).body.data.items;
    assert.deepEqual({ capsuleId: item.published.capsuleId, facts: item.published.facts, methods: item.published.methods },
      { capsuleId: result.capsuleId, facts: 2, methods: 1 });
  } finally { await context.close(); }
});
