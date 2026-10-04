/**
 * The execution record of an admitted skill script, read as a producer snapshot.
 *
 * `statistical-analysis` ships `scripts/run_analysis.py`: it runs the researcher's
 * Python or R script, and writes beside the results file a receipt of what it
 * ran — the script, each input and transform with their sha-256, the interpreter
 * and every installed library with its version, the exit status and whether the
 * sources stayed unchanged. That receipt is a file in the runtime's workspace, so
 * the platform does not take it on trust; it re-reads every file the receipt
 * names and records, per item, whether the bytes it can read now are the bytes
 * the receipt says. What the receipt states and the platform could confirm is
 * `verified`; what it states and the platform could not is recorded as stated
 * and never as measured (plan 2026-10-02 §11.3 N06).
 *
 * Hidden knowledge:
 *
 * - **The receipt is matched to the file, not to a name.** The execution that
 *   produced a results file is the last one whose recorded output (`after`)
 *   carries that path and the sha-256 of the bytes the platform holds. A results
 *   file the receipt does not account for gets no skill snapshot: it stays
 *   whatever it was, and this says why.
 * - **Preserved inputs are bounded.** An input is captured as an immutable
 *   version only up to a size (`inputLimit`); a larger one is recorded with the
 *   digest the receipt gives and is not copied. A missing input is an unverified
 *   reference, never a refusal.
 * - **A script's other reads stay unknown.** The helper declares the inputs it
 *   was told about; a script may read anything else its process can reach, and
 *   `undeclared_dependencies` stays on the snapshot.
 * - **Nothing here refuses a result.** Every failure answers `unavailable` with
 *   its reason, and the caller carries on with the file as it was.
 */
import { replayDigest } from "./resultReplayClient.mjs";
import { normalizeResultPath } from "@evimed/domain/result-provenance";
import { flattenMachineValues, skillScriptSnapshot } from "@evimed/domain";
import { createHash } from "node:crypto";

const sha = (/** @type {Buffer | string} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_RESULTS_BYTES = 8 * 1024 * 1024;
/** Files one execution names that are looked at: a receipt that lists more is read for the first of each kind. */
const MAX_FILES = 24;

/** @param {unknown} value @returns {value is Record<string, any>} */
const record = (value) => value != null && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value @returns {string | null} */
function workspacePath(value) {
  try { return typeof value === "string" ? normalizeResultPath(value) : null; } catch { return null; }
}

/** The kind of interpreter by the script's file type, which the receipt's own `--interpreter` choice also decides. @param {string} path */
function interpreterOf(path) {
  const lower = path.toLowerCase();
  return lower.endsWith(".r") ? "r" : lower.endsWith(".py") ? "python" : null;
}

/**
 * @param {{ results: any, project: any, userId: string, receiptPath: string, resultsPath: string,
 *   readBytes: (relativePath: string, limit: number) => Promise<Buffer>,
 *   transformationsFor?: ((digests: string[]) => Promise<any[]>) | null, inputLimit?: number, now?: () => string }} input
 * @returns {Promise<{ status: "recorded", snapshot: any, code: any, inputs: any[], machineValues: any[], truncated: boolean, digest: string }
 *   | { status: "unavailable", reason: string }>}
 */
export async function readSkillExecution({ results, project, userId, receiptPath, resultsPath, readBytes, transformationsFor = null, inputLimit = 8 * 1024 * 1024 }) {
  /** @param {string} reason @returns {{ status: "unavailable", reason: string }} */
  const unavailable = (reason) => ({ status: "unavailable", reason });
  let receipt;
  let resultsBytes;
  try {
    receipt = JSON.parse((await readBytes(receiptPath, MAX_RECEIPT_BYTES)).toString("utf8"));
    resultsBytes = await readBytes(resultsPath, MAX_RESULTS_BYTES);
  } catch { return unavailable("receipt_or_results_unreadable"); }
  if (!record(receipt) || receipt.schemaVersion !== 1 || !Array.isArray(receipt.executions)) return unavailable("not_an_execution_record");
  const resultsDigest = sha(resultsBytes);
  const execution = [...receipt.executions].reverse().find((candidate) => record(candidate) && record(candidate.output)
    && candidate.output.observedWrite === true && record(candidate.output.after)
    && workspacePath(candidate.output.after.path) === resultsPath && candidate.output.after.sha256 === resultsDigest);
  if (!execution) return unavailable("no_execution_produced_these_bytes");

  /** What the receipt names, confirmed against the bytes readable now. @param {unknown} entry @param {number} limit */
  const check = async (entry, limit) => {
    const path = record(entry) ? workspacePath(entry.path) : null;
    const declared = record(entry) && HASH.test(String(entry.sha256)) ? String(entry.sha256) : null;
    if (!path || !declared) return null;
    try {
      const bytes = await readBytes(path, limit);
      return { path, digest: declared, bytes, verified: sha(bytes) === declared };
    } catch { return { path, digest: declared, bytes: null, verified: false }; }
  };

  const script = await check(execution.script, MAX_SCRIPT_BYTES);
  if (!script) return unavailable("script_not_named");
  const named = [...(Array.isArray(execution.inputs) ? execution.inputs : []), ...(Array.isArray(execution.transforms) ? execution.transforms : [])].slice(0, MAX_FILES);
  const checked = (await Promise.all(named.map((entry) => check(entry, inputLimit)))).filter((entry) => entry !== null);

  /** Preserve what the platform confirmed, as workspace versions bound to the digest the receipt states.
   * @param {{ path: string, digest: string, bytes: Buffer | null, verified: boolean }} file @param {string} event */
  const preserve = async (file, event) => {
    if (!file.verified || !file.bytes) return null;
    try {
      return await results.captureFile({ userId, project, relativePath: file.path, expectedDigest: file.digest, producer: { kind: "workspace", eventId: `${event}:${file.digest}` } });
    } catch { return null; }
  };
  const scriptVersion = await preserve(script, "skill-script");
  const inputs = [];
  for (const file of checked) {
    const version = await preserve(file, "skill-input");
    inputs.push({ kind: "data", id: file.path, path: file.path, digest: file.digest, versionId: version?.versionId ?? null,
      availability: version ? "captured" : "reference" });
  }
  const versions = record(execution.versions) ? execution.versions : {};
  const libraries = record(versions.libraries) ? versions.libraries : {};
  const interpreterLine = typeof versions.interpreter === "string" ? versions.interpreter.split("\n")[0].slice(0, 200) : null;
  const reported = interpreterLine !== null || Object.keys(libraries).length > 0;
  let transformations = [];
  if (transformationsFor) {
    try { transformations = await transformationsFor([script.digest, ...checked.map((file) => file.digest)]); } catch { transformations = []; }
  }
  const snapshot = skillScriptSnapshot({
    script: { path: script.path, digest: script.digest, verified: script.verified },
    inputs, transformations, interpreter: interpreterOf(script.path),
    environment: reported ? { digest: replayDigest({ interpreter: interpreterLine, libraries }), facts: { interpreter: interpreterLine, packages: libraries } } : null,
    execution: { exitCode: Number.isSafeInteger(execution.exitCode) ? execution.exitCode : null, startedAt: execution.startedAt, endedAt: execution.endedAt,
      sourcesUnchanged: typeof execution.sourcesUnchanged === "boolean" ? execution.sourcesUnchanged : null, observation: execution.output?.observation },
  });
  /** @type {any} */
  let parsed = null;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resultsBytes)); } catch { parsed = null; }
  const flat = flattenMachineValues(parsed);
  const code = scriptVersion ? { kind: "code", id: script.path, versionId: scriptVersion.versionId, digest: script.digest, availability: "captured" } : null;
  return { status: "recorded", snapshot, code, inputs, machineValues: flat.values, truncated: flat.truncated, digest: resultsDigest };
}

