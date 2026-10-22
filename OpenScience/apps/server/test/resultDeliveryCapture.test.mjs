import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readDeliveryReceipt } from "../src/agentRuns.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { captureFinishedRun, captureResultDelivery, runFindingsOf } from "../src/resultDeliveryCapture.mjs";
import { clinicalSafetyCautionNotice } from "../src/runNotices.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";
import { productPayload } from "../src/productPersistence.mjs";
import { ResultCaptureRepairService } from "../src/resultCaptureRepair.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const QUOTE = "The observed reduction was 20 percent in the selected study.";

test("a 196416-byte 87-claim matrix keeps sibling metadata under 256 KiB and freezes one review snapshot", async t => {
  const f = await fixture(t);
  const put = f.documents.put.bind(f.documents);
  f.documents.put = async (...args) => { productPayload(args[3]); return put(...args); };
  f.matrix.claims = Array.from({ length: 87 }, (_, index) => ({ ...f.matrix.claims[0], claimId: `CLM-${index + 1}` }));
  f.matrix.padding = "";
  f.matrix.padding = "x".repeat(196416 - Buffer.byteLength(JSON.stringify(f.matrix)));
  await f.writeOutputs();
  const outputs = [[f.reportPath, "r".repeat(82860)], ["deliverables/d1/research-agenda.json", JSON.stringify({ note: "a".repeat(65878) })]];
  for (const [relative, text] of outputs) {
    await writeFile(path.join(f.project.workspaceDir, relative), text);
    const entry = { path: relative, sha256: sha(text), bytes: Buffer.byteLength(text) };
    const at = f.receipt.entries[0].files.findIndex(file => file.path === relative);
    if (at >= 0) f.receipt.entries[0].files[at] = entry; else f.receipt.entries[0].files.push(entry);
  }
  const reply = await captureResultDelivery(f);
  assert.deepEqual(reply.failures, []);
  const report = reply.items.find(item => item.path === f.reportPath);
  assert.equal(report.review.verification.claims.length, 87);
  assert.deepEqual(JSON.parse(report.review.matrixText), f.matrix);
  const stored = await f.documents.get("owner", "result-version", report.versionId);
  assert.equal(stored.payload.review.matrixText, undefined);
  assert.equal(stored.payload.review.verification, undefined);
  assert.match(stored.payload.review.verificationSnapshot.digest, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(stored.payload)) < 262144);
  const revision = stored.revision;
  const replay = await captureResultDelivery(f);
  assert.deepEqual(replay.failures, []);
  assert.equal((await f.documents.get("owner", "result-version", report.versionId)).revision, revision);
  const snapshot = stored.payload.review.verificationSnapshot;
  await writeFile(path.join(f.project.metaDir, "result-snapshots", snapshot.digest), "corrupt");
  const corrupted = await f.results.get("owner", "p", report.versionId);
  assert.equal(corrupted.review.status, "unknown");
  assert.equal(corrupted.review.matrixText, null);
});

