import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { createResultProducerCapture, captureReceiptOutputs } from "../src/resultProducerCapture.mjs";
import { createResultProvenanceRoutes } from "../src/resultProvenanceRoutes.mjs";
import { HttpError } from "../src/security.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "evimed-result-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const projects = new Map();
  for (const id of ["one", "two"]) {
    const projectRoot = path.join(rootDir, id);
    const baseDir = path.join(projectRoot, "workspace");
    const project = { userId: "owner", id, rootDir: projectRoot, baseDir,
      workspaceDir: baseDir, metaDir: path.join(projectRoot, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true }); await mkdir(project.metaDir);
    projects.set(id, project);
  }
  const records = new Map();
  const documents = {
    async get(userId, kind, id) { return records.get(JSON.stringify([userId, kind, id])) ?? null; },
    async put(userId, kind, id, payload, { projectId }) {
      const key = JSON.stringify([userId, kind, id]);
      if (records.has(key)) throw new HttpError(409, "product_revision_conflict", "exists");
      const row = { id, projectId, payload: structuredClone(payload) }; records.set(key, row); return row;
    },
    async list(userId, kind, { projectId, filter, limit }) {
      const items = [...records.entries()].filter(([key, row]) => JSON.parse(key)[0] === userId && JSON.parse(key)[1] === kind
        && row.projectId === projectId && row.payload.recordType === filter.recordType
        && (!filter.path || row.payload.path === filter.path)
        && (!filter.producer || row.payload.producer.runId === filter.producer.runId)).map(([, row]) => row);
      return { items: items.slice(0, limit), nextCursor: null };
    },
  };
  let revoked = false;
  const authorizeProject = async (userId, projectId) => {
    if (revoked || !["owner", "collaborator"].includes(userId) || !projects.has(projectId)) throw new HttpError(403, "forbidden", "denied");
    return projects.get(projectId);
  };
  const service = new ResultProvenanceService({ documents, authorizeProject,
    authorizeReference: async (_userId, project, ref) => ref.id.startsWith(`${project.id}:`) ? ref : null });
  const project = projects.get("one");
  const capture = async (relativePath, content, extra = {}) => {
    await mkdir(path.dirname(path.join(project.workspaceDir, relativePath)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relativePath), content);
    return service.captureFile({ userId: "owner", project, relativePath,
      producer: { kind: "tool", runId: "run", sessionId: "session", callId: "call" }, expectedDigest: sha(content), ...extra });
  };
  return { rootDir, project, projects, service, documents, records, capture, revoke: () => { revoked = true; } };
}

test("finding references and embedded reviews reauthorize exact source versions, and restricted bytes are not served", async t => {
  const f = await fixture(t);
  const matrix = await f.capture("matrix.json", '{"claims":[]}');
  const ref = { kind: "source", id: "one:source", versionId: matrix.versionId, digest: matrix.digest,
    availability: "captured", path: "matrix.json", quote: "private quote", title: "private title", sourceUrl: "https://private.invalid" };
  const captured = await f.capture("report.md", "Quoted result: private quote", { inputs: [ref], findings: [{ id: "claim", sourceRefs: [ref] }],
    review: { status: "available", matrixVersionId: matrix.versionId, matrixDigest: matrix.digest,
      matrixText: '{"claims":[]}', verification: { status: "verified" } } });
  // This fixture's source resolver only authorizes one:-prefixed identities.
  assert.equal(captured.review.status, "unknown", "a matrix reference cannot bypass its own authorization");
  f.service.authorizeReference = async (_actor, _project, reference) => reference;
  const allowed = await f.service.get("owner", "one", captured.versionId);
  assert.equal(allowed.review.status, "available");
  assert.equal(allowed.findings[0].sourceRefs[0].versionId, matrix.versionId);
  f.service.authorizeReference = async (_actor, _project, reference) => reference.kind === "source" ? null : reference;
  const denied = await f.service.get("owner", "one", captured.versionId);
  assert.equal(denied.findings[0].sourceRefs[0].availability, "restricted");
  assert.equal(denied.findings[0].sourceRefs[0].quote, undefined);
  assert.equal(denied.findings[0].sourceRefs[0].path, null);
  assert.equal(denied.review.matrixText, null); assert.equal(denied.review.verification, null);
  await assert.rejects(f.service.raw("owner", "one", captured.versionId), { code: "result_input_restricted" });
  f.service.authorizeReference = async (_actor, _project, reference) => ({ ...reference, availability: "deleted" });
  assert.equal((await f.service.raw("owner", "one", captured.versionId)).bytes.toString(), "Quoted result: private quote", "a deleted input is not an access revocation");
  f.service.authorizeReference = async (_actor, _project, reference) => reference.kind === "source" ? null : reference;
  const independent = await f.capture("independent.md", "Independent authorized analysis", { inputs: [ref] });
  assert.equal((await f.service.raw("owner", "one", independent.versionId)).bytes.toString(), "Independent authorized analysis");
  const restrictedMatrix = await f.capture("private-matrix.json", JSON.stringify({ claims: [{ claimId: "private", claimType: "direct",
    identifier: ref.id, supportQuote: "a private\nquotation" }] }), { inputs: [ref] });
  await assert.rejects(f.service.raw("owner", "one", restrictedMatrix.versionId), { code: "result_input_restricted" }, "JSON-escaped restricted quotes also remain protected");
  const matrixRaw = await f.service.raw("owner", "one", matrix.versionId);
  assert.equal(matrixRaw.bytes.toString(), '{"claims":[]}');
});

