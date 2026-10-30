import { allResultsOf, list, markFor, numeric, object } from "./vcrViewsKit.mjs";
import { vcrObjectNode } from "./vcrStore.mjs";
import { vcrCohortBinding } from "./vcrSnapshotBinding.mjs";

/** Whether a method has the subject-grain count contract. @param {unknown} version */
function hasPatientCountContract(version) {
  const [major, minor] = String(version ?? "").split(".").map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) && (major > 1 || (major === 1 && minor >= 1));
}

/** A study's current population and its actual computation, with source-bound counts. @param {Record<string, any>} bundle */
export function presentResearchProgress(bundle) {
  const population = list(bundle.populations)[0] ?? null;
  const results = allResultsOf(bundle);
  const pointed = population?.resultId ? results.find(row => row.id === population.resultId && row.subjectId === population.id && row.kind === "population") ?? null : null;
  const pointedExecution = pointed?.executionId && bundle.executions instanceof Map ? bundle.executions.get(pointed.executionId) : null;
  // A result counts under a real population only when every snapshot its execution read is the population's own. The service has
  // already taken such a result off the population (`resultOtherSnapshot`); a presenter handed rows directly says the same.
  const binding = vcrCohortBinding(population, pointedExecution?.inputs);
  const otherSnapshot = object(population?.resultOtherSnapshot).resultId ? object(population.resultOtherSnapshot)
    : binding.state === "other_snapshot" ? { resultId: pointed?.id ?? null, snapshotIds: binding.snapshotIds } : null;
  const candidate = otherSnapshot ? null : pointed;
  const execution = candidate ? pointedExecution : null;
  const originatingJob = execution?.jobId ? list(bundle.jobs).find(row => row.id === execution.jobId) : null;
  const version = object(originatingJob?.checkpoint).configurationVersion;
  const result = candidate && (version == null || Number(version) === Number(population.version)) ? candidate : null;
  const mark = (row) => row ? markFor(list(bundle.stale), `result:${row.id}@${row.version}`) : null;
  const stale = Boolean(result && ((population && markFor(list(bundle.stale), vcrObjectNode("population", population))) || mark(result)));
  const relatedJob = population ? list(bundle.jobs).find(job => { const checkpoint = object(job.checkpoint); return checkpoint.subjectId === population.id && (checkpoint.configurationVersion == null || Number(checkpoint.configurationVersion) === Number(population.version)); }) : null;
  const jobIsCurrent = !result || (Number.isFinite(Date.parse(relatedJob?.createdAt)) && Number.isFinite(Date.parse(result.createdAt)) && Date.parse(relatedJob.createdAt) > Date.parse(result.createdAt));
  const jobState = jobIsCurrent && ["queued", "running", "awaiting_budget", "failed", "canceled"].includes(relatedJob?.state) ? relatedJob.state : null;
  const status = jobState ?? (stale ? "stale" : result ? (result.conclusion === "not_estimable" ? "not_estimable" : result.conclusion === "limited" || object(result.diagnostics).partial === true ? "limited" : "available") : "none");
  const input = object(bundle.taskInputs).cohort;
  let availability = ["available", "missing", "unknown"].includes(input?.status) ? input.status : "unknown";
  if (result && ["scenario", "literature"].includes(population?.kind)) availability = "not_required";
  if (population && availability === "available") {
    availability = !population.snapshotId ? "unknown" : list(input.sources).some(source => source.snapshotId === population.snapshotId) ? "available" : input.partial === true ? "unknown" : "missing";
  }
  const selectedCounts = object(result?.counts);
  // Profile jobs have no subjectId. Bind the reported first table to this snapshot
  // through the frozen execution input, never through a coincidental result label.
  // Profile jobs are filed under no object, so a later profile of another snapshot supersedes this one in `bundle.results`: the
  // history is searched, newest first, and the profile taken is the one of this snapshot.
  const profile = population?.snapshotId && bundle.executions instanceof Map ? results.find(row => {
    if (row.kind !== "snapshot_profile" || mark(row)) return false;
    const exec = bundle.executions.get(row.executionId);
    const first = list(object(row.diagnostics).tables)[0];
    const inputId = typeof first?.input === "string" ? first.input : "";
    return exec?.method === "profile.snapshot" && hasPatientCountContract(exec?.methodVersion) && inputId.startsWith(`${population.snapshotId}:`)
      && list(exec.inputs).some(entry => ["analysis_table", "snapshot_file"].includes(entry.kind) && entry.id === inputId);
  }) ?? null : null;
  const profileCounts = object(profile?.counts);
  const firstTable = list(object(profile?.diagnostics).tables)[0];
  const observations = ["observed", "extracted", "calculated", "imputed"].includes(firstTable?.valueSource) && ["long", "event"].includes(firstTable?.shape) ? numeric(firstTable.rows) : null;
  return {
    populationId: population?.id ?? null, populationVersion: population?.version ?? null,
    definition: population ? "saved" : "none", input: availability, calculation: status,
    resultId: result?.id ?? null, resultStale: stale,
    // A result that exists but was computed on another snapshot: not counted here, said so, never drawn as a zero.
    ...(otherSnapshot ? { resultNotCounted: { reason: "other_snapshot", resultId: otherSnapshot.resultId ?? null, snapshotIds: list(otherSnapshot.snapshotIds).map(String) } } : {}),
    counts: {
      sourcePatients: numeric(profileCounts.realPatients),
      realPatients: population?.kind === "real" && (execution?.method !== "cohort.build" || !hasPatientCountContract(execution?.methodVersion)) ? null : numeric(selectedCounts.realPatients),
      observations,
      generatedRecords: numeric(selectedCounts.generatedRecords),
      reconstructedPseudoPatients: numeric(selectedCounts.reconstructedPseudoPatients),
    },
    profileStatistics: list(firstTable?.columns).filter(row => ["mean_above_median", "mean_below_median", "equal"].includes(row.meanMedianDirection))
      .map(row => ({ column: row.column, mean: numeric(row.mean), median: numeric(row.median), direction: row.meanMedianDirection })),
  };
}
