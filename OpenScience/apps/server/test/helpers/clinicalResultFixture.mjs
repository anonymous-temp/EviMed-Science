// A finished clinical-evidence run as the control plane holds it, for the tests of publishing a result as an evidence card:
// a project on disk, the preserved sources and the matrix, the delivery receipt, and the result versions the capture made —
// through the real capture (`captureResultDelivery`) and the real `ResultProvenanceService` over the in-memory documents
// double, so a version is exactly what a researcher's result page reads.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readDeliveryReceipt } from "../../src/agentRuns.mjs";
import { ResultProvenanceService } from "../../src/resultProvenanceService.mjs";
import { captureResultDelivery } from "../../src/resultDeliveryCapture.mjs";
import { productDocumentsDouble } from "./productDocumentsDouble.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

export const QUOTES = Object.freeze({
  A: "Among 100 adults on the drug, 7 had a stroke, against 12 of 100 on usual care.",
  B: "Major bleeding occurred in 3 of 100 on the drug and 1 of 100 on usual care.",
  R: "The restricted registry reported a private enrolment figure of 4,321 participants.",
});
const TEXTS = {
  A: `# Trial A\n\nIn this randomized trial, ${QUOTES.A} The trial was open-label.\n`,
  B: `# Trial B\n\nA second trial found that ${QUOTES.B}\n`,
  R: `# Registry R\n\n${QUOTES.R}\n`,
};

/**
 * @param {import("node:test").TestContext} t
 * @param {{ userId?: string, projectId?: string, runId?: string, claims?: string[], matrixExtra?: Record<string, any>, reportBody?: string, reportTitle?: string }} [options]
 *   `claims`: which of the fixture's claims the matrix holds (default all five). `unaddressed`: the sources (`A`, `B`, `R`) that are the
 *   researcher's own documents — cited with no public address and no DOI, only the preserved text. `oversize`: the sources whose preserved
 *   text is padded past what a card keeps whole. `CLM-006` (a second quotation of trial A) is in the matrix only when `claims` names it.
 */