test("immutable text and binary versions survive overwrite, rename and replay without dropping fan-out", async t => {
  const f = await fixture(t);
  const first = await f.capture("report.md", "original");
  const replay = await f.service.captureFile({ userId: "owner", project: f.project, relativePath: "report.md",
    producer: first.producer, expectedDigest: sha("original") });
  assert.equal(replay.versionId, first.versionId);
  const secondFile = await f.capture("values.bin", Buffer.from([0, 255, 1]));
  assert.notEqual(secondFile.versionId, first.versionId);
  assert.equal((await f.service.raw("owner", "one", secondFile.versionId)).bytes[1], 255);
  const next = await f.capture("report.md", "updated", { supersedesVersionId: first.versionId });
  assert.equal(next.artifactId, first.artifactId); assert.notEqual(next.versionId, first.versionId);
  await rename(path.join(f.project.workspaceDir, "report.md"), path.join(f.project.workspaceDir, "renamed.md"));
  const moved = await f.service.captureFile({ userId: "owner", project: f.project, relativePath: "renamed.md",
    producer: next.producer, expectedDigest: sha("updated"), supersedesVersionId: next.versionId });
  assert.notEqual(moved.artifactId, next.artifactId); assert.equal(moved.digest, next.digest);
  assert.equal((await f.service.raw("owner", "one", first.versionId)).bytes.toString(), "original");
  assert.equal((await f.service.list("owner", { projectId: "one", path: "report.md" })).items.length, 2);
  assert.equal((await f.service.list("owner", { projectId: "one", runId: "run" })).items.length, 4);
});

test("concurrent replay publishes one version and refuses mismatched producer bytes", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project.workspaceDir, "report.md"), "same");
  const input = { userId: "owner", project: f.project, relativePath: "report.md",
    producer: { kind: "tool", sessionId: "s", callId: "c" }, expectedDigest: sha("same") };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.captureFile(input)));
  assert.equal(new Set(results.map(item => item.versionId)).size, 1); assert.equal(f.records.size, 1);
  await writeFile(path.join(f.project.workspaceDir, "report.md"), "overwrite");
  await assert.rejects(f.service.captureFile(input), { code: "result_capture_changed" });
  assert.equal(f.records.size, 1);
  assert.equal((await f.service.raw("owner", "one", results[0].versionId)).bytes.toString(), "same");
});

test("child and fork outputs preserve actual session identity and unknown dependencies stay unknown", async t => {
  const f = await fixture(t);
  const parent = await f.capture("same.txt", "same");
  const child = await f.service.captureFile({ userId: "owner", project: f.project, relativePath: "same.txt",
    producer: { kind: "tool", sessionId: "child", parentSessionId: "session", runId: "run", callId: "call" } });
  const fork = await f.service.captureFile({ userId: "owner", project: f.project, relativePath: "same.txt",
    producer: { kind: "tool", sessionId: "fork", branchId: "branch", runId: "fork-run", callId: "call" } });
  assert.equal(new Set([parent.versionId, child.versionId, fork.versionId]).size, 3);
  assert.equal(child.producer.parentSessionId, "session"); assert.equal(fork.producer.branchId, "branch");
  assert.equal(child.coverage.producer, "observed"); assert.equal(child.coverage.inputs, "unknown");
  assert.ok(child.coverage.gaps.includes("environment_not_captured"));
  assert.equal(child.reuseEligibility.replay.status, "unavailable");
});

