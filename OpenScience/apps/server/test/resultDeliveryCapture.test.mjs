import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readDeliveryReceipt } from "../src/agentRuns.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { captureResultDelivery } from "../src/resultDeliveryCapture.mjs";
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
  const run = { id: "run", sessionId: "session", qualityFindings: [{ code: "partial_search", severity: "notice", message: "One search was unavailable." }] };
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
  assert.equal(reply.items.length, 1);
  assert.equal(reply.items[0].path, f.reportPath);
  assert.equal(reply.items[0].inputs.length, 0);
  assert.equal(reply.items[0].findings.some(item => item.elementId), false);
  assert.equal(reply.items[0].review.status, "unknown");
  assert.equal(reply.items[0].review.matrixText, null);
  assert.equal(reply.entries[0].metadata, "unavailable");
  assert.ok(reply.failures.some(item => item.code === "result_capture_changed"));
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
  assert.equal(reply.items.length, 1);
  assert.equal(reply.items[0].path, f.reportPath);
  assert.equal(reply.items[0].inputs.length, 0);
  assert.equal(reply.items[0].findings.some(item => item.elementId), false);
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
