import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { knowledgeSourceMarker, parseKnowledgePage, renderKnowledgePage } from "@evimed/domain";
import { KnowledgePageService, buildKnowledgeCompileInput, excerptSourceText } from "../src/knowledgePageService.mjs";
import { KnowledgePageWorker } from "../src/knowledgePageWorker.mjs";

const id = (letter) => `src_${letter.repeat(32)}`;
const A = id("a");
const B = id("b");
const C = id("c");
const TEXT = {
  [A]: "In the primary efficacy analysis, rivaroxaban was non-inferior to warfarin for stroke prevention. Major bleeding occurred in 3.6% of patients.",
  [B]: "Apixaban reduced major bleeding compared with warfarin (hazard ratio 0.69). Stroke or systemic embolism was lower with apixaban.",
  [C]: "Dabigatran 150 mg twice daily was superior to warfarin for stroke and systemic embolism in the RE-LY trial.",
};
const QUOTE_A = "rivaroxaban was non-inferior to warfarin for stroke prevention";
const QUOTE_B = "Apixaban reduced major bleeding compared with warfarin";
const QUOTE_C = "Dabigatran 150 mg twice daily was superior to warfarin";

const containment = (value, filter) => {
  if (Array.isArray(filter)) return Array.isArray(value) && filter.every((item) => value.some((have) => containment(have, item)));
  if (filter && typeof filter === "object") return value && typeof value === "object" && Object.entries(filter).every(([key, part]) => containment(value[key], part));
  return value === filter;
};

