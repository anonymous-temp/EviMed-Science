import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { ProductDocuments, ProductJobs } from './productStore.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { preserveGeoAssessment } from './geoLearningSignals.mjs';
import { GeoJudge, judgeInputOf, factsOf, geoJudgeBudget } from './geoJudge.mjs';
import { brandRegistry } from './geoParse.mjs';
import { HttpError } from './security.mjs';

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const conflict = () => new HttpError(409, 'geo_assessment_changed', 'The assessment changed. Refresh before submitting feedback.');
const kind = 'geo-judgment-recheck';

/** Feedback is a preserved request about one assessment, never a replacement verdict. */
export function createGeoDiagnosisReview({ database, store, config = {}, judge = null, usageLedger = null, learning = null }) {
  const documents = new ProductDocuments(database), jobs = new ProductJobs(database);
  const evaluator = judge ?? new GeoJudge(config, { usageLedger });
  async function assessment(project, snapshotId, client = database) {
    return (await client.query(`SELECT * FROM evimed_product.documents WHERE user_id=$1 AND project_id=$2 AND kind='knowledge'
      AND deleted_at IS NULL AND payload->>'recordType'='geo-assessment' AND payload->>'geoProjectId'=$3 AND payload->>'snapshotId'=$4`,
    [project.userId, project.projectId, project.id, snapshotId])).rows[0] ?? null;
  }
  async function read(project, snapshotId) {
    await migrateProductStore(database);
    const snapshot = await store.snapshot(snapshotId);
    if (!snapshot || snapshot.geoProjectId !== project.id || snapshot.userId !== project.userId) throw new HttpError(404, 'geo_snapshot_not_found', 'Answer not found.');
    const current = await assessment(project, snapshotId);
    const feedback = (await database.query(`SELECT d.id,d.payload,d.created_at,j.id AS job_id,j.status,j.error,j.result FROM evimed_product.documents d
      LEFT JOIN evimed_product.jobs j ON j.user_id=d.user_id AND j.id=d.payload->>'jobId'
      WHERE d.user_id=$1 AND d.project_id=$2 AND d.kind='knowledge' AND d.deleted_at IS NULL AND d.payload->>'recordType'='geo-judgment-feedback'
      AND d.payload->>'geoProjectId'=$3 AND d.payload->>'snapshotId'=$4 ORDER BY d.created_at DESC,d.id DESC LIMIT 100`,
    [project.userId, project.projectId, project.id, snapshotId])).rows;
    const first = current ? (await database.query("SELECT payload FROM evimed_product.revisions WHERE user_id=$1 AND kind='knowledge' AND id=$2 ORDER BY revision ASC LIMIT 1", [project.userId, current.id])).rows[0]?.payload?.assessment : null;
    const claimIds = [...new Set([...(first?.statements ?? []), ...(current?.payload.assessment.statements ?? [])].map(row => row.claimId).filter(Boolean))];
    const claimDetails = claimIds.length ? (await database.query(`SELECT id, version, population, elements, source_ref, source_label, statement, quote
      FROM evimed_geo.claims WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) LIMIT 400`, [project.id, project.userId, claimIds])).rows.map(row => ({
        id: row.id, version: row.version, population: row.population, elements: row.elements, sourceRef: row.source_ref, sourceLabel: row.source_label, statement: row.statement, quote: row.quote })) : [];
    return { claimDetails, original: first, assessmentVersion: current?.payload.assessmentVersion ?? null, current: current?.payload.assessment ?? null,
      state: current?.payload.state ?? 'unknown', history: current ? (await documents.history(project.userId, 'knowledge', current.id)).map(row => ({ version: row.payload.assessmentVersion, assessment: row.payload.assessment, state: row.payload.state })) : [],
      feedback: feedback.map(row => ({ id: row.id, ...row.payload, status: row.status ?? 'unknown', error: row.error, result: row.result, createdAt: row.created_at })) };
  }
  async function submit(project, input) {
    if (typeof input.snapshotId !== 'string' || typeof input.statement !== 'string' || !input.statement.trim() || input.statement.length > 2000
      || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 4000
      || typeof input.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/u.test(input.requestKey)
      || typeof input.assessmentVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(input.assessmentVersion)) throw new HttpError(400, 'geo_feedback_invalid', 'Feedback requires an exact assessment, statement, reason and request key.');
    await migrateProductStore(database);
    const id = `geo-feedback-${hash([project.id, input.requestKey])}`;
    const content = { snapshotId: input.snapshotId, statement: input.statement, claimId: input.claimId ?? null, assessmentVersion: input.assessmentVersion, note: input.note.trim(), selectionRef: input.selectionRef ?? null };
    return database.transaction(client => database.withTransactionClient(client, async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-geo-assessment:${input.snapshotId}`]);
      const old = await documents.get(project.userId, 'knowledge', id);
      if (old) {
        if (old.payload.requestDigest !== hash(content)) throw new HttpError(409, 'geo_feedback_request_conflict', 'This request key already names different feedback.');
        return { id, jobId: old.payload.jobId, repeated: true };
      }
      const current = await assessment(project, input.snapshotId, client);
      if (!current || current.payload.assessmentVersion !== input.assessmentVersion) throw conflict();
      const original = (current.payload.assessment.statements ?? []).find(row => row.text === input.statement && (row.claimId ?? null) === content.claimId);
      if (!original) throw conflict();
      const job = await jobs.enqueue(project.userId, kind, { feedbackId: id, geoProjectId: project.id, snapshotId: input.snapshotId },
        { projectId: project.projectId, idempotencyKey: id, maxAttempts: 3, transactionClient: client });
      await documents.put(project.userId, 'knowledge', id, { recordType: 'geo-judgment-feedback', ...content, geoProjectId: project.id,
        actorId: project.actorId ?? project.userId, requestDigest: hash(content), original, jobId: job.id },
      { expectedRevision: 0, projectId: project.projectId, transactionClient: client });
      return { id, jobId: job.id, repeated: false };
    }));
  }
  async function tick() {
    if (!evaluator.available || (await geoJudgeBudget(store, config, new Date())).exhausted) return { processed: 0, skipped: 'judge_unavailable_or_budget' };
    const job = await jobs.claim([kind], 'geo-judgment-review', { leaseMs: 180000 });
    if (!job) return { processed: 0 };
    let completed = false;
    try {
      const feedback = await documents.get(job.userId, 'knowledge', job.payload.feedbackId);
      const p = feedback?.payload;
      const project = await store.project(job.payload.geoProjectId);
      if (!p || !project || project.userId !== job.userId || project.projectId !== job.projectId) throw new HttpError(404, 'geo_feedback_not_found', 'Feedback not found.');
      const snapshot = await store.snapshot(p.snapshotId);
      if (!snapshot || snapshot.geoProjectId !== project.id || snapshot.userId !== project.userId) throw new HttpError(404, 'geo_snapshot_not_found', 'Answer not found.');
      const current = await assessment(project, snapshot.id);
      if (!current || current.payload.assessmentVersion !== p.assessmentVersion) throw conflict();
      const context = await store.projectContext(project.id, snapshot.roundId);
      if (!context || !snapshot.roundId || !(await store.round(snapshot.roundId))?.ref?.evaluationBasis) throw new HttpError(409, 'geo_review_basis_unavailable', 'The original assessment basis is unavailable.');
      const basis = current.payload.assessment.basis;
      if (basis.some(row => !context.claims.some(claim => claim.id === row.id && (claim.version ?? null) === row.version && hash(claim.quote ?? '') === row.quoteDigest && (claim.sourceRef ?? null) === row.sourceRef))) throw conflict();
      const question = snapshot.questionId ? (await store.questions(project.id, { ids: [snapshot.questionId] }))[0] : null;
      const input = /** @type {import("./geoJudge.mjs").GeoJudgeInput} */ (judgeInputOf(context, question, snapshot));
      input.reviewFeedback = { statement: p.statement, note: p.note };
      const judged = await evaluator.judge(input);
      const retained = current.payload.assessment.statements.filter(prior => !judged.statements.some(next => next.text === prior.text && next.claimId === prior.claimId));
      if (retained.length) {
        judged.statements.push(...retained);
        judged.checks.judgementCoverage = { ...judged.checks.judgementCoverage, status: 'partial',
          reasons: [...(judged.checks.judgementCoverage?.reasons ?? []), 'review_retained_prior_statements'] };
      }
      const { facts, status } = factsOf({ snapshot, judged, registry: brandRegistry(context.judgeProduct ?? context.project.product, context.judgeCompetitors ?? context.project.competitors), countedOwned: context.judgeOwned ?? context.owned, at: new Date(), claims: context.claims });
      await jobs.finishWithLease(job.userId, job.id, job.leaseToken, { statements: facts.statements, judgedAt: facts.judgedAt }, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-geo-assessment:${snapshot.id}`]);
        const head = await assessment(project, snapshot.id, client);
        if (head?.payload.assessmentVersion !== p.assessmentVersion) throw conflict();
        const fields = { brands: facts.brands ?? [], mentions_ours: facts.mentionsOurs ?? null, first_ours: facts.firstOurs ?? null,
          recommended_ours: facts.recommendedOurs ?? null, position_ours: facts.positionOurs ?? null, brands_mentioned: facts.brandsMentioned ?? null,
          retrieval_triggered: facts.retrievalTriggered ?? null, cites_ours: facts.citesOurs ?? null, cites_ours_in_body: facts.citesOursInBody ?? null,
          care_hint: facts.careHint ?? null, statements: facts.statements, checks: facts.checks, failure_mode: facts.failureMode,
          parser_version: facts.parserVersion, judged_at: facts.judgedAt, red_flag_expected: facts.redFlagExpected,
          red_flag_hits: facts.redFlagHits, safety_terms_hit: facts.safetyTermsHit, registry_key: facts.registryKey, judge_extract: facts.judgeExtract,
          errors_owed: facts.statements.some(row => row.verdict === 'wrong') };
        const jsonFields = new Set(['brands', 'statements', 'checks', 'red_flag_expected', 'red_flag_hits', 'safety_terms_hit', 'judge_extract']);
        const entries = Object.entries(fields);
        await client.query(`UPDATE evimed_geo.facts SET ${entries.map(([key], index) => `${key}=$${index + 4}${jsonFields.has(key) ? '::jsonb' : ''}`).join(',')},
          reparsed_at=clock_timestamp() WHERE snapshot_id=$1 AND user_id=$2 AND geo_project_id=$3`,
        [snapshot.id, project.userId, project.id, ...entries.map(([key, value]) => jsonFields.has(key) ? JSON.stringify(value) : value)]);
        if (status !== snapshot.status) await client.query('UPDATE evimed_geo.snapshots SET status=$2 WHERE id=$1', [snapshot.id, status]);
        await preserveGeoAssessment({ database, client, snapshotId: snapshot.id, facts });
      });
      completed = true;
      // Reconcile the existing withdrawal outbox before a later learning pass can reuse the replaced assessment.
      await learning?.reconcileDependencies?.();
      await learning?.flush?.();
      return { processed: 1 };
    } catch (error) {
      if (completed) throw error;
      const code = error?.code ?? 'geo_review_failed';
      if (code !== 'product_job_lease_lost') await jobs.fail(job.userId, job.id, job.leaseToken, { code, message: 'The judgment could not be rechecked.' }, { retry: !['geo_assessment_changed', 'geo_review_basis_unavailable', 'geo_feedback_not_found', 'geo_snapshot_not_found'].includes(code) });
      return { processed: 0, failed: 1 };
    }
  }
  return { read, submit, tick };
}
