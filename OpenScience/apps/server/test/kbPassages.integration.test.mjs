// The knowledge-base page's box also searches the documents' own text (N-16, design reference §13.1): the same chunks
// `kb_search` reads, asked which documents contain every word typed and where — with the document's page and the line around
// the match — and listed under their documents. Against PostgreSQL, through the real routes.
import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrl, fixture, ingestCorpus, signedIn, titleOf } from "./helpers/knowledgeBaseApp.mjs";

const skip = !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured";
const GUIDELINE = "房颤抗凝指南.pdf";
const DIABETES = "糖尿病用药要点.pdf";
const BLEEDING = "出血处理共识.pdf";

/**
 * What the knowledge base holds of a document is its text, and what the list searches by name is a title and a summary the
 * reading wrote: the fixture's parser makes the whole text the summary, which would let the list's own search find every
 * word. A summary that is one short line is what a real one is.
 * @param {any} context @param {any[]} sources
 */
async function shortSummaries({ app, user }, sources) {
  for (const source of sources) {
    const current = await app.sourceService.get(user.id, source.id);
    await app.sourceService.documents.put(user.id, "source", current.id, { ...current.payload, outputs: { ...current.payload.outputs, summary: "一份资料。" } },
      { expectedRevision: current.revision, projectId: current.projectId });
  }
}

/** @param {{ base: string, headers: Record<string, string> }} context @param {string} query */
async function list({ base, headers }, query) {
  const response = await fetch(`${base}/api/sources?${new URLSearchParams(query)}`, { headers });
  assert.equal(response.status, 200, query);
  return (await response.json()).data;
}

test("the box finds a document by what its text says, with the page and the line around the match", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, user, project } = context;
    const sources = await ingestCorpus(context);
    await shortSummaries(context, sources);
    const guideline = sources.find((source) => source.payload.paths[0].endsWith(GUIDELINE));
    const found = await app.kbIndex.passages({ userId: user.id, projectId: project.id, shared: false, q: "达比加群" });
    assert.deepEqual(found.shas, [guideline.payload.fingerprint.sha256]);
    const [passage] = found.bySha[guideline.payload.fingerprint.sha256];
    assert.equal(passage.page, 2);
    assert.match(passage.snippet, /达比加群酯为另一选择/);
    // The line is the captured text at start–end, whitespace folded, with an ellipsis where it was cut.
    const capture = await app.sourceService.loadCapture(user.id, guideline);
    assert.equal(passage.snippet.replaceAll("…", ""), capture.input.text.slice(passage.start, passage.end).replace(/\s+/g, " ").trim());
    assert.ok(passage.snippet.length < 200, "one line, not a chunk");

    // Through the list: the document comes back for a word only its text holds, and says where.
    const page = await list(context, { projectId: project.id, q: "达比加群" });
    assert.deepEqual(page.items.map((item) => item.display.title), [titleOf(GUIDELINE)], "found by its text alone: no title or summary holds the word");
    assert.equal(page.counts.all, 1, "the chips count the documents the box matched, however it matched them");
    assert.deepEqual(page.passages[page.items[0].id].map((entry) => [entry.page, /达比加群酯/.test(entry.snippet)]), [[2, true]]);
    // Without a box, the list is the list: no passages, nothing asked of the index.
    const plain = await list(context, { projectId: project.id });
    assert.equal(plain.items.length, fixture.documents.length);
    assert.equal("passages" in plain, false);
  } finally { await context.close(); }
});

test("every word typed has to be in the text, a Latin word may be a prefix, and a box with nothing to look up is the list's own search", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, user, project } = context;
    const sources = await ingestCorpus(context);
    const ask = (q) => app.kbIndex.passages({ userId: user.id, projectId: project.id, shared: false, q });
    const nameOf = (sha) => fixture.documents.find((entry) => sources.find((source) => source.payload.fingerprint.sha256 === sha).payload.paths[0].endsWith(entry.name)).title;
    const titles = async (q) => ((await ask(q))?.shas ?? []).map(nameOf);
    // A prefix of a Latin word, as typed.
    assert.deepEqual(await titles("empagli"), [titleOf(DIABETES)]);
    assert.deepEqual(await titles("EMPAGLIFLOZIN"), [titleOf(DIABETES)], "case is not part of what was typed");
    // Both words: the guideline has 利伐沙班 and 达比加群; the kidney note has 利伐沙班 and no 达比加群.
    assert.deepEqual((await titles("利伐沙班 达比加群")), [titleOf(GUIDELINE)]);
    assert.equal((await titles("利伐沙班")).length, 2);
    // A word the terms hold and the text does not (the pair of characters, not the phrase) is not a match.
    assert.equal(await ask("沙班达比"), null, "the characters are indexed in pairs; the phrase must be in the text");
    // Nothing to look up: a single Chinese character, a single letter, only punctuation.
    for (const q of ["药", "a", "  ", "—"]) assert.equal(await ask(q), null, JSON.stringify(q));
    // And a word that is nowhere.
    assert.equal(await ask("不存在的词语"), null);
    // Two passages of one document are shown in the order a reader meets them.
    const both = await ask("抗凝");
    const guideline = sources.find((source) => source.payload.paths[0].endsWith(GUIDELINE));
    const pages = both.bySha[guideline.payload.fingerprint.sha256].map((entry) => entry.page);
    assert.deepEqual(pages, [...pages].sort((left, right) => (left ?? 0) - (right ?? 0)));
  } finally { await context.close(); }
});