function fixture(overrides = {}) {
  const config = { knowledgePagesEnabled: true, knowledgePagesMinSources: 3, knowledgePagesDebounceMs: 600_000, knowledgePagesMaxSourcesPerRound: 8,
    knowledgePagesSourceChars: 40_000, knowledgePagesInputChars: 240_000, knowledgePagesPagesBytes: 300_000, ...overrides.config };
  let clock = Date.parse("2026-10-12T08:00:00Z");
  const now = () => new Date(clock);
  const rows = new Map();
  const documents = {
    async get(userId, kind, rowId) { return rows.get(`${kind}:${rowId}`) ?? null; },
    async put(userId, kind, rowId, payload, { expectedRevision, projectId }) {
      const key = `${kind}:${rowId}`;
      const current = rows.get(key);
      if ((current?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
      const row = { id: rowId, kind, projectId, payload: structuredClone(payload), revision: expectedRevision + 1 };
      rows.set(key, row);
      return row;
    },
    async list(userId, kind, { projectId, filter = {} }) {
      const items = [...rows.values()].filter((row) => row.kind === kind && row.projectId === projectId && containment(row.payload, filter));
      return { items: structuredClone(items), nextCursor: null };
    },
  };
  const enqueued = [];
  const jobs = {
    async enqueue(userId, kind, payload, options) { enqueued.push({ userId, kind, payload, options }); return { id: `job-${enqueued.length}`, payload }; },
    async bringForward(userId, key) { enqueued.push({ broughtForward: key }); return true; },
  };
  const sourceRows = new Map();
  const addSource = (sourceId, { path = `knowledge-base/${sourceId}.md`, title = `Doc ${sourceId.slice(4, 6)}`, text = TEXT[sourceId] ?? "x" } = {}) => {
    sourceRows.set(sourceId, { id: sourceId, kind: "source", projectId: "p1", deletedAt: null, revision: 1,
      payload: { paths: [path], connector: { type: "upload" }, generation: 1, docType: "published-paper", title,
        analysis: { generation: 1, textSha256: createHash("sha256").update(text).digest("hex") }, fingerprint: { size: text.length } }, text });
    return sourceRows.get(sourceId);
  };
  const sources = {
    documents: { async list() { return { items: [] }; } },
    async get(userId, sourceId) { const row = sourceRows.get(sourceId); if (!row) throw Object.assign(new Error("gone"), { status: 404, code: "source_not_found" }); return row; },
    async list() { return { items: [...sourceRows.values()].filter((row) => !row.deletedAt), nextCursor: null }; },
    async loadCapture(userId, source) { return { input: { text: sourceRows.get(source.id).text } }; },
    async getUnderstanding() { return { current: null }; },
  };
  const pages = new Map();
  let versions = 0;
  const written = [];
  const entries = {
    async writePage({ slug, markdown, title }) { pages.set(slug, markdown); versions += 1; written.push(slug); return { source: { id: `src_${String(versions).padStart(32, "9")}`, revision: 1 }, duplicate: false, title }; },
    async readPage(project, slug) { return pages.get(slug) ?? null; },
    async retirePage({ source }) { retired.push(source.id); },
  };
  const retired = [];
  const calls = { dispatch: [], read: [] };
  const runtime = {
    async dispatch(request) { calls.dispatch.push(request); if (overrides.dispatchError) throw overrides.dispatchError; return { runId: "run-1", sessionId: "s-1", dispatchId: request.dispatchId }; },
    async readResult(identity) { calls.read.push(identity); return overrides.result ? overrides.result() : { status: "succeeded", patch: calls.patch, usage: { actualCost: 0.12 } }; },
  };
  const reports = [];
  const store = {
    async userById(userId) { return { id: userId }; },
    async requireProject(user, projectId) { if (projectId === "gone") throw Object.assign(new Error("none"), { status: 404 }); return { id: projectId, userId: user.id, baseDir: "/tmp/x" }; },
  };
  const service = new KnowledgePageService({ config, documents, jobs, sources, store, entries, runtime, now, report: (code) => reports.push(code) });
  return { service, config, rows, enqueued, sources, addSource, pages, written, retired, calls, reports, advance: (ms) => { clock += ms; }, documents, sourceRows,
    job: (round = 1) => ({ id: "job-1", userId: "u1", projectId: "p1", payload: { projectId: "p1", round } }) };
}

const claim = (text, sourceId, quote, extra = {}) => ({ text, kind: "direct", evidence: [{ sourceId, quote }], ...extra });
const patchOf = (...pages) => ({ schemaVersion: 1, pages });
const topic = (slug, ...claims) => ({ op: "create", slug, type: "topic", title: `Title ${slug}`, sections: [{ heading: "Findings", claims }] });

test("a document is cut to verbatim spans, opening first, and says that it was cut", () => {
  const text = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} says something particular about item ${index}.`).join("\n");
  assert.deepEqual(excerptSourceText("short", 100), { text: "short", truncated: false });
  const anchored = excerptSourceText(text, 4000, [{ start: 12_000, end: 12_100 }]);
  assert.equal(anchored.truncated, true);
  assert.ok(anchored.text.length <= 4200);
  assert.ok(anchored.text.startsWith("Paragraph 0 says"));
  const middle = text.slice(11_700, 12_400);
  assert.ok(anchored.text.includes(middle.slice(100, 200)), "the passage the understanding anchored survives");
  for (const span of anchored.text.split("\n\n----\n\n")) assert.ok(text.includes(span.trim()), "every span is a piece of the document, word for word");
  const even = excerptSourceText(text, 4000);
  assert.equal(even.truncated, true);
  for (const span of even.text.split("\n\n----\n\n")) assert.ok(text.includes(span.trim()));
});

test("the input offers stale pages first and says which pages it could not give", () => {
  const page = (slug, extra = {}) => ({ slug, type: "topic", title: slug, markdown: `# ${slug}\n\n## H\n\n- ${"x".repeat(100)} ${knowledgeSourceMarker(A, QUOTE_A)}\n`, userEdited: false, claims: 1, sources: [A], stale: null, held: [], ...extra });
  const { input, files } = buildKnowledgeCompileInput({ round: 2, sources: [{ sourceId: A, title: "A", generation: 1, textSha256: "s", text: TEXT[A], truncated: false }],
    pages: [page("alpha"), page("beta", { stale: [{ sourceId: B, reason: "retracted" }] }), page("gamma", { sources: [C] })], pagesBytes: 600 });
  assert.deepEqual(input.pages.map((entry) => entry.slug), ["beta", "alpha", "gamma"]);
  assert.deepEqual(input.changed, [{ slug: "beta", reason: "retracted" }]);
  assert.equal(input.pages.filter((entry) => entry.unreadable).map((entry) => entry.slug).join(), "gamma");
  assert.deepEqual(files.map((file) => file.rel), [`sources/${A}.txt`, "pages/beta.md", "pages/alpha.md"]);
  assert.equal(input.sources[0].text, TEXT[A]);
});

test("a readable document queues the project's round after the quiet period; a page and a switch that is off queue nothing", async () => {
  const t = fixture();
  t.addSource(A);
  await t.service.noteSourceReady("u1", "p1", A);
  assert.equal(t.enqueued.length, 1);
  assert.equal(t.enqueued[0].kind, "wiki-compile");
  assert.deepEqual(t.enqueued[0].payload, { projectId: "p1", round: 1 });
  assert.equal(t.enqueued[0].options.idempotencyKey, "wiki-compile:p1:1");
  assert.equal(t.enqueued[0].options.runAfter.getTime() - Date.parse("2026-10-12T08:00:00Z"), 600_000);
  assert.deepEqual((await t.service.summary("u1", "p1")).pending, 1);

  const page = t.addSource(id("e"), { path: "knowledge-base/wiki/afib.md" });
  await t.service.noteSourceReady("u1", "p1", page.id);
  assert.equal(t.enqueued.length, 1, "a knowledge page is not a document to compile");

  const off = fixture({ config: { knowledgePagesEnabled: false } });
  off.addSource(A);
  await off.service.noteSourceReady("u1", "p1", A);
  assert.deepEqual(off.enqueued, []);
  assert.equal(off.rows.size, 0, "off, nothing is written");
});

test("a round waits for quiet, for the threshold, and then compiles: sentences that stand are written, the others are held, the index is rendered", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  for (const sourceId of [A, B]) await t.service.noteSourceReady("u1", "p1", sourceId);
  assert.deepEqual(await t.service.runJob(t.job()), { defer: { code: "knowledge_waiting_for_quiet", delayMs: 600_000 } });
  t.advance(600_001);
  t.calls.patch = patchOf(
    topic("anticoagulants",
      claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A),
      claim("Apixaban cured every patient.", B, "Apixaban cured every patient in the trial"),
      { text: "Two agents lower bleeding or stroke.", kind: "synthesized", confidence: "moderate", evidence: [{ sourceId: B, quote: QUOTE_B }, { sourceId: C, quote: QUOTE_C }] }),
    topic("invented", claim("Nothing here stands.", A, "a passage that is not in the document at all")),
  );
  const outcome = await t.service.runJob(t.job());
  assert.equal(t.calls.dispatch.length, 1);
  assert.match(t.calls.dispatch[0].dispatchId, /^knowledge-compile-[a-f0-9]{32}$/);
  assert.deepEqual(t.calls.dispatch[0].files.map((file) => file.rel).sort(), [`sources/${A}.txt`, `sources/${B}.txt`].sort().concat(`sources/${C}.txt`).sort().slice(0, 2));
  assert.equal(outcome.result.pagesCreated, 1);
  assert.equal(outcome.result.kept, 2);
  assert.equal(outcome.result.held, 2);
  assert.equal(outcome.result.pagesSkipped, 1);
  assert.equal(outcome.result.cost, 0.12);

  const markdown = t.pages.get("anticoagulants");
  assert.ok(markdown.includes("Rivaroxaban was non-inferior to warfarin.") && markdown.includes("Two agents lower bleeding or stroke."));
  assert.ok(!markdown.includes("cured every patient"), "a sentence that does not stand is not in the file a search reads");
  assert.equal(t.pages.has("invented"), false, "a page with nothing that stands is not written");
  assert.equal(parseKnowledgePage(markdown).units.length, 2);
  assert.ok(t.pages.get("index").includes("[[anticoagulants|Title anticoagulants]]"));

  const record = [...t.rows.values()].find((row) => row.payload.recordType === "wiki-page");
  assert.deepEqual(record.payload.dependsOn.sort(), [A, B, C].sort());
  assert.equal(record.payload.basis, "compiler");
  assert.equal(record.payload.heldCount, 1);
  assert.deepEqual(record.payload.held[0].reasons, ["quote_not_found"]);

  const state = (await t.service.summary("u1", "p1"));
  assert.equal(state.round, 2);
  assert.equal(state.pending, 0, "the round's documents left the queue");
  assert.equal(state.lastRound.kept, 2);
});

