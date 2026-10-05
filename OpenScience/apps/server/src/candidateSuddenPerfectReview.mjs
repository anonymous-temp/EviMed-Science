import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@evimed/domain";
import { createHash } from "node:crypto";
import { writeFileExclusiveNoFollow } from "./security.mjs";
const hash = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const localLocks = new Map();
async function withLocalLock(key, operation) {
  const prior = localLocks.get(key) ?? Promise.resolve();
  const pending = prior.catch(() => {}).then(operation);
  localLocks.set(key, pending);
  try { return await pending; } finally { if (localLocks.get(key) === pending) localLocks.delete(key); }
}
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const comparable = (a, b) => a.methodId === b.methodId && a.evaluatorHash === b.evaluatorHash && a.evaluatorCodeHash === b.evaluatorCodeHash && a.frozenSourceDigest === b.frozenSourceDigest;
const measured = receipt => validHash(receipt.evaluatorHash) && validHash(receipt.evaluatorCodeHash) && validHash(receipt.frozenSourceDigest)
  && validHash(receipt.executionContractDigest) && /^sha256:[a-f0-9]{64}$/.test(receipt.sourceArtifactDigest ?? "")
  && receipt.exposureTier === "unexposed" && Array.isArray(receipt.assessments) && receipt.assessments.length > 0;
const perfect = receipt => measured(receipt) && receipt.ok === true && receipt.status === "verified" && receipt.assessments.every(row => row.passed === true)
  && receipt.executionEvidence?.length > 0 && receipt.executionEvidence.every(row => row.executed === true && row.ok === true);
const failed = receipt => measured(receipt) && receipt.ok === false && receipt.status === "repair" && receipt.assessments.some(row => row.passed === false
  && receipt.executionEvidence?.some(observed => observed.caseId === row.caseId && observed.executed === true && observed.ok === true));
async function readReceipt(directory, id) {
  if (!validHash(id)) throw new Error("Invalid immutable candidate receipt identity.");
  const file = await fs.realpath(path.join(directory, `${id}.json`));
  if (!file.startsWith(`${await fs.realpath(directory)}${path.sep}`)) throw new Error("Candidate receipt escaped control storage.");
  const receipt = JSON.parse(await fs.readFile(file, "utf8"));
  if (hash(receipt) !== id) throw new Error("Immutable candidate receipt hash changed.");
  return receipt;
}
/** Additional review is separate from ordinary replicates. Unknown, exposed and resource failures never trigger.
 * @param {any} request */
export async function reviewSuddenPerfect({ dataDir, currentReceiptHash, replay, signal, withReviewLock }) {
  const directory = path.join(dataDir, "paper-gold", "candidate-evaluations");
  const current = await readReceipt(directory, currentReceiptHash);
  if (!perfect(current) || current.purpose !== "candidate-validation") return { triggered: false, reason: "not_verified_perfect" };
  const history = [];
  for (const file of await fs.readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file) || file === `${currentReceiptHash}.json`) continue;
    const id = file.slice(0, -5), receipt = await readReceipt(directory, id);
    if (comparable(receipt, current) && receipt.purpose === "candidate-validation" && failed(receipt) && Date.parse(receipt.measuredAt) <= Date.parse(current.startedAt)) history.push({ id, receipt });
  }
  history.sort((a, b) => Date.parse(b.receipt.measuredAt) - Date.parse(a.receipt.measuredAt) || a.id.localeCompare(b.id));
  if (!history.length) return { triggered: false, reason: "no_comparable_measured_failure" };
  const previous = history[0];
  const identity = { methodId: current.methodId, candidateDigest: current.sourceArtifactDigest, executionContractDigest: current.executionContractDigest, evaluatorHash: current.evaluatorHash,
    evaluatorCodeHash: current.evaluatorCodeHash, frozenSourceDigest: current.frozenSourceDigest, previousFailedReceiptHash: previous.id };
  const reviewId = hash(identity), root = path.join(dataDir, "paper-gold", "sudden-perfect-reviews"), completedFile = path.join(root, `${reviewId}.json`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const operation = async () => {
  try {
    const sealed = JSON.parse(await fs.readFile(completedFile, "utf8")), completed = sealed.receipt;
    if (!completed || sealed.receiptHash !== hash(completed)) throw new Error("Sudden-perfect review receipt hash changed.");
    if (completed.reviewId !== reviewId || hash(completed.identity) !== reviewId) throw new Error("Sudden-perfect review identity changed.");
    return { triggered: true, passed: completed.passed, status: completed.status, reviewId, reviewReceiptHash: hash(completed), resumed: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const queued = { schemaVersion: 1, reviewId, identity, purpose: "sudden-perfect-independent-review", trigger: "measured-failure-to-all-passed", queuedAt: new Date().toISOString() };
  await writeFileExclusiveNoFollow(dataDir, path.join(root, `${reviewId}.queued.json`), canonicalJson(queued) + "\n", { mode: 0o444 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    signal?.throwIfAborted();
    const replayed = await replay();
    const receipt = await readReceipt(directory, replayed.evaluationReceiptHash);
    if (receipt.exposureTier === "unknown" || !receipt.executionEvidence?.length || receipt.executionEvidence.some(row => row.executed !== true || row.ok !== true)) {
      // Unobserved or resource-limited replay remains queued, never a completed scientific failure.
      return { triggered: true, passed: false, status: "pending", reviewId, reason: "additional_execution_or_exposure_unknown" };
    }
    const contractUnchanged = receipt.sourceArtifactDigest === current.sourceArtifactDigest && receipt.executionContractDigest === current.executionContractDigest;
    const passed = receipt.purpose === "sudden-perfect-independent-review" && comparable(receipt, current) && contractUnchanged && perfect(receipt);
    const completed = { schemaVersion: 1, reviewId, identity, currentReceiptHash, additionalReceiptHash: replayed.evaluationReceiptHash,
      purpose: "sudden-perfect-independent-review", trigger: queued.trigger, reviewedAt: new Date().toISOString(),
      passed, status: passed ? "reviewed" : "repair", additionalExecutions: receipt.executionEvidence.length,
      // Separate immutable receipts demonstrate this is additional work, not the routine two replicates.
      reviewChecks: { frozenEvidenceAndEvaluatorUnchanged: comparable(receipt, current), candidateCodeAndContractUnchanged: contractUnchanged,
        exposureUnexposed: receipt.exposureTier === "unexposed", allIndependentHiddenChecksPassed: perfect(receipt) } };
    await writeFileExclusiveNoFollow(dataDir, completedFile, canonicalJson({ receipt: completed, receiptHash: hash(completed) }) + "\n", { mode: 0o444 });
    return { triggered: true, passed, status: completed.status, reviewId, reviewReceiptHash: hash(completed), additionalExecutions: completed.additionalExecutions };
  };
  // Production uses the existing PostgreSQL transaction advisory lock: disconnect/crash releases it.
  // Standalone fixtures serialize only within this process; no persistent lock can orphan on disk.
  return withReviewLock ? withReviewLock(reviewId, operation) : withLocalLock(`${dataDir}:${reviewId}`, operation);
}
