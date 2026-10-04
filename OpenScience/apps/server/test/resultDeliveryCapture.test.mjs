import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readDeliveryReceipt } from "../src/agentRuns.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { captureFinishedRun, captureResultDelivery, runFindingsOf } from "../src/resultDeliveryCapture.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const QUOTE = "The observed reduction was 20 percent in the selected study.";
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
    "MUST FIX — claims[0].claim numeric fact 6 is not present"] };
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

test("every version of a run shows the findings that run left, in the reader's words, whatever its receipt says", async t => {
  const f = await fixture(t);
  const runFindings = item => item.findings.filter(finding => finding.id.startsWith("run-finding-"));
  assert.deepEqual(runFindingsOf(f.run), [
    { id: "run-finding-0", kind: "run_partial_read", status: "advice", message: "部分子任务的记录无法读取：有一项检索没有完成，这一项结论只基于能读到的部分。" },
    { id: "run-finding-1", kind: "legacy_notice", status: "must-fix", message: "有一处依据需要核对：证据矩阵第 1 条结论" },
  ], "a legacy sentence is described in Chinese, not shown as the validator wrote it");

  const verified = await readDeliveryReceipt(f.project, f.run);
  const graded = await captureResultDelivery({ ...f, receipt: verified });
  assert.equal(graded.items.length, 2);
  for (const item of graded.items) {
    assert.deepEqual(runFindings(item).map(finding => [finding.id, finding.status]), [["run-finding-0", "advice"], ["run-finding-1", "must-fix"]], item.path);
    assert.ok(item.findings.every(finding => typeof finding.message === "string" && finding.message), item.path);
  }
  // The matrix's own claim findings keep to the report, beside the run's.
  const report = graded.items.find(item => item.path === f.reportPath);
  assert.deepEqual(report.findings.filter(finding => finding.elementId).map(finding => finding.elementId), ["CLM-001", "CLM-002", "CLM-003"]);
  // What the reader opens later is the stored version, not the capture's return value.
  const stored = await f.results.get("owner", "p", graded.items.find(item => item.path === f.matrixPath).versionId);
  assert.equal(runFindings(stored).length, 2);

  // Without a receipt, and for a run of another id: observed files carry them too.
  await rm(path.join(f.project.workspaceDir, "delivery-receipt.json"));
  const observed = await captureResultDelivery({ ...f, run: { ...f.run, id: "run-observed" }, receipt: null, files: [f.reportPath, f.matrixPath] });
  assert.equal(observed.items.length, 2);
  for (const item of observed.items) assert.equal(runFindings(item).length, 2, item.path);

  // A run that found nothing says nothing, and the old field name carries nothing.
  const quiet = await captureResultDelivery({ ...f, run: { id: "run-quiet", sessionId: "session", qualityFindings: [{ code: "x", message: "never read" }] }, receipt: null, files: [f.reportPath] });
  assert.deepEqual(runFindings(quiet.items[0]), []);
});
