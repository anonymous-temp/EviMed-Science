/** Join a verified delivery receipt to exact clinical matrix and source snapshots. */
import { createHash } from "node:crypto";
import path from "node:path";
import { claimEvidenceSources, claimVerification } from "@evimed/domain/clinical-evidence";
import { normalizeResultPath } from "@evimed/domain/result-provenance";
import { clinicalResultLinks } from "./resultImpact.mjs";
import { HttpError, openScopedFileNoFollow, readStableFileHandle, resolveScopedPath } from "./security.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_MATRIX_BYTES = 8 * 1024 * 1024;
const MAX_SOURCES = 48;

async function stableBytes(project, relativePath, limit) {
  let opened;
  try {
    const normalized = normalizeResultPath(relativePath);
    if (normalized !== relativePath) throw new HttpError(400, "result_capture_path_invalid", "An exact canonical artifact path is required.");
    opened = await openScopedFileNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, normalized));
    if (!opened.stat.isFile() || opened.stat.size > limit) throw new HttpError(413, "result_capture_metadata_too_large", "Artifact exceeds its metadata read allowance.");
    return await readStableFileHandle(opened.handle, opened.stat);
  } finally { await opened?.handle.close(); }
}

/** The existing preserving tool's content address binds its manifest; no manifest can rename changed bytes into this version. */
async function sourceCapture(project, relativePath, limit) {
  const normalized = normalizeResultPath(relativePath);
  if (normalized !== relativePath || !relativePath.startsWith(".evimed-sources/")) throw new HttpError(400, "result_source_path_invalid", "Only an exact preserved source path can become a captured input.");
  const directory = path.posix.dirname(relativePath);
  const manifestBytes = await stableBytes(project, `${directory}/capture.json`, 64 * 1024);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new HttpError(409, "result_source_capture_invalid", "Source capture manifest is unreadable."); }
  const hashes = manifest?.artifacts;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes) || !Object.keys(hashes).length || Object.keys(hashes).length > 100) {
    throw new HttpError(409, "result_source_capture_invalid", "Source capture manifest has no bounded artifact digests.");
  }
  const names = Object.keys(hashes).sort();
  if (names.some(name => path.posix.basename(name) !== name || [".", ".."].includes(name) || name.includes("\\") || !DIGEST.test(hashes[name]))) {
    throw new HttpError(409, "result_source_capture_invalid", "Source capture artifact identity is invalid.");
  }
  // Match Python's json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=True).
  const canonical = JSON.stringify(Object.fromEntries(names.map(name => [name, hashes[name]])))
    .replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const version = sha(canonical);
  if (path.posix.basename(directory) !== version || manifest.version !== version) throw new HttpError(409, "result_source_capture_invalid", "Source directory does not match its manifest version.");
  const expectedDigest = hashes[path.posix.basename(relativePath)];
  if (!DIGEST.test(expectedDigest ?? "")) throw new HttpError(409, "result_source_capture_invalid", "Source artifact is absent from its capture manifest.");
  const bytes = await stableBytes(project, relativePath, limit);
  if (sha(bytes) !== expectedDigest) throw new HttpError(409, "result_source_capture_changed", "Source bytes changed after preservation.");
  return { bytes, expectedDigest, version };
}

/**
 * Internal only. `receipt` has already passed readDeliveryReceipt; hashes are rechecked at publication.
 * Partial capture never withholds the delivered report. A failed matrix capture cannot promote its claims.
 * @param {{results:any,project:any,run:any,receipt:any}} input
 */
