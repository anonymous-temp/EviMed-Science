import { createHash } from "node:crypto";

/** Shared observational comparison basis; the presenter never subtracts incompatible readings. */
import { computeGvi, geoMetricMembers, geoCellRows, geoCoverageKey, GEO_MEASUREMENT_METHOD_VERSION, documentExportDigest } from '@evimed/domain';
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
// Medical judgments are comparable only when every contributing judgment has one recorded rubric.
const medicalMetrics = new Set(['M-01', 'M-01S', 'M-02', 'M-03', 'M-04', 'M-04C', 'M-05', 'M-06', 'M-07', 'M-11', 'M-12', 'M-13', 'M-14', 'M-15', 'M-16', 'M-17', 'M-18']);
function rubricVersions(selected, cell) {
    let metrics = medicalMetrics.has(cell.metricId) ? [cell] : [];
    if (cell.metricId === 'M-19') {
        const basis = compositeBasis(selected, cell) ?? [];
        metrics = basis.flatMap(({ pool, dimensions }) => dimensions.flatMap(({ ingredients }) => ingredients
            .filter(({ metricId }) => medicalMetrics.has(metricId))
            .map(({ metricId }) => selected.computed.cells.find(candidate => candidate.metricId === metricId && candidate.pool === pool && candidate.scope === (cell.arm ? 'arm' : 'pool') && candidate.arm === cell.arm && !candidate.engine && !candidate.variant && !candidate.rival)).filter(Boolean)));
    }
    // A verdict can change eligibility itself; inspect all valid answers in the cell, not just its current denominator.
    const rows = metrics.flatMap(metric => {
        const input = metric.scope === 'engine' || metric.scope === 'pool_engine' ? selected.computed.balance.deduped : selected.computed.balance.rows;
        return geoCellRows(input, metric, selected.metricOptions);
    });
    const eligible = /** @type {any[]} */ (rows).filter(row => row.status === 'valid' || row.status === 'refusal');
    const judged = eligible.filter(row => row.surface?.mode !== 'inclusion' && (row.status === 'valid' || row.facts));
    const versions = [...new Set(judged.map(row => row.facts?.judgedAt && row.facts?.checks?.judgementCoverage?.status === 'complete' && typeof row.facts?.judgeExtract?.rubricVersion === 'string' && row.facts.judgeExtract.rubricVersion.trim() || null))];
    if (!eligible.length) versions.push(null);
    return { applies: metrics.length > 0, versions };
}
function rubricMismatch(left, right, cell, old) {
    const a = rubricVersions(left, cell), b = rubricVersions(right, old);
    if (!a.applies && !b.applies) return null;
    if (a.versions.length > 1 || b.versions.length > 1 || a.versions.includes(null) || b.versions.includes(null)) return 'judge_version_unknown_or_mixed';
    return !a.versions.length || !b.versions.length || a.versions[0] === b.versions[0] ? null : 'judge_version_changed';
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
        const reason = mode !== 'common' ? 'separate_cohorts' : !commonCount ? 'no_common_cohort' : !methodMatches ? 'measurement_method_changed' : !contractMatches ? 'measurement_contract_changed' : !old ? 'previous_metric_absent' : documentExportDigest(compositeBasis(left, cell)) !== documentExportDigest(compositeBasis(right, old)) ? 'comparison_basis_changed' : documentExportDigest(memberKeys(left, cell)) !== documentExportDigest(memberKeys(right, old)) ? 'metric_members_changed' : rubricMismatch(left, right, cell, old);
        const comparable = reason === null;
        const measurable = comparable && cell.status === 'ok' && old?.status === 'ok' && cell.value != null && old.value != null;
        return { metricId: cell.metricId, scope: cell.scope, pool: cell.pool, engine: cell.engine, groupId: cell.groupId, arm: cell.arm, variant: cell.variant, rival: cell.rival, current: cell, previous: old ?? null, comparable, reason,
            delta: measurable ? Math.round((cell.value - old.value) * 100) / 100 : null };
    });
}


/** A metric-local compatibility key from the exact inputs being computed, never the round's current facts. */
export function geoMetricInputCoverage(selected, cell, setVersion) {
    if (!cell || cell.status !== 'ok') return null;
    const input = cell.scope === 'engine' || cell.scope === 'pool_engine' || cell.metricId === 'M-20' ? selected.computed.balance.deduped : selected.computed.balance.rows;
    const scope = geoCellRows(input, cell, selected.metricOptions).filter(geoComparableAnswer);
    if (!scope.length) return null;
    const rubric = rubricVersions(selected, cell);
    if (rubric.applies && (rubric.versions.includes(null) || rubric.versions.length > 1)) return null;
    const parsed = scope.filter(row => row.surface?.mode !== 'inclusion' && row.status === 'valid');
    const parsers = [...new Set(parsed.map(row => row.facts?.parserVersion || null))];
    if (rubric.applies && (parsers.includes(null) || parsers.length > 1)) return null;
    const surfaces = [...new Set(scope.map(row => JSON.stringify(row.surface ?? null)))];
    if (surfaces.length !== 1) return null;
    const base = geoCoverageKey({ setVersion, pools: [...new Set(scope.map(row => row.pool).filter(Boolean))],
        engines: [...new Set(scope.map(row => row.engine))], surface: JSON.parse(surfaces[0]), methodVersion: GEO_MEASUREMENT_METHOD_VERSION });
    if (!base) return null;
    const cohort = [...new Set(scope.map(row => documentExportDigest([geoComparisonKey(row), row.pool, row.groupId, row.repeatIndex ?? 0])))].sort();
    const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
    const questions = hash([...new Set(scope.map(row => row.questionId))].sort()).slice(0, 24);
    const composite = compositeBasis(selected, cell);
    const usesOwned = metricId => /^M-0[89]/u.test(metricId);
    const ownedDependent = usesOwned(cell.metricId) || composite?.some(pool => pool.dimensions.some(dimension => dimension.ingredients.some(ingredient => usesOwned(ingredient.metricId))));
    return `${base};questions=${questions};basis=${hash({ cell: geoComparisonCellKey(cell), cohort, members: memberKeys(selected, cell),
        composite, rubric: rubric.versions, parsers, samplingMode: selected.metricOptions.samplingMode,
        owned: ownedDependent ? selected.metricOptions.owned : undefined,
        competitors: cell.rival ? selected.metricOptions.competitors : undefined })}`;
}
