/** Exact immutable source comparison identity; display labels never identify a cohort. */
import { geoComparisonKey } from './geoComparison.mjs';
export function geoSourceGroup(row, questions, groups, rounds) {
    const question = questions.get(row.questionId), group = groups.get(row.groupId), setVersion = question?.set_version ?? rounds.get(row.roundId)?.set_version ?? group?.set_version ?? null;
    return { setVersion, groupId: row.groupId ?? null, groupName: group?.name ?? (row.groupId ? '未映射问题群' : '问题群未知'), groupState: group ? 'known' : row.groupId ? 'unmapped' : 'unknown' };
}
export function geoSourceCohort(row, questions, rounds) {
    const setVersion = questions.get(row.questionId)?.set_version ?? rounds.get(row.roundId)?.set_version ?? null;
    const mode = row.surface?.mode ?? null;
    return { comparisonCohortKey: JSON.stringify([setVersion, geoComparisonKey(row)]), setVersion, questionId: row.questionId ?? null, engine: row.engine ?? null, mode, known: Boolean(row.questionId && row.engine && mode && setVersion != null) };
}
/** Exhaustiveness is an explicit preserved producer assertion, never inferred from status or an array. */
export function geoSourceCitationComplete(row) {
    return row.status === 'valid' && row.surface?.citationObservation?.schemaVersion === 1 && row.surface.citationObservation.capability === 'linked_list' && row.surface.citationObservation.complete === true;
}
