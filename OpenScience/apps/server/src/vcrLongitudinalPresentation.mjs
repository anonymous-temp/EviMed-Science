/** Presentation of ledger-derived summaries. The caller names the projection;
 * an arbitrary user-supplied dataClass cannot exempt a model card or a report.
 *
 * Hidden knowledge:
 *
 * - **The page reads a batch's ledger whole; a run never does** (review eng P1-3). A batch forecast's per-status head counts and its
 *   reason histogram are people counts the model boundary hides (`accounting`, `accountingReasons` in the domain's vocabulary); the
 *   study's own page (`{ page: true }`, the routes only) gets them back from the saved summary, because who was rejected and why is what
 *   the person reads the ledger for. Nothing else is restored, and the model projections never pass the option. */
import { suppressForModel } from '@evimed/domain';

/** The summary keys only the page projection restores. */
const PAGE_LEDGER_KEYS = Object.freeze(['accounting','accountingReasons']);

/** A comparison with an observed block that carries no `outcomeHistoryId` was written before the outcome history joined its class and
 * lineage (F01/F02): its stored class may be a synthetic exemption its real outcomes never had, and its lineage does not hold the
 * history's. Until the startup repair (`repairComparisons`) settles the row it is read as patient-class with the observed block
 * withheld, so a stored class weaker than the strictest of its lineage is never what a reader is served.
 * @param {any} record */
function unsettledComparison(record) {
  return record?.kind === 'comparison' && record.summary?.observed != null && record.summary.outcomeHistoryId === undefined;
}

/** @param {any} record @param {any} options */
function artifact(record,options) {
  if (unsettledComparison(record)) record = {...record,summary:{...record.summary,observed:null,observedWithheld:'lineage_unsettled',dataClass:'patient'}};
  const shown = suppressForModel(record,options);
  if (!record?.summary || !String(record.id).startsWith('vlf_')) return shown;
  if (record.summary.dataClass === 'synthetic') return {...shown,summary:structuredClone(record.summary)};
  if (options?.page === true && shown.summary) for (const key of PAGE_LEDGER_KEYS) if (record.summary[key] !== undefined) shown.summary[key] = structuredClone(record.summary[key]);
  /** Only time and group identities are restored, never hidden counts. */
  const timed = (/** @type {any} */ row,/** @type {any} */ original) => row.suppressed?.length
    ? {...row,...(original.horizonDays != null ? {horizonDays:original.horizonDays} : {}),
      ...(original.day != null ? {day:original.day} : {}),
      ...(original.targetAt ? {targetAt:original.targetAt} : {}),displayReason:'small_cell_suppression'} : row;
  for (const key of ['groups','trajectories','designInputs']) {
    const original = record.summary[key];
    if (!Array.isArray(original) || !Array.isArray(shown.summary?.[key])) continue;
    shown.summary[key] = shown.summary[key].map((/** @type {any} */ row,/** @type {number} */ index) => timed(row,original[index]));
  }
  if (Array.isArray(shown.summary?.subgroups)) shown.summary.subgroups = shown.summary.subgroups.map((/** @type {any} */ row,/** @type {number} */ index) => {
    const original = record.summary.subgroups[index];
    return {...row,site:original.site,groups:row.groups ? row.groups.map((/** @type {any} */ group,/** @type {number} */ i) => timed(group,original.groups[i]))
      : original.groups.map((/** @type {any} */ group) => ({horizonDays:group.horizonDays,displayReason:'small_cell_suppression'}))};
  });
  return shown;
}

/** Only accepts metadata from longitudinalIndex or saved artifacts. `options.page` is the study page's projection (see the header).
 * @param {any} payload @param {{ minCell?: number, page?: boolean }} [options] */
export function presentLongitudinal(payload,options = {}) {
  if (payload?.id) return artifact(payload,options);
  const shown = suppressForModel(payload,options);
  for (const key of ['records','related']) if (Array.isArray(payload?.[key])) shown[key] = payload[key].map((/** @type {any} */ row) => artifact(row,options));
  if (payload.byId) shown.byId = Object.fromEntries([...(shown.records ?? []),...(shown.related ?? [])].map(row => [row.id,row.summary]));
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
