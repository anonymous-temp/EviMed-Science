import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultExportService } from "../src/resultExport.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { HttpError } from "../src/security.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "result-reuse-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const project = { id: "project", userId: "owner", rootDir, baseDir: rootDir,
    workspaceDir: path.join(rootDir, "workspace"), metaDir: path.join(rootDir, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const rows = new Map(); let revoked = false;
  const key = (user, kind, id) => JSON.stringify([user, kind, id]);
  const documents = {
    async get(user, kind, id) { return structuredClone(rows.get(key(user, kind, id)) ?? null); },
    async put(user, kind, id, payload, options) {
      const prior = rows.get(key(user, kind, id));
      if ((prior?.revision ?? 0) !== options.expectedRevision) throw new HttpError(409, "product_revision_conflict", "changed");
      const row = { id, projectId: options.projectId, payload: structuredClone(payload), revision: (prior?.revision ?? 0) + 1 };
      rows.set(key(user, kind, id), row); return structuredClone(row);
    },
  };
  const results = new ResultProvenanceService({ documents,
    authorizeProject: async (user, id) => {
      if (revoked || !["owner", "member"].includes(user) || id !== project.id) throw new HttpError(403, "forbidden", "unavailable");
      return project;
    },
    authorizeReference: async (_user, _project, ref) => ref,
  });
  const capture = async (name, value, extra = {}) => {
    await writeFile(path.join(project.workspaceDir, name), value);
    return results.captureFile({ userId: "owner", project, relativePath: name,
      producer: { kind: "deliverable", runId: "run", sessionId: "session" }, expectedDigest: hash(value), ...extra });
  };
  return { project, rows, documents, results, capture, revoke: () => { revoked = true; } };
}

test("selected export preserves original bytes, hashes every bundled file, and never walks the workspace", async t => {
  const f = await fixture(t);
  const input = await f.capture("data.json", "{\"value\":2}");
  const selected = await f.capture("report.md", "Original result", { inputs: [{ kind: "data", id: "data", versionId: input.versionId,
    digest: input.digest, availability: "captured" }, { kind: "source", id: "10.1234/missing", availability: "reference" }] });
  await writeFile(path.join(f.project.workspaceDir, "report.md"), "Overwritten");
  await writeFile(path.join(f.project.workspaceDir, "connection-secret.txt"), "must not be exported");
  const exported = await new ResultExportService({ results: f.results }).export("owner", "project", selected.versionId);
  const files = unzipSync(exported.bytes);
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  assert.equal(manifest.completeness, "partial"); assert.equal(manifest.scientificApplicability, "not_assessed");
  assert.equal(manifest.versions.length, 2); assert.equal(manifest.omissions.length, 1);
  assert.equal(Buffer.from(files[`results/${selected.versionId}/report.md`]).toString(), "Original result");
  for (const file of manifest.files) assert.equal(hash(files[file.archivePath]), file.sha256);
  assert.equal(Object.keys(files).some(name => name.includes("connection")), false);
  assert.equal(Object.values(files).some(value => Buffer.from(value).includes("must not be exported")), false);
  await assert.rejects(new ResultExportService({ results: f.results, maxBytes: 10 }).export("owner", "project", selected.versionId), { code: "result_export_limit" });
  f.revoke();
  await assert.rejects(new ResultExportService({ results: f.results }).export("owner", "project", selected.versionId), { status: 403 });
});

test("native revisions bind only the selected frozen bytes, actor, session, request and submitted instruction", async t => {
  const f = await fixture(t); const selected = await f.capture("report.md", "Original finding.");
  const service = new ResultRevisionService({ results: f.results, documents: f.documents });
  const input = { projectId: "project", digest: selected.digest, requestId: "stage", sessionId: "session",
    anchor: { kind: "text", elementId: "paragraph-1", selectedText: "Original finding." } };
  const stage = await service.stage("owner", selected.versionId, input);
  assert.deepEqual(await service.stage("owner", selected.versionId, input), stage);
  await writeFile(path.join(f.project.workspaceDir, "report.md"), "Current different finding.");
  const request = { sessionId: "session", requestId: "prompt", evimedResultRevision: { referenceId: stage.referenceId },
    content: [{ type: "text", text: `${stage.draft}Clarify the limitation.` }] };
  await assert.rejects(service.bind("member", f.project, structuredClone(request)), { code: "result_revision_stale" });
  await assert.rejects(service.bind("owner", f.project, { ...structuredClone(request), sessionId: "other" }), { code: "result_revision_stale" });
  await assert.rejects(service.bind("owner", f.project, { ...structuredClone(request), content: [{ type: "text", text: "Unrelated new question" }] }), { code: "result_revision_stale" });
  const untouched = structuredClone(request);
  const bound = await service.bind("owner", f.project, request);
  assert.equal(request.evimedResultRevision, undefined);
  assert.equal(bound.instruction, "Clarify the limitation.");
  assert.equal(await readFile(path.join(f.project.workspaceDir, bound.inputPath), "utf8"), "Original finding.");
  assert.equal(request.content[1].text.includes(selected.digest), true);
  assert.equal((await service.bind("owner", f.project, structuredClone(untouched))).promptRequestId, "prompt");
  await assert.rejects(service.bind("owner", f.project, { ...structuredClone(untouched), requestId: "other" }), { code: "result_revision_stale" });
  await writeFile(path.join(f.project.workspaceDir, bound.inputPath), "Tampered input");
  await assert.rejects(service.bind("owner", f.project, structuredClone(untouched)), { code: "result_revision_stale" });
});

test("stale and absent text selections cannot become modification targets", async t => {
  const f = await fixture(t); const selected = await f.capture("report.md", "Current text");
  const service = new ResultRevisionService({ results: f.results, documents: f.documents });
  const input = { projectId: "project", digest: selected.digest, requestId: "selection", sessionId: "session",
    anchor: { kind: "text", elementId: "paragraph-1", selectedText: "Text from another version" } };
  await assert.rejects(service.stage("owner", selected.versionId, input), { code: "result_selection_changed" });
  await assert.rejects(service.stage("owner", selected.versionId, { ...input, digest: hash("other") }), { code: "result_revision_stale" });
});
