import type { GeoDiagnosis, GeoMonitoring, GeoProject, GeoStrategyView } from '@/lib/geoClient';
import type { GeoLoad } from './geoProjectData';

/** Descriptor rows and empty member envelopes are not observations. Preserve actual zero and partial samples. */
function hasObservation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasObservation);
  const cell = value as Record<string, unknown>;
  if (['value', 'numerator', 'denominator', 'ciLow', 'ciHigh'].some(key => typeof cell[key] === 'number')) return true;
  if (Array.isArray(cell.snapshotIds) && cell.snapshotIds.length > 0) return true;
  const members = cell.members as {total?: number | null; shown?: number} | undefined;
  if ((members?.total ?? 0) > 0 || (members?.shown ?? 0) > 0) return true;
  const assessment = cell.assessment as Record<string, unknown> | undefined;
  if (assessment && Object.entries(assessment).some(([key, count]) => key.endsWith('Answers') && typeof count === 'number' && count > 0)) return true;
  return Object.entries(cell).some(([key, child]) => key !== 'members' && key !== 'assessment' && hasObservation(child));
}

/** First use is proven by successful independent reads, never inferred from one unavailable metric. */
export function geoOverviewFirstUse(project: GeoProject, diagnosis: GeoLoad<GeoDiagnosis>, monitoring: GeoLoad<GeoMonitoring>, strategy: GeoLoad<GeoStrategyView>): boolean {
  if (diagnosis.kind !== 'ready' || monitoring.kind !== 'ready' || strategy.kind !== 'ready') return false;
  if (diagnosis.refreshError || monitoring.refreshError || strategy.refreshError) return false;
  const d = diagnosis.data, m = monitoring.data, p = strategy.data;
  // A zero numerator is still an observed answer. Null current rates do not erase partial or unavailable observations.
  const retainedCell = hasObservation;
  const retainedPlan = p.battlefield || p.noGo?.length || p.engines?.length || p.tiers?.length || p.assumptions?.length
    || p.layout?.constraints?.length || p.layout?.clientActions?.length
    || Object.values(p.layout?.layers ?? {}).some(rows => rows?.length)
    || (p.gaps?.total ?? 0) > 0 || (p.gaps?.withoutAction ?? 0) > 0 || (p.actions?.total ?? 0) > 0
    || Object.values(p.actions?.byStatus ?? {}).some(count => (count ?? 0) > 0);
  if (retainedPlan || retainedCell(d.failureModes) || retainedCell(d.noise) || retainedCell(m.arms?.netEffect)
    || d.byClaim?.length || (d.errorPage?.total ?? 0) > 0 || (d.errorCounts?.total ?? 0) > 0
    || [d.activeErrorSummary, d.errorSummary, d.scopeErrorSummary].some(summary => (summary?.total ?? 0) > 0)
    || d.noise || p.targets?.targetsVersion != null || m.rivals?.some(rival => rival.points?.length || rival.ownPoints?.length)
    || m.next || p.createdAt || p.runId) return false;
  return !project.budget && !project.needsYou?.length && !project.overview.week?.length
    && !project.overview.metrics.some(metric => retainedCell(metric.cell) || metric.trend?.length)
    && !Object.values(project.steps).some(step => step && (step.status !== 'none' || step.requested))
    && !d.round && !d.rounds?.length && !d.errors?.length && !hasObservation(d.byEngine) && !hasObservation(d.byPool) && !hasObservation(d.more)
    && !m.series?.some(series => series.points.length) && !m.byEngine?.some(engine => engine.points.length)
    && !m.cited?.length && !m.newErrors?.length && !m.arms?.pilot?.length && !m.arms?.control?.length
    && p.version == null && !p.summary && !p.implementation?.actions?.length && !p.basis
    && !p.targets?.baselineRound && !p.targets?.latestRound && !p.targets?.rows?.length;
}

/** No-measurement layout is independent of whether evidence, questions or a plan already exist. */
export function geoOverviewNeedsMeasurement(project: GeoProject, diagnosis: GeoLoad<GeoDiagnosis>, monitoring: GeoLoad<GeoMonitoring>): boolean {
  if (diagnosis.kind !== 'ready' || monitoring.kind !== 'ready' || diagnosis.refreshError || monitoring.refreshError) return false;
  const d = diagnosis.data, m = monitoring.data;
  const numeric = hasObservation;
  return !d.round && !d.rounds?.length && !d.errors?.length && !hasObservation(d.byEngine) && !hasObservation(d.byPool) && !d.byClaim?.length && !hasObservation(d.more)
    && !numeric(d.failureModes) && !d.noise && !(d.errorPage?.total || d.errorCounts?.total)
    && ![d.activeErrorSummary, d.errorSummary, d.scopeErrorSummary].some(summary => (summary?.total ?? 0) > 0)
    && !project.overview.metrics.some(metric => numeric(metric.cell) || metric.trend?.length)
    && !m.series?.some(series => series.points.length) && !m.byEngine?.some(engine => engine.points.length)
    && !m.rivals?.some(rival => rival.points?.length || rival.ownPoints?.length)
    && !m.cited?.length && !m.newErrors?.length && !m.arms?.pilot?.length && !m.arms?.control?.length && !numeric(m.arms?.netEffect);
}
