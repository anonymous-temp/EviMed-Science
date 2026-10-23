import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoMarketStore } from "../src/geoMarketStore.mjs";
import { GeoArticleResults } from "../src/geoArticleResults.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { captureFinishedRun } from "../src/resultDeliveryCapture.mjs";
import { createGeoDeliveryImport } from "../src/geoDeliveryImport.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60000 };
const sha = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, filename = "article.md") {
  const isolated = await createGeoTestDatabase(url, "georevision");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "geo-revision-"));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: "postgres", devAuth: true });
  const accounts = new PostgresStore(config);
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await accounts.devUser(); const project = await accounts.requireProject(user, "default");
  await mkdir(project.workspaceDir, { recursive: true }); await mkdir(project.metaDir, { recursive: true });
  const store = new GeoStore({ database: accounts.database }); await store.ready();
  const geo = await store.createProject({ userId: user.id, projectId: project.id, engines: ["deepseek"], coverageDays: 90 });
  const documents = new ProductDocuments(accounts.database);
  const f = { accounts, project, user, store, geo, documents, run: { id: "r0", sessionId: "native-session", status: "succeeded", kernelRequestIds: ["initial-request"] } };
  f.results = new ResultProvenanceService({ documents, config,
    authorizeProject: async (actor, id) => accounts.requireProject(await accounts.userById(actor), id),
    authorizeReference: async (_actor, _project, ref) => ref,
    resolveCaptureContext: (owned, input) => f.revisions.captureContext(owned, input, f.run) });
  f.revisions = new ResultRevisionService({ results: f.results, documents });
  f.service = new GeoService({ store, config });
  f.reports = [];
  f.adapter = new GeoArticleResults({ store, service: f.service, results: f.results, revisions: f.revisions, documents,
    cards: { checkText: async (_geo, { text }) => ({ status: text.includes("[claim]") ? "resolved" : "none", references: text.includes("[claim]") ? [{ cardId: "card", claimId: "claim", revision: 1 }] : [] }) },
    parser: { parseBytes: async ({ bytes, sha256 }) => { assert.equal(sha(bytes), sha256); assert.equal(bytes.subarray(0, 2).toString(), "PK"); return { text: "Extracted Word [claim]" }; } },
    report: code => f.reports.push(code) });
  f.capture = async (relativePath, content) => {
    await mkdir(path.dirname(path.join(project.workspaceDir, relativePath)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relativePath), content);
    return f.results.captureFile({ userId: user.id, project, relativePath,
      producer: { kind: "tool", runId: f.run.id, sessionId: f.run.sessionId, callId: `call-${f.run.id}` } });
  };
  f.initialBytes = filename.endsWith("docx") ? Buffer.from("PK original Word") : Buffer.from("# Original\nEvidence [claim].");
  f.original = await f.capture(filename, f.initialBytes);
  [f.articleId] = await store.registerArticles(user.id, geo.id, [{ path: filename, layer: "popular", title: "Original", groupId: null,
    claimIds: ["claim"], gate: "passed", safety: "released", contentSha256: f.original.digest, runId: f.run.id,
    valueContext: { basis: "known" }, channel: "media_market", audience: "patient" }]);
  await f.adapter.complete(project, f.run);
  f.request = text => ({ sessionId: f.run.sessionId, requestId: `request-${f.run.id}`, content: [{ type: "text", text }] });
  f.output = (binding, content) => f.capture(`artifacts/result-revisions/${binding.id}/output/${filename}`, content);
  return f;
}