test("historical capture repair reuses the original matrix, freezes a labeled repair-time verdict and replays one generation", async t => {
  const f = await fixture(t);
  const initial = await captureResultDelivery(f);
  const matrix = initial.items.find(item => item.path === f.matrixPath);
  const report = initial.items.find(item => item.path === f.reportPath);
  // The old capture had saved its matrix and sources, but no report or durable review.
  f.documents.rows.delete(JSON.stringify(["owner", "result-version", report.versionId]));
  const original = await f.documents.get("owner", "result-version", matrix.versionId);
  await f.documents.put("owner", "result-version", matrix.versionId, { ...original.payload, review: null }, { projectId: "p", expectedRevision: original.revision });
  const run = { ...f.run, status: "succeeded", verification: "unverified", finishedAt: "2026-10-02T01:00:00Z" };
  const unchanged = structuredClone(run);
  let settlements = 0;
  const service = new ResultCaptureRepairService({ results: f.results, runs: { list: async () => [run] }, programme: { settleCaptureRepair: async () => { settlements += 1; return { state: "no_qualifying_claims" }; } } });
  const request = { userId: "owner", projectId: "p", runId: "run" };
  const before = f.documents.rows.size;
  const plan = await service.plan(request);
  assert.equal(f.documents.rows.size, before, "dry-run publishes nothing");
  await assert.rejects(service.apply({ ...request, expectedReceiptSha256: plan.receiptSha256, expectedPlanSha256: "0".repeat(64) }), { code: "result_capture_repair_plan_changed" });
  const input = { ...request, expectedReceiptSha256: plan.receiptSha256, expectedPlanSha256: plan.planSha256 };
  const applied = await service.apply(input);
  assert.equal(applied.receipt.matrixVersionId, matrix.versionId);
  const recovered = await f.results.get("owner", "p", report.versionId);
  assert.equal(recovered.review.verificationRecord.origin, "capture-repair");
  assert.equal(recovered.review.verificationRecord.verifierVersion, "claim-verification-v1");
  assert.deepEqual(run, unchanged);
  const revision = (await f.documents.get("owner", "result-version", matrix.versionId)).revision;
  f.results.now = () => new Date("2030-01-01T00:00:00Z");
  const replayPlan = await service.plan(request);
  assert.equal(replayPlan.planSha256, plan.planSha256);
  const replay = await service.apply(input);
  assert.equal(replay.receipt.generation, applied.receipt.generation);
  assert.equal((await f.documents.get("owner", "result-version", matrix.versionId)).revision, revision);
  assert.equal(settlements, 0, "settlement is explicit");
  await writeFile(path.join(f.project.workspaceDir, f.reportPath), "changed");
  await assert.rejects(service.apply(input), { code: "result_capture_changed" });
});

test("compact review reads reauthorize sources and projects, reject reference corruption and preserve a concurrent annotation", async t => {
  const f = await fixture(t);
  const first = await captureResultDelivery(f);
  const matrix = first.items.find(item => item.path === f.matrixPath);
  const report = first.items.find(item => item.path === f.reportPath);
  f.results.authorizeReference = async (_user, _project, ref) => ref.kind === "source" ? null : ref;
  assert.equal((await f.results.get("owner", "p", report.versionId)).review.status, "unavailable");
  assert.equal((await f.results.list("owner", { projectId: "p", runId: "run" })).items.find(item => item.versionId === report.versionId).review.verification, null);
  await assert.rejects(f.results.get("owner", "foreign", report.versionId), { code: "result_project_forbidden" });
  f.results.authorizeReference = async (_user, _project, ref) => ref;
  const original = await f.documents.get("owner", "result-version", matrix.versionId);
  const review = original.payload.review;
  await f.documents.put("owner", "result-version", matrix.versionId, { ...original.payload, review: null }, { projectId: "p", expectedRevision: original.revision });
  const put = f.documents.put.bind(f.documents);
  let raced = false;
  f.documents.put = async (...args) => {
    if (!raced && args[2] === matrix.versionId && args[3].review) {
      raced = true;
      const row = await f.documents.get("owner", "result-version", matrix.versionId);
      await put("owner", "result-version", matrix.versionId, { ...row.payload, concurrentAnnotation: "preserved" }, { projectId: "p", expectedRevision: row.revision });
      throw Object.assign(new Error("race"), { code: "product_revision_conflict" });
    }
    return put(...args);
  };
  await f.results.annotateReview("owner", f.project, await f.documents.get("owner", "result-version", matrix.versionId), review);
  const after = await f.documents.get("owner", "result-version", matrix.versionId);
  assert.equal(after.payload.concurrentAnnotation, "preserved");
  assert.equal(after.payload.digest, matrix.digest);
  assert.deepEqual(after.payload.producer, original.payload.producer);
  const bad = { ...review, verificationSnapshot: { ...review.verificationSnapshot, digest: "0".repeat(64) } };
  assert.equal((await f.results.readReview("owner", f.project, bad)).status, "unknown");
  const ref = review.verificationSnapshot;
  const snapshot = path.join(f.project.metaDir, "result-snapshots", ref.digest);
  await rm(snapshot);
  await symlink(path.join(f.project.workspaceDir, f.sourcePath), snapshot);
  assert.equal((await f.results.get("owner", "p", report.versionId)).review.status, "unknown");
});

