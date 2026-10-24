/** Exact immutable source comparison identity; display labels never identify a cohort. */
import { validateGeoMeasurementContract } from '@evimed/domain';
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

/** Index the actual preserved schedule once; a snapshot list cannot prove its expected repeat universe. */
export function geoSourceObservationPlans(selected) {
    const plan = selected.sourceObservationPlan;
    const available = plan?.schemaVersion === 1 && Array.isArray(plan.jobs);
    const jobsByCell = new Map(), contracts = new Map(), questions = new Map((selected.questions ?? []).map(question => [question.id, question]));
    const key = (roundId, questionId, engine) => JSON.stringify([roundId, questionId, engine]);
    if (available) for (const job of plan.jobs) {
        const cell = key(job.roundId, job.questionId, job.engine), jobs = jobsByCell.get(cell) ?? [];
        jobs.push(job); jobsByCell.set(cell, jobs);
    }
    for (const round of selected.rounds) {
        try { contracts.set(round.id, validateGeoMeasurementContract(round.surface?.measurementContract)); }
        catch (error) { if (!(error instanceof TypeError)) throw error; contracts.set(round.id, null); }
    }
    return (round, cohort, batch) => {
        const contract = contracts.get(round.id), jobs = jobsByCell.get(key(round.id, cohort.questionId, cohort.engine)) ?? [];
        const expectedRepeats = contract?.repeats ?? null, snapshots = new Map(batch.map(row => [row.snapshotId, row])), admitted = new Set(jobs.map(job => job.admittedSnapshotId));
        const basis = { schemaVersion: 1, contract, expectedRepeats, roundId: round.id, questionId: cohort.questionId, setVersion: cohort.setVersion, engine: cohort.engine, mode: cohort.mode, jobs, state: 'unknown', reason: null };
        const finish = reason => ({ basis: { ...basis, state: reason ? 'unknown' : 'known', reason }, reason,
            missingJobs: jobs.filter(job => !job.admittedSnapshotId || !snapshots.has(job.admittedSnapshotId)) });
        if (!available || !contract || !questions.has(cohort.questionId)) return finish('sampling_plan_unknown');
        if (round.surface?.mode !== cohort.mode || Number(round.set_version) !== Number(cohort.setVersion) || Number(questions.get(cohort.questionId).set_version) !== Number(cohort.setVersion) || !contract.engines.includes(cohort.engine)) return finish('sampling_plan_unknown');
        const indices = new Set(jobs.map(job => job.repeatIndex));
        if (jobs.length !== expectedRepeats || indices.size !== expectedRepeats || jobs.some(job => !Number.isSafeInteger(job.repeatIndex) || job.repeatIndex < 0 || job.repeatIndex >= expectedRepeats)) return finish('sampling_plan_incomplete');
        if (jobs.some(job => !job.snapshotId)) return finish('scheduled_observation_missing');
        if (jobs.some(job => !job.admittedSnapshotId || job.admittedSnapshotId !== job.snapshotId || snapshots.get(job.admittedSnapshotId)?.repeatIndex !== job.repeatIndex) || batch.some(row => !admitted.has(row.snapshotId))) return finish('sampling_scope_incomplete');
        return finish(null);
    };
}