test("below the threshold a round is not run and its queue is kept", async () => {
  const t = fixture({ config: { knowledgePagesMinSources: 5 } });
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  assert.deepEqual(await t.service.runJob(t.job()), { result: { skipped: "below_threshold", readable: 3 } });
  assert.equal(t.calls.dispatch.length, 0);
  assert.equal((await t.service.summary("u1", "p1")).pending, 1);
});

test("a job for a superseded round, a switch that is off, or a project that is gone does nothing", async () => {
  const t = fixture();
  assert.deepEqual(await t.service.runJob(t.job(7)), { result: { skipped: "round_superseded" } });
  assert.deepEqual(await t.service.runJob({ ...t.job(), projectId: "gone", payload: { projectId: "gone", round: 1 } }), { result: { skipped: "project_gone" } });
  const off = fixture({ config: { knowledgePagesEnabled: false } });
  assert.deepEqual(await off.service.runJob(off.job()), { result: { skipped: "disabled" } });
});

test("a run that is still working defers the round with no failure; a run that failed closes it", async () => {
  let status = "pending";
  const t = fixture({ result: () => ({ status }) });
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  assert.deepEqual(await t.service.runJob(t.job()), { defer: { code: "knowledge_run_pending", delayMs: 15_000 } });
  status = "failed";
  await assert.rejects(() => t.service.runJob(t.job()), (error) => error.code === "knowledge_run_failed");
  await t.service.recordFailure(t.job(), "knowledge_run_failed");
  const state = await t.service.summary("u1", "p1");
  assert.equal(state.round, 2, "the next change asks for a new round and a new run");
  assert.equal(state.lastError.code, "knowledge_run_failed");
  assert.equal(state.pending, 1, "the documents wait for the next round");
});

