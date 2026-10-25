/** Exact journey coverage. Business links are context, never a funnel or inferred medical support. */
import { createHash } from 'node:crypto';
import { documentExportDigest, verifyEvidenceCardClaims, PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { claimFromRow, geoArticleFromRow } from './geoStore.mjs';
import { readEvidenceCardRevisions } from './evidenceZoneService.mjs';
import { readStoredSourceChanges, sourceIdentifiersOf } from './sourceChanges.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const wire = items => items.map(item => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
const bounded = items => { if (items.length > 20000)
    throw new HttpError(422, 'geo_read_filter_invalid', 'Narrow the scope to at most 20,000 linked records.'); return items; };
/** Uses the caller's authorized repeatable-read transaction; no source check, content read or write. @param {any} store @param {any} project */
export async function readGeoEvidenceContext(store, project) {
    const read = async (sql) => wire(bounded((await store.query(sql, [project.id, project.userId])).rows));
    const articles = (await read('SELECT * FROM evimed_geo.articles WHERE geo_project_id=$1 AND user_id=$2 ORDER BY id LIMIT 20001')).map(geoArticleFromRow);
    const versions = await read('SELECT article_id AS "articleId",result_version_id AS "resultVersionId",digest,path,association,created_at AS "createdAt" FROM evimed_geo.article_versions WHERE geo_project_id=$1 AND user_id=$2 ORDER BY article_id,result_version_id LIMIT 20001');
    const claims = (await read('SELECT *,valid_until <= transaction_timestamp() AS expired FROM evimed_geo.claims WHERE geo_project_id=$1 AND user_id=$2 ORDER BY id LIMIT 20001')).map(row => ({ ...claimFromRow(row), expired: row.expired }));
    const publications = await read(`SELECT id,'owned_link' AS kind,article_id AS "articleId",article_result_version_id AS "resultVersionId",article_digest AS digest,url,status,published_at AS "publishedAt" FROM evimed_geo.owned_links WHERE geo_project_id=$1 AND user_id=$2 ORDER BY id LIMIT 20001`);
    const orders = await read(`SELECT id,'order' AS kind,article_id AS "articleId",article_result_version_id AS "resultVersionId",article_digest AS digest,published_url AS url,state AS status,updated_at AS "recordedAt" FROM evimed_geo.orders WHERE geo_project_id=$1 AND user_id=$2 AND state IN ('published','verified','settled') ORDER BY id LIMIT 20001`);
    const value = (await read('SELECT version,data FROM evimed_geo.value_profiles WHERE geo_project_id=$1 AND user_id=$2 ORDER BY version DESC LIMIT 1'))[0] ?? { version: 0, data: {} };
    const journey = (await read('SELECT version,data FROM evimed_geo.journeys WHERE geo_project_id=$1 AND user_id=$2 ORDER BY version DESC LIMIT 1'))[0] ?? { version: 0, data: {} };
    const groupFindingLinks = await read('SELECT id,value_context FROM evimed_geo.question_groups WHERE geo_project_id=$1 AND user_id=$2 ORDER BY id LIMIT 20001');
    const refs = claims.filter(c => c.cardId && Number.isSafeInteger(c.cardRevision) && c.cardRevision > 0).map(c => ({ cardId: c.cardId, revision: c.cardRevision }));
    const cards = await readEvidenceCardRevisions(store, project, refs);
    const identifiers = [...new Set(cards.flatMap(card => list(card.at?.sources).flatMap(sourceIdentifiersOf)))];
    const sourceChanges = new Map();
    for (let i = 0; i < identifiers.length; i += 500)
        for (const [key, fact] of await readStoredSourceChanges(store, PLATFORM_PUBLISHER_USER_ID, identifiers.slice(i, i + 500)))
            sourceChanges.set(key, fact);
    return { articles, versions, claims, publications: bounded([...publications, ...orders]), value, journey, groupFindingLinks, cards, sourceChanges: [...sourceChanges.values()] };
}
/** Prepare lookup indexes once for a complete selected context, outside its claim loop. */
export function geoEvidenceSupportIndex(evidence = {}) {
    const sourceChangesByIdentifier = new Map();
    for (const change of list(evidence.sourceChanges)) {
        const identifier = change.identifier;
        if (!sourceChangesByIdentifier.has(identifier)) sourceChangesByIdentifier.set(identifier, []);
        sourceChangesByIdentifier.get(identifier).push(change);
    }
    return { ...evidence, cardsByRef: new Map(list(evidence.cards).map(card => [`${card.cardId}@${card.revision}`, card])), sourceChangesByIdentifier };
}
/** Exact preserved quote bond only. A current source annotation is labelled current context. @param {any} claim @param {any} evidence */
export function geoJourneyClaimSupport(claim, evidence) {
    const support = { cardId: claim.cardId ?? null, cardRevision: claim.cardRevision ?? null, cardClaimId: claim.cardClaimId ?? null,
        quote: claim.quote ?? null, sourceRef: claim.sourceRef ?? null, sourceChanges: [], sourceChangeState: 'unknown',
        sourceAnnotationBasis: 'current_context', preservedQuoteVerification: null, sourcePublicationStatus: null };
    const fail = (reason, known = false) => ({ ...support, verification: 'linked_not_verified', verificationState: known ? 'not_verified' : 'unknown', reason });
    // Current eligibility never erases a preserved quote bond or a known
    // source notice. Collect those independent facts before choosing a reason.
    const claimReason = claim.status !== 'active' ? ['claim_inactive', true]
        : claim.validUntil && claim.expired === true ? ['claim_expired', true]
        : claim.validUntil && claim.expired !== false ? ['claim_expiry_unknown', false] : null;
    const found = evidence.cardsByRef ? evidence.cardsByRef.get(`${claim.cardId}@${claim.cardRevision}`)
        : list(evidence.cards).find(c => c.cardId === claim.cardId && c.revision === claim.cardRevision);
    const cardWithdrawn = found?.current?.withdrawn || found?.current?.retiredAt || found?.at?.withdrawn;
    const unavailable = (reason, known = false) => claimReason ? fail(claimReason[0], claimReason[1] === true)
        : cardWithdrawn ? fail('card_withdrawn', true) : fail(reason, known);
    if (!found?.at)
        return unavailable('exact_card_revision_unavailable');
    const cardClaim = list(found.at.claims).find(c => c.claimId === claim.cardClaimId);
    const source = found.at.sources?.[(cardClaim?.sourceIndexes?.[0] ?? 0) - 1];
    if (!source || !(source.url === claim.sourceRef || source.title === claim.sourceRef))
        return unavailable(cardClaim ? 'exact_source_identity_unavailable' : 'exact_claim_quote_unavailable');
    const identifiers = sourceIdentifiersOf(source);
    const changes = evidence.sourceChangesByIdentifier
        ? identifiers.flatMap(identifier => evidence.sourceChangesByIdentifier.get(identifier) ?? [])
        : list(evidence.sourceChanges).filter(change => identifiers.includes(change.identifier));
    support.sourceChanges = changes;
    support.sourceChangeState = changes.some(change => change.state === 'changed') ? 'changed'
        : changes.length && changes.every(change => change.state === 'clean') ? 'clean' : 'unknown';
    support.sourcePublicationStatus = source.publicationStatus ?? null;
    if (cardClaim.claimType !== 'direct' || cardClaim.claim !== claim.statement || cardClaim.supportQuote !== claim.quote)
        return unavailable('exact_claim_quote_unavailable');
    const verification = verifyEvidenceCardClaims({ claims: [cardClaim], sources: found.at.sources ?? [] }).claims[0];
    support.preservedQuoteVerification = { status: verification?.status ?? 'source_unavailable',
        cardId: claim.cardId, cardRevision: claim.cardRevision, cardClaimId: claim.cardClaimId };
    if (claimReason) return fail(claimReason[0], claimReason[1] === true);
    if (cardWithdrawn) return fail('card_withdrawn', true);
    if (verification?.status !== 'verified')
        return fail(verification?.status ?? 'source_unavailable', verification?.status === 'quote_not_found');
    if (source.publicationStatus?.kind || changes.some(c => c.state === 'changed'))
        return fail('source_update_needed', true);
    return { ...support, verification: 'verified_preserved_quote', verificationState: 'verified', reason: null };
}
export const GEO_JOURNEY_COLUMNS = Object.freeze([
    ['questions', '原始问题', 'questions'], ['answeredQuestions', '取得回答的问题', 'distinct_answered_questions'], ['answers', '取得回答', 'answers'], ['linkedClaims', '已关联主张', 'claims'], ['verifiedClaims', '原文已核实主张', 'claims'], ['unknownClaims', '待核实主张', 'claims'], ['findings', '已关联发现', 'findings'], ['articles', '内容', 'articles'], ['resultVersions', '内容版本', 'result_versions'], ['publications', '发布记录', 'publications'],
].map(([key, label, unit]) => ({ key, label, unit })));
/** @param {any} selected @param {any} view @param {any} context */
export function buildGeoEvidenceAnalysis(selected, view, context = {}) {
    const evidence = context.evidence, groups = new Map(list(context.groups).map(g => [g.id, g])), questions = new Map(list(selected.questions).map(q => [q.id, q]));
    const buckets = new Map(), memberItems = new Map(), claims = new Map(list(evidence?.claims).map(c => [c.id, c]));
    const make = (key, dimensions, label) => { if (!buckets.has(key))
        buckets.set(key, { key: hash(['V10', key]), label, metricId: null, dimensions, values: {}, items: Object.fromEntries(GEO_JOURNEY_COLUMNS.map(c => [c.key, new Map()])) }); return buckets.get(key); };
    const unmapped = () => make('unmapped', { kind: 'journey_unmapped', groupId: null, setVersion: null, groupState: 'unmapped', temporalBasis: 'current_context' }, '未关联或版本依据不足的项目对象');
    const byQuestion = new Map(), byGroup = new Map();
    for (const q of questions.values()) {
        const g = groups.get(q.group_id), exact = g && Number(g.set_version) === Number(q.set_version);
        const dims = { kind: 'journey_need', groupId: q.group_id ?? null, setVersion: q.set_version ?? null, groupName: exact ? g.name : null, groupState: exact ? 'known' : 'unmapped', journeyStage: exact ? g.journey_stage ?? null : null, journeyStageNo: exact ? g.journey_stage_no ?? null : null, audience: exact ? g.audience ?? null : null, temporalBasis: 'current_context' };
        const bucket = make(JSON.stringify([q.group_id, q.set_version]), dims, `${dims.journeyStage ?? '旅程未标注'} · ${({ patient: '患者', physician: '医生', caregiver: '照护者', pharmacist: '药师', institution: '机构', other: '其他' })[dims.audience] ?? '人群未标注'} · ${dims.groupName ?? '问题群未映射'} · 问题版本 ${dims.setVersion ?? '未知'}`);
        byQuestion.set(q.id, bucket);
        if (exact)
            byGroup.set(g.id, bucket);
        bucket.items.questions.set(q.id, { id: q.id, unit: 'questions', questionId: q.id, questionVersion: q.set_version, text: q.text, originalId: q.original_id ?? null, originalRow: q.original_row_index ?? null, originalGroup: q.original_group ?? null, clientTags: q.client_tags ?? [], groupId: q.group_id });
    }
    for (const answer of selected.rows ?? [])
        if (answer.status === 'valid') {
            const b = byQuestion.get(answer.questionId) ?? unmapped();
            b.items.answers.set(answer.snapshotId, { id: answer.snapshotId, unit: 'answers', ...answer });
            b.items.answeredQuestions.set(answer.questionId, { ...(b.items.questions.get(answer.questionId) ?? { id: answer.questionId, questionId: answer.questionId }), unit: 'distinct_answered_questions' });
        }
    const claimBuckets = new Map(), findingBuckets = new Map(), knownClaimGroups = new Map(), knownFindingGroups = new Map();
    const link = (map, id, b) => { if (!map.has(id))
        map.set(id, new Set()); map.get(id).add(b); };
    const associate = (association) => {
        if (typeof association?.groupId === 'string' && association.groupId) {
            for (const id of list(association.claimIds)) link(knownClaimGroups, id, association.groupId);
            for (const id of list(association.valueContext?.findingIds)) link(knownFindingGroups, id, association.groupId);
        }
        const b = byGroup.get(association?.groupId);
        if (b)
            for (const id of list(association.claimIds))
                link(claimBuckets, id, b);
        return b;
    };
    const versions = new Map(), articleVersions = new Map();
    for (const version of list(evidence?.versions)) {
        const key = JSON.stringify([version.articleId, version.resultVersionId]);
        versions.set(key, version);
        if (!articleVersions.has(version.articleId))
            articleVersions.set(version.articleId, []);
        articleVersions.get(version.articleId).push(version);
        const b = associate(version.association) ?? (!version.association?.groupId ? unmapped() : null);
        if (b) {
            b.items.resultVersions.set(key, { id: key, unit: 'result_versions', ...version });
            for (const id of list(version.association?.valueContext?.findingIds))
                link(findingBuckets, id, b);
        }
    }
    for (const article of list(evidence?.articles)) {
        const stored = articleVersions.get(article.id) ?? [], associations = stored.map(v => v.association);
        // Drafts without a result have only current context. An absent old version never borrows today's head.
        if (!stored.length && !article.currentResultVersionId)
            associations.push(article);
        if (!associations.length)
            associations.push({});
        const mapped = new Set();
        for (const association of associations) {
            const b = associate(association) ?? (!association?.groupId ? unmapped() : null);
            if (b) {
                mapped.add(b);
                for (const id of list(association?.valueContext?.findingIds))
                    link(findingBuckets, id, b);
            }
        }
        for (const b of mapped)
            b.items.articles.set(article.id, { id: article.id, unit: 'articles', title: article.title, articleId: article.id, associations: stored.filter(v => byGroup.get(v.association?.groupId) === b) });
    }
    for (const publication of list(evidence?.publications)) {
        const version = versions.get(JSON.stringify([publication.articleId, publication.resultVersionId]));
        const exact = version && publication.digest === version.digest;
        const b = exact ? byGroup.get(version.association?.groupId) ?? (!version.association?.groupId ? unmapped() : null) : unmapped();
        if (b)
            b.items.publications.set(`${publication.kind ?? 'owned_link'}:${publication.id}`, { ...publication, id: `${publication.kind ?? 'owned_link'}:${publication.id}`, objectId: publication.id, unit: 'publications', pinState: exact ? 'exact' : 'unknown', association: exact ? version.association : null });
    }
    for (const group of list(evidence?.groupFindingLinks))
        for (const findingId of list(group.value_context?.findingIds))
            link(knownFindingGroups, findingId, group.id);
    for (const [id, b] of byGroup) {
        const g = groups.get(id);
        for (const findingId of list(g?.value_context?.findingIds))
            link(findingBuckets, findingId, b);
    }
    for (const finding of list(evidence?.value?.data?.findings)) {
        const { statement, ...findingFields } = finding;
        for (const groupId of list(finding.groupIds)) {
            link(knownFindingGroups, finding.id, groupId);
            const b = byGroup.get(groupId);
            if (b)
                link(findingBuckets, finding.id, b);
        }
        const linked = findingBuckets.get(finding.id);
        if (linked?.size)
            for (const b of linked)
                b.items.findings.set(finding.id, { ...findingFields, claimStatement: statement ?? null, unit: 'findings', basisVersion: evidence.value.version, verification: 'linked_not_verified' });
        else if (!knownFindingGroups.get(finding.id)?.size)
            unmapped().items.findings.set(finding.id, { ...findingFields, claimStatement: statement ?? null, unit: 'findings', basisVersion: evidence.value.version, verification: 'linked_not_verified' });
    }
    const supportContext = geoEvidenceSupportIndex(evidence ?? {});
    for (const claim of claims.values()) {
        const linked = claimBuckets.get(claim.id);
        const targets = linked?.size ? [...linked] : knownClaimGroups.get(claim.id)?.size ? [] : [unmapped()];
        if (!targets.length) continue;
        const support = geoJourneyClaimSupport(claim, supportContext);
        for (const b of targets) {
            const { statement, ...details } = claim;
            const item = { ...details, claimStatement: statement, ...support, unit: 'claims' };
            b.items.linkedClaims.set(claim.id, item);
            if (support.verification === 'verified_preserved_quote')
                b.items.verifiedClaims.set(claim.id, item);
            if (support.verificationState === 'unknown')
                b.items.unknownClaims.set(claim.id, item);
        }
    }
    const rows = [...buckets.values()].sort((a, b) => (a.dimensions.journeyStageNo ?? 999) - (b.dimensions.journeyStageNo ?? 999) || a.key.localeCompare(b.key));
    for (const row of rows) {
        row.dimensions.objects = Object.fromEntries(["questions", "answeredQuestions", "linkedClaims", "verifiedClaims", "unknownClaims", "findings", "articles", "resultVersions", "publications"].map(key => [key, [...row.items[key].values()].map(item => key === "articles" ? {id:item.id, associations:item.associations.map(version=>({resultVersionId:version.resultVersionId,digest:version.digest}))} : item)]));
        for (const column of GEO_JOURNEY_COLUMNS) {
            const items = [...row.items[column.key].values()];
            const known = ['questions', 'answeredQuestions', 'answers'].includes(column.key) || evidence != null;
            row.values[column.key] = { value: known ? items.length : null, state: known ? 'known' : 'unknown', reason: !known ? 'association_context_unavailable' : ['linkedClaims', 'findings'].includes(column.key) ? 'linked_not_verified' : null, unit: column.unit, metric: null, members: null };
            if (known)
                memberItems.set(`${row.key}:${column.key}`, items);
        }
        if (evidence != null) {
            const verified = row.items.verifiedClaims.size, unknown = row.items.unknownClaims.size;
            row.dimensions.supportCounts = { verified, unknownCandidates: unknown, knownNotVerified: row.items.linkedClaims.size - verified - unknown };
            row.values.verifiedClaims = { ...row.values.verifiedClaims, knownSubtotal: verified, unknownCandidates: unknown,
                value: unknown && !verified ? null : verified, state: unknown ? verified ? 'partial' : 'unknown' : 'known',
                reason: unknown ? verified ? 'verification_basis_incomplete' : 'verification_basis_unavailable' : null };
            if (!verified && unknown) memberItems.delete(`${row.key}:verifiedClaims`);
        }
        delete row.items;
    }
    const incomplete = rows.some(row => row.values.verifiedClaims.state !== 'known');
    return { definition: { methodVersion: 'journey-explicit-links-v2', countingRule: 'Distinct IDs within each exact selected question-group/set version; current context and immutable result associations are separate. Counts can overlap across rows. Verified subtotals and candidates with unavailable verification are separate.', denominatorRule: 'Independent questions, distinct answered questions, valid returned answers, claims, findings, articles, result versions and publication records. No shared denominator or inferred funnel.' }, contextualBasis: [{ kind: 'journey_links', temporalBasis: 'current_context', version: evidence?.journey?.version ?? null, digest: hash({ groups: context.groups ?? [], evidence: evidence ?? null }) }], columns: GEO_JOURNEY_COLUMNS.map(c => ({ ...c, type: 'number' })), rows, chart: { kind: 'journey', labels: rows.map(r => r.label), series: [], cells: rows.flatMap(row => GEO_JOURNEY_COLUMNS.map(column => ({ rowKey: row.key, columnKey: column.key, label: row.label, groupId: row.dimensions.groupId, setVersion: row.dimensions.setVersion, engine: null, ...row.values[column.key] }))) }, availability: { status: rows.length ? incomplete ? 'partial' : 'available' : 'empty', reasons: !evidence ? ['association_context_unavailable'] : incomplete ? ['verification_basis_incomplete'] : [] }, dependencies: { groups: context.groups ?? [], evidence: evidence ?? null }, memberItems };
}
