import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { boundedHalfWidth } from "./tolerance.mjs";
export const STAGES = Object.freeze(["question", "method", "recall", "extraction", "calculation", "certainty", "writing"]);
export const GAPS = Object.freeze(["connector", "extraction", "method_missing", "implementation", "routing", "skill_instruction", "writing", "model_capability", "outside_product"]);
export const BENCHMARKS = Object.freeze(["method", "research", "question"]);
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A reference's stated tolerance is honoured only up to the bound `tolerance.mjs` derives from how the
 *  number was printed; `toleranceClamped` says a frozen definition asked for more than that. */
export function numericScore(actual, reference) {
  if (!Number.isFinite(actual)) return { valid: false, reason: "missing_numeric_result" };
  const interval = reference.interval ?? [reference.value, reference.value];
  const { halfWidth: tolerance, clamped } = boundedHalfWidth(reference);
  return { valid: actual >= interval[0] - tolerance && actual <= interval[1] + tolerance, distance: actual < interval[0] ? interval[0] - actual : actual > interval[1] ? actual - interval[1] : 0, ...(clamped ? { toleranceClamped: true } : {}) };
}
export function crossImplementationScore(actual, independent, tolerances = {}) {
  if (!independent.implementationId || independent.implementationId === actual.implementationId) throw new Error("Cross-implementation scoring requires independent implementations.");
  return Object.fromEntries(Object.entries(independent.numeric).map(([key, value]) => [key, numericScore(actual.numeric[key], { ...tolerances[key], value, interval: undefined })]));
}
export function simulationScore(samples, specification) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error("Simulation requires at least two replicates.");
  const n = samples.length;
  const bias = samples.reduce((sum, row) => sum + row.estimate - specification.truth, 0) / n;
  const variance = samples.reduce((sum, row) => sum + (row.estimate - specification.truth - bias) ** 2, 0) / (n - 1);
  const coverage = samples.filter(row => row.lower <= specification.truth && row.upper >= specification.truth).length / n;
  const falsePositive = samples.filter(row => row.p < specification.alpha).length / n;
  const mcseCoverage = Math.sqrt(coverage * (1 - coverage) / n);
  const mcseBias = Math.sqrt(variance / n);
  const mcseFalsePositive = Math.sqrt(falsePositive * (1 - falsePositive) / n);
  return { n, bias, coverage, falsePositive, mcseBias, mcseCoverage, mcseFalsePositive,
    valid: Math.abs(bias) <= specification.maxBias + 1.96 * mcseBias && Math.abs(coverage - specification.coverage) <= specification.coverageTolerance + 1.96 * mcseCoverage && (specification.truth !== 0 || falsePositive <= specification.alpha + specification.falsePositiveTolerance + 1.96 * mcseFalsePositive) };
}
export function timeHoldout(caseRecord, modelReleasedAt, toolDevelopedAt) {
  const earliest = Math.min(...(caseRecord.firstPublicDates ?? []).map(Date.parse));
  return Number.isFinite(earliest) && earliest > Date.parse(modelReleasedAt) && earliest > Date.parse(toolDevelopedAt);
}
export function validateRewrite(rewrite, original) {
  if (!rewrite.writer || !rewrite.qaExecutor || rewrite.writer === rewrite.qaExecutor || rewrite.qaPassed !== true) throw new Error("Rewrite requires independent passing QA.");
  if (!Array.isArray(rewrite.variants) || rewrite.variants.length !== 3 || new Set(rewrite.variants).size !== 3) throw new Error("Exactly three distinct neutral variants are required.");
  for (const text of [rewrite.question, ...rewrite.variants]) {
    if (!text || (original.identifiers ?? []).some(id => text.toLowerCase().includes(id.toLowerCase()))) throw new Error("Rewrite leaked a target identifier.");
    if (/\b(reduces|increases|improves|decreases|protective|causes)\b/i.test(text)) throw new Error("Directional wording requires a neutral rewrite.");
  }
  return true;
}
export async function screenRetractions(dois, fetchImpl = fetch) {
  const records = [];
  for (const doi of dois) {
    const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) { records.push({ doi, status: "unavailable", admissible: false }); continue; }
    const record = /** @type {any} */ (await response.json()).message;
    const updates = [...(record["update-to"] ?? []), ...(record["updated-by"] ?? [])];
    const notices = updates.filter(item => /retract|correction|erratum|concern/i.test(item.type ?? item.label ?? ""));
    records.push({ doi, status: notices.length ? "development_only" : "clear", admissible: !notices.length, notices, checkedAt: new Date().toISOString() });
  }
  return records;
}
export async function freezeCycle(dataDir, cycleId, definition) {
  if (!/^[a-zA-Z0-9_-]+$/.test(cycleId)) throw new Error("Invalid cycle id.");
  const directory = path.join(dataDir, "paper-gold", "cycles", cycleId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evaluatorSources = await Promise.all(["./evaluator.mjs", "./tolerance.mjs", "./run.mjs", "./benchmarks.mjs", "../../apps/server/src/paperGoldEvaluator.mjs", "../../apps/server/src/paperGoldCalibration.mjs", "../../apps/server/src/reviewModel.mjs", "../../apps/server/src/paperGoldVerification.mjs"].map(file => readFile(new URL(file, import.meta.url), "utf8")));
  const evaluatorCodeHash = digest(evaluatorSources);
  const hash = digest({ definition, evaluatorCodeHash });
  const file = path.join(directory, "definition.json");
  try { await writeFile(file, JSON.stringify({ hash, evaluatorCodeHash, definition }), { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; if (JSON.parse(await readFile(file, "utf8")).hash !== hash) throw new Error("Evaluator is frozen for this cycle."); }
  return { directory, hash, evaluatorCodeHash };
}
export async function sealProspective(dataDir, id, answer, now = new Date()) {
  const directory = path.join(dataDir, "paper-gold", "prospective");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sealed = { id, at: now.toISOString(), answerHash: digest(answer), answer };
  await writeFile(path.join(directory, `${digest(id)}.json`), JSON.stringify(sealed), { mode: 0o600, flag: "wx" });
  return { id, at: sealed.at, answerHash: sealed.answerHash };
}
/** Gold and scoring stay in the evaluator process, never in dispatched prompt. */
/** @param {any} unit @param {any} gold @param {{review?: any,verifyCode?: any}} [options] */
export async function scoreUnit(unit, gold, { review, verifyCode } = {}) {
  if (!BENCHMARKS.includes(gold.type)) throw new Error("Unknown benchmark type.");
  const stages = {};
  const applicableStages = gold.applicableStages ?? (gold.type === "method" ? ["method", "calculation"] : STAGES);
  if (applicableStages.some(stage => !STAGES.includes(stage))) throw new Error("Unknown applicable stage.");
  const numeric = Object.fromEntries(Object.entries(gold.numeric ?? {}).map(([key, reference]) => [key, numericScore(unit.numeric?.[key], reference)]));
  for (const stage of STAGES) {
    const checks = gold.stageChecks?.[stage] ?? [];
    stages[stage] = { valid: checks.length > 0 && checks.every(key => unit.checks?.[key] === true), observed: checks.length > 0 };
  }
  if (Object.keys(numeric).length) stages.calculation = { valid: Object.values(numeric).every(row => row.valid), observed: true };
  let verification = null;
  if (gold.deterministicVerification) {
    verification = verifyCode ? await verifyCode({unit,gold}) : {verified:false,reason:"isolated_verification_unavailable"};
    stages.calculation = {valid:stages.calculation.valid && verification?.verified === true,observed:true};
  }
  let disagreement = null;
  if (Object.values(numeric).some(row => !row.valid) && review) {
    disagreement = await review({ evidence: gold.preservedEvidence, actual: unit.numeric, reference: gold.numeric, unit, gold, verification });
    if (!disagreement.reviewerFamily || disagreement.reviewerFamily === unit.modelFamily || !["platform_error", "paper_error", "reasonable_difference"].includes(disagreement.verdict) || !disagreement.evidenceIds?.length) throw new Error("Disagreement requires evidence and cross-family review.");
    if (["paper_error", "reasonable_difference"].includes(disagreement.verdict) && disagreement.codeVerified === true) stages.calculation.valid = !gold.deterministicVerification || verification?.verified === true;
  }
  const gaps = (unit.gaps ?? []).map(code => { if (!GAPS.includes(code)) throw new Error("Unknown gap code."); return code; });
  const reachable = new Set(gold.reachableEvidenceIds ?? []);
  const recalled = new Set(unit.recalledEvidenceIds ?? []);
  return { id: unit.id, type: gold.type, nativeEgressProofHash:unit.nativeEgressProofHash??null,assessmentReceiptHash:unit.assessmentReceiptHash??null,assessmentEvidenceIds:unit.assessmentEvidenceIds??[],assessmentReasoningStatus:unit.assessmentReasoningStatus??"unknown", stages, numeric, disagreement, gaps, deterministicVerificationRequired:Boolean(gold.deterministicVerification), ...(verification ? {codeVerified:verification.verified === true,...(verification.verified ? {verificationProof:verification.proof}:{verificationFailure:verification.reason})}:{}), applicableStagesValid: applicableStages.every(stage => stages[stage].observed && stages[stage].valid), allStagesValid: gold.inputAvailable !== false && applicableStages.every(stage => stages[stage].observed && stages[stage].valid), fullResearchReproductionValid: gold.type === "research" && gold.inputAvailable !== false && ["unexposed", "exposed_uncited", "exposed-unreferenced", "cited"].includes(unit.exposureTier) && STAGES.every(stage => stages[stage].observed && stages[stage].valid), benchmarkScope: gold.benchmarkScope ?? (gold.inputAvailable === false ? "missing-input-response" : gold.type), recall: { denominator: reachable.size, found: [...reachable].filter(id => recalled.has(id)).length, connectorGaps: gold.unreachableEvidenceIds ?? [] }, exposureTier: unit.exposureTier ?? "unknown" };
}
function groupBy(rows, select) {
  const groups = {}; for (const row of rows) { const key = select(row); (groups[key] ??= []).push(row); } return groups;
}
export function reportReplicates(rows) {
  const groups = groupBy(rows, row => row.caseId ?? row.id);
  return Object.entries(groups).map(([caseId, replicates]) => {
    if (replicates.length < 2) throw new Error("Every case needs at least two replicates.");
    const mean = replicates.filter(row => row.allStagesValid).length / replicates.length;
    return { caseId, n: replicates.length, allStagesValidRate: mean, fullResearchReproductionRate: replicates.filter(row => row.fullResearchReproductionValid).length / replicates.length, benchmarkScope: replicates[0].benchmarkScope, variance: replicates.reduce((sum, row) => sum + (Number(row.allStagesValid) - mean) ** 2, 0) / (replicates.length - 1), byExposure: groupBy(replicates, row => row.exposureTier) };
  });
}
