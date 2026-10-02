import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { createResultProvenanceRoutes } from "../src/resultProvenanceRoutes.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

test("native revision outputs retain explicit ancestry across filenames only for the bound producing request", async t => {
  const root = await mkdtemp("/tmp/evimed-revision-capture-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: "owner", rootDir: root, baseDir: root,
    workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const documents = productDocumentsDouble();
  let run = { id: "revision-run", sessionId: "revision-session", kernelRequestIds: ["submitted-request"] };
  const results = new ResultProvenanceService({ documents, authorizeProject: async () => project,
    authorizeReference: async (_actor, _project, reference) => reference,
    resolveCaptureContext: (owned, input) => revisions.captureContext(owned, input, run) });
  const revisions = new ResultRevisionService({ results, documents });
  const capture = async (relativePath, bytes, producer = { kind: "tool", runId: run.id, sessionId: run.sessionId, callId: relativePath }) => {
    await mkdir(path.dirname(path.join(project.workspaceDir, relativePath)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relativePath), bytes);
    return results.captureFile({ userId: "owner", project, relativePath, producer,
      expectedDigest: createHash("sha256").update(bytes).digest("hex") });
  };
  const original = await capture("original.md", "The original finding.");
  const stage = await revisions.stage("owner", original.versionId, { projectId: "p", digest: original.digest,
    requestId: "selected", sessionId: run.sessionId, anchor: { kind: "text", elementId: "paragraph-1", selectedText: "The original finding." } });
  const prefix = `artifacts/result-revisions/${stage.referenceId}/output`;
  const stagedOnly = await capture(`${prefix}/not-submitted.md`, "A filename cannot submit an instruction.");
  assert.equal(stagedOnly.supersedesVersionId, null);
  await revisions.bind("owner", project, { sessionId: run.sessionId, requestId: "submitted-request",
    evimedResultRevision: { referenceId: stage.referenceId }, content: [{ type: "text", text: `${stage.draft}Clarify the limitation.` }] });
  const successor = await capture(`${prefix}/revised.md`, "The original finding has a stated limitation.");
  assert.equal(successor.supersedesVersionId, original.versionId);
  assert.equal(successor.inputs[0].versionId, original.versionId);
  assert.equal(successor.inputs[0].digest, original.digest);
  assert.notEqual(successor.artifactId, original.artifactId);
  assert.deepEqual((await results.related("owner", { projectId: "p", versionId: original.versionId })).items.map(item => item.versionId), [successor.versionId]);
  assert.deepEqual((await results.related("owner", { projectId: "p", versionId: successor.versionId })).items.map(item => item.versionId), [original.versionId]);
  run = { ...run, id: "later-run", kernelRequestIds: ["unrelated-request"] };
  const unrelated = await capture(`${prefix}/unrelated.md`, "This later request has no recorded relationship.");
  assert.equal(unrelated.supersedesVersionId, null);
  assert.equal((await results.raw("owner", "p", original.versionId)).bytes.toString(), "The original finding.");
  const route = createResultProvenanceRoutes({ service: results, store: {
    ensureSessionUser: async () => ({ user: { id: "owner" } }), requireProject: async () => project,
  } });
  let payload;
  await route({ method: "GET", url: `/api/results?projectId=p&relatedTo=${original.versionId}` }, {
    writeHead() {}, end(bytes) { payload = JSON.parse(bytes); },
  });
  assert.equal(payload.data.items[0].versionId, successor.versionId);
});