/**
 * Capture the results file an execution record accounts for, as a calculation: its numbers flattened to machine values
 * and the record as its producer snapshot. The same bytes already preserved as a calculation by this record are that
 * calculation — a second copy would be a second identity for one result.
 *
 * The producer is the workspace (`kind: "workspace"`) of the run: the file was made by a script run through the shell,
 * which no tool call of this run wrote, so no call is claimed as its producer; the record the script left, and the bytes
 * the platform re-read against it, are what bind it.
 *
 * @param {{ results: any, project: any, userId: string, receiptPath: string, resultsPath: string,
 *   readBytes: (relativePath: string, limit: number) => Promise<Buffer>, producer: { sessionId?: string | null, runId?: string | null,
 *   parentSessionId?: string | null, branchId?: string | null },
 *   transformationsFor?: ((digests: string[]) => Promise<any[]>) | null }} input
 * @returns {Promise<{ status: "captured", version: any } | { status: "unavailable", reason: string }>}
 */
export async function captureSkillResults({ results, project, userId, receiptPath, resultsPath, readBytes, producer, transformationsFor = null }) {
  const read = await readSkillExecution({ results, project, userId, receiptPath, resultsPath, readBytes, transformationsFor });
  if (read.status !== "recorded") return read;
  const existing = (await results.query(userId, project.id, { path: resultsPath, digest: read.digest, hasMachineValues: true, snapshot: { kind: "skill_script" } }, { limit: 1 })).items[0];
  if (existing) return { status: "captured", version: existing };
  const version = await results.captureFile({ userId, project, relativePath: resultsPath, expectedDigest: read.digest, machineValues: read.machineValues,
    snapshot: read.snapshot, code: read.code, inputs: read.inputs,
    producer: { kind: "workspace", sessionId: producer.sessionId ?? null, runId: producer.runId ?? null, parentSessionId: producer.parentSessionId ?? null,
      branchId: producer.branchId ?? null, eventId: `skill-results:${read.digest}` } });
  return { status: "captured", version };
}

/**
 * Receipts among a delivery's files, by shape: a JSON file that is an execution
 * ledger, and the results files its executions name that are also in the
 * delivery. A closed structural check on a file the receipt itself describes,
 * not a reading of the report's prose.
 * @param {{ paths: readonly string[], readBytes: (relativePath: string, limit: number) => Promise<Buffer> }} input
 * @returns {Promise<Array<{ receiptPath: string, resultsPath: string }>>}
 */
export async function findSkillExecutions({ paths, readBytes }) {
  const pairs = [];
  const present = new Set(paths);
  for (const path of paths.filter((candidate) => candidate.toLowerCase().endsWith(".json"))) {
    let receipt;
    try { receipt = JSON.parse((await readBytes(path, MAX_RECEIPT_BYTES)).toString("utf8")); } catch { continue; }
    if (!record(receipt) || receipt.schemaVersion !== 1 || !Array.isArray(receipt.executions) || !receipt.executions.length) continue;
    const named = new Set(receipt.executions.flatMap((/** @type {any} */ execution) => {
      const target = record(execution) && record(execution.output) && record(execution.output.after) ? workspacePath(execution.output.after.path) : null;
      return target ? [target] : [];
    }));
    for (const resultsPath of named) if (present.has(resultsPath)) pairs.push({ receiptPath: path, resultsPath });
  }
  return pairs;
}
