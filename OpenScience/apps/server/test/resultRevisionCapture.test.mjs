import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { createResultProvenanceRoutes } from "../src/resultProvenanceRoutes.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

async function fixture(t) {
  const root = await mkdtemp("/tmp/evimed-revision-capture-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: "owner", rootDir: root, baseDir: root,
    workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const documents = productDocumentsDouble();
  const f = { project, documents, run: { id: "revision-run", sessionId: "revision-session", kernelRequestIds: ["submitted-request"] } };
  f.results = new ResultProvenanceService({ documents, authorizeProject: async () => project,
    authorizeReference: async (_actor, _project, reference) => reference,
    resolveCaptureContext: (owned, input) => f.revisions.captureContext(owned, input, f.run) });
  f.revisions = new ResultRevisionService({ results: f.results, documents });
  // `bytes` is what the producing tool wrote; an edit states a patch, not its bytes, so it carries no digest.
  f.capture = async (relativePath, bytes, { receipted = true, producer = { kind: "tool", runId: f.run.id, sessionId: f.run.sessionId, callId: relativePath } } = {}) => {
    await mkdir(path.dirname(path.join(project.workspaceDir, relativePath)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relativePath), bytes);
    return f.results.captureFile({ userId: "owner", project, relativePath, producer,
      ...(receipted ? { expectedDigest: createHash("sha256").update(bytes).digest("hex") } : {}) });
  };
  f.revise = async (original, text) => {
    const stage = await f.revisions.stage("owner", original.versionId, { projectId: "p", digest: original.digest,
      requestId: `selected-${original.versionId.slice(3, 11)}`, sessionId: f.run.sessionId, anchor: { kind: "text", elementId: "paragraph-1", selectedText: text } });
    return { stage, prefix: `artifacts/result-revisions/${stage.referenceId}/output`,
      bind: () => f.revisions.bind("owner", project, { sessionId: f.run.sessionId, requestId: "submitted-request",
        evimedResultRevision: { referenceId: stage.referenceId }, content: [{ type: "text", text: `${stage.draft}Clarify the limitation.` }] }) };
  };
  return f;
}

test("native revision outputs retain explicit ancestry only for the file that is the selected output revised, and only for the bound producing request", async t => {
  const f = await fixture(t);
  const original = await f.capture("original.md", "The original finding.");
  const { stage, prefix, bind } = await f.revise(original, "The original finding.");
  const stagedOnly = await f.capture(`${prefix}/original.md`, "A filename cannot submit an instruction.");
  assert.equal(stagedOnly.supersedesVersionId, null, "an unsubmitted selection has no authority over any output");
  await bind();

  const successor = await f.capture(`${prefix}/original.md`, "The original finding has a stated limitation.");
  assert.equal(successor.supersedesVersionId, original.versionId);
  assert.equal(successor.inputs[0].versionId, original.versionId);
  assert.equal(successor.inputs[0].digest, original.digest);
  assert.notEqual(successor.artifactId, original.artifactId);

  // Everything else the run left in the directory is its own output.
  const rendering = await f.capture(`${prefix}/report.docx`, "A rendering of the revised report.");
  const renamed = await f.capture(`${prefix}/revised.md`, "Another name is another output, never a guessed successor.");
  const nested = await f.capture(`${prefix}/notes/original.md`, "Only the selected file's own place in the directory counts.");
  const edited = await f.capture(`${prefix}/figure.svg`, "<svg/>", { receipted: false });
  for (const sibling of [rendering, renamed, nested, edited]) {
    assert.equal(sibling.supersedesVersionId, null, sibling.path);
    assert.deepEqual(sibling.inputs, [], `${sibling.path} claims no input it was not shown to derive from`);
    assert.equal((await f.results.related("owner", { projectId: "p", versionId: sibling.versionId })).items.length, 0, sibling.path);
  }
  assert.deepEqual((await f.results.related("owner", { projectId: "p", versionId: original.versionId })).items.map(item => item.versionId), [successor.versionId]);
  assert.deepEqual((await f.results.related("owner", { projectId: "p", versionId: successor.versionId })).items.map(item => item.versionId), [original.versionId]);

  // A later request in the same session has no recorded relationship.
  f.run = { ...f.run, id: "later-run", kernelRequestIds: ["unrelated-request"] };
  const unrelated = await f.capture(`${prefix}/original.md`, "This later request has no recorded relationship.");
  assert.equal(unrelated.supersedesVersionId, null);
  f.run = { ...f.run, id: "revision-run", kernelRequestIds: ["submitted-request"] };

  // The old bytes are untouched by any of it.
  assert.equal((await f.results.raw("owner", "p", original.versionId)).bytes.toString(), "The original finding.");
  const route = createResultProvenanceRoutes({ service: f.results, store: {
    ensureSessionUser: async () => ({ user: { id: "owner" } }), requireProject: async () => f.project,
  } });
  let payload;
  await route({ method: "GET", url: `/api/results?projectId=p&relatedTo=${original.versionId}` }, {
    writeHead() {}, end(bytes) { payload = JSON.parse(bytes); },
  });
  assert.deepEqual(payload.data.items.map(item => item.versionId), [successor.versionId]);
  assert.equal(stage.referenceId.startsWith("rr_"), true);
});

test("a deliverable-producer capture is held to the same identity rule as a tool write", async t => {
  const f = await fixture(t);
  const original = await f.capture("deliverables/d1/report.md", "The original finding.");
  const { prefix, bind } = await f.revise(original, "The original finding.");
  await bind();
  const producer = { kind: "deliverable", runId: f.run.id, sessionId: f.run.sessionId, eventId: "d1" };
  const successor = await f.capture(`${prefix}/report.md`, "The revised finding.", { producer });
  const sibling = await f.capture(`${prefix}/summary.md`, "A summary written beside it.", { producer });
  assert.equal(successor.supersedesVersionId, original.versionId, "the selected file's name, whatever directory it was selected from");
  assert.equal(sibling.supersedesVersionId, null);
});

test("a copy of the selected bytes is not a revision of them", async t => {
  const f = await fixture(t);
  const original = await f.capture("forest.svg", "<svg>unchanged</svg>");
  const { prefix, bind } = await f.revise(original, "unchanged");
  await bind();
  const copy = await f.capture(`${prefix}/forest.svg`, "<svg>unchanged</svg>");
  assert.equal(copy.supersedesVersionId, null);
  assert.equal(copy.digest, original.digest);
  assert.equal((await f.results.raw("owner", "p", original.versionId)).bytes.toString(), "<svg>unchanged</svg>");
  const restyled = await f.capture(`${prefix}/forest.svg`, "<svg>restyled</svg>");
  assert.equal(restyled.supersedesVersionId, original.versionId);
});

test("the run is told which file is the revised form of the selection", async t => {
  const f = await fixture(t);
  const original = await f.capture("deliverables/d1/report.md", "The original finding.");
  const { stage, prefix } = await f.revise(original, "The original finding.");
  const request = { sessionId: f.run.sessionId, requestId: "submitted-request", evimedResultRevision: { referenceId: stage.referenceId },
    content: [{ type: "text", text: `${stage.draft}Clarify the limitation.` }] };
  await f.revisions.bind("owner", f.project, request);
  const block = JSON.parse(/<evimed_result_selection>\n([\s\S]*?)\n<\/evimed_result_selection>/.exec(request.content.at(-1).text)[1]);
  assert.equal(block.outputDirectory, prefix);
  assert.equal(block.revisedPath, `${prefix}/report.md`);
  assert.match(block.preservation, /revisedPath/);
});

test("whole-file native context binds actual words, replays its request, refuses stale bytes, and ignores unreceipted copies", async t => {
  const f = await fixture(t);
  const original = await f.capture("article.md", "Original [citation].");
  const makeRequest = () => ({ sessionId: f.run.sessionId, requestId: "submitted-request", content: [{ type: "text", text: "Make this easier to understand." }] });
  const options = { versionId: original.versionId, digest: original.digest, target: null, expectedHeadVersionId: null };
  const request = makeRequest();
  const bound = await f.revisions.bindConversation("owner", f.project, request, options);
  assert.equal(bound.anchor.kind, "file"); assert.equal(bound.anchor.matchMode, "whole_file");
  assert.equal(bound.instruction, makeRequest().content[0].text);
  assert.equal((await f.revisions.bindConversation("owner", f.project, makeRequest(), options)).id, bound.id);
  await assert.rejects(f.revisions.bindConversation("owner", f.project, { ...makeRequest(), content: [{ type: "text", text: "A different instruction" }] }, options), { code: "result_revision_stale" });
  await assert.rejects(f.revisions.bindConversation("owner", f.project, { ...makeRequest(), requestId: "stale" }, { ...options, digest: "a".repeat(64) }), { code: "result_revision_stale" });
  const output = `artifacts/result-revisions/${bound.id}/output/article.md`;
  const copy = await f.capture(output, "Original [citation].", { receipted: false });
  assert.equal(copy.supersedesVersionId, null);
  const successor = await f.capture(output, "Clearer wording [citation].", { receipted: false });
  assert.equal(successor.supersedesVersionId, original.versionId);
  assert.equal((await f.capture(`artifacts/result-revisions/${bound.id}/output/article.pdf`, "PDF rendition", { receipted: false })).supersedesVersionId, null);
});

test("mtime-only ordinary output discovery preserves bytes without claiming another session's producer", async t => {
  const f = await fixture(t);
  const foreign = await f.capture("concurrent-b.docx", "PK another session's Word", { producer: { kind: "tool", runId: "run-b", sessionId: "session-b", callId: "write-b" } });
  const other = await f.capture("deliverables/b/article.md", "Another session's Markdown", { producer: { kind: "tool", runId: "run-b", sessionId: "session-b", callId: "write-b-md" } });
  const { captureFinishedRun } = await import("../src/resultDeliveryCapture.mjs");
  const captured = await captureFinishedRun({ results: f.results, project: f.project,
    run: { ...f.run, outputFiles: [foreign.path, other.path] }, readReceipt: async () => null });
  assert.equal(captured.items.length, 2);
  for (const item of captured.items) {
    assert.equal(item.producer.kind, "workspace");
    assert.equal(item.producer.sessionId, null);
  }
  assert.equal((await f.results.query("owner", "p", { producer: { sessionId: f.run.sessionId } })).items.length, 0);
  assert.equal((await f.results.raw("owner", "p", captured.items[0].versionId)).bytes.toString(), "PK another session's Word");
});


test("an actual native presentation gives a shell-written ordinary Word file its own conversation witness", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project.workspaceDir, "presented.docx"), "PK shell-written Word");
  const { captureFinishedRun } = await import("../src/resultDeliveryCapture.mjs");
  const captured = await captureFinishedRun({ results: f.results, project: f.project,
    run: { ...f.run, outputFiles: ["presented.docx"], presentedFiles: ["presented.docx"] }, readReceipt: async () => null });
  assert.equal(captured.items[0].producer.kind, "deliverable");
  assert.equal(captured.items[0].producer.sessionId, f.run.sessionId);
});
