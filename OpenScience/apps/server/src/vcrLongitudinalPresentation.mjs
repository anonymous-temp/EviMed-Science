/** Presentation of ledger-derived summaries. The caller names the projection;
 * an arbitrary user-supplied dataClass cannot exempt a model card or a report. */
import { suppressForModel } from '@evimed/domain';

/** @param {any} record @param {any} options */
function artifact(record,options) {
  const shown = suppressForModel(record,options);
  if (!record?.summary || !String(record.id).startsWith('vlf_')) return shown;
  if (record.summary.dataClass === 'synthetic') return {...shown,summary:structuredClone(record.summary)};
  for (const key of ['groups','trajectories','designInputs']) {
    const original = record.summary[key];
    if (!Array.isArray(original) || !Array.isArray(shown.summary?.[key])) continue;
    shown.summary[key] = shown.summary[key].map((/** @type {any} */ row,/** @type {number} */ index) => row.suppressed?.length
      ? {...row,...(original[index].horizonDays != null ? {horizonDays:original[index].horizonDays} : {}),
        ...(original[index].day != null ? {day:original[index].day} : {}),displayReason:'small_cell_suppression'} : row);
  }
  return shown;
}

/** Only accepts metadata from longitudinalIndex or saved artifacts.
 * @param {any} payload @param {any} [options] */
export function presentLongitudinal(payload,options = {}) {
  if (payload?.id) return artifact(payload,options);
  const shown = suppressForModel(payload,options);
  for (const key of ['records','related']) if (Array.isArray(payload?.[key])) shown[key] = payload[key].map((/** @type {any} */ row) => artifact(row,options));
  return shown;
}

/** Restore only platform-owned projections after generic suppression.
 * @param {any} original @param {any} shown @param {string} what @param {any} options */
export function presentLongitudinalRead(original,shown,what,options) {
  if (what === 'longitudinal') return presentLongitudinal(original,options);
  const report = what === 'report_model' ? original.model ?? original : null;
  const target = what === 'report_model' ? shown.model ?? shown : null;
  if (report?.longitudinal) target.longitudinal = presentLongitudinal(report.longitudinal,options);
  if (report?.modelAnalysis?.longitudinal) target.modelAnalysis.longitudinal = presentLongitudinal(report.modelAnalysis.longitudinal,options);
  const pairs = what === 'results' ? (original.results ?? []).map((/** @type {any} */ result,/** @type {number} */ i) => [result,shown.results[i]])
    : what === 'job_result' && original.result ? [[original.result,shown.result]] : [];
  for (const [result,presented] of pairs) if (result.kind === 'longitudinal' && result.diagnostics?.longitudinal && presented?.diagnostics) {
    presented.diagnostics.longitudinal = presentLongitudinal(result.diagnostics.longitudinal,options);
  }
  return shown;
}
