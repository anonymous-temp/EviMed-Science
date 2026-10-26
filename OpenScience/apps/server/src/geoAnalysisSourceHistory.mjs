/** Observable citation history over exact selected rounds and immutable question/engine/mode/version cohorts. */
import { createHash } from 'node:crypto';
import { documentExportDigest } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { sourceCitation } from './geoSourceAnswers.mjs';
import { geoSourceCohort, geoSourceCitationComplete, geoSourceObservationPlans } from './geoAnalysisSourceCohort.mjs';
const hash = value => createHash('sha256').update(documentExportDigest(value)).digest('hex');
const unknown = reason => ({ value: null, state: 'unknown', reason, unit: 'observations', metric: null, members: null });
const known = value => ({ value, state: 'known', reason: null, unit: 'observations', metric: null, members: null });

/** Classify the collection once per cohort and round, independently of any source page. */
function collection(batch, cohort, plan) {
    const reason = !cohort.known ? 'comparison_cohort_unknown'
        : !batch.length ? 'no_sampling'
        : batch.some(row => row.status !== 'valid') ? 'answer_not_returned'
        : batch.some(row => (row.citations ?? []).some(citation => !sourceCitation(citation))) ? 'citations_without_links'
        : batch.some(row => !geoSourceCitationComplete(row)) ? 'citation_completeness_unknown' : plan.reason;
    const times = batch.map(row => row.askedAt).filter(Boolean).sort();
    return { batch, reason, plan, time: times.length === batch.length && times.length ? times.at(-1) : null };
}

