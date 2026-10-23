import { createHash } from 'node:crypto';
import { canonicalJson, geoClaimApplicability, geoClaimAssessmentIdentity, geoStatementAssessmentIdentity, geoClaimForStatement } from '@evimed/domain';
import { ProductDocuments, ProductJobs } from './productStore.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { preserveGeoAssessment } from './geoLearningSignals.mjs';
import { GeoJudge, judgeInputOf, factsOf, geoJudgeBudget } from './geoJudge.mjs';
import { errorFingerprint, geoErrorOrigin, geoErrorResolutionSatisfied } from './geoErrors.mjs';
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
  async function read(project, snapshotId, page = {}) {
    const { feedbackBefore = null, historyBefore = null, feedbackLimit = 100, historyLimit = 50 } = page;
    if (Object.keys(page).some(key => !['feedbackBefore', 'historyBefore', 'feedbackLimit', 'historyLimit'].includes(key))
      || feedbackBefore != null && (typeof feedbackBefore !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(feedbackBefore))
      || historyBefore != null && (!Number.isSafeInteger(historyBefore) || historyBefore < 1)
      || !Number.isSafeInteger(feedbackLimit) || feedbackLimit < 1 || feedbackLimit > 100
      || !Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 50) throw new HttpError(400, 'geo_read_filter_invalid', 'Invalid judgment history page.');
    await migrateProductStore(database);
    return database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return database.withTransactionClient(client, () => readPage(project, snapshotId, { feedbackBefore, historyBefore, feedbackLimit, historyLimit }));
    });
  }
  async function readPage(project, snapshotId, { feedbackBefore, historyBefore, feedbackLimit, historyLimit }) {
    const snapshot = await store.snapshot(snapshotId);
    if (!snapshot || snapshot.geoProjectId !== project.id || snapshot.userId !== project.userId) throw new HttpError(404, 'geo_snapshot_not_found', 'Answer not found.');
    const current = await assessment(project, snapshotId);
    const feedbackWhere = `d.user_id=$1 AND d.project_id=$2 AND d.kind='knowledge' AND d.deleted_at IS NULL
      AND d.payload->>'recordType'='geo-judgment-feedback' AND d.payload->>'geoProjectId'=$3 AND d.payload->>'snapshotId'=$4`;
    const params = [project.userId, project.projectId, project.id, snapshotId];
    if (feedbackBefore && !(await database.query(`SELECT d.id FROM evimed_product.documents d WHERE ${feedbackWhere} AND d.id=$5`, [...params, feedbackBefore])).rows[0]) {
      throw new HttpError(404, 'geo_feedback_not_found', 'Feedback page not found.');
    }
    const feedbackRows = (await database.query(`SELECT d.id,d.payload,d.created_at,j.id AS job_id,j.status,j.error,j.result FROM evimed_product.documents d
      LEFT JOIN evimed_product.jobs j ON j.user_id=d.user_id AND j.id=d.payload->>'jobId' WHERE ${feedbackWhere}
      AND ($5::text IS NULL OR (d.created_at,d.id)<(SELECT cursor.created_at,cursor.id FROM evimed_product.documents cursor WHERE cursor.user_id=$1 AND cursor.kind='knowledge' AND cursor.id=$5))
      ORDER BY d.created_at DESC,d.id DESC LIMIT $6`, [...params, feedbackBefore, feedbackLimit + 1])).rows;
    const feedbackTotal = Number((await database.query(`SELECT count(*)::integer AS n FROM evimed_product.documents d WHERE ${feedbackWhere}`, params)).rows[0].n);
    const feedback = feedbackRows.slice(0, feedbackLimit);
    const judged = `SELECT DISTINCT ON (payload->>'assessmentVersion') revision,payload FROM evimed_product.revisions
      WHERE user_id=$1 AND kind='knowledge' AND id=$2 AND payload->>'assessmentVersion' IS NOT NULL
      ORDER BY payload->>'assessmentVersion',revision DESC`;
    const historyRows = current ? (await database.query(`SELECT * FROM (${judged}) judged WHERE ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4`,
      [project.userId, current.id, historyBefore, historyLimit + 1])).rows : [];
    const historyTotal = current ? Number((await database.query(`SELECT count(*)::integer AS n FROM (${judged}) judged`, [project.userId, current.id])).rows[0].n) : 0;
    const history = historyRows.slice(0, historyLimit);
    const first = current ? (await database.query("SELECT payload FROM evimed_product.revisions WHERE user_id=$1 AND kind='knowledge' AND id=$2 ORDER BY revision ASC LIMIT 1", [project.userId, current.id])).rows[0]?.payload?.assessment : null;
    const claimIds = [...new Set([...(first?.statements ?? []), ...(current?.payload.assessment.statements ?? []), ...history.flatMap(row => row.payload.assessment?.statements ?? []), ...feedback.map(row => row.payload.original)].map(row => row.claimId).filter(Boolean))];
    const claimDetails = claimIds.length ? (await database.query(`SELECT id, version, population, elements, in_label, valid_until, evidence_level, source_ref, source_label, statement, quote
      FROM evimed_geo.claims WHERE geo_project_id=$1 AND user_id=$2 AND id=ANY($3::text[]) LIMIT 400`, [project.id, project.userId, claimIds])).rows.map(row => ({
        id: row.id, version: row.version, population: row.population, elements: row.elements, inLabel: row.in_label ?? null, validUntil: row.valid_until == null ? null : new Date(row.valid_until).toISOString(), evidenceLevel: row.evidence_level ?? null, sourceRef: row.source_ref, sourceLabel: row.source_label, statement: row.statement, quote: row.quote })) : [];
    return { claimDetails, original: first, assessmentVersion: current?.payload.assessmentVersion ?? null, current: current?.payload.assessment ?? null,
      state: current?.payload.state ?? 'unknown', history: history.map(row => ({ revision: row.revision, version: row.payload.assessmentVersion, assessment: row.payload.assessment, state: row.payload.state })),
      historyPage: { total: historyTotal, shown: history.length, more: historyRows.length > historyLimit, nextBefore: historyRows.length > historyLimit ? history.at(-1).revision : null },
      feedbackPage: { total: feedbackTotal, shown: feedback.length, more: feedbackRows.length > feedbackLimit, nextBefore: feedbackRows.length > feedbackLimit ? feedback.at(-1).id : null },
      feedback: feedback.map(row => ({ id: row.id, ...row.payload, status: row.status ?? 'unknown', error: row.error, result: row.result, createdAt: row.created_at })) };
  }
  async function submit(project, input) {
    if (typeof input.snapshotId !== 'string' || typeof input.statement !== 'string' || !input.statement.trim() || input.statement.length > 2000
      || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 4000
      || typeof input.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/u.test(input.requestKey)
      || input.statementIdentity != null && (typeof input.statementIdentity !== 'string' || input.statementIdentity.length > 20000)
      || typeof input.assessmentVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(input.assessmentVersion)) throw new HttpError(400, 'geo_feedback_invalid', 'Feedback requires an exact assessment, statement, reason and request key.');
    await migrateProductStore(database);
    const id = `geo-feedback-${hash([project.id, input.requestKey])}`;
    const content = { snapshotId: input.snapshotId, statement: input.statement, claimId: input.claimId ?? null, assessmentVersion: input.assessmentVersion, note: input.note.trim(), selectionRef: input.selectionRef ?? null, ...(input.statementIdentity == null ? {} : { statementIdentity: input.statementIdentity }) };
    return database.transaction(client => database.withTransactionClient(client, async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-geo-assessment:${input.snapshotId}`]);
      const old = await documents.get(project.userId, 'knowledge', id);
      if (old) {
        if (old.payload.requestDigest !== hash(content)) throw new HttpError(409, 'geo_feedback_request_conflict', 'This request key already names different feedback.');
        return { id, jobId: old.payload.jobId, repeated: true };
      }
      const current = await assessment(project, input.snapshotId, client);
      if (!current || current.payload.assessmentVersion !== input.assessmentVersion) throw conflict();
      const matches = (current.payload.assessment.statements ?? []).filter(row => row.text === input.statement && (row.claimId ?? null) === content.claimId
        && (input.statementIdentity == null || geoStatementAssessmentIdentity(row) === input.statementIdentity));
      if (matches.length !== 1) throw conflict();
      const original = matches[0];
      const job = await jobs.enqueue(project.userId, kind, { feedbackId: id, geoProjectId: project.id, snapshotId: input.snapshotId },
        { projectId: project.projectId, idempotencyKey: id, maxAttempts: 3, transactionClient: client });
      await documents.put(project.userId, 'knowledge', id, { recordType: 'geo-judgment-feedback', ...content, geoProjectId: project.id,
        actorId: project.actorId ?? project.userId, requestDigest: hash(content), statementIdentity: geoStatementAssessmentIdentity(original), original, jobId: job.id },
      { expectedRevision: 0, projectId: project.projectId, transactionClient: client });
      return { id, jobId: job.id, repeated: false };
    }));
  }
  async function reconcileErrorJudgments(client, project, snapshot, previous, next, facts, claims) {
    const candidates = [...(previous.assessment.statements ?? []), ...facts.statements].filter(statement => statement.claimId);
    const affectedIds = [...new Set(candidates.map(statement => statement.claimId))];
    if (!affectedIds.length) return;
    const errors = (await client.query(`SELECT * FROM evimed_geo.errors WHERE user_id=$1 AND geo_project_id=$2 AND engine=$3
      AND claim_id=ANY($4::text[]) ORDER BY id FOR UPDATE`, [project.userId, project.id, snapshot.engine, affectedIds])).rows;
    for (const error of errors) {
      const original = geoErrorOrigin(candidates, { claimId: error.claim_id, fingerprint: error.fingerprint }, [], { includeNonWrong: true });
      if (!original) continue;
      const legacy = errorFingerprint(original) !== error.fingerprint || original.claimVersion == null;
      const identity = geoClaimAssessmentIdentity(original);
      const residual = (await client.query(`SELECT EXISTS(SELECT 1 FROM evimed_geo.snapshots s JOIN evimed_geo.facts f ON f.snapshot_id=s.id
        CROSS JOIN LATERAL jsonb_array_elements(f.statements) statement WHERE s.user_id=$1 AND s.geo_project_id=$2 AND s.engine=$3
        AND statement->>'verdict'='wrong' AND CASE WHEN $4::boolean THEN (statement->>'claimKey'=$5 OR ($5::text IS NULL AND statement->>'claimId'=$7)) ELSE
        jsonb_build_object('claimId',statement->'claimId','claimKey',null,'version',statement->'claimVersion',
          'applicability',CASE WHEN coalesce(statement->'applicability','null'::jsonb)='null'::jsonb THEN 'null'::jsonb ELSE
          jsonb_build_object('population',statement->'applicability'->'population','elements',statement->'applicability'->'elements',
            'inLabel',statement->'applicability'->'inLabel','validUntil',statement->'applicability'->'validUntil','evidenceLevel',statement->'applicability'->'evidenceLevel') END)=$6::jsonb END) AS present`,
        [project.userId, project.id, snapshot.engine, legacy, original.claimKey ?? null, identity, original.claimId])).rows[0].present;
      const corrected = facts.statements.some(statement => statement.verdict === 'correct' && geoClaimAssessmentIdentity(statement) === identity);
      if (!residual && !corrected) continue;
      const state = residual ? 'active' : 'withdrawn';
      const proof = { ...snapshot, ...facts };
      const resolutionWithdrawn = error.status === 'closed' && error.closed_snapshot_id === snapshot.id
        && error.question_id === snapshot.questionId && error.engine === snapshot.engine
        && !geoErrorResolutionSatisfied(original, proof, geoClaimForStatement(claims, original));
      if (state === error.judgment_state && !resolutionWithdrawn) continue;
      const receipt = { kind: resolutionWithdrawn ? 'resolution_basis_withdrawn' : state === 'withdrawn' ? 'assessment_correction' : 'judgment_reactivated', snapshotId: snapshot.id,
        ...(resolutionWithdrawn ? { previousClosedSnapshotId: error.closed_snapshot_id } : {}),
        previousAssessmentVersion: previous.assessmentVersion, assessmentVersion: next.payload.assessmentVersion,
        claimId: original.claimId, claimVersion: original.claimVersion ?? null, applicability: geoClaimApplicability(original), changedAt: new Date().toISOString() };
      await client.query(`UPDATE evimed_geo.errors SET judgment_state=$2,judgment_correction=$3::jsonb,judgment_history=judgment_history || jsonb_build_array($3::jsonb),
        notified_at=CASE WHEN $2='active' AND judgment_state<>'active' THEN NULL ELSE notified_at END,
        status=CASE WHEN $4::boolean THEN 'awaiting_remeasure' ELSE status END,
        closed_snapshot_id=CASE WHEN $4::boolean THEN NULL ELSE closed_snapshot_id END,
        updated_at=CASE WHEN $4::boolean THEN $5::timestamptz ELSE updated_at END WHERE id=$1`, [error.id, state, JSON.stringify(receipt), resolutionWithdrawn, receipt.changedAt]);
    }
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
      if ((current.payload.assessment.statements ?? []).some(statement => statement.claimId && !geoClaimForStatement(context.claims, statement))) throw conflict();
      if (basis.some(row => !context.claims.some(claim => claim.id === row.id && (claim.version ?? null) === row.version && (!row.identity || geoClaimAssessmentIdentity(claim) === row.identity) && hash(claim.quote ?? '') === row.quoteDigest && (claim.sourceRef ?? null) === row.sourceRef))) throw conflict();
      const question = snapshot.questionId ? (await store.questions(project.id, { ids: [snapshot.questionId] }))[0] : null;
      const input = /** @type {import("./geoJudge.mjs").GeoJudgeInput} */ (judgeInputOf(context, question, snapshot));
      const targetClaim = geoClaimForStatement(context.claims, p.original);
      if (p.original.claimId != null && !targetClaim) throw conflict();
      input.reviewFeedback = { statement: p.statement, note: p.note, ...(targetClaim ? { claim: `C${context.claims.indexOf(targetClaim) + 1}` } : {}), statementIdentity: p.statementIdentity ?? geoStatementAssessmentIdentity(p.original) };
      const judged = await evaluator.judge(input);
      const priorCitations = current.payload.assessment.checks?.citations ?? [];
      for (const prior of priorCitations) {
        if (prior.exists == null && prior.supports == null && !prior.evidence
          || !snapshot.citations.some(citation => citation.url === prior.url)
          || !snapshot.answerText?.includes(prior.statement)) continue;
        const index = judged.checks.citations.findIndex(citation => citation.url === prior.url && citation.statement === prior.statement);
        const next = judged.checks.citations[index];
        if (next && (next.exists != null || next.supports != null || next.evidence)) continue;
        const retained = { ...prior, retainedFromAssessment: prior.retainedFromAssessment ?? current.payload.assessmentVersion };
        if (index < 0) judged.checks.citations.push(retained);
        else judged.checks.citations[index] = retained;
      }
      const retained = current.payload.assessment.statements.filter(prior => !judged.statements.some(next => geoStatementAssessmentIdentity(next) === geoStatementAssessmentIdentity(prior)));
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
        const saved = await preserveGeoAssessment({ database, client, snapshotId: snapshot.id, facts });
        await reconcileErrorJudgments(client, project, { ...snapshot, status }, head.payload, saved, facts, context.claims);
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