test("the list's counts, pages and chips take a document found only by its text like any other", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { project } = context;
    await shortSummaries(context, await ingestCorpus(context));
    // 利伐沙班 is in two documents' text and in no title or summary.
    const first = await list(context, { projectId: project.id, q: "利伐沙班", limit: "1" });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor, "a second page");
    assert.equal(first.counts.all, 2);
    const second = await list(context, { projectId: project.id, q: "利伐沙班", limit: "1", cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.notEqual(second.items[0].id, first.items[0].id);
    // A chip narrows what the box matched.
    const kind = first.items[0].display.kind;
    const narrowed = await list(context, { projectId: project.id, q: "利伐沙班", kind });
    assert.ok(narrowed.items.every((item) => item.display.kind === kind));
    // The passages are for the rows of the page that carries them, and for no others.
    assert.deepEqual(Object.keys(first.passages), [first.items[0].id]);
  } finally { await context.close(); }
});

test("a search reads only this account's documents, and only the project the page lists", { skip }, async () => {
  const mine = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  const theirs = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const owner = await mine.app.store.userById(mine.user.id);
    await mine.app.store.createProject(owner, "papers-b", "资料 B");
    await shortSummaries(mine, await ingestCorpus(mine, { names: [GUIDELINE] }));
    await shortSummaries(mine, await ingestCorpus(mine, { names: [BLEEDING], projectId: "papers-b" }));
    // The other account holds the same bytes of the same file, and one more document of its own.
    await shortSummaries(theirs, await ingestCorpus(theirs, { names: [GUIDELINE, DIABETES] }));
    const here = (q, projectId = mine.project.id) => mine.app.kbIndex.passages({ userId: mine.user.id, projectId, shared: false, q });
    // Mine, in this project.
    assert.equal((await here("达比加群")).shas.length, 1);
    // Another project of mine is another list: its document is not in this project's search, and this project's is not in its.
    assert.equal(await here("大出血"), null, "that document is in the other project");
    assert.equal((await here("大出血", "papers-b")).shas.length, 1);
    assert.equal(await here("达比加群", "papers-b"), null);
    // The other account's document is nowhere in mine, by the engine or through the routes; the same bytes of mine are mine.
    assert.equal(await here("empagliflozin"), null);
    assert.equal((await list(mine, { projectId: mine.project.id, q: "empagliflozin" })).items.length, 0);
    assert.equal((await list(theirs, { projectId: theirs.project.id, q: "empagliflozin" })).items.length, 1);
    // A project that is not the caller's is refused before anything is searched.
    const refused = await fetch(`${mine.base}/api/sources?${new URLSearchParams({ projectId: "someone-elses-project", q: "达比加群" })}`, { headers: mine.headers });
    assert.equal(refused.status, 404);
    // The index is derived from rows keyed by account: counting both accounts' chunks shows the search did not need to
    // look past its own.
    const chunks = await mine.app.store.database.query("SELECT count(DISTINCT user_id)::integer AS n FROM evimed_kb.chunks WHERE user_id=ANY($1)", [[mine.user.id, theirs.user.id]]);
    assert.equal(chunks.rows[0].n, 2);
  } finally { await mine.close(); await theirs.close(); }
});

test("the shared documents are searched the same way, through the library's own copy", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { base, headers, app, user } = context;
    const [guideline] = await ingestCorpus(context, { names: [GUIDELINE] });
    const [diabetes] = await ingestCorpus(context, { names: [DIABETES] });
    await shortSummaries(context, [guideline, diabetes]);
    const added = await fetch(`${base}/api/library`, { method: "POST", headers, body: JSON.stringify({ sourceId: guideline.id }) });
    assert.equal(added.status, 201);
    const page = await list(context, { scope: "shared", q: "达比加群" });
    assert.deepEqual(page.items.map((item) => item.id), [guideline.id]);
    assert.equal(page.passages[guideline.id][0].page, 2);
    // A document that is in the project and not the library is not in the shared scope's search.
    assert.equal((await list(context, { scope: "shared", q: "empagliflozin" })).items.length, 0);
    assert.equal(await app.kbIndex.passages({ userId: user.id, projectId: null, shared: true, q: "empagliflozin" }), null);
  } finally { await context.close(); }
});

test("a search that cannot reach the index is the list's own search, not an error", { skip }, async () => {
  const context = await signedIn({ kbEmbedder: { configured: false, counters: {} } });
  try {
    const { app, project } = context;
    await shortSummaries(context, await ingestCorpus(context));
    app.kbIndex.passages = async () => { throw Object.assign(new Error("down"), { code: "kb_index_down" }); };
    const page = await list(context, { projectId: project.id, q: "达比加群" });
    assert.equal("passages" in page, false);
    assert.equal(page.items.length, 0, "only the text holds that word, and the text is what could not be reached");
    // The documents are still found by their name.
    const byName = await list(context, { projectId: project.id, q: "房颤抗凝指南" });
    assert.equal(byName.items.length, 1);
  } finally { await context.close(); }
});