test("a runtime that is busy or a cap that is reached defers the round without spending an attempt", async () => {
  for (const code of ["runtime_busy", "usage_budget_exceeded"]) {
    const t = fixture({ dispatchError: Object.assign(new Error(code), { code }) });
    for (const sourceId of [A, B, C]) t.addSource(sourceId);
    await t.service.noteSourceReady("u1", "p1", A);
    t.advance(600_001);
    const outcome = await t.service.runJob(t.job());
    assert.equal(outcome.defer.code, code);
  }
  const broken = fixture({ dispatchError: Object.assign(new Error("boom"), { code: "knowledge_unconfigured" }) });
  for (const sourceId of [A, B, C]) broken.addSource(sourceId);
  await broken.service.noteSourceReady("u1", "p1", A);
  broken.advance(600_001);
  await assert.rejects(() => broken.service.runJob(broken.job()), (error) => error.code === "knowledge_unconfigured");
});

test("a patch with one page that cannot be read still writes the others", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(
    { op: "create", slug: "Not A Slug", type: "topic", title: "Bad", sections: [] },
    topic("good", claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A)),
  );
  const { result } = await t.service.runJob(t.job());
  assert.equal(result.rejectedPages, 1);
  assert.equal(result.pagesCreated, 1);
  assert.ok(t.pages.has("good"));
});

test("a patch that is not a patch fails the round", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = { schemaVersion: 9 };
  await assert.rejects(() => t.service.runJob(t.job()), (error) => error.code === "knowledge_patch_invalid");
});