test("two actual native follow-ups keep originals, request ancestry, business links and immutable publication pins across restart", options, async t => {
  const f = await fixture(t);
  const market = new GeoMarketStore(f.accounts.database);
  const at = new Date().toISOString();
  await f.store.query(`UPDATE evimed_geo.projects SET status='active', budget='{"totalCny":1000,"dailyCny":1000}'::jsonb WHERE id=$1`, [f.geo.id]);
  const [order] = await market.insertOrders([{ userId: f.user.id, geoProjectId: f.geo.id, articleId: f.articleId, mediaType: "website", resourceId: "outlet", priceCny: 10, reserveCny: 11 }], at);
  assert.equal(order.articleResultVersionId, f.original.versionId);
  await f.store.upsertOwnedLinks(f.user.id, f.geo.id, [{ url: "https://example.org/article", urlKey: "example.org/article", platform: "brand_site", title: "Original", publishedAt: at, articleId: f.articleId, groupId: null }]);
  await f.store.query(`UPDATE evimed_geo.articles SET status='published' WHERE id=$1`, [f.articleId]);
  const successors = [];
  for (let i = 1; i <= 2; i += 1) {
    f.run = { ...f.run, id: `r${i}`, kernelRequestIds: [`request-r${i}`] };
    const request = f.request(i === 1 ? "Make the second paragraph easier to understand." : "Add the study limitation.");
    const binding = await f.adapter.bind(f.user, f.project, request);
    assert.equal(binding.anchor.kind, "file"); assert.equal(binding.instruction, request.content[0].text);
    assert.equal(request.content[0].text.startsWith("请修改"), false);
    const version = await f.output(binding, `# Revised ${i}\nEvidence [claim], limitation ${i}.`);
    successors.push(version);
    assert.equal(version.supersedesVersionId, i === 1 ? f.original.versionId : successors[0].versionId);
    await f.adapter.complete(f.project, f.run); await f.adapter.complete(f.project, f.run);
    assert.equal((await f.store.getArticle(f.geo.id, f.articleId)).currentResultVersionId, version.versionId);
  }
  const article = await f.store.getArticle(f.geo.id, f.articleId);
  assert.equal(article.status, "published"); assert.equal(article.onlineUpdateNeeded, true);
  assert.equal(article.gate, "unverified"); assert.equal(article.safety, "open");
  assert.equal(article.channel, "media_market"); assert.equal(article.audience, "patient"); assert.deepEqual(article.claimIds, ["claim"]);
  assert.equal(article.refCheckedSha, successors[1].digest); assert.equal(article.refStatus, "resolved");
  assert.equal((await f.store.articleVersions(f.geo.id, f.articleId)).length, 3);
  assert.deepEqual((await f.results.raw(f.user.id, f.project.id, f.original.versionId)).bytes, f.initialBytes);
  const pinned = await market.getOrderArticle(order);
  assert.equal(pinned.currentResultVersionId, f.original.versionId); assert.equal(pinned.contentSha256, f.original.digest);
  assert.equal((await f.adapter.readVersion(f.project, pinned.currentResultVersionId)).text, f.initialBytes.toString());
  const savedOrder = (await f.store.query(`SELECT article_result_version_id,article_digest,state FROM evimed_geo.orders WHERE id=$1`, [order.id])).rows[0];
  assert.equal(savedOrder.state, "planned"); assert.equal(savedOrder.article_digest, f.original.digest);
  const owned = (await f.store.query(`SELECT article_result_version_id,article_digest FROM evimed_geo.owned_links WHERE article_id=$1`, [f.articleId])).rows[0];
  assert.equal(owned.article_result_version_id, f.original.versionId); assert.equal(owned.article_digest, f.original.digest);
  const reservation = await market.reserveForSend(order.id, { at, dayStart: at, sendDetail: { title: "Original" }, articleSha256: f.original.digest });
  assert.ok(reservation && "order" in reservation, "the pre-existing order reserves against its immutable original, not the revised head");
  await f.store.query(`UPDATE evimed_geo.orders SET state='planned',article_result_version_id=NULL,article_digest=NULL WHERE id=$1`, [order.id]);
  assert.equal(await market.getOrderArticle({ ...order, articleResultVersionId: null, articleDigest: null }), null);
  assert.equal((await market.reserveForSend(order.id, { at, dayStart: at, sendDetail: {}, articleSha256: successors[1].digest })).refused, "article_changed_since_review");
  const restarted = new GeoStore({ database: f.accounts.database });
  assert.equal((await restarted.getArticle(f.geo.id, f.articleId)).currentResultVersionId, successors[1].versionId);
});