test("capture-repair planning refuses a changed source, a linked output and another run's receipt before capture", async t => {
  for (const mode of ["source", "symlink", "foreign-run"]) {
    const f = await fixture(t);
    const run = { ...f.run, status: "succeeded" };
    const service = new ResultCaptureRepairService({ results: f.results, runs: { list: async () => [run] } });
    if (mode === "source") await writeFile(path.join(f.project.workspaceDir, f.sourcePath), "Changed source");
    if (mode === "symlink") { await rm(path.join(f.project.workspaceDir, f.reportPath)); await symlink(path.join(f.project.workspaceDir, f.matrixPath), path.join(f.project.workspaceDir, f.reportPath)); }
    if (mode === "foreign-run") await writeFile(path.join(f.project.workspaceDir, "delivery-receipt.json"), JSON.stringify({ ...f.receipt, runId: "foreign" }));
    await assert.rejects(service.plan({ userId: "owner", projectId: "p", runId: "run" }), { code: mode === "source" ? "result_source_capture_changed" : mode === "symlink" ? "path_forbidden" : "result_capture_receipt_invalid" });
    assert.equal(f.documents.rows.size, 0);
  }
});
async function fixture(t) {
  const root = await mkdtemp("/tmp/evimed-delivery-capture-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { userId: "owner", id: "p", rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const documents = productDocumentsDouble();
  const results = new ResultProvenanceService({ documents, authorizeProject: async userId => { assert.equal(userId, "owner"); return project; }, authorizeReference: async (_user, _project, ref) => ref });
  // As the ledger stores a finished run's findings: `qualityNotices`, each with the identity it was raised under.
  const run = { id: "run", sessionId: "session", qualityNotices: [
    { code: "run_partial_read", severity: "advice", text: "One search was unavailable.", detail: "有一项检索没有完成，这一项结论只基于能读到的部分。" },
    "MUST FIX — claims[0].claim numeric fact 6 is not present",
    clinicalSafetyCautionNotice({ ruleId: "aspirin-primary-prevention", titleZh: "阿司匹林一级预防：出血风险", messageZh: "老年人一级预防使用阿司匹林出血风险超过获益，应由医生评估。" })] };
  const sourceText = `# Study\n\n- DOI: 10.9999/paper\n\n${QUOTE}\n`;
  const sourceManifest = { "fulltext.md": sha(sourceText) };
  const sourceVersion = sha(JSON.stringify(sourceManifest));
  const sourcePath = `.evimed-sources/paper/${sourceVersion}/fulltext.md`;
  const sourceDir = path.dirname(path.join(project.workspaceDir, sourcePath));
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(project.workspaceDir, sourcePath), sourceText);
  await writeFile(path.join(sourceDir, "capture.json"), JSON.stringify({ schemaVersion: 1, version: sourceVersion, artifacts: sourceManifest }));
  const matrix = { claims: [
    { claimId: "CLM-001", claimType: "direct", identifier: "10.9999/paper", artifactPath: sourcePath, supportQuote: QUOTE, accessLevel: "full_text" },
    { claimId: "CLM-002", claimType: "derived", derivedFrom: ["CLM-001"] },
    { claimId: "CLM-003", claimType: "direct", identifier: "10.9999/abstract", accessLevel: "abstract_only", supportQuote: "Abstract statement." },
  ] };
  const matrixPath = "deliverables/d1/clinical-evidence-matrix.json";
  const reportPath = "deliverables/d1/clinical-evidence-report.md";
  await mkdir(path.join(project.workspaceDir, "deliverables/d1"), { recursive: true });
  const receipt = { formatVersion: 1, runId: run.id, bundleVersion: "1", domainVersion: "1", entries: [{ deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", acceptedAt: "2026-10-02T00:00:00Z", attempt: 1, notices: [], files: [] }] };
  const writeOutputs = async () => {
    const outputs = [[matrixPath, JSON.stringify(matrix)], [reportPath, "# Research result\n\nObserved reduction [1].\n"]];
    for (const [relativePath, text] of outputs) await writeFile(path.join(project.workspaceDir, relativePath), text);
    receipt.entries[0].files = outputs.map(([relativePath, text]) => ({ path: relativePath, sha256: sha(text), bytes: Buffer.byteLength(text) }));
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify(receipt));
  };
  await writeOutputs();
  return { documents, results, project, run, receipt, matrix, matrixPath, reportPath, sourcePath, sourceText, sourceDir, writeOutputs };
}

test("the server-verified receipt creates immutable report, matrix and preserved source versions with exact claim links", async t => {
  const f = await fixture(t);
  const verified = await readDeliveryReceipt(f.project, f.run);
  assert.ok(verified);
  const reply = await captureResultDelivery({ ...f, receipt: verified });
  assert.equal(reply.failures.length, 0);
  assert.equal(reply.items.length, 2);
  assert.equal(reply.sourceItems.length, 1);
  const report = reply.items.find(item => item.path === f.reportPath);
  const matrix = reply.items.find(item => item.path === f.matrixPath);
  const source = reply.sourceItems[0];
  assert.equal(report.review.status, "available");
  assert.equal(report.review.matrixVersionId, matrix.versionId);
  assert.equal(report.review.matrixDigest, matrix.digest);
  assert.deepEqual(JSON.parse(report.review.matrixText), f.matrix);
  assert.equal(report.review.verification.claims.find(claim => claim.claimId === "CLM-001").status, "verified");
  assert.equal(report.inputs.find(input => input.id === "10.9999/paper").versionId, source.versionId);
  assert.equal(report.inputs.find(input => input.id === matrix.artifactId).versionId, matrix.versionId);
  assert.equal(report.inputs.find(input => input.id === "10.9999/abstract").availability, "reference");
  assert.deepEqual(report.findings.filter(item => item.elementId).map(item => [item.elementId, item.status]), [["CLM-001", "verified"], ["CLM-002", "derived"], ["CLM-003", "no_quote"]]);
  await writeFile(path.join(f.project.workspaceDir, f.reportPath), "New report after edit");
  assert.match((await f.results.raw("owner", "p", report.versionId)).bytes.toString(), /Observed reduction/);
  const impacts = new ResultImpactService({ documents: f.documents, results: f.results });
  const changed = await impacts.reconcileSourceUpdate("owner", { projectId: "p", source: { id: "10.9999/paper", digest: sha(f.sourceText), versionId: source.versionId },
    status: { state: "changed", checkedAt: "2026-10-02T00:00:00Z", updates: [{ kind: "correction", noticeDoi: "10.9999/correction" }] } });
  assert.equal(changed.items.length, 2, "source update reaches both original report and its matrix");
  assert.ok(changed.items.every(item => item.payload.claimIds.includes("CLM-002")));
});

test("missing or changed source bytes remain explicit input gaps and keep usable reports", async t => {
  for (const mode of ["missing", "changed", "manifest_changed"]) {
    const f = await fixture(t);
    if (mode === "missing") await rm(path.join(f.project.workspaceDir, f.sourcePath));
    if (mode === "changed") await writeFile(path.join(f.project.workspaceDir, f.sourcePath), "Changed source");
    if (mode === "manifest_changed") await writeFile(path.join(f.sourceDir, "capture.json"), JSON.stringify({ version: path.basename(f.sourceDir), artifacts: { "fulltext.md": sha("Changed source") } }));
    const reply = await captureResultDelivery(f);
    assert.equal(reply.items.length, 2);
    assert.equal(reply.sourceItems.length, 0);
    assert.equal(reply.items.find(item => item.path === f.reportPath).inputs.find(input => input.id === "10.9999/paper").availability, "reference");
    assert.ok(reply.failures.some(item => item.path === f.sourcePath));
  }
});

test("a matrix changed after receipt verification cannot promote metadata into its preserved report", async t => {
  const f = await fixture(t);
  const verified = await readDeliveryReceipt(f.project, f.run);
  await writeFile(path.join(f.project.workspaceDir, f.matrixPath), JSON.stringify({ claims: [{ claimId: "CLM-999", identifier: "10.9999/invented" }] }));
  const reply = await captureResultDelivery({ ...f, receipt: verified });
  const report = reply.items.find(item => item.path === f.reportPath);
  assert.equal(report.inputs.length, 0);
  assert.equal(report.findings.some(item => item.elementId), false);
  assert.equal(report.review.status, "unknown");
  assert.equal(report.review.matrixText, null);
  assert.equal(reply.entries[0].metadata, "unavailable");
  assert.ok(reply.failures.some(item => item.code === "result_capture_changed"));
  // The changed matrix is still the file the run produced: it keeps a version,
  // as the bytes it is now, bound to nothing and carrying no claim metadata
  // (2026-10-04: a receipt labels a result, it does not hide one).
  const matrix = reply.items.find(item => item.path === f.matrixPath);
  assert.ok(matrix, "the changed matrix is captured as observed");
  assert.equal(matrix.coverage.producer, "observed");
  assert.ok(matrix.coverage.gaps.includes("producer_bytes_not_bound"));
  assert.equal(matrix.inputs.length, 0);
  assert.equal(matrix.findings.some(item => item.elementId), false);
  assert.deepEqual(reply.unbound, [f.matrixPath]);
  assert.equal(report.coverage.producer, "bound", "the report that still matches its receipt stays bound");
  assert.deepEqual((await f.results.raw("owner", "p", matrix.versionId)).bytes, await readFile(path.join(f.project.workspaceDir, f.matrixPath)));
});

test("a report changed after its receipt keeps a version as observed bytes, never bound to the receipt", async t => {
  const f = await fixture(t);
  const verified = await readDeliveryReceipt(f.project, f.run);
  await writeFile(path.join(f.project.workspaceDir, f.reportPath), "# Report edited after the gate accepted it\n");
  const reply = await captureResultDelivery({ ...f, receipt: verified });
  const report = reply.items.find(item => item.path === f.reportPath);
  assert.ok(report, "the edited report is captured");
  assert.equal(report.coverage.producer, "observed");
  assert.ok(report.coverage.gaps.includes("producer_bytes_not_bound"));
  assert.equal(report.review.status, "unknown", "the matrix's claim links are not promoted onto bytes the receipt did not vouch for");
  assert.equal(report.inputs.length, 0);
  assert.deepEqual(reply.unbound, [f.reportPath]);
  assert.equal(reply.items.find(item => item.path === f.matrixPath).coverage.producer, "bound", "the matrix that still matches is bound");
  assert.match((await f.results.raw("owner", "p", report.versionId)).bytes.toString(), /edited after the gate accepted it/);
});

test("a delivery with no receipt at all still gets a version for each file it left, observed and carrying no claim metadata", async t => {
  const f = await fixture(t);
  await rm(path.join(f.project.workspaceDir, "delivery-receipt.json"));
  assert.equal(await readDeliveryReceipt(f.project, f.run), null);
  await mkdir(path.join(f.project.workspaceDir, "deliverables/d2"), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, "deliverables/d2/notes.md"), "# Notes the run left\n");
  const files = [f.reportPath, f.matrixPath, "deliverables/d2/notes.md", "analysis/scratch.py", "../escape.md", f.reportPath];
  const reply = await captureResultDelivery({ ...f, receipt: null, files });
  assert.deepEqual(reply.failures, []);
  assert.deepEqual(reply.items.map(item => item.path).sort(), [f.matrixPath, f.reportPath, "deliverables/d2/notes.md"].sort(),
    "deliverable files only, each once: a scratch script and a path outside the layout are not results");
  for (const item of reply.items) {
    assert.equal(item.coverage.producer, "observed", item.path);
    assert.ok(item.coverage.gaps.includes("producer_bytes_not_bound"), item.path);
    assert.equal(item.inputs.length, 0, `${item.path}: no claim metadata is promoted from a matrix nothing graded`);
    assert.equal(item.review.status, "unknown", item.path);
    assert.equal(item.producer.kind, "deliverable");
    assert.equal(item.producer.runId, "run");
  }
  assert.deepEqual(reply.entries.map(entry => [entry.deliverableId, entry.metadata]).sort(), [["d1", "unavailable"], ["d2", "not_applicable"]]);
  assert.equal(reply.unbound.length, 3);
  assert.match((await f.results.raw("owner", "p", reply.items.find(item => item.path === "deliverables/d2/notes.md").versionId)).bytes.toString(), /Notes the run left/);
  // The same files again are the same versions: a replayed finish adds nothing.
  const replay = await captureResultDelivery({ ...f, receipt: null, files });
  assert.deepEqual(replay.items.map(item => item.versionId).sort(), reply.items.map(item => item.versionId).sort());
});

test("files of a deliverable the receipt does not vouch for are captured beside the ones it does, and a graded deliverable keeps to its receipt", async t => {
  const f = await fixture(t);
  const verified = await readDeliveryReceipt(f.project, f.run);
  await mkdir(path.join(f.project.workspaceDir, "deliverables/d2"), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, "deliverables/d2/second.md"), "# A second deliverable no gate accepted\n");
  await writeFile(path.join(f.project.workspaceDir, "deliverables/d1/scratch.txt"), "left in the graded package's directory\n");
  const reply = await captureResultDelivery({ ...f, receipt: verified,
    files: [f.reportPath, f.matrixPath, "deliverables/d1/scratch.txt", "deliverables/d2/second.md"] });
  assert.deepEqual(reply.failures, []);
  assert.deepEqual(reply.items.map(item => item.path).sort(), [f.matrixPath, f.reportPath, "deliverables/d2/second.md"].sort());
  assert.equal(reply.items.find(item => item.path === f.reportPath).coverage.producer, "bound");
  assert.equal(reply.items.find(item => item.path === "deliverables/d2/second.md").coverage.producer, "observed");
  assert.deepEqual(reply.unbound, ["deliverables/d2/second.md"]);
});