test("a quotation is checked against the whole document, and only against this project's documents", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  const foreign = id("f");
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(topic("mixed",
    claim("From a document of the project that was not in the round's input.", C, QUOTE_C),
    claim("From a document that is not the project's.", foreign, QUOTE_A)));
  const { result } = await t.service.runJob(t.job());
  assert.equal(result.kept, 1);
  assert.equal(result.held, 1);
  const record = [...t.rows.values()].find((row) => row.payload.recordType === "wiki-page");
  assert.equal(record.payload.held[0].evidence[0].status, "source_unavailable");
});

test("a change to a document the pages quote labels them and queues a round; a round that reads them again and changes nothing stops asking", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(topic("afib", claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A)));
  await t.service.runJob(t.job());
  t.enqueued.length = 0;

  const labelled = await t.service.noteSourcesChanged("u1", "p1", [{ sourceId: A, reason: "retracted" }]);
  assert.equal(labelled.pages, 1);
  assert.equal(t.enqueued.at(-1).payload.round, 2);
  assert.deepEqual((await t.service.pagesQuoting("u1", "p1", A)).map((page) => page.slug), ["afib"]);
  assert.deepEqual(await t.service.pagesQuoting("u1", "p1", B), []);
  const summary = await t.service.summary("u1", "p1");
  assert.equal(summary.stale, 1);

  t.advance(600_001);
  t.calls.patch = patchOf();
  await t.service.runJob(t.job(2));
  const record = [...t.rows.values()].find((row) => row.payload.recordType === "wiki-page");
  assert.equal(record.payload.stale.sources[0].reason, "retracted", "the label stays: the document did change");
  assert.equal(record.payload.stale.reviewed, true, "but the page no longer asks for another round");
  const next = t.enqueued.filter((entry) => entry.kind === "wiki-compile" && entry.payload.round === 3);
  assert.equal(next.length, 0);
});

test("a recompile rewrites the page the compiler wrote and clears its label", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(topic("afib", claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A)));
  await t.service.runJob(t.job());
  await t.service.noteSourcesChanged("u1", "p1", [{ sourceId: A, reason: "changed" }]);
  t.advance(600_001);
  t.calls.patch = patchOf({ op: "update", slug: "afib", type: "topic", title: "Title afib", sections: [{ heading: "Findings", claims: [claim("Apixaban reduced major bleeding.", B, QUOTE_B)] }] });
  const { result } = await t.service.runJob(t.job(2));
  assert.equal(result.pagesUpdated, 1);
  const record = [...t.rows.values()].find((row) => row.payload.recordType === "wiki-page");
  assert.equal(record.payload.stale, null);
  assert.deepEqual(record.payload.dependsOn, [B]);
});

test("a page the researcher edited is never rewritten or retired by a recompile: the compiler's new statements are added under one heading", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(topic("afib", claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A)));
  await t.service.runJob(t.job());
  const mine = renderKnowledgePage({ type: "topic", title: "Title afib", sections: [{ heading: "Findings", claims: [claim("My own wording of the rivaroxaban finding.", A, QUOTE_A)] }] });
  t.pages.set("afib", mine);
  await t.service.pageEdited("u1", "p1", { id: id("7"), payload: { paths: ["knowledge-base/wiki/afib.md"] } });
  assert.equal([...t.rows.values()].find((row) => row.payload.recordType === "wiki-page").payload.basis, "user");

  await t.service.noteSourcesChanged("u1", "p1", [{ sourceId: B, reason: "changed" }]);
  t.advance(600_001);
  t.calls.patch = patchOf({ op: "update", slug: "afib", type: "topic", title: "Title afib", sections: [{ heading: "Findings", claims: [
    claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A), claim("Apixaban reduced major bleeding.", B, QUOTE_B)] }] });
  const { result } = await t.service.runJob(t.job(2));
  assert.equal(result.pagesUpdated, 1);
  const merged = t.pages.get("afib");
  assert.ok(merged.startsWith(mine.trimEnd()), "the researcher's page is the start of the result");
  assert.ok(merged.includes("My own wording of the rivaroxaban finding.") && merged.includes("来源更新后新增") && merged.includes("Apixaban reduced major bleeding."));

  t.advance(600_001);
  t.calls.patch = patchOf({ op: "retire", slug: "afib", reason: "merged" });
  await t.service.noteSourcesChanged("u1", "p1", [{ sourceId: C, reason: "changed" }]);
  t.advance(600_001);
  const retiring = await t.service.runJob(t.job(3));
  assert.equal(retiring.result.pagesRetired, 0);
  assert.equal(t.retired.length, 0);
});