export function buildGeoSourceHistory(selected, view, base) {
    const rounds = new Map(selected.rounds.map(round => [round.id, round]));
    const questions = new Map((selected.questions ?? []).map(question => [question.id, question]));
    const cohorts = new Map(), byRound = new Map(), roundTime = new Map();
    for (const row of selected.computed.balance.deduped ?? []) {
        if (row.askedAt && (!roundTime.has(row.roundId) || row.askedAt < roundTime.get(row.roundId))) roundTime.set(row.roundId, row.askedAt);
        if (view.sourceRelationship === 'wrong' && row.failureMode !== 'wrong_ours' || view.sourceRelationship === 'mentions' && row.mentionsOurs !== true) continue;
        const cohort = geoSourceCohort(row, questions, rounds), key = cohort.comparisonCohortKey;
        if (!cohorts.has(key)) cohorts.set(key, cohort);
        if (!byRound.has(key)) byRound.set(key, new Map());
        const batch = byRound.get(key).get(row.roundId) ?? [];
        batch.push(row); byRound.get(key).set(row.roundId, batch);
    }
    // Bound the complete rectangular output before per-page expansion; never truncate it.
    if (base.rows.length * cohorts.size * rounds.size > 20000) throw new HttpError(422, 'geo_read_filter_invalid', 'Narrow the pages, questions or rounds to at most 20,000 history rows.');
    const collections = new Map(), observationPlan = geoSourceObservationPlans(selected);
    if (base.rows.length) for (const [key, cohort] of cohorts) collections.set(key, new Map([...rounds.values()].map(round => { const batch = byRound.get(key).get(round.id) ?? []; return [round.id, collection(batch, cohort, observationPlan(round, cohort, batch))]; })));
    // The display axis uses actual observations only. Missing timestamps never borrow a planned date.
    const ordered = [...rounds.values()].sort((a, b) => String(roundTime.get(a.id) ?? 'z').localeCompare(String(roundTime.get(b.id) ?? 'z')) || a.id.localeCompare(b.id));
    const memberItems = new Map(), rows = [], cells = [];
    const columns = [
        { key: 'observation', label: '页面观察状态', unit: 'observations', type: 'text' },
        { key: 'transition', label: '可比观察变化', unit: 'observations', type: 'text' },
    ];
    function member(row, page, preserved) {
        const question = questions.get(row.questionId);
        return {
            id: row.snapshotId, unit: 'answers', snapshotId: row.snapshotId, questionId: row.questionId, roundId: row.roundId,
            engine: row.engine, repeatIndex: row.repeatIndex, askedAt: row.askedAt ?? null, status: row.status,
            judgment: row.assessmentFacts ?? row.facts ?? null, citationObservation: row.surface?.citationObservation ?? null,
            question: question ? { text: question.text, originalId: question.original_id ?? null, originalRow: question.original_row_index ?? null, originalGroup: question.original_group ?? null, clientTags: question.client_tags ?? [] } : null,
            source: { sourceKey: page.sourceKey, domain: page.domain, pages: [preserved ?? { ...page, preservedCitations: [] }], cooccurrenceOnly: true },
        };
    }
    for (const pageRow of base.rows) {
        const page = { sourceKey: pageRow.dimensions.sourceKey, domain: pageRow.dimensions.domain, sourceType: pageRow.dimensions.sourceType, originalUrls: pageRow.dimensions.originalUrls, titles: [], snapshotIds: [] };
        // D1 already indexed every exact (snapshot, page). Reuse it instead of rescanning raw lists per page.
        const preserved = new Map((base.memberItems.get(`${pageRow.key}:answers`) ?? []).map(answer => [answer.snapshotId, answer.source.pages[0]]));
        for (const [key, cohort] of cohorts) {
            const points = new Map();
            for (const round of ordered) {
                const sampled = collections.get(key).get(round.id), batch = sampled.batch;
                // Only a valid repeat can establish presence; completeness and other repeats still govern absence.
                const observation = batch.some(row => row.status === 'valid' && preserved.has(row.snapshotId)) ? 'present' : sampled.reason ? null : 'absent';
                points.set(round.id, { ...sampled, roundId: round.id, observation, items: [...batch.map(row => member(row, page, preserved.get(row.snapshotId))), ...sampled.plan.missingJobs.map(job => ({ id: job.id, unit: 'asks', roundId: job.roundId, questionId: job.questionId, engine: job.engine, repeatIndex: job.repeatIndex, status: job.status, reason: sampled.plan.reason }))], previous: null, transition: null });
            }
            // Cohort chronology is its own answer timestamps, even when another cohort was sampled earlier in a round.
            const chronological = [...points.values()].filter(point => point.observation && cohort.known && point.time).sort((a, b) => a.time.localeCompare(b.time) || a.roundId.localeCompare(b.roundId));
            const times = new Map();
            for (const point of chronological) times.set(point.time, (times.get(point.time) ?? 0) + 1);
            let previous = null, seenPresence = false;
            for (const point of chronological) {
                // Tied timestamps cannot establish an old/new order.
                if (times.get(point.time) !== 1) {
                    point.transitionReason = 'sampling_order_unknown';
                    previous = null;
                    if (point.observation === 'present') seenPresence = true;
                    continue;
                }
                point.previous = previous;
                point.transition = point.observation === 'present'
                    ? previous?.observation === 'absent' ? 'new_appearance' : !seenPresence ? 'first_observed_in_scope' : 'present'
                    : previous?.observation === 'present' ? 'no_longer_observed' : 'absent';
                previous = point;
                if (point.observation === 'present') seenPresence = true;
            }
            const observedTimes = [...points.values()].filter(point => point.observation === 'present' && point.time).map(point => point.time).sort();
            for (const [ordinal, round] of ordered.entries()) {
                const point = points.get(round.id), { observation, transition, items, previous: old } = point;
                const transitionReason = point.transitionReason ?? (observation && !point.time ? 'sampling_time_unknown' : point.reason);
                const row = {
                    key: hash(['V22', page.sourceKey, round.id, key]), label: `${page.sourceKey} · 第 ${ordinal + 1} 轮 · ${cohort.engine ?? '平台未知'}`,
                    metricId: null, dimensions: {
                        ...pageRow.dimensions, history: null, kind: 'source_history', ...cohort,
                        roundId: round.id, roundLabel: `第 ${ordinal + 1} 轮`, roundOrdinal: ordinal + 1, roundKind: round.kind ?? null,
                        askedAt: point.time, firstObserved: observedTimes[0] ?? null, lastObserved: observedTimes.at(-1) ?? null, firstObservedBasis: 'selected_scope', previousRoundId: old?.roundId ?? null,
                        observationPlan: point.plan.basis,
                        citationCompleteness: point.batch.map(answer => ({ snapshotId: answer.snapshotId, declaration: answer.surface?.citationObservation ?? null })), observation, transition,
                    },
                    values: { observation: observation ? known(observation) : unknown(point.reason), transition: transition ? known(transition) : unknown(transitionReason) }, links: [],
                };
                const empty = { id: hash([page.sourceKey, round.id, key, 'no-sampling']), unit: 'observations', roundId: round.id, questionId: cohort.questionId, engine: cohort.engine, reason: point.reason, ...cohort, source: { ...page, pages: [page], cooccurrenceOnly: true } };
                memberItems.set(`${row.key}:observation`, items.length ? items : [empty]);
                memberItems.set(`${row.key}:transition`, old ? [...old.items, ...items] : items.length ? items : [empty]);
                rows.push(row);
                if (cells.length < (view.topN ?? 15) * ordered.length) cells.push({
                    rowKey: row.key, columnKey: 'observation', label: row.label, sourceKey: page.sourceKey, facetKey: key,
                    roundId: round.id, roundLabel: row.dimensions.roundLabel, engine: cohort.engine, groupId: null, setVersion: cohort.setVersion,
                    value: observation === 'present' ? 1 : observation === 'absent' ? 0 : null, state: row.values.observation.state,
                    reason: row.values.observation.reason, observation, transition, unit: 'observations', comparisonCohortKey: key, questionId: cohort.questionId,
                });
            }
        }
    }
    return {
        ...base, rows, columns, memberItems,
        chart: { kind: 'source_history', labels: ordered.map((round, index) => `第 ${index + 1} 轮`), series: [], cells, totalCategories: rows.length, topN: view.topN ?? 15 },
        dependencies: { ...base.dependencies, observations: selected.computed.balance.deduped, sourceObservationPlan: selected.sourceObservationPlan ?? null },
        availability: { status: rows.length ? 'ready' : 'empty', reasons: ['citation_history_selected_scope', 'citation_completeness_required'], remedy: null },
        definition: {
            ...base.definition, unit: 'observations',
            countingRule: 'Preserved citation presence requires a valid returned repeat with a usable URL; a non-valid repeat cannot establish presence. A valid positive remains observable in a mixed batch. Absence requires the explicit preserved round contract and exact scheduled repeat jobs, each with a reciprocally linked admitted valid snapshot and complete linked citation list. Missing jobs, missing captures, out-of-scope snapshots and unavailable historical plans remain unknown. Without a valid positive, legacy empty arrays, linkless retrieval, refusal, failure and missing samples remain unknown. First observation is in selected scope only. Citation completeness is the collection producer’s preserved declaration, not evidence of exhaustive knowledge across the web or model.',
            denominatorRule: 'Only the same immutable question, set version, exact engine and sampling mode form a comparison cohort. New appearance requires prior comparable observable absence; no-longer-observed requires later comparable observable absence. Unknown intervals remain blank. No fitted citation lifetime or causal interpretation.',
        },
    };
}