test("a source symlink and an unsafe matrix path never acquire capture authority", async t => {
  const f = await fixture(t);
  await rm(path.join(f.project.workspaceDir, f.sourcePath));
  await writeFile(path.join(f.project.metaDir, "secret.md"), f.sourceText);
  await symlink(path.join(f.project.metaDir, "secret.md"), path.join(f.project.workspaceDir, f.sourcePath));
  f.matrix.claims.push({ claimId: "CLM-004", claimType: "direct", artifactPath: "../../secret.md", identifier: "10.9999/private" });
  await f.writeOutputs();
  const reply = await captureResultDelivery(f);
  assert.equal(reply.sourceItems.length, 0);
  assert.equal(reply.items.length, 2);
  assert.ok(reply.failures.some(item => item.path === "../../secret.md"));
  assert.equal(reply.items.find(item => item.path === f.reportPath).inputs.find(item => item.id === "10.9999/private").path, null);
});

test("replayed delivery keeps one identity per output while an unrelated nonclinical binary remains usable", async t => {
  const f = await fixture(t);
  const first = await captureResultDelivery(f);
  const replay = await captureResultDelivery(f);
  assert.deepEqual(first.items.map(item => item.versionId), replay.items.map(item => item.versionId));
  const binaryPath = "deliverables/d2/values.bin";
  const binary = Buffer.from([0, 255, 42]);
  await mkdir(path.join(f.project.workspaceDir, "deliverables/d2"), { recursive: true });
  await writeFile(path.join(f.project.workspaceDir, binaryPath), binary);
  const other = await captureResultDelivery({ ...f, receipt: { entries: [{ deliverableId: "d2", files: [{ path: binaryPath, sha256: sha(binary), bytes: binary.length }] }] } });
  assert.equal(other.items.length, 1);
  assert.equal(other.items[0].inputs.length, 0);
  assert.equal(other.entries[0].metadata, "not_applicable");
  assert.deepEqual((await f.results.raw("owner", "p", other.items[0].versionId)).bytes, await readFile(path.join(f.project.workspaceDir, binaryPath)));
});

