import assert from "node:assert/strict";
import test from "node:test";
import { knowledgePageSlugOfPath, parseKnowledgePage } from "@evimed/domain";
import { databaseUrl, ingestCorpus, signedIn, titleOf } from "./helpers/knowledgeBaseApp.mjs";

const skip = !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured";
const GUIDELINE = "房颤抗凝指南.pdf";
const KIDNEY = "肾功能与抗凝.pdf";
const DIABETES = "糖尿病用药要点.pdf";
const BLEEDING = "出血处理共识.pdf";

/** @param {string} base @param {Record<string, string>} headers */
function api(base, headers) {
  return async (/** @type {string} */ route, /** @type {{ method?: string, body?: unknown }} */ { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

/** The runtime stand-in: it answers the round with a patch built from the documents the round was given. */
function compileRuntime() {
  const state = { requests: [], patch: /** @type {any} */ (null), failures: 0 };
  return { state, runtime: {
    async dispatch(/** @type {any} */ request) { state.requests.push(request); return { runId: "run-1", sessionId: "session-1", dispatchId: request.dispatchId }; },
    async readResult() { return { status: "succeeded", patch: typeof state.patch === "function" ? state.patch(state.requests.at(-1)) : state.patch, usage: { actualCost: 0.07 } }; },
  } };
}

/** @param {any} app @param {any} user @param {string} id */
async function textOf(app, user, id) {
  const source = await app.sourceService.get(user.id, id);
  return (await app.sourceService.loadCapture(user.id, source)).input.text;
}

/** Drive every queued ingestion of a page to a readable document. */
async function settlePages(app, user, projectId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await app.sourceWorker.tick();
    const pending = await app.store.database.query(`SELECT count(*)::int AS n FROM evimed_product.documents WHERE user_id=$1 AND project_id=$2 AND kind='source'
      AND deleted_at IS NULL AND payload->>'status' IN ('queued','parsing')`, [user.id, projectId]);
    if (pending.rows[0].n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("the pages were not read");
}

test("the compile writes the sentences that stand as documents of the knowledge base, holds the others, and a researcher's edit is the stronger basis", { skip }, async (t) => {
  const { state, runtime } = compileRuntime();
  const app = await signedIn({ knowledgePagesEnabled: true, knowledgePagesMinSources: 3, knowledgePagesDebounceMs: 0, knowledgePagesPollMs: 3_600_000,
    knowledgeCompileRuntime: runtime });
  t.after(() => app.close());
  await app.app.knowledgePagesWorker.close();
  const call = api(app.base, app.headers);
  const projectId = app.project.id;

  const sources = await ingestCorpus(app, { names: [GUIDELINE, KIDNEY, DIABETES, BLEEDING] });
  const [guideline, kidney, , bleeding] = sources;
  // Every readable document reached the queue through the worker's own hook.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await call(`/api/knowledge-pages?projectId=${projectId}`)).body.data.pending >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const before = (await call(`/api/knowledge-pages?projectId=${projectId}`)).body.data;
  assert.deepEqual([before.enabled, before.pages, before.readable, before.pending], [true, 0, 4, 4]);
  assert.equal((await call("/api/me")).body.data.features.knowledgePages, true);

  // The patch quotes the documents as they were read; one quotation is invented.
  const guidelineText = await textOf(app.app, app.user, guideline.id);
  const kidneyText = await textOf(app.app, app.user, kidney.id);
  const first = guidelineText.slice(0, 24);
  const second = kidneyText.slice(0, 24);
  state.patch = { schemaVersion: 1, pages: [{ op: "create", slug: "anticoagulation", type: "topic", title: "抗凝治疗",
    sections: [{ heading: "房颤与肾病", claims: [
      { text: "指南把口服抗凝作为非瓣膜性房颤卒中预防的基础。", kind: "direct", evidence: [{ sourceId: guideline.id, quote: first }] },
      { text: "这句话的引文并不存在于任何一份资料。", kind: "direct", evidence: [{ sourceId: guideline.id, quote: "这是一句没有出现在资料里的虚构引文内容" }] },
      { text: "两份资料都谈到抗凝药的使用前提。", kind: "synthesized", confidence: "moderate", evidence: [{ sourceId: guideline.id, quote: first }, { sourceId: kidney.id, quote: second }] },
    ] }], related: [] }] };

  const job = await call(`/api/knowledge-pages/compile`, { method: "POST", body: { projectId } });
  assert.equal(job.status, 202);
  await app.app.knowledgePagesWorker.tick();
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].input.sources.length, 4, "the round was given the project's four documents");
  assert.ok(state.requests[0].files.some((file) => file.rel === `sources/${guideline.id}.txt`));
  await settlePages(app.app, app.user, projectId);

  // The pages are documents of the knowledge base under their own chip.
  const listed = (await call(`/api/sources?projectId=${projectId}&kind=wiki`)).body.data;
  assert.equal(listed.items.length, 2, "the page and the index the platform renders");
  assert.equal(listed.counts.wiki, 2);
  const page = listed.items.find((item) => knowledgePageSlugOfPath(item.payload.paths[0]) === "anticoagulation");
  assert.equal(page.display.kind, "wiki");
  assert.equal(page.display.origin, "wiki");
  assert.equal(page.payload.depth, "index_only", "a page is read for search and never understood");
  assert.equal(page.display.title, "抗凝治疗");

  const view = (await call(`/api/knowledge-pages/page?sourceId=${page.id}`)).body.data;
  assert.deepEqual(view.counts, { claims: 2, verified: 2, unverified: 0, unsupported: 0 });
  assert.equal(view.heldCount, 1);
  assert.equal(view.held[0].reasons[0], "quote_not_found");
  assert.equal(view.sections[0].items[1].claimKind, "synthesized");
  assert.equal(view.sections[0].items[1].evidence[1].title, titleOf(KIDNEY));
  const file = (await call(`/api/sources/${page.id}/note`)).body.data.body;
  assert.ok(file.includes("指南把口服抗凝") && !file.includes("虚构引文"), "what a search reads holds only the sentences that stand");

  const summary = (await call(`/api/knowledge-pages?projectId=${projectId}`)).body.data;
  assert.deepEqual([summary.pages, summary.pending, summary.held, summary.round], [1, 0, 1, 2]);
  assert.equal(summary.lastRound.kept, 2);

  // The index can be searched with the rest: the page text is in the knowledge-base index.
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await app.app.kbIndex.sync({ userId: app.user.id, limit: 20 });
    if (!result.indexed && !result.embedded) break;
  }
  const ready = await app.app.sourceService.get(app.user.id, page.id);
  const indexed = await app.app.store.database.query("SELECT count(*)::int AS n FROM evimed_kb.documents WHERE user_id=$1 AND sha256=$2 AND text_sha256=$3",
    [app.user.id, ready.payload.fingerprint.sha256, ready.payload.analysis.textSha256]);
  assert.equal(indexed.rows[0].n, 1, "the page is searched with the rest of the knowledge base");
  const found = await app.app.kbIndex.search({ userId: app.user.id, projectId, query: "指南把口服抗凝作为非瓣膜性房颤卒中预防的基础", limit: 8 });
  assert.ok(found.hits.some((hit) => hit.compiled === true && hit.sourceId === page.id), "a search finds the page and says it is one");
  assert.match(found.note, /compiled from the documents[^]*cite that document, never the page/, "and the answer says what a page is for");

  // The researcher's edit: their line is added, and from here a recompile only adds to the page.
  const saved = await call(`/api/sources/${page.id}/note`, { method: "PUT", body: { title: "抗凝治疗", body: `${file}\n\n## 我的补充\n\n我自己的一句话，没有引文。\n` } });
  assert.equal(saved.status, 200);
  await settlePages(app.app, app.user, projectId);
  const editedRecord = (await app.app.store.database.query(`SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='wiki-page'`, [app.user.id])).rows[0].payload;
  assert.equal(editedRecord.basis, "user");
  const newPage = (await call(`/api/sources?projectId=${projectId}&kind=wiki`)).body.data.items.find((item) => knowledgePageSlugOfPath(item.payload.paths[0]) === "anticoagulation");
  assert.notEqual(newPage.id, page.id, "a save is the next version of the one document");
  const editedView = (await call(`/api/knowledge-pages/page?sourceId=${newPage.id}`)).body.data;
  assert.deepEqual(editedView.counts, { claims: 3, verified: 2, unverified: 0, unsupported: 1 });
  assert.equal(editedView.basis, "user");

  // A page stays in its project: sharing it would put sentences where the documents they quote are not.
  const shared = await call("/api/library", { method: "POST", body: { sourceId: newPage.id } });
  assert.equal(shared.status, 409);
  assert.equal(shared.body.code, "library_source_invalid");

  // A document the page quotes goes: the page is labelled and the project queued; nothing is hidden.
  const removal = await call(`/api/sources/${kidney.id}`, { method: "DELETE", body: { expectedRevision: (await app.app.sourceService.get(app.user.id, kidney.id)).revision } });
  assert.equal(removal.status, 200);
  const after = (await call(`/api/knowledge-pages?projectId=${projectId}`)).body.data;
  assert.equal(after.stale, 1);
  assert.equal(after.pending, 1);
  const stale = (await call(`/api/knowledge-pages/page?sourceId=${newPage.id}`)).body.data;
  assert.equal(stale.stale[0].reason, "removed");
  assert.deepEqual(stale.counts, { claims: 3, verified: 1, unverified: 1, unsupported: 1 }, "the sentence resting on the removed document is shown as unconfirmed, not hidden");

  // The next round: a researcher's page is not rewritten; the compiler's new statement is added under its own heading.
  state.patch = { schemaVersion: 1, pages: [{ op: "update", slug: "anticoagulation", type: "topic", title: "抗凝治疗",
    sections: [{ heading: "出血", claims: [{ text: "出血处理共识要求大出血时立即停用抗凝药物。", kind: "direct", evidence: [{ sourceId: bleeding.id, quote: (await textOf(app.app, app.user, bleeding.id)).slice(0, 24) }] }] }] }] };
  await call(`/api/knowledge-pages/compile`, { method: "POST", body: { projectId } });
  await app.app.knowledgePagesWorker.tick();
  await settlePages(app.app, app.user, projectId);
  const merged = (await call(`/api/sources?projectId=${projectId}&kind=wiki`)).body.data.items.find((item) => knowledgePageSlugOfPath(item.payload.paths[0]) === "anticoagulation");
  const mergedText = (await call(`/api/sources/${merged.id}/note`)).body.data.body;
  assert.ok(mergedText.includes("我自己的一句话，没有引文。") && mergedText.includes("来源更新后新增") && mergedText.includes("大出血时立即停用抗凝药物"));
  assert.equal(parseKnowledgePage(mergedText).units.filter((unit) => unit.kind === "claim").length, 4);
});

test("with the switch off nothing is queued or written, and the pages that exist stay readable", { skip }, async (t) => {
  const app = await signedIn({ knowledgePagesEnabled: false });
  t.after(() => app.close());
  const call = api(app.base, app.headers);
  assert.equal(app.app.knowledgePagesWorker, null);
  await ingestCorpus(app, { names: [GUIDELINE, KIDNEY] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const summary = (await call(`/api/knowledge-pages?projectId=${app.project.id}`)).body.data;
  assert.deepEqual([summary.enabled, summary.pages, summary.pending], [false, 0, 0]);
  assert.equal((await call("/api/me")).body.data.features.knowledgePages, false);
  assert.equal((await call("/api/knowledge-pages/compile", { method: "POST", body: { projectId: app.project.id } })).body.code, "knowledge_pages_disabled");
  const jobs = await app.app.store.database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='wiki-compile'", [app.user.id]);
  assert.equal(jobs.rows[0].n, 0);
});

test("a document that is not a page cannot be opened as one, and a project's pages are not another account's", { skip }, async (t) => {
  const app = await signedIn({ knowledgePagesEnabled: true, knowledgePageDebounceMs: 0 });
  t.after(() => app.close());
  await app.app.knowledgePagesWorker.close();
  const call = api(app.base, app.headers);
  const [guideline] = await ingestCorpus(app, { names: [GUIDELINE] });
  const refused = await call(`/api/knowledge-pages/page?sourceId=${guideline.id}`);
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, "knowledge_page_not_found");
  assert.equal((await call(`/api/knowledge-pages?projectId=no-such-project`)).status, 404);
});
