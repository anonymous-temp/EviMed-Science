/** Join a verified delivery receipt to exact clinical matrix and source snapshots. */
import { createHash } from "node:crypto";
import path from "node:path";
import { workspaceLayout } from "@evimed/domain";
import { claimEvidenceSources, claimVerification } from "@evimed/domain/clinical-evidence";
import { normalizeResultPath } from "@evimed/domain/result-provenance";
import { clinicalResultLinks } from "./resultImpact.mjs";
import { describedQualityNotices } from "./runNotices.mjs";
import { captureSkillResults, findSkillExecutions, readSkillExecution } from "./skillExecution.mjs";
import { HttpError, openScopedFileNoFollow, readStableFileHandle, resolveScopedPath } from "./security.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_MATRIX_BYTES = 8 * 1024 * 1024;
const MAX_SOURCES = 48;

/** One workspace file, read whole and checked not to have changed while it was read. Exported for the lineage view's render. */
export async function stableBytes(project, relativePath, limit) {
  let opened;
  try {
    const normalized = normalizeResultPath(relativePath);
    if (normalized !== relativePath) throw new HttpError(400, "result_capture_path_invalid", "An exact canonical artifact path is required.");
    opened = await openScopedFileNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, normalized));
    if (!opened.stat.isFile() || opened.stat.size > limit) throw new HttpError(413, "result_capture_metadata_too_large", "Artifact exceeds its metadata read allowance.");
    return await readStableFileHandle(opened.handle, opened.stat);
  } finally { await opened?.handle.close(); }
}

/** The existing preserving tool's content address binds its manifest; no manifest can rename changed bytes into this version.
 * Exported for source intake (`sourceIntakeHandoff.mjs`), which hands a preserved file to the knowledge base only
 * after this check has shown the bytes are the ones the tool preserved. */
export async function sourceCapture(project, relativePath, limit) {
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
 * The findings of the run that produced a result, as findings of that result.
 *
 * A finished run's ledger record carries them as `qualityNotices` — the gate's
 * `SAFETY — ` and `MUST FIX — ` findings and the platform's own notes, with the
 * identity each was raised under. This read `qualityFindings`, a name only the
 * in-flight completion outcome uses and a stored run never has, so a version
 * never showed what its run had found about it. Each is described in the
 * reader's Chinese (`describedQualityNotices`, the same table the inbox and the
 * run page use) and keeps its severity as its status; none is tied to a claim of
 * the matrix, because a run-level finding is not a verdict on one.
 * @param {{ qualityNotices?: unknown }} run
 * @returns {{ id: string, kind: string, status: string, message: string }[]}
 */
export function runFindingsOf(run) {
  return describedQualityNotices(run?.qualityNotices).map((notice, index) => ({
    id: `run-finding-${index}`, kind: notice.code, status: notice.severity,
    message: notice.detail ? `${notice.title}：${notice.detail}` : (notice.title || notice.text),
  }));
}

/**
 * The files of every deliverable the run left that its receipt holds no entry
 * for, grouped by deliverable, as entries that carry no digest — there is
 * nothing they were graded against, and the version they get says so
 * (`producer: observed`, the gap `producer_bytes_not_bound`: the existing
 * vocabulary for exactly this). A deliverable the receipt does vouch for keeps
 * to the files it names.
 *
 * Only `deliverables/<id>/…`: the layout the platform writes a package into.
 * @param {readonly string[]} files @param {any} receipt
 * @returns {{ deliverableId: string, unbound: true, files: { path: string }[] }[]}
 */
function unreceiptedEntries(files, receipt) {
  const graded = new Set((receipt?.entries ?? []).map(entry => String(entry.deliverableId)));
  const prefix = `${workspaceLayout.deliverablesDir}/`;
  /** @type {Map<string, string[]>} */
  const byDeliverable = new Map();
  for (const file of new Set(files)) {
    if (typeof file !== "string" || !file.startsWith(prefix)) continue;
    const [id, ...rest] = file.slice(prefix.length).split("/");
    if (!id || id === "." || id === ".." || !rest.length || rest.some(part => !part) || graded.has(id)) continue;
    byDeliverable.set(id, [...(byDeliverable.get(id) ?? []), file]);
  }
  return [...byDeliverable].map(([deliverableId, paths]) => ({ deliverableId, unbound: /** @type {const} */ (true), files: paths.map(file => ({ path: file })) }));
}