test("a retire of the compiler's own page retires its document and its record", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(topic("old", claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A)));
  await t.service.runJob(t.job());
  const pageDocument = [...t.rows.values()].find((row) => row.payload.recordType === "wiki-page").payload.pageSourceId;
  t.sourceRows.set(pageDocument, { id: pageDocument, projectId: "p1", deletedAt: null, revision: 1, payload: { paths: ["knowledge-base/wiki/old.md"], connector: { type: "upload" } } });
  await t.service.noteSourcesChanged("u1", "p1", [{ sourceId: A, reason: "changed" }]);
  t.advance(600_001);
  t.calls.patch = patchOf({ op: "retire", slug: "old", mergedInto: "new" }, topic("new", claim("Apixaban reduced major bleeding.", B, QUOTE_B)));
  const { result } = await t.service.runJob(t.job(2));
  assert.equal(result.pagesRetired, 1);
  assert.deepEqual(t.retired, [pageDocument]);
  assert.equal((await t.service.summary("u1", "p1")).pages, 1);
});

test("the reader's view checks every sentence now, against the documents as they are now", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(topic("afib", claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A), claim("Apixaban reduced major bleeding.", B, QUOTE_B)));
  await t.service.runJob(t.job());
  const pageSource = { id: id("7"), payload: { paths: ["knowledge-base/wiki/afib.md"] } };
  const project = { id: "p1" };
  const view = await t.service.pageView("u1", project, pageSource);
  assert.equal(view.title, "Title afib");
  assert.deepEqual(view.counts, { claims: 2, verified: 2, unverified: 0, unsupported: 0 });
  assert.equal(view.sections[0].heading, "Findings");
  assert.equal(view.sections[0].items[0].evidence[0].title, "Doc aa");

  // The second document is replaced by one that no longer says it.
  t.sourceRows.get(B).text = "A different text altogether, with no bleeding result.";
  const stale = await t.service.pageView("u1", project, pageSource);
  assert.deepEqual(stale.counts, { claims: 2, verified: 1, unverified: 1, unsupported: 0 });
  assert.equal(stale.sections[0].items[1].status, "unverified");
  assert.equal(stale.sections[0].items[1].evidence[0].status, "quote_not_found");

  await assert.rejects(() => t.service.pageView("u1", project, { id: A, payload: { paths: ["knowledge-base/a.md"] } }), (error) => error.code === "knowledge_page_not_found");
});

test("the worker puts back a round that is not ready, finishes one that is done, and closes one that cannot be retried", async () => {
  const log = [];
  const claims = [
    { id: "j1", userId: "u1", leaseToken: "l1", attempts: 1, payload: { projectId: "p1", round: 1 } },
    { id: "j2", userId: "u1", leaseToken: "l2", attempts: 1, payload: { projectId: "p1", round: 2 } },
    { id: "j3", userId: "u1", leaseToken: "l3", attempts: 1, payload: { projectId: "p1", round: 3 } },
    { id: "j4", userId: "u1", leaseToken: "l4", attempts: 1, payload: { projectId: "p1", round: 4 } },
  ];
  const jobs = {
    async claim() { return claims.shift() ?? null; },
    async renew() { return true; },
    async finish(userId, jobId, lease, result) { log.push(["finish", jobId, result]); },
    async fail(userId, jobId, lease, error, options) { log.push(["fail", jobId, error.code, options]); },
  };
  const outcomes = [{ defer: { code: "runtime_busy", delayMs: 60_000 } }, { result: { kept: 1 } },
    Object.assign(new Error("x"), { code: "knowledge_run_failed" }), Object.assign(new Error("y"), { code: "some_transient" })];
  const service = { enabled: true, async runJob() { const next = outcomes.shift(); if (next instanceof Error) throw next; return next; }, async recordFailure(job, code) { log.push(["closed", job.id, code]); } };
  const worker = new KnowledgePageWorker({ jobs, service, pollMs: 100, leaseMs: 5000 });
  for (let index = 0; index < 4; index += 1) await worker.tick();
  assert.deepEqual(log, [
    ["fail", "j1", "runtime_busy", { retry: true, refundAttempt: true, delayMs: 60_000 }],
    ["finish", "j2", { kept: 1 }],
    ["closed", "j3", "knowledge_run_failed"],
    ["fail", "j3", "knowledge_run_failed", { retry: false, delayMs: 0 }],
    ["fail", "j4", "some_transient", { retry: true, delayMs: 2000 }],
  ]);
  const off = new KnowledgePageWorker({ jobs: { async claim() { throw new Error("must not claim"); } }, service: { enabled: false } });
  assert.equal(await off.tick(), null);
});

