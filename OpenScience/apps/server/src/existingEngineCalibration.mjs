import { saveEvolutionEvaluation, publishEvaluationGaps } from './evolutionEvaluationGaps.mjs';
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { scoreUnit } from "../../../evals/paper-gold/evaluator.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
/** What each ruler row executes. The MR row runs two functions of the TwoSampleMR library the MR engine
 * is built on; the engine's own pipeline (instrument selection, harmonisation, allele flips) is not on that
 * path, so its units are named for the library and carry no capability: they say nothing about the engine. */
const EXECUTED = {
  meta: { executionKinds: ["actual-existing-engine"], unitEngineId: "meta", capabilityId: "meta-analysis", track: "E", implementations: ["new_meta.engines.meta_engine.random_effects_reml"] },
  pharmacovigilance: { executionKinds: ["actual-existing-engine"], unitEngineId: "pharmacovigilance", capabilityId: "adr-analysis", track: "P", implementations: ["safety_agent.signals.disproportionality.ror"] },
  mr: { executionKinds: ["library-component"], unitEngineId: "twosamplemr-library", capabilityId: null, track: "P",
    implementations: ["mr_ivw_fe", "mr_wald_ratio"].map(name => `TwoSampleMR::${name} (library component; the platform MR engine pipeline is not executed)`) },
};
/**
 * Import an operator's offline method-ruler receipt and score it again here.
 *
 * Every case of the frozen definition is in the result with one outcome: agree, disagree or
 * could-not-run. The counts are cases. The receipt runs each case twice to check the engine is
 * deterministic; those two rows used to be counted as two cases ("92/92" was 46 cases), and the
 * definitions used to be filtered until the engine agreed with all of them. Neither is true any more: a
 * unit here is one case, and it agrees only when both of its replicates do.
 * Only operator-owned offline receipts are read, never runtime or candidate evidence.
 * @param {any} request
 */