test("ordinary questions, copies, wrong request/session and racing heads do not create a false business successor", options, async t => {
  const f = await fixture(t);
  f.run = { ...f.run, id: "r1", kernelRequestIds: ["request-r1"] };
  const question = f.request("What does this conclusion mean?");
  const context = await f.adapter.bind(f.user, f.project, question);
  await f.adapter.complete(f.project, f.run);
  assert.equal((await f.store.articleVersions(f.geo.id, f.articleId)).length, 1);
  const copy = await f.output(context, f.initialBytes);
  assert.equal(copy.supersedesVersionId, null, "shell/edit without a receipt still compares the actual bytes");
  await f.adapter.complete(f.project, f.run);
  const wrongRun = { ...f.run, id: "unrelated", kernelRequestIds: ["wrong-request"] };
  f.run = wrongRun;
  assert.equal((await f.output(context, "Different bytes from another request")).supersedesVersionId, null);
  assert.equal(await f.adapter.bind(f.user, f.project, { sessionId: "other-session", requestId: "other", content: [{ type: "text", text: "Revise" }] }), null);
  f.run = { ...f.run, id: "r2", kernelRequestIds: ["request-r2"] };
  const first = await f.adapter.bind(f.user, f.project, f.request("Revise the introduction."));
  const firstVersion = await f.output(first, "First concurrent revision [claim]");
  f.run = { ...f.run, id: "r3", kernelRequestIds: ["request-r3"] };
  const second = await f.adapter.bind(f.user, f.project, f.request("Revise the conclusion."));
  const secondVersion = await f.output(second, "Second concurrent revision [claim]");
  await f.adapter.complete(f.project, { ...f.run, id: "r2", kernelRequestIds: ["request-r2"] });
  await f.adapter.complete(f.project, f.run);
  assert.equal((await f.store.getArticle(f.geo.id, f.articleId)).currentResultVersionId, firstVersion.versionId);
  assert.ok(f.reports.includes("geo_article_head_changed"));
  assert.equal((await f.results.raw(f.user.id, f.project.id, secondVersion.versionId)).bytes.toString(), "Second concurrent revision [claim]");
});

test("shell Word outputs and useful failed-run Markdown are captured, while immutable Word checks use the document parser", options, async t => {
  const f = await fixture(t, "article.docx");
  f.run = { ...f.run, id: "word-r1", status: "failed", kernelRequestIds: ["request-word-r1"] };
  const binding = await f.adapter.bind(f.user, f.project, f.request("Clarify the discussion."));
  const output = `artifacts/result-revisions/${binding.id}/output/article.docx`;
  await mkdir(path.dirname(path.join(f.project.workspaceDir, output)), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, output), Buffer.from("PK revised Word"));
  await writeFile(path.join(f.project.workspaceDir, "useful.md"), "Useful partial findings");
  f.run.outputFiles = [output, "useful.md"];
  const captured = await captureFinishedRun({ results: f.results, project: f.project, run: f.run, readReceipt: async () => null });
  assert.equal(captured.items.length, 2);
  assert.equal(captured.items.find(version => version.path === output).supersedesVersionId, f.original.versionId);
  await f.adapter.complete(f.project, f.run);
  const article = await f.store.getArticle(f.geo.id, f.articleId);
  assert.equal(article.refStatus, "resolved"); assert.equal(article.refCheckedSha, sha(Buffer.from("PK revised Word")));
  assert.equal(article.gate, "unverified");
});