test("matrix overwrite during source capture leaves its sibling report without uncaptured metadata", async t => {
  const f = await fixture(t);
  const capture = f.results.captureFile.bind(f.results);
  f.results.captureFile = async input => {
    const result = await capture(input);
    if (input.relativePath === f.sourcePath) await writeFile(path.join(f.project.workspaceDir, f.matrixPath), "Changed after metadata read");
    return result;
  };
  const reply = await captureResultDelivery(f);
  assert.equal(reply.sourceItems.length, 1);
  // The overwritten matrix keeps a version of its own, as observed bytes; what
  // it must not do is lend the report any metadata it was not captured with.
  assert.equal(reply.items.length, 2);
  const report = reply.items.find(item => item.path === f.reportPath);
  assert.equal(report.inputs.length, 0);
  assert.equal(report.findings.some(item => item.elementId), false);
  assert.equal(reply.items.find(item => item.path === f.matrixPath).coverage.producer, "observed");
  assert.equal(reply.entries[0].metadata, "unavailable");
});

test("a partial parse keeps bytes and an unsupported quotation finding rather than claiming a clean source", async t => {
  const f = await fixture(t);
  f.matrix.claims[0].supportQuote = "The full-text result was not part of this partial parse.";
  await f.writeOutputs();
  const reply = await captureResultDelivery(f);
  assert.equal(reply.items.length, 2);
  const report = reply.items.find(item => item.path === f.reportPath);
  assert.equal(report.findings.find(item => item.elementId === "CLM-001").status, "quote_not_found");
  assert.equal(report.inputs.find(item => item.id === "10.9999/paper").availability, "captured");
});

