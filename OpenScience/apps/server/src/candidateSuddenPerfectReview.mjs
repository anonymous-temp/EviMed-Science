import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@evimed/domain";
import { createHash } from "node:crypto";
import { writeFileExclusiveNoFollow } from "./security.mjs";
import { BEHAVIOUR_LIMITS } from "../../../evals/paper-gold/behavioural.mjs";
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
/**
 * The review of a candidate that goes from a measured failure to a perfect score.
 *
 * It used to replay the evaluation it was reviewing: the same bytes on the same cases with the same
 * inputs, which deterministic code cannot fail, recorded as an independent review. A review has to test
 * something the first evaluation did not. `replay` now runs the evaluator in its review mode, which
 * executes only held-out material:
 *  - reserved cases (`reserve: true` in the frozen definition), which no ordinary evaluation and so no
 *    repair round has ever run;
 *  - the behavioural checks of `behavioural.mjs` under the review's own seed, so their fresh cases and
 *    relation factors are ones the candidate has never been scored on.
 * If neither a reserved case nor the minimum of fresh cases exists for the candidate, the record says
 * the review could not be done (`status: "not-performed"`, `passed: null`). That is never a pass, and the
 * evaluator does not promote on it.
 *
 * Unknown, exposed and resource failures never trigger a review.
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
  const queued = { schemaVersion: 2, reviewId, identity, purpose: "sudden-perfect-held-out-review", trigger: "measured-failure-to-all-passed", queuedAt: new Date().toISOString() };
  await writeFileExclusiveNoFollow(dataDir, path.join(root, `${reviewId}.queued.json`), canonicalJson(queued) + "\n", { mode: 0o444 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    signal?.throwIfAborted();
    const replayed = await replay();
    const receipt = await readReceipt(directory, replayed.evaluationReceiptHash);
    if (receipt.exposureTier === "unknown" || receipt.executionEvidence?.some(row => row.executed !== true || row.ok !== true)) {
      // Unobserved or resource-limited execution remains queued, never a completed scientific failure.
      return { triggered: true, passed: false, status: "pending", reviewId, reason: "additional_execution_or_exposure_unknown" };
    }
    const heldOut = { reservedCases: Number(receipt.heldOut?.reservedCases ?? 0), reservedFailures: Number(receipt.heldOut?.reservedFailures ?? 0), freshCases: Number(receipt.heldOut?.freshCases ?? 0), relationChecks: Number(receipt.heldOut?.relationChecks ?? 0) };
    // Relations alone compare the candidate with itself; a review needs cases with an answer the candidate was never scored on.
    const performed = heldOut.reservedCases > 0 || heldOut.freshCases >= BEHAVIOUR_LIMITS.freshPerCase;
    const contractUnchanged = receipt.sourceArtifactDigest === current.sourceArtifactDigest && receipt.executionContractDigest === current.executionContractDigest;
    const behaviour = receipt.behaviour?.status ?? null;
    const passed = !performed ? null : receipt.purpose === "sudden-perfect-held-out-review" && comparable(receipt, current) && contractUnchanged
      && receipt.exposureTier === "unexposed" && receipt.ok === true && receipt.assessments.every(row => row.passed === true) && heldOut.reservedFailures === 0 && behaviour === "passed";
    const completed = { schemaVersion: 2, reviewId, identity, currentReceiptHash, additionalReceiptHash: replayed.evaluationReceiptHash,
      purpose: "sudden-perfect-held-out-review", trigger: queued.trigger, reviewedAt: new Date().toISOString(),
      passed, status: passed === null ? "not-performed" : passed ? "reviewed" : "repair", ...(passed === null ? { reason: "no_held_out_cases" } : {}),
      additionalExecutions: receipt.executionEvidence?.length ?? 0, heldOut,
      reviewChecks: { frozenEvidenceAndEvaluatorUnchanged: comparable(receipt, current), candidateCodeAndContractUnchanged: contractUnchanged,
        exposureUnexposed: receipt.exposureTier === "unexposed",
        // null means "not tested", which is what the record must say when there was nothing held out to test with.
        reservedCasesPassed: heldOut.reservedCases > 0 ? heldOut.reservedFailures === 0 : null,
        behaviouralChecksPassed: behaviour === "passed" ? true : behaviour === "failed" ? false : null } };
    await writeFileExclusiveNoFollow(dataDir, completedFile, canonicalJson({ receipt: completed, receiptHash: hash(completed) }) + "\n", { mode: 0o444 });
    return { triggered: true, passed, status: completed.status, reviewId, reviewReceiptHash: hash(completed), additionalExecutions: completed.additionalExecutions, heldOut };
  };
  // Production uses the existing PostgreSQL transaction advisory lock: disconnect/crash releases it.
  // Standalone fixtures serialize only within this process; no persistent lock can orphan on disk.
  return withReviewLock ? withReviewLock(reviewId, operation) : withLocalLock(`${dataDir}:${reviewId}`, operation);
}
