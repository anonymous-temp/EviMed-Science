import { EVOLUTION_TRACKS } from '@evimed/domain';

/** @param {any} row */
const value = row => row?.payload ? { id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, ...row.payload } : row;
/** Unknown or empty denominators stay unknown, never a perfect score. @param {number} numerator @param {number} denominator */
const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator > 0 ? numerator / denominator : null, observed: denominator > 0 });
/** @param {number[]} values */
function median(values) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : null; }
/** Measured monthly outcomes. Inputs retain track, split and timestamp; unknown coverage is explicit.
 * @param {{month:string,now?:Date,tools?:any[],dossiers?:any[],evaluations?:any[],decisions?:any[],uses?:any[],budgetSummary?:any,previous?:any}} input */
export function evolutionMonthlyMetrics({ month, now = new Date(), tools = [], dossiers = [], evaluations = [], decisions = [], uses = [], budgetSummary = {}, previous = null }) {
  const start = Date.parse(`${month}-01T00:00:00Z`);
  const startDate = new Date(start);
  const end = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1);
  if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(start)) throw new Error('Invalid evolution metrics month.');
  const inMonth = (/** @type {any} */ row) => { const at = Date.parse(row.at ?? row.completedAt ?? row.decidedAt ?? row.createdAt ?? ''); return at >= start && at < end; };
  const months = evaluations.map(value).filter(inMonth);
  const cases = months.flatMap(row => (row.units ?? row.rows ?? row.cases ?? []).map((/** @type {any} */ unit) => ({ track: unit.track ?? row.track, group: unit.group ?? row.group, ...unit }))).map(row => row.type === 'research' ? { ...row, allStagesValid: row.fullResearchReproductionValid, allStagesValidRate: row.fullResearchReproductionValidRate } : row);
  const realUses = uses.map(value).filter(row => inMonth(row) && row.researcherOwned !== false && row.evaluation !== true);
  const requestGroups = new Map();
  for (const row of realUses) {
    const key = `${row.projectId}:${row.runId}:${row.track}`;
    if (!requestGroups.has(key)) requestGroups.set(key, []);
    requestGroups.get(key).push(row);
  }
  const requests = [...requestGroups.values()].map(rows => ({ ...rows[0],
    supported: rows.some(row => row.supported === true) ? true : rows.every(row => row.supported === false) ? false : null }));
  const active = tools.map(value).filter(row => row.status === 'active');
  const coverage = new Set(active.flatMap(row => Number(String(row.validationLevel).slice(1)) >= 2 ? (row.holdoutCases ?? []).map((/** @type {any} */ c) => `${c.id}:${c.sha256}`) : []));
  const byTrack = EVOLUTION_TRACKS.map(track => {
    const scored = cases.filter(row => row.track === track && ['time-holdout', 'prospective'].includes(row.group) && !row.excluded
      && !(row.type === 'research' && row.allStagesValid === true && row.codeVerified !== true)
      && row.eligibleForMainMetric !== false && !['question-only','numeric-prospective-prediction','missing-input-response'].includes(row.benchmarkScope)
      && (row.eligibleForMainMetric === true || (row.type === 'research' && ['research','full-research-reproduction'].includes(row.benchmarkScope)))
      && (typeof row.allStagesValid === 'boolean' || (Number.isFinite(row.allStagesValidRate) && Number(row.n) > 0)));
    const n = scored.reduce((sum, row) => sum + (typeof row.allStagesValid === 'boolean' ? 1 : Number(row.n ?? 0)), 0);
    const valid = scored.reduce((sum, row) => sum + (typeof row.allStagesValid === 'boolean' ? Number(row.allStagesValid) : Number(row.n ?? 0) * Number(row.allStagesValidRate ?? 0)), 0);
    const calls = requests.filter(row => row.track === track && typeof row.supported === 'boolean');
    const numeric = cases.filter(row => row.track === track && typeof row.numericEvaluationPassed === 'boolean');
    const clean = scored.filter(row => row.exposureTier === 'unexposed');
    const cleanN = clean.reduce((sum, row) => sum + (typeof row.allStagesValid === 'boolean' ? 1 : Number(row.n ?? 0)), 0);
    const cleanValid = clean.reduce((sum, row) => sum + (typeof row.allStagesValid === 'boolean' ? Number(row.allStagesValid) : Number(row.n ?? 0) * Number(row.allStagesValidRate ?? 0)), 0);
    const byExposure = ['unexposed', 'exposed-unreferenced', 'cited'].map(tier => {
      const selected = scored.filter(row => row.exposureTier === tier || (tier === 'exposed-unreferenced' && ['exposed', 'exposed_uncited'].includes(row.exposureTier)) || (tier === 'cited' && row.exposureTier === 'referenced'));
      const total = selected.reduce((sum, row) => sum + (typeof row.allStagesValid === 'boolean' ? 1 : Number(row.n ?? 0)), 0);
      const passed = selected.reduce((sum, row) => sum + (typeof row.allStagesValid === 'boolean' ? Number(row.allStagesValid) : Number(row.n ?? 0) * Number(row.allStagesValidRate ?? 0)), 0);
      return { tier, allStagesValid: ratio(passed, total) };
    });
    return { track, allStagesValid: ratio(cleanValid, cleanN), includingExposed: ratio(valid, n), byExposure, supportedRealRequests: ratio(calls.filter(row => row.supported).length, calls.length), numericOutcome: ratio(numeric.filter(row => row.numericEvaluationPassed).length, numeric.length) };
  });
  const reachableDenominator = cases.reduce((sum, row) => sum + Number(row.recall?.denominator ?? 0), 0);
  const recalled = cases.reduce((sum, row) => sum + Number(row.recall?.found ?? 0), 0);
  const audited = cases.filter(row => ['unexposed', 'exposed', 'exposed-unreferenced', 'cited', 'referenced', 'exposed_uncited'].includes(row.exposureTier));
  const monthTools = tools.map(value).filter(row => inMonth({ at: row.publishedAt ?? row.createdAt }));
  const leads = dossiers.map(value);
  const latency = monthTools.map(tool => { const dossier = leads.find(row => row.id === tool.dossierId || row.toolId === tool.id); return dossier ? (Date.parse(tool.publishedAt ?? tool.createdAt) - Date.parse(dossier.createdAt)) / 3600000 : NaN; });
  const decided = decisions.map(value).filter(row => inMonth(row) && row.status === 'executed');
  const invoked = active.reduce((sum, row) => sum + Number(row.usage?.invoked ?? 0), 0);
  const retrieved = active.reduce((sum, row) => sum + Number(row.usage?.retrieved ?? 0), 0);
  const size = active.every(row => Number.isFinite(row.artifactBytes)) ? active.reduce((sum, row) => sum + row.artifactBytes, 0) : null;
  const completeMonth = now.getTime() >= end;
  const v2Cards = leads.filter(row => inMonth(row) && row.toolId && tools.map(value).some(tool => tool.id === row.toolId && Number(String(tool.validationLevel).slice(1)) >= 2)).length;
  return { month, observationWindow: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), complete: completeMonth, status: completeMonth ? 'observed' : 'not-observed' }, byTrack,
    reachableEvidenceRecall: ratio(recalled, reachableDenominator), connectorGaps: cases.reduce((sum, row) => sum + (row.recall?.connectorGaps?.length ?? 0), 0),
    exposureLeakage: ratio(audited.filter(row => row.exposureTier !== 'unexposed').length, audited.length), developmentAssetAccesses: budgetSummary.developmentAssetAccesses ?? null,
    v2DossierRate: ratio(v2Cards, leads.filter(inMonth).length), medianLeadToPublicationHours: median(latency.filter(hours => hours >= 0)),
    verifiedCaseCoverage: coverage.size, v3ResearchCoverage: active.filter(row => ['V3', 'V4'].includes(row.validationLevel)).reduce((sum, row) => sum + Math.max(0, ...(row.assessments ?? []).filter((/** @type {any} */ a) => a.kind === 'research' && a.passed).map((/** @type {any} */ a) => Number(a.papers ?? 0))), 0),
    invocationToRetrieval: ratio(invoked, retrieved), researcherCostCny: realUses.length && realUses.every(row => Number.isFinite(row.costCny)) ? realUses.reduce((sum, row) => sum + row.costCny, 0) : null,
    platformCostCny: budgetSummary.costCny ?? null, harmRetirements: tools.map(value).filter(row => row.retirement?.reason === 'sequential-harm' && inMonth({ at: row.retirement.at })).length,
    inventorySnapshot: { observedAt: now.toISOString(), scope: 'current-observed-library', historicalMonthEnd: false, telemetryScope: 'active-library-lifetime' },
    activeArtifactBytes: size, sizeAtSameCoverage: completeMonth && Number.isFinite(size) && Number.isFinite(previous?.activeArtifactBytes)
      && previous?.inventorySnapshot?.scope === 'current-observed-library' && Date.parse(previous.inventorySnapshot.observedAt) < now.getTime()
      && previous?.verifiedCaseCoverage === coverage.size ? { observed: true, deltaBytes: size - previous.activeArtifactBytes,
        fromObservedAt: previous.inventorySnapshot.observedAt, toObservedAt: now.toISOString() } : { observed: false, deltaBytes: null },
    operatorOverrides: ratio(decided.filter(row => row.overridden).length, decided.length), autonomousShare: ratio(decided.filter(row => ['autonomous', 'default', 'resource-alternative', 'conservative'].includes(row.source)).length, decided.length),
    safetyRegressions: budgetSummary.safetyRegressions ?? null, newBlockingPoints: budgetSummary.newBlockingPoints ?? null };
}