test("a run that finishes with no receipt hands its listed files to capture, and one with nothing to hand over is not an error", async t => {
  const f = await fixture(t);
  await rm(path.join(f.project.workspaceDir, "delivery-receipt.json"));
  // The run as the ledger holds it once finished unverified: its files are its
  // artifacts, and no receipt came back for them.
  const finished = { ...f.run, status: "succeeded", verification: "unverified", artifacts: [f.reportPath, f.matrixPath], unverifiedArtifacts: [] };
  const reply = await captureFinishedRun({ results: f.results, project: f.project, run: finished, readReceipt: readDeliveryReceipt });
  assert.deepEqual(reply.items.map(item => item.path).sort(), [f.matrixPath, f.reportPath].sort());
  assert.ok(reply.items.every(item => item.coverage.producer === "observed"));
  // Files a failed or stopped run only recovered are listed apart, and are files all the same.
  const stopped = { ...f.run, id: "run-two", status: "failed", artifacts: [], unverifiedArtifacts: [f.reportPath] };
  const recovered = await captureFinishedRun({ results: f.results, project: f.project, run: stopped, readReceipt: readDeliveryReceipt });
  assert.deepEqual(recovered.items.map(item => item.path), [f.reportPath]);
  // Nothing to hand over: no receipt and no file.
  const empty = { ...f.run, id: "run-three", status: "failed", artifacts: [], unverifiedArtifacts: [] };
  assert.equal(await captureFinishedRun({ results: f.results, project: f.project, run: empty, readReceipt: readDeliveryReceipt }), null);
  // The platform's own background projects keep to what a receipt vouches for.
  const background = { ...f.run, id: "run-background", status: "succeeded", artifacts: [f.reportPath], unverifiedArtifacts: [] };
  assert.equal(await captureFinishedRun({ results: f.results, project: f.project, run: background, readReceipt: readDeliveryReceipt, unreceipted: false }), null);
  // A receipt that is there is read as before, and what it names stays bound.
  // Another run's, since a version's identity is the run, the path and the bytes:
  // the same run's files were just captured as observed.
  f.receipt.runId = "run-graded";
  await f.writeOutputs();
  const graded = { ...f.run, id: "run-graded", status: "succeeded", artifacts: [f.reportPath, f.matrixPath], unverifiedArtifacts: [] };
  const verified = await captureFinishedRun({ results: f.results, project: f.project, run: graded, readReceipt: readDeliveryReceipt });
  assert.ok(verified.items.every(item => item.coverage.producer === "bound"));
  assert.deepEqual(verified.unbound, []);
});

