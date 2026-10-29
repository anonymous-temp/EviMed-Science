/** Shared observational comparison basis; the presenter never subtracts incompatible readings. */
import { computeGvi, geoMetricMembers, documentExportDigest } from '@evimed/domain';
export const geoComparisonKey = row => JSON.stringify([row.questionId, row.engine, row.surface?.mode ?? null]);
export const geoComparableAnswer = row => Boolean(row.questionId) && (row.status === 'refusal' || row.status === 'valid' && Boolean(row.facts));
export const geoComparisonCellKey = cell => documentExportDigest([cell.scope, cell.metricId, cell.pool, cell.engine, cell.groupId, cell.arm, cell.variant, cell.rival]);
export function geoComparisonMembers(selected, metric) {
    if (!metric)
        return { rows: [], unit: 'answers' };
    const input = metric.scope === 'engine' || metric.scope === 'pool_engine' || metric.metricId === 'M-20' ? selected.computed.balance.deduped : selected.computed.balance.rows;
    return geoMetricMembers(input, metric, selected.metricOptions);
}
const memberKeys = (selected, metric) => [...new Set(geoComparisonMembers(selected, metric).rows.map(row => documentExportDigest([geoComparisonKey(row), row.pool, row.groupId])))].sort();
function compositeBasis(selected, metric) {
    if (metric?.metricId !== 'M-19')
        return null;
    const gvi = computeGvi(selected.computed.cells, { arm: metric.arm });
    return (metric.pool ? [metric.pool] : gvi.poolsUsed).map(pool => {
        const index = gvi.pools[pool];
        return { pool, weight: metric.pool ? 1 : gvi.poolWeights[pool], dimensions: Object.entries(index?.dimensions ?? {}).map(([dimension, entry]) => ({
                dimension, weight: index.effectiveWeights[dimension] ?? null,
                ingredients: entry.used.map(metricId => {
                    const ingredient = selected.computed.cells.find(candidate => candidate.metricId === metricId && candidate.pool === pool && candidate.scope === (metric.arm ? 'arm' : 'pool') && candidate.arm === metric.arm && !candidate.engine && !candidate.variant && !candidate.rival);
                    return { metricId, members: memberKeys(selected, ingredient) };
                }),
            })) };
    });
}
const contractKeys = selected => [...new Set((selected.selection.comparability?.samplingContracts ?? [null]).map(contract => documentExportDigest(contract ? { samplingMode: contract.samplingMode, repeats: contract.repeats, sourceBasis: contract.sourceBasis, metricIds: contract.metricIds } : null)))].sort();
export function geoComparisonContractsMatch(left, right) {
    return contractKeys(left).length === 1 && documentExportDigest(contractKeys(left)) === documentExportDigest(contractKeys(right));
}
/** Both cohorts have already been selected by the canonical common-cohort read. @param {any} left @param {any} right @param {{mode:string,commonCount:number}} options */
export function compareGeoMetricCohorts(left, right, { mode, commonCount }) {
    const before = new Map(right.computed.cells.map(cell => [geoComparisonCellKey(cell), cell]));
    const methods = selected => [selected.selection.methodVersion, [...(selected.selection.comparability?.methodVersions ?? [])].sort()];
    const methodMatches = documentExportDigest(methods(left)) === documentExportDigest(methods(right));
    const contractMatches = geoComparisonContractsMatch(left, right);
    return left.computed.cells.map(cell => {
        const old = before.get(geoComparisonCellKey(cell));
        const reason = mode !== 'common' ? 'separate_cohorts' : !commonCount ? 'no_common_cohort' : !methodMatches ? 'measurement_method_changed' : !contractMatches ? 'measurement_contract_changed' : !old ? 'previous_metric_absent' : documentExportDigest(compositeBasis(left, cell)) !== documentExportDigest(compositeBasis(right, old)) ? 'comparison_basis_changed' : documentExportDigest(memberKeys(left, cell)) !== documentExportDigest(memberKeys(right, old)) ? 'metric_members_changed' : null;
        const comparable = reason === null;
        const measurable = comparable && cell.status === 'ok' && old?.status === 'ok' && cell.value != null && old.value != null;
        return { metricId: cell.metricId, scope: cell.scope, pool: cell.pool, engine: cell.engine, groupId: cell.groupId, arm: cell.arm, variant: cell.variant, rival: cell.rival, current: cell, previous: old ?? null, comparable, reason,
            delta: measurable ? Math.round((cell.value - old.value) * 100) / 100 : null };
    });
}