test("tenant, project, link, input and revocation boundaries apply to historical bytes", async t => {
  const f = await fixture(t);
  const first = await f.capture("report.md", "private", { inputs: [
    { kind: "source", id: "two:source", digest: sha("source"), availability: "captured", path: "private.txt" },
  ] });
  assert.equal(first.inputs[0].availability, "restricted"); assert.equal(first.inputs[0].path, null);
  await assert.rejects(f.service.get("stranger", "one", first.versionId), { code: "forbidden" });
  await assert.rejects(f.service.get("owner", "two", first.versionId), { code: "result_version_unavailable" });
  assert.equal((await f.service.get("collaborator", "one", first.versionId)).versionId, first.versionId);
  await symlink(path.join(f.projects.get("two").workspaceDir, "secret.txt"), path.join(f.project.workspaceDir, "link.txt"));
  await writeFile(path.join(f.projects.get("two").workspaceDir, "secret.txt"), "secret");
  await assert.rejects(f.service.captureFile({ userId: "owner", project: f.project, relativePath: "link.txt" }), { code: "path_forbidden" });
  await assert.rejects(f.service.captureFile({ userId: "owner", project: f.project, relativePath: "../two/secret.txt" }));
  f.revoke(); await assert.rejects(f.service.raw("owner", "one", first.versionId), { code: "forbidden" });
});

test("snapshot tampering and limits are visible, partial receipt outputs remain usable", async t => {
  const f = await fixture(t);
  const first = await f.capture("a.md", "one");
  await writeFile(path.join(f.project.metaDir, "result-snapshots", first.digest), "bad");
  await assert.rejects(f.service.raw("owner", "one", first.versionId), { code: "result_snapshot_changed" });
  f.service.maxSnapshotBytes = 2;
  await assert.rejects(f.capture("large.txt", "large"), { code: "result_snapshot_too_large" });
  f.service.maxSnapshotBytes = 100;
  await writeFile(path.join(f.project.workspaceDir, "b.md"), "two");
  const partial = await captureReceiptOutputs(f.service, { userId: "owner", project: f.project,
    producer: { kind: "deliverable", sessionId: "session", runId: "run", callId: "submit" } },
  [{ path: "b.md", sha256: sha("two") }, { path: "missing.md", sha256: sha("missing") }, { path: "no-receipt.md" }]);
  assert.equal(partial.items.length, 1); assert.equal(partial.failures.length, 2);
  assert.equal(partial.items[0].coverage.producer, "bound");
});

test("actual observed write/edit callbacks capture without browser authority and drain pending work", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project.workspaceDir, "first.md"), "first");
  await writeFile(path.join(f.project.workspaceDir, "second.md"), "second");
  const failures = [];
  const adapter = createResultProducerCapture({ service: f.service, runtimeWorkspaceRoot: () => "/workspace/project", onFailure: failure => failures.push(failure) });
  const call = (callId, file, content, tool = "write") => ({ sessionId: "child", parentSessionId: "parent",
    event: { type: "tool/call", callId, tool, seq: 1, input: { file_path: file, content } } });
  const result = callId => ({ sessionId: "child", parentSessionId: "parent", event: { type: "tool/result", callId, tool: "write", seq: 2, status: "completed" } });
  adapter.onRunEvent(f.project, "run", call("c1", "/workspace/project/first.md", "first"));
  adapter.onRunEvent(f.project, "run", result("c1"));
  adapter.onRunEvent(f.project, "run", call("c2", "second.md", null, "edit"));
  adapter.onRunEvent(f.project, "run", result("c2"));
  await adapter.drain();
  const versions = (await f.service.list("owner", { projectId: "one" })).items;
  assert.equal(versions.length, 2); assert.equal(failures.length, 0);
  assert.equal(versions.find(item => item.path === "first.md").coverage.producer, "bound");
  assert.equal(versions.find(item => item.path === "second.md").coverage.producer, "observed");
  assert.equal(versions[0].producer.parentSessionId, "parent");
  await writeFile(path.join(f.project.workspaceDir, "first.md"), "new");
  await adapter.observe(f.project, "run", call("c1", "first.md", "first"));
  await adapter.observe(f.project, "run", result("c1"));
  assert.equal(failures.at(-1).code, "result_capture_changed");
  assert.equal((await f.service.list("owner", { projectId: "one" })).items.length, 2);
});

test("read routes preserve exact raw bytes and leave revision/export actions to their existing composition", async t => {
  const f = await fixture(t); const first = await f.capture("report.md", "one");
  const routes = createResultProvenanceRoutes({ service: f.service, store: {
    ensureSessionUser: async () => ({ user: { id: "owner" } }), requireProject: async () => f.project,
  } });
  const reply = { status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  assert.equal(await routes({ method: "POST", url: `/api/results/${first.versionId}/revisions` }, reply), false);
  assert.equal(await routes({ method: "GET", url: `/api/results/${first.versionId}/export?projectId=one` }, reply), false);
  assert.equal(await routes({ method: "GET", url: `/api/results/${first.versionId}/raw?projectId=one` }, reply), true);
  assert.equal(reply.status, 200); assert.equal(reply.body.toString(), "one"); assert.equal(reply.headers.ETag, `"${sha("one")}"`);
  assert.equal((await readFile(path.join(f.project.workspaceDir, "report.md"))).toString(), "one");
});