test("a cached delivery import always links post-capture results, including after a process restart", options, async t => {
  const f = await fixture(t);
  await f.store.query(`DELETE FROM evimed_geo.article_versions WHERE article_id=$1`, [f.articleId]);
  await f.store.query(`UPDATE evimed_geo.articles SET current_result_version_id=NULL WHERE id=$1`, [f.articleId]);
  let called = 0; let captureComplete = false;
  const importer = createGeoDeliveryImport({ store: f.store, listInsightFolders: async () => [], listDeliverableFolders: async () => [],
    readFile: async () => { throw new Error("no delivery files"); }, afterImport: async (project, run) => { called += 1; return captureComplete ? f.adapter.complete(project, run) : null; } });
  await importer(f.project, f.run);
  assert.equal((await f.store.articleVersions(f.geo.id, f.articleId)).length, 0);
  captureComplete = true;
  await importer(f.project, f.run);
  assert.equal(called, 2);
  assert.equal((await f.store.articleVersions(f.geo.id, f.articleId)).length, 1);
});

test("whole-file selection authorizes the actor and session, stale digests and ambiguous files never guess a target", options, async t => {
  const f = await fixture(t);
  f.run = { ...f.run, id: "auth-r1", kernelRequestIds: ["request-auth-r1"] };
  await assert.rejects(f.adapter.bind({ id: "another-owner" }, f.project, f.request("Revise")), { code: "geo_project_not_found" });
  await assert.rejects(f.revisions.stage(f.user.id, f.original.versionId, { projectId: f.project.id, digest: "f".repeat(64), requestId: "stale", sessionId: f.run.sessionId,
    anchor: { kind: "file", elementId: "file", selectedText: "" } }), { code: "result_revision_stale" });
  const staged = await f.revisions.stage(f.user.id, f.original.versionId, { projectId: f.project.id, digest: f.original.digest, requestId: "file-context", sessionId: f.run.sessionId,
    anchor: { kind: "file", elementId: "file", selectedText: "" } });
  assert.equal(staged.draft, "");
  await assert.rejects(f.adapter.bind(f.user, f.project, { ...f.request("Revise"), sessionId: "another-session", evimedResultRevision: { referenceId: staged.referenceId } }), { code: "result_revision_stale" });
  const bound = await f.adapter.bind(f.user, f.project, { ...f.request("Revise"), evimedResultRevision: { referenceId: staged.referenceId } });
  assert.equal(bound.target.articleId, f.articleId); assert.equal(bound.anchor.kind, "file");
  const second = await f.capture("another.md", "A distinct article");
  await f.store.registerArticles(f.user.id, f.geo.id, [{ path: second.path, layer: "popular", claimIds: [], gate: "unverified", safety: "open", contentSha256: second.digest, runId: f.run.id }]);
  await f.adapter.complete(f.project, f.run);
  const ambiguous = { ...f.request("Revise it"), requestId: "ambiguous" };
  assert.equal(await f.adapter.bind(f.user, f.project, ambiguous), null);
  assert.match(ambiguous.content[1].text, /native clarification/);
  assert.match(ambiguous.content[1].text, /article.md/); assert.match(ambiguous.content[1].text, /another.md/);
});

test("unavailable Word parsing preserves new bytes with unknown checks and never carries the old release", options, async t => {
  const f = await fixture(t, "article.docx");
  f.adapter.parser = { parseBytes: async () => { throw Object.assign(new Error("unavailable"), { code: "source_parser_unconfigured" }); } };
  f.run = { ...f.run, id: "unparsed", kernelRequestIds: ["request-unparsed"] };
  const bound = await f.adapter.bind(f.user, f.project, f.request("Revise the introduction"));
  const next = await f.output(bound, Buffer.from("PK revised with unavailable parser"));
  await f.adapter.complete(f.project, f.run);
  const article = await f.store.getArticle(f.geo.id, f.articleId);
  assert.equal(article.currentResultVersionId, next.versionId);
  assert.equal(article.refStatus, "unchecked"); assert.equal(article.refCheckedSha, null); assert.equal(article.safety, "open");
  assert.ok(f.reports.includes("source_parser_unconfigured"));
  assert.equal((await f.results.raw(f.user.id, f.project.id, next.versionId)).bytes.toString(), "PK revised with unavailable parser");
});
