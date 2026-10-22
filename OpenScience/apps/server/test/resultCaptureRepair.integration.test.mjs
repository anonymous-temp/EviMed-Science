import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { claimVerification } from "@evimed/domain/clinical-evidence";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { loadConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultCaptureRepairService } from "../src/resultCaptureRepair.mjs";
import { clinicalResultLinks } from "../src/resultImpact.mjs";
import { withAccountExportSnapshot } from "../src/accountExport.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl && "local PostgreSQL required", timeout: 30000 };
const sha = value => createHash("sha256").update(value).digest("hex");

test("PostgreSQL preserves one oversized-package capture repair generation across jsonb reads and replay", options, async t => {
  const isolated = await createGeoTestDatabase(databaseUrl, "capturerepair");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "result-capture-repair-"));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: "postgres", devAuth: true, maxProjectBytes: 32 * 1024 * 1024 });
  const store = new PostgresStore(config);
  t.after(async () => { await store.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await store.devUser();
  const project = await store.requireProject(user, "default");
  const documents = new ProductDocuments(store.database);
  const results = new ResultProvenanceService({ documents, config,
    authorizeProject: async (actor, id) => store.requireProject(await store.userById(actor), id), authorizeReference: async (_actor, _project, ref) => ref });
  const put = async (relative, bytes) => { await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true }); await writeFile(path.join(project.workspaceDir, relative), bytes); };
  const quote = "The preserved source reports the selected study result.";
  const manifest = { "fulltext.md": sha(quote) };
  const sourceVersion = sha(JSON.stringify(manifest));
  const sourcePath = `.evimed-sources/study/${sourceVersion}/fulltext.md`;
  await put(sourcePath, quote);
  await put(path.posix.join(path.posix.dirname(sourcePath), "capture.json"), JSON.stringify({ schemaVersion: 1, version: sourceVersion, artifacts: manifest }));
  const source = await results.captureFile({ userId: user.id, project, relativePath: sourcePath, expectedDigest: sha(quote), producer: { kind: "workspace", eventId: `source-capture:${sourceVersion}` } });
  const matrix = { claims: Array.from({ length: 87 }, (_, index) => ({ claimId: `CLM-${index}`, claimType: "direct", identifier: "10.9999/test",
    artifactPath: sourcePath, supportQuote: quote, accessLevel: "full_text" })), padding: "" };
  matrix.padding = "x".repeat(196416 - Buffer.byteLength(JSON.stringify(matrix)));
  const matrixPath = "deliverables/d1/clinical-evidence-matrix.json";
  const reportPath = "deliverables/d1/clinical-evidence-report.md";
  const agendaPath = "deliverables/d1/research-agenda.json";
  const outputs = [[matrixPath, JSON.stringify(matrix)], [reportPath, "r".repeat(82860)], [agendaPath, JSON.stringify({ note: "a".repeat(65878) })]];
  for (const [relative, bytes] of outputs) await put(relative, bytes);
  const run = { id: "run-original", sessionId: "session-original", status: "succeeded", verification: "unverified", qualityNotices: ["Original notice"] };
  const links = clinicalResultLinks(matrix, { verdict: claimVerification({ matrix, sourceArtifacts: { [sourcePath]: quote } }),
    capturedSources: new Map([[sourcePath, { digest: source.digest, versionId: source.versionId }]]) });
  const original = await results.captureFile({ userId: user.id, project, relativePath: matrixPath, expectedDigest: sha(outputs[0][1]),
    producer: { kind: "deliverable", runId: run.id, sessionId: run.sessionId, eventId: "d1" }, ...links });
  await put("delivery-receipt.json", JSON.stringify({ formatVersion: 1, runId: run.id, bundleVersion: "1", domainVersion: "1", entries: [{
    deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", acceptedAt: "2026-10-02T00:00:00Z", attempt: 1, notices: [],
    files: outputs.map(([relative, bytes]) => ({ path: relative, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) })) }] }));
  const repair = new ResultCaptureRepairService({ results, runs: { list: async () => [run] } });
  const request = { userId: user.id, projectId: project.id, runId: run.id };
  const plan = await repair.plan(request);
  const input = { ...request, expectedReceiptSha256: plan.receiptSha256, expectedPlanSha256: plan.planSha256 };
  const first = await repair.apply(input);
  assert.equal(first.receipt.matrixVersionId, original.versionId);
  const captured = await results.list(user.id, { projectId: project.id, runId: run.id });
  assert.equal(captured.items.length, 3);
  for (const item of captured.items) {
    assert.equal(item.review.status, "available");
    assert.equal(item.review.verification.claims.length, 87);
    const row = await documents.get(user.id, "result-version", item.versionId);
    assert.ok(Buffer.byteLength(JSON.stringify(row.payload)) < 262144);
    assert.equal(row.payload.review.matrixText, undefined);
  }
  const revision = (await documents.get(user.id, "result-version", original.versionId)).revision;
  const replay = await repair.apply(input);
  assert.equal(replay.receipt.generation, first.receipt.generation);
  assert.equal((await documents.get(user.id, "result-version", original.versionId)).revision, revision);
  assert.equal(run.verification, "unverified");
  assert.deepEqual(run.qualityNotices, ["Original notice"]);
  // The account archive remains portable: compact and historical inline reviews both leave as authorized inline content.
  const frozen = captured.items.find(item => item.path === reportPath).review;
  await put("legacy.md", "Legacy report");
  const legacy = await results.captureFile({ userId: user.id, project, relativePath: "legacy.md", producer: { kind: "deliverable", runId: "legacy", eventId: "legacy" },
    review: { status: "available", matrixVersionId: original.versionId, matrixDigest: original.digest, matrixText: JSON.stringify(matrix), verification: frozen.verification } });
  await documents.put(user.id, "fact", "usable", { content: "usable account fact" }, { projectId: project.id, expectedRevision: 0 });
  const generation = (await store.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [user.id])).rows[0].generation;
  const actor = { ...user, accountCreatedAt: generation };
  const archive = () => withAccountExportSnapshot(store.database, actor, config, async snapshot => JSON.parse(snapshot.data.toString()), {
    report: () => {}, readResultReview: async (account, row) => (await results.project(account.id, await results.scope(account.id, row.projectId), row.payload)).review });
  const exported = await archive();
  for (const selected of [first.versions.find(item => item.path === reportPath).versionId, legacy.versionId]) {
    const review = exported.documents.find(row => row.id === selected).payload.review;
    assert.equal(review.status, "available");
    assert.equal(JSON.parse(review.matrixText).claims.length, 87);
    assert.equal(review.verification.claims.length, 87);
    assert.equal(review.verificationSnapshot, undefined);
  }
  const held = (await documents.get(user.id, "result-version", original.versionId)).payload.review.verificationSnapshot;
  const snapshotPath = path.join(project.metaDir, "result-snapshots", held.digest);
  const verificationBytes = await readFile(snapshotPath);
  for (const mode of ["missing", "corrupt", "revoked"]) {
    if (mode === "missing") await rm(snapshotPath);
    if (mode === "corrupt") await writeFile(snapshotPath, "corrupt");
    if (mode === "revoked") results.authorizeReference = async (_account, _project, ref) => ref.kind === "source" ? null : ref;
    const partial = await archive();
    const review = partial.documents.find(row => row.id === first.versions.find(item => item.path === reportPath).versionId).payload.review;
    assert.equal(review.status, mode === "revoked" ? "unavailable" : "unknown");
    assert.equal(review.matrixText, null);
    assert.equal(review.verificationSnapshot, undefined);
    assert.ok(partial.omissions.some(entry => entry.reason === "review_unavailable" && entry.documents >= 3));
    assert.equal(partial.documents.find(row => row.kind === "fact").payload.content, "usable account fact");
    await writeFile(snapshotPath, verificationBytes);
  }
});