/**
 * Internal only. `receipt` has already passed readDeliveryReceipt; hashes are rechecked at publication.
 * Partial capture never withholds the delivered report. A failed matrix capture cannot promote its claims.
 *
 * A receipt is our own record of what was graded, and it labels a result; it does
 * not decide whether there is one (2026-10-04). Every deliverable file the run
 * left — `files`, whether or not the receipt names it — gets a version, so what
 * a researcher was handed can be inspected, revised, replayed and exported. A
 * file with no receipt behind it, or one that changed after its receipt, is
 * captured as observed: its bytes are exact, its producer is not bound to them,
 * and no claim metadata is promoted from a matrix nothing graded.
 *
 * A results file an admitted skill script's execution record accounts for
 * (`skillExecution.mjs`) is captured with that record as its producer snapshot
 * — the script, the inputs, the reported environment, each re-checked against
 * the bytes readable now — and before its siblings, so a report captured beside
 * it can bind its numbers to it. `transformationsFor` joins the script to the
 * dataset transformations N03 recorded for it.
 * @param {{results:any,project:any,run:any,receipt?:any,files?:readonly string[],transformationsFor?:((digests:string[])=>Promise<any[]>)|null}} input
 */
export async function captureResultDelivery({ results, project, run, receipt = null, files = [], transformationsFor = null }) {
  const items = [];
  const sourceItems = [];
  const failures = [];
  const entries = [];
  /** Paths captured without a receipt digest behind them. @type {string[]} */
  const unbound = [];
  const sourceCache = new Map();
  const findings = runFindingsOf(run);
  const fail = (relativePath, error) => failures.push({ path: relativePath, code: error?.code ?? "result_capture_failed" });
  for (const entry of [...(receipt?.entries ?? []), ...unreceiptedEntries(files, receipt)]) {
    const graded = entry.unbound !== true;
    const producer = { kind: "deliverable", runId: run.id, sessionId: run.sessionId,
      eventId: String(entry.deliverableId), parentSessionId: run.parentSessionId ?? run.forkedFrom ?? null,
      branchId: run.branchId ?? (run.forkedFrom ? run.sessionId : null) };
    const recorded = entry.files ?? [];
    const matrixFile = recorded.find(file => path.posix.basename(file.path) === "clinical-evidence-matrix.json");
    let links = { inputs: [], findings: [] };
    let matrixVersion = null;
    let review = null;
    if (matrixFile && graded) {
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
          producer, expectedDigest: matrixFile.sha256, ...links, findings: [...links.findings, ...findings] });
        review = { status: "available", matrixText: bytes.toString("utf8"), verification,
          matrixVersionId: matrixVersion.versionId, matrixDigest: matrixVersion.digest };
        items.push(matrixVersion);
      } catch (error) { fail(matrixFile.path, error); links = { inputs: [], findings: [] }; review = null; }
    }
    const capturedOutputs = [];
    // Results an admitted skill script's execution record accounts for, found by the record's shape and the bytes it names.
    const readBytes = (/** @type {string} */ relativePath, /** @type {number} */ limit) => stableBytes(project, relativePath, limit);
    /** @type {Map<string, any>} */
    const executions = new Map();
    try {
      for (const pair of await findSkillExecutions({ paths: recorded.map(file => file.path), readBytes })) {
        if (executions.has(pair.resultsPath)) continue;
        const read = await readSkillExecution({ results, project, userId: project.userId, ...pair, readBytes, transformationsFor });
        if (read.status === "recorded") executions.set(pair.resultsPath, read);
      }
    } catch { /* An execution record that cannot be read leaves the files as they would have been. */ }
    const lineageOf = (/** @type {string} */ relativePath) => {
      const found = executions.get(relativePath);
      return found ? { snapshot: found.snapshot, code: found.code, machineValues: found.machineValues } : {};
    };
    // The calculation first, so its siblings can bind their numbers to it.
    const ordered = [...recorded].sort((left, right) => Number(executions.has(right.path)) - Number(executions.has(left.path)));
    for (const file of ordered) {
      if (matrixVersion && file.path === matrixFile.path) { capturedOutputs.push(matrixVersion); continue; }
      try {
        const input = { userId: project.userId, project, relativePath: file.path, producer, expectedDigest: file.sha256, review,
          inputs: [...links.inputs, ...(matrixVersion ? [{ kind: "artifact", id: matrixVersion.artifactId, digest: matrixVersion.digest,
            versionId: matrixVersion.versionId, path: matrixVersion.path, availability: "captured" }] : []), ...(executions.get(file.path)?.inputs ?? [])],
          findings: [...links.findings, ...findings], ...lineageOf(file.path) };
        let output;
        if (graded) {
          if (!DIGEST.test(file.sha256 ?? "")) throw new HttpError(409, "result_capture_receipt_invalid", "A delivery output must carry its exact byte digest.");
          try { output = await results.captureFile(input); }
          catch (error) {
            if (error?.code !== "result_capture_changed") throw error;
            // Changed after its receipt: still the file the run produced. It
            // is captured as the bytes it is now, with nothing the receipt
            // vouched for — no digest binding, no claim links, no review.
            output = await results.captureFile({ userId: project.userId, project, relativePath: file.path, producer, findings,
              inputs: executions.get(file.path)?.inputs ?? [], ...lineageOf(file.path) });
            unbound.push(file.path);
          }
        } else {
          output = await results.captureFile({ userId: project.userId, project, relativePath: file.path, producer, findings,
            inputs: executions.get(file.path)?.inputs ?? [], ...lineageOf(file.path) });
          unbound.push(file.path);
        }
        items.push(output); capturedOutputs.push(output);
      } catch (error) { fail(file.path, error); }
    }
    entries.push({ deliverableId: entry.deliverableId, versions: capturedOutputs, metadata: matrixVersion ? "clinical_links_captured" : matrixFile ? "unavailable" : "not_applicable" });
  }
  return { items, sourceItems, failures, entries, unbound };
}