export async function captureResultDelivery({ results, project, run, receipt }) {
  const items = [];
  const sourceItems = [];
  const failures = [];
  const entries = [];
  const sourceCache = new Map();
  const fail = (relativePath, error) => failures.push({ path: relativePath, code: error?.code ?? "result_capture_failed" });
  for (const entry of receipt?.entries ?? []) {
    const producer = { kind: "deliverable", runId: run.id, sessionId: run.sessionId,
      eventId: String(entry.deliverableId), parentSessionId: run.parentSessionId ?? run.forkedFrom ?? null,
      branchId: run.branchId ?? (run.forkedFrom ? run.sessionId : null) };
    const recorded = entry.files ?? [];
    const matrixFile = recorded.find(file => path.posix.basename(file.path) === "clinical-evidence-matrix.json");
    let links = { inputs: [], findings: [] };
    let matrixVersion = null;
    let review = null;
    if (matrixFile) {
      try {
        const bytes = await stableBytes(project, matrixFile.path, MAX_MATRIX_BYTES);
        if (sha(bytes) !== matrixFile.sha256 || bytes.length !== matrixFile.bytes) throw new HttpError(409, "result_capture_changed", "Evidence matrix no longer matches its delivery receipt.");
        const matrix = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!Array.isArray(matrix?.claims) || matrix.claims.length > 500 || matrix.claims.some(claim => typeof claim?.claimId !== "string" || claim.claimId.length > 160)) {
          throw new HttpError(422, "result_capture_matrix_invalid", "Evidence matrix does not contain bounded identified claims.");
        }
        const paths = [...new Set(matrix.claims.flatMap(claim => claimEvidenceSources(claim).map(source => source?.artifactPath)).filter(Boolean))];
        const capturedSources = new Map();
        /** @type {Record<string, string>} */
        const sourceArtifacts = {};
        for (const relativePath of paths.slice(0, MAX_SOURCES)) {
          try {
            let captured = sourceCache.get(relativePath);
            if (!captured) {
              const source = await sourceCapture(project, relativePath, results.maxSnapshotBytes ?? 64 * 1024 * 1024);
              const version = await results.captureFile({ userId: project.userId, project, relativePath, expectedDigest: source.expectedDigest,
                producer: { kind: "workspace", eventId: `source-capture:${source.version}` } });
              let text = null;
              try { text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes); } catch { /* binary source bytes are preserved without a quotation verdict */ }
              captured = { version, text };
              sourceCache.set(relativePath, captured); sourceItems.push(version);
            }
            capturedSources.set(relativePath, { digest: captured.version.digest, versionId: captured.version.versionId });
            if (captured.text !== null) sourceArtifacts[relativePath] = captured.text;
          } catch (error) { fail(relativePath, error); }
        }
        if (paths.length > MAX_SOURCES) fail(matrixFile.path, { code: "result_source_capture_limit" });
        const verification = claimVerification({ matrix, sourceArtifacts });
        links = clinicalResultLinks(matrix, { capturedSources, verdict: verification });
        // Metadata bounds are advisory. The original matrix/report still get captured without an oversized join.
        if (links.inputs.length > 255 || Buffer.byteLength(JSON.stringify(links)) > 1024 * 1024) {
          throw new HttpError(413, "result_capture_metadata_too_large", "Clinical result links exceed their allowance.");
        }
        matrixVersion = await results.captureFile({ userId: project.userId, project, relativePath: matrixFile.path,
          producer, expectedDigest: matrixFile.sha256, ...links });
        review = { status: "available", matrixText: bytes.toString("utf8"), verification,
          matrixVersionId: matrixVersion.versionId, matrixDigest: matrixVersion.digest };
        items.push(matrixVersion);
      } catch (error) { fail(matrixFile.path, error); links = { inputs: [], findings: [] }; review = null; }
    }
    const capturedOutputs = [];
    for (const file of recorded) {
      if (matrixVersion && file.path === matrixFile.path) { capturedOutputs.push(matrixVersion); continue; }
      try {
        const input = { userId: project.userId, project, relativePath: file.path, producer, expectedDigest: file.sha256, review,
          inputs: [...links.inputs, ...(matrixVersion ? [{ kind: "artifact", id: matrixVersion.artifactId, digest: matrixVersion.digest,
            versionId: matrixVersion.versionId, path: matrixVersion.path, availability: "captured" }] : [])],
          findings: [...links.findings, ...(run.qualityFindings ?? []).map((finding, index) => ({
            id: `run-finding-${index}`, kind: finding.code ?? "run_finding", status: finding.severity ?? "notice", message: finding.message ?? finding.text ?? "",
          }))] };
        if (!DIGEST.test(file.sha256 ?? "")) throw new HttpError(409, "result_capture_receipt_invalid", "A delivery output must carry its exact byte digest.");
        const output = await results.captureFile(input);
        items.push(output); capturedOutputs.push(output);
      } catch (error) { fail(file.path, error); }
    }
    entries.push({ deliverableId: entry.deliverableId, versions: capturedOutputs, metadata: matrixVersion ? "clinical_links_captured" : matrixFile ? "unavailable" : "not_applicable" });
  }
  return { items, sourceItems, failures, entries };
}