export async function clinicalResultFixture(t, { userId = "alice", projectId = "p", runId = "run_one", claims = ["CLM-001", "CLM-002", "CLM-003", "CLM-004", "CLM-005"], matrixExtra = {}, reportBody = "Observed fewer strokes [1].\n", reportTitle = "Does the drug prevent stroke?", unaddressed = /** @type {string[]} */ ([]), oversize = /** @type {string[]} */ ([]) } = {}) {
  const root = await mkdtemp("/tmp/evimed-result-card-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { userId, id: projectId, rootDir: root, baseDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, "meta") };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  const documents = productDocumentsDouble();
  /** The identities the project may no longer read, set after the capture the way a changed authorization would be. */
  const access = { restricted: new Set() };
  const results = new ResultProvenanceService({
    documents,
    // Another account that names the project gets a project of its own with the same id; its ledger is not this one's.
    authorizeProject: async (asUser) => ({ ...project, userId: asUser }),
    authorizeReference: async (_user, _project, reference) => (access.restricted.has(reference.id) ? null
      : { ...reference, path: reference.path ?? null, availability: reference.digest ? "captured" : "reference" }),
  });

  const sources = {};
  for (const key of ["A", "B", "R"]) {
    const text = oversize.includes(key) ? `${TEXTS[key]}\n${"padding ".repeat(270_000)}\n` : TEXTS[key];
    const manifest = { "fulltext.md": sha(text) };
    const version = sha(JSON.stringify(manifest));
    const artifactPath = `.evimed-sources/trial-${key}/${version}/fulltext.md`;
    const directory = path.join(project.workspaceDir, path.dirname(artifactPath));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(project.workspaceDir, artifactPath), text);
    await writeFile(path.join(directory, "capture.json"), JSON.stringify({ schemaVersion: 1, version, artifacts: manifest }));
    sources[key] = { artifactPath, doi: `10.9999/trial-${key.toLowerCase()}`, digest: sha(text) };
  }
  const bond = (key, quote, extra = {}) => ({
    ...(unaddressed.includes(key)
      ? { sourceTitle: `Trial ${key}`, artifactPath: sources[key].artifactPath, identifier: `kb:src_${key.toLowerCase()}` }
      : { sourceUrl: `https://example.org/${key}`, sourceTitle: `Trial ${key}`, artifactPath: sources[key].artifactPath, identifier: sources[key].doi }),
    accessLevel: "full_text", supportQuote: quote, ...extra,
  });
  const all = [
    { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug in trial A.", ...bond("A", QUOTES.A),
      applicability: "Adults in trial A.", uncertainty: "Open-label." },
    // Not in its source: the run's gate marks it, and a card built from it would show ⚠.
    { claimId: "CLM-002", claimType: "direct", claim: "Stroke fell by half.", ...bond("A", "Stroke fell by half in every subgroup.") },
    { claimId: "CLM-003", claimType: "derived", claim: "About five fewer strokes per hundred over the trial.", derivedFrom: ["CLM-001"],
      method: "12 per 100 minus 7 per 100.", assumptions: "The two arms are comparable.", sensitivity: "Moves with the event counts." },
    { claimId: "CLM-004", claimType: "synthesized", claim: "Both trials point the same way on the balance of stroke and bleeding.", confidence: "moderate",
      supportingSources: [bond("A", QUOTES.A), bond("B", QUOTES.B)] },
    { claimId: "CLM-005", claimType: "direct", claim: "The registry holds a private enrolment figure.", ...bond("R", QUOTES.R) },
    { claimId: "CLM-006", claimType: "direct", claim: "Trial A was open-label.", ...bond("A", "The trial was open-label.") },
  ];
  const matrix = { questionPico: { population: "Adults at risk of stroke", intervention: "The drug", comparator: "Usual care", outcome: "Stroke" },
    claims: all.filter((claim) => claims.includes(claim.claimId)), ...matrixExtra };

  const run = { id: runId, sessionId: `session_${runId}`, effectiveAgentId: "clinical-evidence-synthesis", model: "deepseek/deepseek-v4-flash", qualityNotices: [] };
  const deliverable = "d1";
  const matrixPath = `deliverables/${deliverable}/clinical-evidence-matrix.json`;
  const reportPath = `deliverables/${deliverable}/clinical-evidence-report.md`;
  await mkdir(path.join(project.workspaceDir, "deliverables", deliverable), { recursive: true });

  /** Write the package for `run` (a report whose bytes change with `body`), capture it, and hand back the versions. */
  async function deliver({ body = reportBody, thisRun = run } = {}) {
    const outputs = [[matrixPath, JSON.stringify(matrix)], [reportPath, `# ${reportTitle}\n\n${body}`]];
    for (const [relativePath, text] of outputs) await writeFile(path.join(project.workspaceDir, relativePath), text);
    const receipt = { formatVersion: 1, runId: thisRun.id, bundleVersion: "1", domainVersion: "1", entries: [{ deliverableId: deliverable,
      contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", acceptedAt: "2026-10-02T00:00:00Z", attempt: 1, notices: [],
      files: outputs.map(([relativePath, text]) => ({ path: relativePath, sha256: sha(text), bytes: Buffer.byteLength(text) })) }] };
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify(receipt));
    const verified = await readDeliveryReceipt(project, thisRun);
    const captured = await captureResultDelivery({ results, project, run: thisRun, receipt: verified });
    return {
      report: captured.items.find((item) => item.path === reportPath), matrix: captured.items.find((item) => item.path === matrixPath),
      sources: captured.sourceItems, failures: captured.failures,
    };
  }
  /** A result that is not a clinical package: a plain file with no review. */
  async function capturePlain() {
    await writeFile(path.join(project.workspaceDir, "notes.txt"), "just notes");
    return results.captureFile({ userId, project, relativePath: "notes.txt", producer: { kind: "tool", runId: "run_plain", sessionId: "s" } });
  }
  return { root, project, documents, results, run, matrix, sources, access, deliver, capturePlain, matrixPath, reportPath };
}
