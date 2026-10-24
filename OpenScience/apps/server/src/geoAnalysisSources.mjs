/** Complete preserved citation universe over the selected source-answer cohort. No retrieval inference or live URL resolution. */
import { createHash } from 'node:crypto';
import { documentExportDigest, GEO_SOURCE_KIND_LABELS_ZH, GEO_SOURCE_RELATIONSHIPS, GEO_SOURCE_RELATIONSHIP_LABELS_ZH, geoMetricMembers } from '@evimed/domain';
import { sourceCitation } from './geoSourceAnswers.mjs';
import { buildGeoSourceHistory } from './geoAnalysisSourceHistory.mjs';
import { geoSourceGroup } from './geoAnalysisSourceCohort.mjs';
import { computeGeoSelection } from './geoReadScope.mjs';
import { GeoSourceOwnership, normalizeGeoOwnershipTarget } from './geoSourceOwnership.mjs';
import { ProductDocuments } from './productStore.mjs';
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
const exactPage = url => normalizeGeoOwnershipTarget({kind:'page',value:url}).key;
function citedPublications(publications, urls, articles) {
    const cited = new Set(urls.map(exactPage)), byArticle = new Map(articles.map(article=>[article.id,article]));
    return publications.filter(publication=>cited.has(exactPage(publication.url))&&byArticle.has(publication.articleId)).map(publication=>({...publication,
        versionState: !publication.resultVersionId || !byArticle.get(publication.articleId).resultVersionId ? 'unknown' : publication.resultVersionId === byArticle.get(publication.articleId).resultVersionId ? 'current_article' : 'different_from_current_article'}));
}
/** Deduplicate repeated annotation records without losing any exact URL/revision binding in a frozen row. */
function compactAnnotations(annotations) {
    const records = [], byRecord = new Map();
    const pages = annotations.map(annotation => {
        const { url, ...record } = annotation, key = documentExportDigest(record);
        if (!byRecord.has(key)) { byRecord.set(key, records.length); records.push(record); }
        return { url, recordIndex: byRecord.get(key) };
    });
    return { records, pages };
}
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
    if (view.viewId==='V21') return buildGeoOpportunityAnalysis(selected,view,context);
    if (view.viewId==='V22') return buildGeoSourceHistory(selected,view,buildGeoSourceAnalysis(selected,{...view,viewId:'V18',sourceLevel:'page'},context));
    const questions=new Map((selected.questions??[]).map(question=>[question.id,question])), groups=new Map((context.groups??[]).map(group=>[group.id,group])), roundsById=new Map(view.viewId==='V19'?(selected.rounds??[]).map(round=>[round.id,round]):[]);
    const facet = row => view.sourceFacet==='group'?geoSourceGroup(row,questions,groups,roundsById):{engine:row.engine};
    const annotations=new Map((context.sourceAnnotations??[]).map(annotation=>[annotation.url,annotation]));
    const categoryOf = pair => {if(view.viewId==='V20')return pair.relationship;const sourceKey=view.sourceLevel==='page'?pair.sourceKey:pair.domain;return view.viewId==='V17'?pair.sourceType:view.viewId==='V19'?JSON.stringify([sourceKey,view.sourceFacet,...(view.sourceFacet==='group'?[facet(pair.row).setVersion,facet(pair.row).groupId]:[pair.row.engine])]):sourceKey;};
    const observations = selectedSourceObservations(selected), catalog = new Map((context.sources ?? []).map(source => [String(source.domain).toLowerCase().replace(/^www\./u, ''), source]));
    const bySnapshot = new Map(), byDomain = new Map(), byPage = new Map(), pairs = [], rowBySnapshot = new Map(observations.map(row => [row.snapshotId, row])), sourceTypes = new Set(), categories = new Map();
    for (const row of observations) {
        const seen = new Map();
        for (const citation of row.citations ?? []) {
            const reference=sourceCitation(citation);
            if (!reference) continue;
            const {domain,key}=reference, source=catalog.get(domain), sourceType=source?.kind||'unknown';
            sourceTypes.add(sourceType);
            const annotation=annotations.get(String(citation.url))??{url:String(citation.url),relation:'unknown',reference:null,basis:'unclassified'};
            const relationship=GEO_SOURCE_RELATIONSHIPS.includes(annotation.relation)?annotation.relation:'unknown';
            const pairKey=view.viewId==='V20'?JSON.stringify([key,relationship,annotation.reference]):key;
            const existing = seen.get(pairKey) ?? {
                id: hash([row.snapshotId, pairKey]), relationship, annotations: [], row, snapshotId: row.snapshotId, sourceKey: key, domain, sourceType, name: source?.name ?? null, sourceId: source?.id ?? null, originalUrls: [], titles: [], preservedCitations: []
            };
            existing.preservedCitations.push(citation);
            existing.annotations.push(annotation);
            existing.originalUrls.push(String(citation.url));
            if (citation.title)
                existing.titles.push(String(citation.title));
            seen.set(pairKey, existing);
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
            const category=categoryOf(pair);
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
        sourceKey: key, domain: matching[0].domain, sourceType: matching[0].sourceType, originalUrls: [...new Set(matching.flatMap(pair => pair.originalUrls))].sort(), titles: [...new Set(matching.flatMap(pair => pair.titles))].sort(), snapshotIds: [...new Set(matching.map(pair => pair.snapshotId))].sort(), ...(view.viewId==='V20'?{annotations:[...new Map(matching.flatMap(pair=>pair.annotations).map(annotation=>[annotation.url,annotation])).values()],temporalBasis:'current_context'}:{}), preservedCitations: matching.flatMap(pair=>pair.preservedCitations)
    }));
    const withQuestion = row => {const q=questions.get(row.questionId);return {...answerItem(row),question:q?{text:q.text,originalId:q.original_id??null,originalRow:q.original_row_index??null,originalGroup:q.original_group??null,clientTags:q.client_tags??[]}:null};};
    const answerMembers = batch => [...groupBy(batch, pair => pair.snapshotId)].sort(([a], [b]) => a.localeCompare(b)).map(([, matching]) => ({ ...withQuestion(matching[0].row), source: { pages: pageContext(matching), cooccurrenceOnly: true } }));
    const pairMembers = batch => batch.map(pair => ({
        ...withQuestion(pair.row), id: pair.id, unit: 'source_pairs', source: {
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
    if(view.viewId==='V20') for(const relationship of GEO_SOURCE_RELATIONSHIPS) append(relationship,GEO_SOURCE_RELATIONSHIP_LABELS_ZH[relationship],categories.get(relationship)??[],{kind:'source_relationship',relationship,temporalBasis:'current_context',annotationContext:compactAnnotations([...new Map((categories.get(relationship)??[]).flatMap(pair=>pair.annotations).map(annotation=>[annotation.url,annotation])).values()]),publications:citedPublications(context.opportunityLinks?.publications??[],(categories.get(relationship)??[]).flatMap(pair=>pair.originalUrls),context.opportunityLinks?.articles??[])});
    for (const [key,batch] of view.viewId==='V20'?[]:categories) {
        if (view.viewId==='V17') append(key,GEO_SOURCE_KIND_LABELS_ZH[key]??(key==='unknown'?'类型未知':key),batch,{kind:'source_type',sourceType:key});
        else append(key,[view.sourceLevel==='page'?batch[0].originalUrls[0]:batch[0].domain,...(view.viewId==='V19'?[view.sourceFacet==='engine'?batch[0].row.engine:`${facet(batch[0].row).groupName} · 问题版本 ${facet(batch[0].row).setVersion??'未知'}`]:[])].join(' · '),batch,{kind:view.sourceLevel==='page'?'source_page':'source_domain',domain:batch[0].domain,sourceKey:view.sourceLevel==='page'?batch[0].sourceKey:null,sourceId:batch[0].sourceId,sourceType:batch[0].sourceType,...(view.viewId==='V19'?{sourceLevel:view.sourceLevel,sourceFacet:view.sourceFacet,sourceCategoryKey:key,...facet(batch[0].row)}:{})});
    }
    rows.sort((a, b) => b.values.answers.value - a.values.answers.value || b.values.pairs.value - a.values.pairs.value || a.key.localeCompare(b.key));
    const chartRows = view.viewId==='V20'?rows:rows.slice(0, view.topN ?? 15), chartColumn = view.viewId === 'V17' ? 'coverage' : view.viewId==='V19'?'answers':'pairs', cells = chartRows.map(row => ({
        rowKey: row.key, columnKey: chartColumn, label: row.label, value: row.values[chartColumn].value, state: row.values[chartColumn].state, unit: row.values[chartColumn].unit, engine: row.dimensions.engine??null, groupId: row.dimensions.groupId??null, groupName: row.dimensions.groupName??null, setVersion: row.dimensions.setVersion??null, sourceKey:row.dimensions.sourceKey??row.dimensions.domain, sourceLabel:row.dimensions.sourceKey??row.dimensions.domain, facetKey:view.sourceFacet==='group'?JSON.stringify([row.dimensions.setVersion,row.dimensions.groupId]):row.dimensions.engine??null
    }));
    if (rows.length > chartRows.length) {
        const rest = rows.slice(chartRows.length), restKeys = new Set(rest.map(row => view.viewId==='V19'?row.dimensions.sourceCategoryKey:view.viewId === 'V17' ? row.dimensions.sourceType : view.sourceLevel === 'page' ? row.dimensions.sourceKey : row.dimensions.domain)), key = hash([view.viewId, 'chart-remainder', view.topN]), restPairs = pairs.filter(pair => restKeys.has(categoryOf(pair)));
        const items = ['V17','V19'].includes(view.viewId) ? answerMembers(restPairs) : pairMembers(restPairs);
        memberItems.set(`${key}:${chartColumn}`, items);
        cells.push({
            rowKey: key, columnKey: chartColumn, label: '其余来源', value: view.viewId === 'V17' ? (denominator ? items.length / denominator * 100 : null) : items.length, state: 'known', unit: chartColumn === 'coverage' ? 'percent' : view.viewId==='V19'?'answers':'source_pairs', engine: null, groupId: null, groupName:null,setVersion: null,sourceKey:null,sourceLabel:'其余来源',facetKey:'remainder'
        });
    }
    const citedAnswers = unique(pairs.map(pair => answerItem(pair.row)));
    return {
        rows, columns, memberItems, chart: {
            kind: view.viewId==='V20'?'source_relationships':view.viewId==='V19'?'source_facets':'sources', mode: view.viewId === 'V17' ? 'type_coverage' : 'source_concentration', labels: [], series: [], cells, denominator: ['V17','V19'].includes(view.viewId) ? denominator : pairs.length, topN: view.topN ?? 15, totalCategories: rows.length
        }, contextualBasis: [...(view.viewId==='V20'?[{kind:'source_annotations',id:'annotations',version:null,digest:hash(context.sourceAnnotations??[]),temporalBasis:'current_context'}]:[]),...(context.sources?.length ? [{
                kind: 'source_catalogue', id: 'sources', version: null, digest: hash(context.sources), temporalBasis: 'current_context'
            }] : [])], dependencies: { sources: context.sources ?? [], ...(view.viewId==='V20'?{sourceAnnotations:context.sourceAnnotations??[],opportunityLinks:context.opportunityLinks??null}: {}) }, availability: { status: rows.length ? 'ready' : 'empty', reasons: ['preserved_citations_partial_judgement', 'source_relationship_cooccurrence_only', 'unlinked_citations_unobservable'], remedy: null }, definition: {
            ...(view.viewId==='V20'?{relationshipBasis:'current_context',annotationRule:'Current user annotations resolved for exact actual URLs. Page override precedes exact-host annotation; no historical effective date is inferred. Brand co-occurrence is independent.'}:{}), unit: view.viewId === 'V17' ? 'answers' : 'source_pairs', methodVersion: selected.selection.methodVersion, sourceTypes: [...sourceTypes].sort(), countingRule: 'Distinct admitted selected valid/refusal answers; partial judgement retains usable preserved citations. Each type is a distinct-answer union; type coverage overlaps and is not a composition. Query-preserving source keys deduplicate repeated pages within one answer.', denominatorRule: 'Type coverage divides by filtered cited answers. Concentration divides by all filtered distinct (snapshot, source-key) pairs, including the complete remainder. Wrong/brand columns are co-occurrence, never source causation. Catalogue labels are current context; no live redirects or inferred alias merges.', knownTimeAnswers: citedAnswers.filter(answer => answer.askedAt).length, unknownTimeAnswers: citedAnswers.filter(answer => !answer.askedAt).length, refusedAnswers: observations.filter(row => row.status === 'refusal').length, linklessAnswers: observations.filter(row => (row.citations ?? []).length && !bySnapshot.has(row.snapshotId) && !(row.citations ?? []).some(sourceCitation)).length, unlinkedCitationCapability: 'unobservable', maps: { snapshots: bySnapshot.size, domains: byDomain.size, pages: byPage.size }
        }
    };
}

/** Current annotations are contextual; resolve actual preserved URLs in the producer's bounded batches. */
export async function readGeoSourceAnnotations(store, project, selected) {
    const urls = [...new Set(selectedSourceObservations(selected).flatMap(row => (row.citations ?? []).filter(sourceCitation).map(citation => String(citation.url))))].sort();
    const resolver = new GeoSourceOwnership({ documents: new ProductDocuments(store.database) }), annotations = [];
    for (let offset = 0; offset < urls.length; offset += 1000) annotations.push(...await resolver.resolve(project, urls.slice(offset, offset + 1000)));
    return annotations;
}

/** Read-only exact group/article/claim/publication projection. No writer, source check or live lookup. */
export async function readGeoOpportunityLinks(store, project, selected) {
    const groupIds = [...new Set(selected.rows.map(row => row.groupId).filter(Boolean))];
    const articles = (await store.query(`SELECT a.id,a.group_id AS "groupId",g.set_version AS "setVersion",a.current_result_version_id AS "resultVersionId",a.content_sha256 AS digest,a.claim_ids AS "claimIds",a.status,a.updated_at AS "updatedAt"
      FROM evimed_geo.articles a JOIN evimed_geo.question_groups g ON g.id=a.group_id AND g.geo_project_id=a.geo_project_id
      WHERE a.geo_project_id=$1 AND a.user_id=$2 AND a.group_id=ANY($3::text[]) ORDER BY a.id LIMIT 20001`, [project.id, project.userId, groupIds])).rows;
    const claimIds = [...new Set([...articles.flatMap(article => article.claimIds ?? []), ...selected.rows.flatMap(row => (row.assessmentFacts?.statements ?? row.facts?.statements ?? []).flatMap(statement => statement.claimId ? [statement.claimId] : []))])];
    const claims = (await store.query(`SELECT id,version,status,statement,verified_at AS "verifiedAt",valid_until AS "validUntil",source_ref AS "sourceRef",quote,updated_at AS "updatedAt" FROM evimed_geo.claims WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) ORDER BY id LIMIT 20001`, [project.id, project.userId, claimIds])).rows;
    const publications = (await store.query(`SELECT l.id,l.url,l.article_id AS "articleId",l.article_result_version_id AS "resultVersionId",l.article_digest AS digest,l.status,l.published_at AS "publishedAt",l.updated_at AS "updatedAt"
      FROM evimed_geo.owned_links l WHERE l.geo_project_id=$1 AND l.user_id=$2 AND l.article_id=ANY($3::text[]) ORDER BY l.id LIMIT 20001`, [project.id, project.userId, articles.map(article => article.id)])).rows;
    if ([articles, claims, publications].some(items => items.length > 20000)) throw new HttpError(422, 'geo_read_filter_invalid', 'Narrow the scope to at most 20,000 linked records.');
    const wire = items => items.map(item => Object.fromEntries(Object.entries(item).map(([key,value])=>[key,value instanceof Date?value.toISOString():value])));
    return { articles: wire(articles), claims: wire(claims), publications: wire(publications) };
}

/** Existing domain metrics over exact version/group cohorts; annotation relationship never changes M-08 matching. */
function buildGeoOpportunityAnalysis(selected, view, context) {
    const questions = new Map((selected.questions ?? []).map(question => [question.id, question])), groups = new Map((context.groups ?? []).map(group => [group.id, group])), rounds = new Map(selected.rounds.map(round => [round.id, round]));
    const buckets = new Map(), rows = [], memberItems = new Map(), links = context.opportunityLinks ?? { articles: [], claims: [], publications: [] };
    const annotationByUrl = new Map((context.sourceAnnotations ?? []).map(annotation => [annotation.url, annotation]));
    const articlesByGroup=groupBy(links.articles,article=>JSON.stringify([article.setVersion,article.groupId]));
    const claimsById=new Map(links.claims.map(claim=>[claim.id,claim])), publicationsByArticle=groupBy(links.publications,publication=>publication.articleId);
    for (const input of selected.rows) {
        const dims = geoSourceGroup(input, questions, groups, rounds), key = JSON.stringify([dims.setVersion, dims.groupId]);
        if (!buckets.has(key)) buckets.set(key, { dims, inputs: [] });
        buckets.get(key).inputs.push(input);
        if (buckets.size > 20000) throw new HttpError(422, 'geo_read_filter_invalid', 'Narrow the scope to at most 20,000 groups.');
    }
    const bind = (row, column, inputs, value, extra = {}) => {
        memberItems.set(`${row.key}:${column}`, inputs.map(answerItem));
        return { value, state: 'known', unit: 'answers', metric: null, members: null, ...extra };
    };
    for (const [key, { dims, inputs }] of buckets) {
        const computed = computeGeoSelection(inputs, selected.metricOptions);
        const x = computed.cells.find(cell => cell.metricId === 'M-01' && cell.scope === 'group' && cell.groupId === dims.groupId && !cell.variant && !cell.rival && !cell.arm);
        const y = computed.cells.find(cell => cell.metricId === view.ownedMetricId && cell.scope === (view.ownedMetricId === 'M-08S' ? 'project' : 'group') && (view.ownedMetricId === 'M-08S' || cell.groupId === dims.groupId) && !cell.variant && !cell.rival && !cell.arm);
        const row = { key: hash(['V21', key]), label: `${dims.groupName} · 问题版本 ${dims.setVersion ?? '未知'}`, metricId: null, dimensions: { kind: 'opportunity', ...dims, ownershipBasis: 'registered_metric', registeredOwned: selected.metricOptions.owned ?? {}, temporalBasis: 'current_context', configureAction: { step: 'sources', action: 'configure_owned_sources' } }, values: {}, links: [] };
        for (const [column, cell] of /** @type {const} */ ([['mention', x], ['owned', y]])) {
            const members = cell ? geoMetricMembers(/** @type {any[]} */ (cell.scope === 'engine' ? computed.balance.deduped : computed.balance.rows), cell, selected.metricOptions).rows : [];
            row.values[column] = bind(row, column, members, cell?.value ?? null, { metric: cell ?? null, unit: 'percent', memberUnit: 'answers', numerator: cell?.numerator ?? null, denominator: cell?.denominator ?? null,
                state: cell?.status === 'ok' ? 'known' : cell?.status === 'insufficient' ? 'insufficient' : cell?.reason === 'not_applicable' ? 'not_applicable' : 'unknown', reason: cell?.reason ?? (!cell ? 'group_metric_unavailable' : null) });
        }
        if (!(selected.metricOptions.owned?.domains?.length || selected.metricOptions.owned?.urls?.length)) row.values.owned = {...row.values.owned,value:null,state:'unknown',reason:'owned_not_registered'};
        const sample = /** @type {any[]} */ (computed.balance.deduped).filter(input => ['valid', 'refusal'].includes(input.status));
        row.values.sample = bind(row, 'sample', sample, sample.length);
        const articles = articlesByGroup.get(key) ?? [];
        const claimIds = new Set([...articles.flatMap(article => article.claimIds ?? []), ...inputs.flatMap(input => (input.assessmentFacts?.statements ?? input.facts?.statements ?? []).flatMap(statement => statement.claimId ? [statement.claimId] : []))]);
        const claims = [...claimIds].flatMap(id=>claimsById.has(id)?[claimsById.get(id)]:[]).sort((a,b)=>a.id.localeCompare(b.id));
        const pages = [...new Map(sample.flatMap(input => (input.citations ?? []).filter(sourceCitation).map(citation => [String(citation.url), { url: String(citation.url), ...(annotationByUrl.get(String(citation.url))??{relation:'unknown',reference:null,basis:'unclassified'}) }]))).values()];
        const publications = citedPublications(articles.flatMap(article=>publicationsByArticle.get(article.id)??[]), pages.map(page=>page.url), articles).sort((a,b)=>a.id.localeCompare(b.id));
        const annotationContext = compactAnnotations(pages);
        row.dimensions.gaps = {
            evidence: { state: claims.length ? 'linked' : 'no_explicit_links', items: claims, unresolvedClaimIds: [...claimIds].filter(id => !claims.some(claim => claim.id === id)), action: { step: 'evidence', groupId: dims.groupId, setVersion: dims.setVersion } },
            source: { state: pages.length ? 'observed' : 'unobservable', items: annotationContext.pages, annotationRecords: annotationContext.records, publications, action: { step: 'sources', groupId: dims.groupId, setVersion: dims.setVersion } },
            content: { state: articles.length ? 'linked' : 'no_explicit_links', items: articles, action: { step: 'content', groupId: dims.groupId, setVersion: dims.setVersion } }
        };
        rows.push(row);
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    const ownedNotRegistered = !(selected.metricOptions.owned?.domains?.length || selected.metricOptions.owned?.urls?.length);
    return { rows, memberItems, columns: [{ key: 'mention', label: '品牌提及 M-01（%）', type: 'number' }, { key: 'owned', label: `登记自有信源 ${view.ownedMetricId}（%）`, type: 'number' }, { key: 'sample', label: '实际回答样本', type: 'number' }],
        chart: { kind: 'opportunities', labels: [], series: [], cells: rows.map(row => ({ rowKey: row.key, columnKey: 'mention', label: row.label, engine: null, groupId: row.dimensions.groupId, setVersion: row.dimensions.setVersion, x: row.values.mention.value, y: row.values.owned.value, sampleSize: row.values.sample.value, value: row.values.mention.value, state: row.values.mention.state, yState: row.values.owned.state, unit: 'percent', xDenominator: row.values.mention.denominator, yDenominator: row.values.owned.denominator })) },
        contextualBasis: [{ kind: 'source_annotations', id: 'annotations', version: null, digest: hash(context.sourceAnnotations ?? []), temporalBasis: 'current_context' }, { kind: 'registered_owned_and_explicit_links', id: 'project', version: null, digest: hash([selected.metricOptions.owned ?? {}, links, context.groups ?? []]), temporalBasis: 'current_context' }],
        dependencies: [context.sourceAnnotations ?? [], links, ...memberItems], availability: { status: rows.length ? ownedNotRegistered ? 'partial' : 'ready' : 'empty', reasons: ['registered_metric_not_manual_relationship', 'opportunity_denominators', ...(ownedNotRegistered ? ['owned_not_registered'] : [])], remedy: ownedNotRegistered ? 'configure_owned_sources' : null },
        definition: { unit: 'exact_versioned_groups', methodVersion: selected.selection.methodVersion, countingRule: 'Each exact set-version/group has existing M-01 brand mention X and explicitly selected existing M-08/M-08S registered-owned Y. Bubble area is actual deduplicated returned-answer sample count, never estimated demand, medical priority or causality.', denominatorRule: 'The two domain metric eligibility denominators and floors are independent. M-08 uses traceable retrieval; M-08S uses its existing all-answer eligibility. Registered URL/domain matching retains the domain metric normalization, separately from exact-page current manual annotations. Missing own registration leaves Y null. Explicit linked evidence, content versions and source/publication contexts identify work to inspect; missing links do not prove absence.' }
    };
}