export async function importExistingEngineReceipt({ dataDir, methodId, reportHash }) {
  if (!/^(meta-reml-published-data|mr-ivw-published-data|faers-ror-published-data)(?:-v[0-9]+)?$/.test(methodId ?? "") || !/^[a-f0-9]{64}$/.test(reportHash ?? "")) throw new Error("Invalid engine receipt identity.");
  const directory = path.join(dataDir, "paper-gold", "engine-calibration");
  const bytes = await readFile(path.join(directory, `${methodId}-${reportHash}.json`), "utf8"), report = JSON.parse(bytes);
  const sourceBytes = await readFile(path.join(dataDir, "paper-gold", "candidate-cases", `${methodId}.json`), "utf8"), definition = JSON.parse(sourceBytes);
  const expectedEngine = methodId.startsWith("meta-") ? "meta" : methodId.startsWith("faers-") ? "pharmacovigilance" : "mr";
  const executed = EXECUTED[expectedEngine];
  if (sha(bytes) !== reportHash || sha(sourceBytes) !== report.sourceDefinitionHash || report.methodId !== methodId || definition.methodId !== methodId || definition.frozen !== true
    || !Number.isFinite(Date.parse(report.executedAt ?? "")) || !executed.executionKinds.includes(report.executionKind) || report.scope !== "deterministic-method-only" || report.replicates !== 2
    || ![report.engineDigest, report.runtimeDigest, report.scorerDigest].every(value => /^[a-f0-9]{64}$/.test(value ?? ""))) throw new Error("The imported operator engine receipt is not bound to frozen sources and execution.");
  const rows = new Map();
  for (const row of report.rows ?? []) {
    const reference = definition.cases.find(item => item.id === row.caseId);
    const key = `${row.caseId}:${row.replicate}`;
    const couldNotRun = row.outcome === "could-not-run" || Boolean(row.unsupported);
    if (row.engineId !== expectedEngine || (!couldNotRun && !executed.implementations.includes(row.engineImplementation)) || !reference || ![0, 1].includes(row.replicate) || rows.has(key) || row.publicationId !== reference.publicationId || row.sourceHash !== reference.sourceHash) throw new Error("The engine receipt has missing, duplicate or changed source evidence.");
    const score = await scoreUnit({ id: row.caseId, numeric: row.numeric, checks: { method_supported: !couldNotRun }, exposureTier: "direct", gaps: couldNotRun ? ["method_missing"] : [] },
      { type: "method", inputAvailable: true, numeric: reference.numeric, applicableStages: ["method", "calculation"], stageChecks: { method: ["method_supported"] } });
    if (score.allStagesValid !== row.passed) throw new Error("Independent evaluator and engine self-check disagree.");
    rows.set(key, { row, score, couldNotRun });
  }
  if (rows.size !== definition.cases.length * 2) throw new Error("The engine receipt does not cover both replicates of every frozen method case.");
  const units = definition.cases.map(reference => {
    const pair = [0, 1].map(replicate => rows.get(`${reference.id}:${replicate}`));
    const outcome = pair.some(item => item.couldNotRun) ? "could-not-run" : pair.every(item => item.score.allStagesValid) ? "agree" : "disagree";
    const first = pair[0];
    return { ...first.score, allStagesValid: outcome === "agree", applicableStagesValid: outcome === "agree", at: report.executedAt, caseId: reference.id, replicates: 2, outcome,
      reason: outcome === "could-not-run" ? pair.find(item => item.couldNotRun).row.reason ?? pair.find(item => item.couldNotRun).row.unsupported ?? "could_not_run" : outcome === "agree" ? "within_reference_tolerance" : "outside_reference_tolerance",
      ...(outcome === "disagree" && first.row.diagnosis ? { diagnosis: first.row.diagnosis, adjudication: "unadjudicated" } : {}), ...(outcome === "could-not-run" ? { unsupported: true } : {}),
      // What the reference is: a number printed in the paper, or another implementation's output on its data.
      referenceKind: reference.kind ?? null, engineId: executed.unitEngineId, capabilityId: executed.capabilityId, track: executed.track, group: "calibration",
      publishedPaperId: reference.publicationId, goldSourceHash: reference.sourceHash,
      producerRunId: null, producerProjectId: null, independent: true, retracted: null, executionKind: report.executionKind, numeric: undefined };
  });
  const tally = list => ({ cases: list.length, agree: list.filter(unit => unit.outcome === "agree").length, disagree: list.filter(unit => unit.outcome === "disagree").length, couldNotRun: list.filter(unit => unit.outcome === "could-not-run").length });
  const publications = [...new Set(units.map(unit => unit.publishedPaperId))];
  const bySource = Object.fromEntries(publications.map(publication => [publication, tally(units.filter(unit => unit.publishedPaperId === publication))]));
  const counts = tally(units);
  // The receipt's own summary is the operator script's arithmetic; it has to be this arithmetic.
  if (report.summary && ["cases", "agree", "disagree", "couldNotRun"].some(key => report.summary[key] !== counts[key])) throw new Error("Independent evaluator and engine self-check disagree.");
  const excludedBeforeScoring = (definition.excluded ?? definition.rejected ?? []).length;
  const sourcesFullyAgreeing = Object.values(bySource).filter(source => source.agree === source.cases).length;
  const disagreementDiagnoses = {};
  for (const unit of units) if (unit.diagnosis) disagreementDiagnoses[unit.diagnosis] = (disagreementDiagnoses[unit.diagnosis] ?? 0) + 1;
  const evaluationScorerHash = sha((await readFile(new URL("../../../evals/paper-gold/evaluator.mjs", import.meta.url), "utf8")) + (await readFile(new URL("../../../evals/paper-gold/tolerance.mjs", import.meta.url), "utf8")) + (await readFile(new URL("./existingEngineCalibration.mjs", import.meta.url), "utf8")));
  const scored = JSON.stringify({ sourceReportHash: reportHash, sourceDefinitionHash: report.sourceDefinitionHash, evaluationScorerHash, engineDigest: report.engineDigest, runtimeDigest: report.runtimeDigest, scorerDigest: report.scorerDigest,
    units, scored: true, scope: "deterministic-method-only" });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = path.join(directory, `${methodId}-${reportHash}-${evaluationScorerHash}-scored.json`);
  try { await writeFile(output, scored, { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST" || await readFile(output, "utf8") !== scored) throw error; }
  return { ok: counts.agree === counts.cases, methodId, engineId: expectedEngine, executionKind: report.executionKind, scored: true, scope: "deterministic-method-only",
    ...counts, rows: rows.size, excludedBeforeScoring, entered: counts.cases + excludedBeforeScoring, publishedSources: publications.length, sourcesFullyAgreeing, bySource, disagreementDiagnoses,
    // The names earlier readers use, with their honest meaning: cases, not rows; a source passes when all of its cases agree.
    methodCases: counts.cases, passed: counts.agree, unsupported: counts.couldNotRun, passedPublishedSources: sourcesFullyAgreeing, scoredPublishedSources: publications.length,
    sourceDefinitionHash: report.sourceDefinitionHash, evaluationScorerHash, engineDigest: report.engineDigest, runtimeDigest: report.runtimeDigest, scorerDigest: report.scorerDigest, reportHash, scoredReportHash: sha(scored), fullResearchReproductions: 0, units };
}

/** Persist sanitized operator scoring in the ordinary evaluation/digest ledger. @param {any} request */
export async function persistExistingEngineEvaluation({ service, paperGold, methodId, reportHash }) {
  const imported = await paperGold.importExistingMethods({ methodId, reportHash });
  const { units, ...summary } = imported;
  const id = `evolution-evaluation-existing-${sha(JSON.stringify([methodId, reportHash, summary.evaluationScorerHash])).slice(0, 48)}`;
  const prior = await service.get(id);
  if (prior) return publishEvaluationGaps(service, prior);
  return saveEvolutionEvaluation(service, id, { at: service.now().toISOString(), units, summary, scope: "deterministic-method-only", executionKind: summary.executionKind }, prior);
}