/**
 * What a finished run hands to capture: its receipt when it left a valid one,
 * and every deliverable file it listed, graded or not. Nothing to capture is
 * `null`; a run that left neither a receipt nor a file is not an error.
 *
 * `unreceipted` is off for the platform's own background projects, whose runs
 * are jobs rather than something a researcher was handed: what they got
 * captured before — the files a receipt vouches for — is all they get.
 * @param {{results:any,project:any,run:any,readReceipt:(project:any, run:any)=>Promise<any>,unreceipted?:boolean,transformationsFor?:((digests:string[])=>Promise<any[]>)|null}} input
 */
export async function captureFinishedRun({ results, project, run, readReceipt, unreceipted = true, transformationsFor = null }) {
  const receipt = await readReceipt(project, run);
  const files = unreceipted ? [...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])] : [];
  if (!receipt && files.length === 0) return null;
  // Results a script left outside the deliverable layout (a statistical package at the workspace root) are preserved as
  // the run's calculations first; those inside it are captured with their deliverable, below.
  const readBytes = (/** @type {string} */ relativePath, /** @type {number} */ limit) => stableBytes(project, relativePath, limit);
  const prefix = `${workspaceLayout.deliverablesDir}/`;
  const failures = [];
  try {
    for (const pair of await findSkillExecutions({ paths: files, readBytes })) {
      if (pair.resultsPath.startsWith(prefix)) continue;
      const captured = await captureSkillResults({ results, project, userId: project.userId, ...pair, readBytes, transformationsFor,
        producer: { sessionId: run.sessionId, runId: run.id, parentSessionId: run.parentSessionId ?? run.forkedFrom ?? null,
          branchId: run.branchId ?? (run.forkedFrom ? run.sessionId : null) } }).catch((/** @type {any} */ error) => ({ status: "unavailable", reason: error?.code ?? "result_capture_failed" }));
      if (captured.status === "unavailable") failures.push({ path: pair.resultsPath, code: "result_skill_execution_unavailable" });
    }
  } catch { /* An execution record that cannot be read leaves the files as they would have been. */ }
  const delivered = await captureResultDelivery({ results, project, run, receipt, files, transformationsFor });
  // Reports written while the run was still working were captured before its calculations existed.
  try { await results.rebindRun?.(project.userId, project, run.id); } catch { /* the labels stay as they were captured */ }
  return failures.length ? { ...delivered, failures: [...delivered.failures, ...failures] } : delivered;
}
