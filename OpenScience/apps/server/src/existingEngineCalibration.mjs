import { saveEvolutionEvaluation, publishEvaluationGaps } from './evolutionEvaluationGaps.mjs';
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { scoreUnit } from "../../../evals/paper-gold/evaluator.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
/** Import only operator-owned offline receipts, never runtime or candidate evidence. @param {any} request */
export async function importExistingEngineReceipt({ dataDir, methodId, reportHash }) {
  if (!/^(meta-reml-published-data|mr-ivw-published-data|faers-ror-published-data)(?:-v[0-9]+)?$/.test(methodId ?? "") || !/^[a-f0-9]{64}$/.test(reportHash ?? "")) throw new Error("Invalid engine receipt identity.");
  const directory = path.join(dataDir, "paper-gold", "engine-calibration");
  const bytes = await readFile(path.join(directory, `${methodId}-${reportHash}.json`), "utf8"), report = JSON.parse(bytes);
  const sourceBytes = await readFile(path.join(dataDir, "paper-gold", "candidate-cases", `${methodId}.json`), "utf8"), definition = JSON.parse(sourceBytes);
  if (sha(bytes) !== reportHash || sha(sourceBytes) !== report.sourceDefinitionHash || report.methodId !== methodId || definition.methodId !== methodId || definition.frozen !== true
    || !Number.isFinite(Date.parse(report.executedAt ?? "")) || report.executionKind !== "actual-existing-engine" || report.scope !== "deterministic-method-only" || report.replicates !== 2
    || ![report.engineDigest, report.runtimeDigest, report.scorerDigest].every(value => /^[a-f0-9]{64}$/.test(value ?? ""))) throw new Error("The imported operator engine receipt is not bound to frozen sources and execution.");
  const expectedEngine = methodId.startsWith("meta-") ? "meta" : methodId.startsWith("faers-") ? "pharmacovigilance" : "mr";
  const implementations = { meta: ["new_meta.engines.meta_engine.random_effects_reml"], pharmacovigilance: ["safety_agent.signals.disproportionality.ror"], mr: ["production-TwoSampleMR::mr_ivw_fe", "production-TwoSampleMR::mr_wald_ratio"] };
  const units = [], seen = new Set();
  for (const row of report.rows ?? []) {
    const reference = definition.cases.find(item => item.id === row.caseId);
    const key = `${row.caseId}:${row.replicate}`;
    if (row.engineId !== expectedEngine || (!row.unsupported && !implementations[expectedEngine].includes(row.engineImplementation)) || !reference || ![0, 1].includes(row.replicate) || seen.has(key) || row.publicationId !== reference.publicationId || row.sourceHash !== reference.sourceHash) throw new Error("The engine receipt has missing, duplicate or changed source evidence.");
    seen.add(key);
    const score = await scoreUnit({ id: row.caseId, numeric: row.numeric, checks: { method_supported: !row.unsupported }, exposureTier: "direct", gaps: row.unsupported ? ["method_missing"] : [] },
      { type: "method", inputAvailable: true, numeric: reference.numeric, applicableStages: ["method", "calculation"], stageChecks: { method: ["method_supported"] } });
    if (score.allStagesValid !== row.passed) throw new Error("Independent evaluator and engine self-check disagree.");
    units.push({ ...score, at: report.executedAt, caseId: row.caseId, replicate: row.replicate, engineId: row.engineId, capabilityId: { meta: "meta-analysis", mr: "mendelian-randomization", pharmacovigilance: "adr-analysis" }[row.engineId],
      track: row.engineId === "meta" ? "E" : "P", group: "calibration", publishedPaperId: row.publicationId, goldSourceHash: row.sourceHash,
      producerRunId: null, producerProjectId: null, independent: true, retracted: null, executionKind: "actual-existing-engine", numeric: undefined });
  }
  if (units.length !== definition.cases.length * 2) throw new Error("The engine receipt does not cover both replicates of every frozen method case.");
  const evaluationScorerHash = sha((await readFile(new URL("../../../evals/paper-gold/evaluator.mjs", import.meta.url), "utf8")) + (await readFile(new URL("./existingEngineCalibration.mjs", import.meta.url), "utf8")));
  const scored = JSON.stringify({ sourceReportHash: reportHash, sourceDefinitionHash: report.sourceDefinitionHash, evaluationScorerHash, engineDigest: report.engineDigest, runtimeDigest: report.runtimeDigest, scorerDigest: report.scorerDigest,
    units, scored: true, scope: "deterministic-method-only" });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = path.join(directory, `${methodId}-${reportHash}-${evaluationScorerHash}-scored.json`);
  try { await writeFile(output, scored, { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST" || await readFile(output, "utf8") !== scored) throw error; }
  return { ok: units.every(unit => unit.allStagesValid), methodId, engineId: report.rows[0]?.engineId, scored: true, scope: "deterministic-method-only", methodCases: units.length,
    passed: units.filter(unit => unit.allStagesValid).length, unsupported: units.filter(unit => unit.gaps.includes("method_missing")).length,
    passedPublishedSources: new Set(units.filter(unit => unit.allStagesValid).map(unit => unit.publishedPaperId)).size,
    sourceDefinitionHash: report.sourceDefinitionHash, evaluationScorerHash, engineDigest: report.engineDigest, runtimeDigest: report.runtimeDigest, scorerDigest: report.scorerDigest, reportHash, scoredReportHash: sha(scored), fullResearchReproductions: 0, units };
}

/** Persist sanitized operator scoring in the ordinary evaluation/digest ledger. @param {any} request */
export async function persistExistingEngineEvaluation({ service, paperGold, methodId, reportHash }) {
  const imported = await paperGold.importExistingMethods({ methodId, reportHash });
  const { units, ...summary } = imported;
  const id = `evolution-evaluation-existing-${sha(JSON.stringify([methodId, reportHash, summary.evaluationScorerHash])).slice(0, 48)}`;
  const prior = await service.get(id);
  if (prior) return publishEvaluationGaps(service, prior);
  return saveEvolutionEvaluation(service, id, { at: service.now().toISOString(), units, summary, scope: "deterministic-method-only", executionKind: "actual-existing-engine" }, prior);
}
