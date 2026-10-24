/** Complete preserved citation universe over the selected source-answer cohort. No retrieval inference or live URL resolution. */
import { createHash } from 'node:crypto';
import { documentExportDigest, GEO_SOURCE_KIND_LABELS_ZH } from '@evimed/domain';
import { sourceCitation } from './geoSourceAnswers.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
const groupBy = (items, key) => {
    const groups = new Map();
    for (const item of items) {
        const value = key(item);
        if (!groups.has(value))
            groups.set(value, []);
        groups.get(value).push(item);
    }
    return groups;
};
const unique = items => [...new Map(items.map(item => [item.id, item])).values()];
const answerItem = row => ({
    id: row.snapshotId, unit: 'answers', snapshotId: row.snapshotId, questionId: row.questionId, roundId: row.roundId, engine: row.engine, repeatIndex: row.repeatIndex, askedAt: row.askedAt ?? null, status: row.status, judgment: row.assessmentFacts ?? row.facts ?? null, citations: row.citations ?? []
});
/** Complete relevant catalogue keys, before type/name filters are applied. @param {any} selected */
export function selectedSourceDomains(selected) {
    return [...new Set(selectedSourceObservations(selected).flatMap(row => (row.citations??[]).flatMap(citation => {
        const reference=sourceCitation(citation);
        return reference?[reference.domain]:[];
    })))].sort();
}
/** The source branch admits valid/refusal deduped observations, including partial or missing judgement. */
export function selectedSourceObservations(selected) {
    return (selected.computed.balance.deduped ?? []).filter(row => ['valid', 'refusal'].includes(row.status));
}
/** @param {any} selected @param {any} view @param {any} [context] */
export function buildGeoSourceAnalysis(selected, view, context = {}) {
    const observations = selectedSourceObservations(selected), catalog = new Map((context.sources ?? []).map(source => [String(source.domain).toLowerCase().replace(/^www\./u, ''), source]));
    const bySnapshot = new Map(), byDomain = new Map(), byPage = new Map(), pairs = [], rowBySnapshot = new Map(observations.map(row => [row.snapshotId, row])), sourceTypes = new Set(), categories = new Map();
    for (const row of observations) {
        const seen = new Map();
        for (const citation of row.citations ?? []) {
            const reference=sourceCitation(citation);
            if (!reference) continue;
            const {domain,key}=reference, source=catalog.get(domain), sourceType=source?.kind||'unknown';
            sourceTypes.add(sourceType);
            const existing = seen.get(key) ?? {
                id: hash([row.snapshotId, key]), row, snapshotId: row.snapshotId, sourceKey: key, domain, sourceType, name: source?.name ?? null, sourceId: source?.id ?? null, originalUrls: [], titles: []
            };
            existing.originalUrls.push(String(citation.url));
            if (citation.title)
                existing.titles.push(String(citation.title));
            seen.set(key, existing);
        }
        for (const pair of seen.values()) {
            pair.originalUrls = [...new Set(pair.originalUrls)].sort();
            pair.titles = [...new Set(pair.titles)].sort();
            if (view.sourceType && pair.sourceType !== view.sourceType)
                continue;
            if (view.sourceRelationship === 'wrong' && row.failureMode !== 'wrong_ours')
                continue;
            if (view.sourceRelationship === 'mentions' && row.mentionsOurs !== true)
                continue;
            if (view.sourceSearch && !`${pair.domain} ${pair.name ?? ''} ${pair.originalUrls.join(' ')} ${pair.titles.join(' ')}`.toLowerCase().includes(view.sourceSearch.toLowerCase()))
                continue;
            const category=view.viewId==='V17'?pair.sourceType:view.sourceLevel==='page'?pair.sourceKey:pair.domain;
            if (!categories.has(category)) {
                if (categories.size>=20000) throw new HttpError(422,'geo_read_filter_invalid','Narrow the scope to at most 20,000 analysis rows.');
                categories.set(category,[]);
            }
            categories.get(category).push(pair);
            pairs.push(pair);
            for (const [map, key] of [[bySnapshot, row.snapshotId], [byDomain, pair.domain], [byPage, pair.sourceKey]]) {
                if (!map.has(key))
                    map.set(key, []);
                map.get(key).push(pair);
            }
        }
    }
    const roundMetadata=new Map(selected.rounds.map(round=>[round.id,round.kind??null]));
    const zeroHistory=[...new Set(observations.map(row=>row.roundId))].sort().map(roundId=>Object.freeze({roundId,kind:roundMetadata.get(roundId)??null,citedAnswers:0}));
    const pageContext = batch => [...groupBy(batch, pair => pair.sourceKey)].sort(([a], [b]) => a.localeCompare(b)).map(([key, matching]) => ({
        sourceKey: key, domain: matching[0].domain, sourceType: matching[0].sourceType, originalUrls: [...new Set(matching.flatMap(pair => pair.originalUrls))].sort(), titles: [...new Set(matching.flatMap(pair => pair.titles))].sort(), snapshotIds: [...new Set(matching.map(pair => pair.snapshotId))].sort()
    }));
    const answerMembers = batch => [...groupBy(batch, pair => pair.snapshotId)].sort(([a], [b]) => a.localeCompare(b)).map(([, matching]) => ({ ...answerItem(matching[0].row), source: { pages: pageContext(matching), cooccurrenceOnly: true } }));
    const pairMembers = batch => batch.map(pair => ({
        ...answerItem(pair.row), id: pair.id, unit: 'source_pairs', source: {
            sourceKey: pair.sourceKey, domain: pair.domain, pages: pageContext([pair]), cooccurrenceOnly: true
        }
    }));
    const pageMembers = batch => [...groupBy(batch, pair => pair.sourceKey)].sort(([a], [b]) => a.localeCompare(b)).map(([key, matching]) => { const page = pageContext(matching)[0]; return {
        id: key, unit: 'source_pages', source: { ...page, pages: [page], cooccurrenceOnly: true }, citingAnswers: answerMembers(matching)
    }; });
    const memberItems = new Map(), rows = [];
    const columns = (view.viewId === 'V17' ? [
        ['answers', '引用回答', 'answers'], ['coverage', '类型回答覆盖率', 'percent'], ['pairs', '回答与页面配对', 'source_pairs'], ['pages', '不同页面', 'source_pages']
    ] : [['answers', '引用回答', 'answers'], ['pairs', '回答与页面配对', 'source_pairs'], ['pages', '不同页面', 'source_pages'], ['rounds', '实际出现轮次', 'rounds'], ['wrong', '共同出现我方错误的回答', 'answers'], ['mentions', '共同出现品牌提及的回答', 'answers'], ['knownTime', '采样时间已知回答', 'answers'], ['unknownTime', '采样时间未知回答', 'answers']]).map(([key, label, unit]) => ({
        key, label, unit, type: 'number'
    }));
    const denominator = bySnapshot.size;
    function append(key, label, batch, dimensions) {
        const answers=answerMembers(batch),pages=pageMembers(batch),pairItems=pairMembers(batch),answersByRound=groupBy(answers,answer=>answer.roundId),rounds=[...answersByRound.keys()].sort();
        const history=zeroHistory.map(zero=>answersByRound.has(zero.roundId)?{...zero,citedAnswers:answersByRound.get(zero.roundId).length}:zero);
        const times = answers.map(answer => answer.askedAt).filter(Boolean).sort(), row = {
            key: hash([view.viewId, key]), label, metricId: null, dimensions: {
                ...dimensions, originalUrls: [...new Set(batch.flatMap(pair => pair.originalUrls))].sort(), firstObserved: times[0] ?? null, lastObserved: times.at(-1) ?? null, history, cooccurrenceOnly: true
            }, values: {}, links: []
        };
        const members = {
            answers, coverage: answers, pairs: pairItems, pages, rounds: rounds.map(roundId => ({
                id: roundId, unit: 'rounds', roundId, citingAnswers: answersByRound.get(roundId)
            })), wrong: answers.filter(answer => rowBySnapshot.get(answer.snapshotId)?.failureMode === 'wrong_ours'), mentions: answers.filter(answer => rowBySnapshot.get(answer.snapshotId)?.mentionsOurs === true), knownTime: answers.filter(answer => answer.askedAt), unknownTime: answers.filter(answer => !answer.askedAt)
        };
        for (const column of columns) {
            const items = members[column.key];
            row.values[column.key] = {
                value: column.key === 'coverage' ? (denominator ? answers.length / denominator * 100 : null) : items.length, state: column.key === 'coverage' && !denominator ? 'no_data' : 'known', unit: column.unit, metric: null, members: null, ...(column.key === 'coverage' ? { memberUnit: 'answers', numerator: answers.length, denominator } : {})
            };
            memberItems.set(`${row.key}:${column.key}`, items);
        }
        rows.push(row);
        return row;
    }
    for (const [key,batch] of categories) {
        if (view.viewId==='V17') append(key,GEO_SOURCE_KIND_LABELS_ZH[key]??(key==='unknown'?'类型未知':key),batch,{kind:'source_type',sourceType:key});
        else append(key,view.sourceLevel==='page'?batch[0].originalUrls[0]:key,batch,{kind:view.sourceLevel==='page'?'source_page':'source_domain',domain:batch[0].domain,sourceKey:view.sourceLevel==='page'?key:null,sourceId:batch[0].sourceId,sourceType:batch[0].sourceType});
    }
    rows.sort((a, b) => b.values.answers.value - a.values.answers.value || b.values.pairs.value - a.values.pairs.value || a.key.localeCompare(b.key));
    const chartRows = rows.slice(0, view.topN ?? 15), chartColumn = view.viewId === 'V17' ? 'coverage' : 'pairs', cells = chartRows.map(row => ({
        rowKey: row.key, columnKey: chartColumn, label: row.label, value: row.values[chartColumn].value, state: row.values[chartColumn].state, unit: row.values[chartColumn].unit, engine: null, groupId: null, setVersion: null
    }));
    if (rows.length > chartRows.length) {
        const rest = rows.slice(chartRows.length), restKeys = new Set(rest.map(row => view.viewId === 'V17' ? row.dimensions.sourceType : view.sourceLevel === 'page' ? row.dimensions.sourceKey : row.dimensions.domain)), key = hash([view.viewId, 'chart-remainder', view.topN]), restPairs = pairs.filter(pair => restKeys.has(view.viewId === 'V17' ? pair.sourceType : view.sourceLevel === 'page' ? pair.sourceKey : pair.domain));
        const items = view.viewId === 'V17' ? answerMembers(restPairs) : pairMembers(restPairs);
        memberItems.set(`${key}:${chartColumn}`, items);
        cells.push({
            rowKey: key, columnKey: chartColumn, label: '其余来源', value: view.viewId === 'V17' ? (denominator ? items.length / denominator * 100 : null) : items.length, state: 'known', unit: chartColumn === 'coverage' ? 'percent' : 'source_pairs', engine: null, groupId: null, setVersion: null
        });
    }
    const citedAnswers = unique(pairs.map(pair => answerItem(pair.row)));
    return {
        rows, columns, memberItems, chart: {
            kind: 'sources', mode: view.viewId === 'V17' ? 'type_coverage' : 'source_concentration', labels: [], series: [], cells, denominator: view.viewId === 'V17' ? denominator : pairs.length, topN: view.topN ?? 15, totalCategories: rows.length
        }, contextualBasis: context.sources?.length ? [{
                kind: 'source_catalogue', id: 'sources', version: null, digest: hash(context.sources), temporalBasis: 'current_context'
            }] : [], dependencies: { sources: context.sources ?? [] }, availability: { status: rows.length ? 'ready' : 'empty', reasons: ['preserved_citations_partial_judgement', 'source_relationship_cooccurrence_only', 'unlinked_citations_unobservable'], remedy: null }, definition: {
            unit: view.viewId === 'V17' ? 'answers' : 'source_pairs', methodVersion: selected.selection.methodVersion, sourceTypes: [...sourceTypes].sort(), countingRule: 'Distinct admitted selected valid/refusal answers; partial judgement retains usable preserved citations. Each type is a distinct-answer union; type coverage overlaps and is not a composition. Query-preserving source keys deduplicate repeated pages within one answer.', denominatorRule: 'Type coverage divides by filtered cited answers. Concentration divides by all filtered distinct (snapshot, source-key) pairs, including the complete remainder. Wrong/brand columns are co-occurrence, never source causation. Catalogue labels are current context; no live redirects or inferred alias merges.', knownTimeAnswers: citedAnswers.filter(answer => answer.askedAt).length, unknownTimeAnswers: citedAnswers.filter(answer => !answer.askedAt).length, refusedAnswers: observations.filter(row => row.status === 'refusal').length, linklessAnswers: observations.filter(row => (row.citations ?? []).length && !bySnapshot.has(row.snapshotId) && !(row.citations ?? []).some(sourceCitation)).length, unlinkedCitationCapability: 'unobservable', maps: { snapshots: bySnapshot.size, domains: byDomain.size, pages: byPage.size }
        }
    };
}