test("every version of a run carries the run's clinical-safety findings and its own claim marks, and not the run's machinery notices, whatever its receipt says", async t => {
  const f = await fixture(t);
  const runFindings = item => item.findings.filter(finding => finding.id.startsWith("run-finding-"));
  // The ledger keeps all three notices of the run (an operator reads them there); a version is handed the clinical-safety one only
  // (owner ruling 2026-10-10: the run's own notices are the back office's, a pharmacist's caution is content).
  assert.deepEqual(runFindingsOf(f.run), [
    { id: "run-finding-0", kind: "clinical_safety_caution", status: "safety", message: "阿司匹林一级预防：出血风险：老年人一级预防使用阿司匹林出血风险超过获益，应由医生评估。" },
  ]);
  assert.deepEqual(runFindingsOf({ qualityNotices: f.run.qualityNotices.slice(0, 2) }), [], "a run that left only machinery notices hands its versions none");

  const verified = await readDeliveryReceipt(f.project, f.run);
  const graded = await captureResultDelivery({ ...f, receipt: verified });
  assert.equal(graded.items.length, 2);
  for (const item of graded.items) {
    assert.deepEqual(runFindings(item).map(finding => [finding.id, finding.status]), [["run-finding-0", "safety"]], item.path);
    assert.ok(runFindings(item).every(finding => finding.message), "a run's finding is described in the reader's words");
    assert.ok(item.findings.filter(finding => finding.kind === "claim_source_binding").every(finding => finding.message === ""), "a claim's finding is its mark, with no sentence");
  }
  // The matrix's own claim findings keep to the report, beside the run's.
  const report = graded.items.find(item => item.path === f.reportPath);
  assert.deepEqual(report.findings.filter(finding => finding.elementId).map(finding => finding.elementId), ["CLM-001", "CLM-002", "CLM-003"]);
  // What the reader opens later is the stored version, not the capture's return value.
  const stored = await f.results.get("owner", "p", graded.items.find(item => item.path === f.matrixPath).versionId);
  assert.equal(runFindings(stored).length, 1);

  // Without a receipt, and for a run of another id: observed files carry them too.
  await rm(path.join(f.project.workspaceDir, "delivery-receipt.json"));
  const observed = await captureResultDelivery({ ...f, run: { ...f.run, id: "run-observed" }, receipt: null, files: [f.reportPath, f.matrixPath] });
  assert.equal(observed.items.length, 2);
  for (const item of observed.items) assert.equal(runFindings(item).length, 1, item.path);

  // A run that found nothing says nothing, and the old field name carries nothing.
  const quiet = await captureResultDelivery({ ...f, run: { id: "run-quiet", sessionId: "session", qualityFindings: [{ code: "x", message: "never read" }] }, receipt: null, files: [f.reportPath] });
  assert.deepEqual(runFindings(quiet.items[0]), []);
});