test("an immediate request brings the queued round forward and offers the documents again", async () => {
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.requestRound("u1", "p1");
  assert.ok(t.enqueued.some((entry) => entry.broughtForward === "wiki-compile:p1:1"));
  assert.equal((await t.service.summary("u1", "p1")).pending, 3);
  assert.equal(t.enqueued[0].options.runAfter.getTime(), Date.parse("2026-10-12T08:00:00Z"));
});

test("a retraction or correction recorded for a work reaches the pages that quote a document carrying it, by recorded id and DOI only", async () => {
  const { KnowledgeChangeService } = await import("../src/knowledgeChange.mjs");
  const t = fixture();
  for (const sourceId of [A, B, C]) t.addSource(sourceId);
  await t.service.noteSourceReady("u1", "p1", A);
  t.advance(600_001);
  t.calls.patch = patchOf(topic("afib", claim("Rivaroxaban was non-inferior to warfarin.", A, QUOTE_A)));
  await t.service.runJob(t.job());
  t.enqueued.length = 0;
  // The document carrying the DOI is found by the project's list of documents, never by what a page says.
  t.sources.documents.list = async (userId, kind, { filter }) => ({ items: filter.metadata.doi === "10.1000/afib" ? [{ id: A }] : [] });
  const knowledge = new KnowledgeChangeService({ pages: t.service, report: (code) => t.reports.push(code) });

  const current = await knowledge.pages("u1", "p1", { id: "10.1000/afib", doi: "10.1000/afib" }, { state: "no_update" });
  assert.deepEqual(current, { items: [], total: 0 });
  assert.equal(t.enqueued.length, 0, "a work with nothing recorded against it changes nothing");

  const changed = await knowledge.pages("u1", "p1", { id: "10.1000/afib", doi: "10.1000/afib" }, { state: "changed", updates: [{ kind: "retraction" }] });
  assert.deepEqual(changed.items.map((item) => item.slug), ["afib"]);
  assert.equal((await t.service.summary("u1", "p1")).stale, 1);
  assert.ok(t.enqueued.some((entry) => entry.kind === "wiki-compile"));
  const record = [...t.rows.values()].find((row) => row.payload.recordType === "wiki-page");
  assert.equal(record.payload.stale.sources[0].reason, "retracted");

  assert.deepEqual(await knowledge.pages("u1", "p1", { id: A }, { state: "changed", updates: [{ kind: "correction" }] }), { total: 1, items: [{ slug: "afib", title: "Title afib", sourceId: record.payload.pageSourceId }] });
  assert.deepEqual(await new KnowledgeChangeService({}).pages("u1", "p1", { id: A }, { state: "changed" }), { unknown: "unavailable" });
  const off = fixture({ config: { knowledgePagesEnabled: false } });
  assert.deepEqual(await new KnowledgeChangeService({ pages: off.service }).pages("u1", "p1", { id: A }, { state: "changed" }), { unknown: "unavailable" });
});
