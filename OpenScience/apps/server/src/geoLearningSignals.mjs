import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSourceIdentifier, geoClaimAssessmentIdentity, geoClaimApplicability, geoClaimForStatement, GEO_ERROR_TYPES, GEO_STATEMENT_TOPICS } from '@evimed/domain';
import { ProductDocuments } from './productStore.mjs';
import { isInternalProject } from './internalProjects.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const assessmentId = snapshotId => `geo-assessment-${digest(snapshotId)}`;
const lockKey = snapshotId => `evimed-geo-assessment:${snapshotId}`;
const compact = value => String(value ?? '').replace(/\s+/g, '');
const excludedProject = project => !project || Boolean(project.deleted_at) || project.internal === true || isInternalProject(project.project_id);

/** Private assessment provenance shares the product revision ledger and the facts transaction. */
export async function preserveGeoAssessment({ database, client, snapshotId, facts }) {
  const snapshot = (await client.query(`SELECT s.*, p.project_id, p.internal, r.ref->'evaluationBasis'->'claims' AS frozen_claims FROM evimed_geo.snapshots s
    JOIN evimed_geo.projects p ON p.id=s.geo_project_id AND p.user_id=s.user_id
    LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id WHERE s.id=$1`, [snapshotId])).rows[0];
  if (!snapshot) return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(snapshotId)]);
  const id = assessmentId(snapshotId);
  const previous = (await client.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2", [snapshot.user_id, id])).rows[0];
  const rawBasis = (Array.isArray(facts.assessmentBasis) ? facts.assessmentBasis : Array.isArray(snapshot.frozen_claims) ? snapshot.frozen_claims : [])
    .filter((claim, _index, claims) => (facts.statements ?? []).some(statement => geoClaimForStatement(claims, statement) === claim));
  // Source bytes already belong to immutable claim/card or frozen round versions. Keep their identities and digests here,
  // not thirty repeated full sources that could exceed the shared ledger's record limit.
  const basis = rawBasis.map(claim => ({ id: claim.id, key: claim.key ?? null, version: claim.version ?? null, identity: geoClaimAssessmentIdentity(claim), applicability: geoClaimApplicability(claim),
    cardId: claim.cardId ?? null, cardClaimId: claim.cardClaimId ?? null, cardRevision: claim.cardRevision ?? null,
    sourceRef: claim.sourceRef ?? null, quoteDigest: digest(claim.quote ?? ''), statementDigest: digest(claim.statement ?? '') }));
  const assessment = { parserVersion: facts.parserVersion ?? null, judgedAt: facts.judgedAt ?? null,
    answerDigest: snapshot.answer_sha256 ?? digest(snapshot.answer_text ?? ''),
    statements: facts.statements ?? [], checks: facts.checks ?? {}, basis };
  const assessmentVersion = digest(assessment);
  const excluded = snapshot.internal === true || isInternalProject(snapshot.project_id);
  if (previous?.payload.assessmentVersion === assessmentVersion && (!excluded || previous.payload.state === 'excluded')) return previous;
  const contributions = new Map();
  if (!excluded && facts.judgedAt && ['valid', 'refusal'].includes(snapshot.status)) for (const statement of assessment.statements) {
    const claim = geoClaimForStatement(rawBasis, statement);
    if (statement.verdict !== 'wrong' || !claim || !compact(statement.evidence)
      || !compact(claim.quote).includes(compact(statement.evidence)) || !GEO_ERROR_TYPES.includes(statement.errorType)) continue;
    const key = digest([geoClaimAssessmentIdentity(claim), statement.errorType]);
    contributions.set(key, { eventId: `geo-assessment:${snapshotId}:${key}`, claimId: claim.id, claimIdentity: geoClaimAssessmentIdentity(claim), errorType: statement.errorType,
      topic: GEO_STATEMENT_TOPICS.includes(statement.topic) ? statement.topic : 'other' });
  }
  return new ProductDocuments(database).put(snapshot.user_id, 'knowledge', id, {
    recordType: 'geo-assessment', snapshotId, geoProjectId: snapshot.geo_project_id, projectId: snapshot.project_id,
    assessmentVersion, assessment: excluded ? { parserVersion: assessment.parserVersion, judgedAt: assessment.judgedAt, basis: [] } : assessment,
    contributions: [...contributions.values()], state: excluded ? 'excluded' : 'active',
    generation: Number(previous?.payload.generation ?? 0) + 1, publishedGeneration: previous?.payload.publishedGeneration ?? 0,
  }, { expectedRevision: previous?.revision ?? 0, projectId: snapshot.project_id, transactionClient: client });
}

/** A durable outbox over existing product documents; no model call or private-to-platform prose transfer. */
export function createGeoLearningSignals({ database, signals, sourceChanges = null }) {
  const documents = new ProductDocuments(database);
  const transaction = (snapshotId, operation) => database.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(snapshotId)]);
    return database.withTransactionClient(client, () => operation(client));
  });
  async function flush({ limit = 100 } = {}) {
    const target = signals();
    if (!target?.record || !target?.transition || !target?.aggregate) return 0;
    return database.transaction(flushClient => database.withTransactionClient(flushClient, async () => {
    await flushClient.query("SELECT pg_advisory_xact_lock(hashtext('evimed-geo-learning-flush'))");
    const pending = await database.query(`SELECT user_id,id,payload->>'snapshotId' AS snapshot_id FROM evimed_product.documents
      WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='geo-assessment'
        AND (payload->>'generation')::integer > coalesce((payload->>'publishedGeneration')::integer,0)
      ORDER BY updated_at,id LIMIT $1`, [Math.max(1, Math.min(500, Number(limit) || 100))]);
    let published = 0;
    for (const row of pending.rows) published += await transaction(row.snapshot_id, async client => {
      const current = await documents.get(row.user_id, 'knowledge', row.id);
      if (!current || current.payload.generation <= current.payload.publishedGeneration) return 0;
      const project = (await client.query('SELECT internal,deleted_at,project_id FROM evimed_geo.projects WHERE id=$1 AND user_id=$2', [current.payload.geoProjectId, row.user_id])).rows[0];
      const excluded = excludedProject(project);
      const p = excluded ? { ...current.payload, state: 'excluded' } : current.payload;
      if (sourceChanges?.getMany && p.state === 'active' && p.dependencyCheckedGeneration !== p.generation) return 0;
      const desired = p.state === 'active' ? p.contributions.filter(entry => !entry.state || entry.state === 'active') : [];
      const existing = (await client.query(`SELECT id,revision,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge'
        AND deleted_at IS NULL AND payload->>'recordType'='evolution-signal' AND payload->>'provenanceRef'=$2`, [row.user_id, row.id])).rows;
      for (const entry of desired) {
        const accepted = await target.record({ ...entry, userId: row.user_id, projectId: p.projectId, moduleId: 'geo', kind: 'geo-misconception',
          capability: 'geo-content', operation: 'synthesize', dataShape: 'text', reason: 'unsupported',
          version: p.assessmentVersion, sourceRevision: p.generation, provenanceRef: row.id });
        if (!accepted) throw new Error('GEO assessment signal delivery was not accepted.');
      }
      for (const old of existing) {
        if (desired.some(entry => entry.eventId === old.payload.sourceEventId)) continue;
        const changed = await target.transition({ userId: row.user_id, projectId: p.projectId,
          eventId: old.payload.sourceEventId, kind: 'geo-misconception', sourceRevision: old.payload.sourceRevision,
          expectedVersion: old.payload.sourceVersion, expectedRevision: old.revision,
          state: p.state === 'suspended' || ['suspended', 'pending'].includes(p.contributions.find(entry => entry.eventId === old.payload.sourceEventId)?.state) ? 'suspended' : 'invalidated' });
        if (!changed) throw new Error('GEO assessment withdrawal changed during delivery.');
      }
      await documents.put(row.user_id, 'knowledge', row.id, { ...p, publishedGeneration: p.generation },
        { expectedRevision: current.revision, projectId: p.projectId, transactionClient: client, telemetry: p.state === current.payload.state });
      return 1;
    });
    // Retiring public summaries is part of the same commit as withdrawing their private contributors.
    if (published) await target.aggregate();
    return published;
    }));
  }

  /** An original judgment being withdrawn differs from a later answer improving or a business task closing. */
  async function invalidate({ userId, geoProjectId, snapshotId, expectedVersion, state }) {
    if (!['suspended', 'invalidated'].includes(state)) return false;
    return transaction(snapshotId, async client => {
      const id = assessmentId(snapshotId), current = await documents.get(userId, 'knowledge', id);
      if (!current || current.payload.geoProjectId !== geoProjectId || current.payload.assessmentVersion !== expectedVersion) return false;
      if (current.payload.state === 'invalidated' || current.payload.state === state) return true;
      await documents.put(userId, 'knowledge', id, { ...current.payload, state, generation: current.payload.generation + 1 },
        { expectedRevision: current.revision, projectId: current.projectId, transactionClient: client });
      return true;
    });
  }

  /** Old rows use their frozen round basis only; current claims cannot impersonate historical evidence. */
  async function backfill({ limit = 50 } = {}) {
    const rows = await database.query(`SELECT f.*,s.status FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id=f.snapshot_id
      JOIN evimed_geo.projects p ON p.id=f.geo_project_id AND p.deleted_at IS NULL
      WHERE NOT EXISTS (SELECT 1 FROM evimed_product.documents d WHERE d.user_id=f.user_id AND d.kind='knowledge'
        AND d.payload->>'recordType'='geo-assessment' AND d.payload->>'snapshotId'=f.snapshot_id)
      ORDER BY f.created_at,f.snapshot_id LIMIT $1`, [Math.max(1, Math.min(100, Number(limit) || 50))]);
    for (const row of rows.rows) await transaction(row.snapshot_id, client => preserveGeoAssessment({ database, client, snapshotId: row.snapshot_id,
      facts: { statements: row.statements, checks: row.checks, judgedAt: row.judged_at, parserVersion: row.parser_version } }));
    return rows.rows.length;
  }

  /** Reconcile each exact preserved claim, even when the value profile has no current findings. */
  async function reconcileDependencies({ limit = 50 } = {}) {
    const rows = await database.query(`SELECT user_id,id,payload FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL
      AND payload->>'recordType'='geo-assessment' AND payload->>'state'='active'
      ORDER BY payload->>'dependencyCheckedAt' NULLS FIRST,updated_at,id LIMIT $1`, [Math.max(1, Math.min(100, Number(limit) || 50))]);
    let changed = 0;
    for (const row of rows.rows) {
      const p = row.payload;
      const project = (await database.query('SELECT internal,deleted_at,project_id FROM evimed_geo.projects WHERE id=$1 AND user_id=$2', [p.geoProjectId, row.user_id])).rows[0];
      if (excludedProject(project)) {
        changed += await transaction(p.snapshotId, async client => {
          const current = await documents.get(row.user_id, 'knowledge', row.id);
          const liveProject = (await client.query('SELECT internal,deleted_at,project_id FROM evimed_geo.projects WHERE id=$1 AND user_id=$2 FOR SHARE', [p.geoProjectId, row.user_id])).rows[0];
          if (!current || current.payload.state === 'excluded' || !excludedProject(liveProject)) return 0;
          await documents.put(row.user_id, 'knowledge', row.id, { ...current.payload, state: 'excluded', generation: current.payload.generation + 1 },
            { expectedRevision: current.revision, projectId: current.projectId, transactionClient: client });
          return 1;
        });
        continue;
      }
      const references = [...new Set(p.assessment.basis.map(claim => canonicalSourceIdentifier(claim.sourceRef)).filter(Boolean))];
      // A failed source read aborts before pending contributions can be activated by the tick.
      const notices = sourceChanges?.getMany && references.length ? await sourceChanges.getMany(references) : new Map();
      const claims = (await database.query("SELECT id,version,status,statement,quote,source_ref,card_id,card_claim_id,card_revision FROM evimed_geo.claims WHERE user_id=$1 AND geo_project_id=$2 AND id=ANY($3::text[])",
        [row.user_id, p.geoProjectId, p.assessment.basis.map(claim => claim.id)])).rows;
      const cardIds = [...new Set(p.assessment.basis.map(claim => claim.cardId).filter(Boolean))];
      const cardsPresent = cardIds.length && (await database.query("SELECT to_regclass('evimed_frontier.evidence_cards') IS NOT NULL AS present")).rows[0]?.present;
      const withdrawnCards = new Set(cardsPresent ? (await database.query("SELECT id FROM evimed_frontier.evidence_cards WHERE id=ANY($1::text[]) AND withdrawn IS NOT NULL", [cardIds])).rows.map(card => card.id) : []);
      const states = new Map(), legacyStates = new Map();
      const priority = { active: 0, pending: 1, suspended: 2, invalidated: 3 };
      for (const basis of p.assessment.basis) {
        const sameId = claims.filter(claim => claim.id === basis.id);
        const live = sameId.find(claim => basis.version == null || String(claim.version) === String(basis.version));
        let state;
        const identifier = canonicalSourceIdentifier(basis.sourceRef), fact = notices.get(identifier);
        const changes = fact?.changes ?? [];
        if (changes.some(change => ['retraction', 'withdrawal'].includes(change.kind)) || live?.status === 'withdrawn' || withdrawnCards.has(basis.cardId)) state = 'invalidated';
        else if (sameId.length && !live || changes.some(change => ['correction', 'concern'].includes(change.kind))
          || (basis.cardId && (!live || live.card_id !== basis.cardId || live.card_claim_id !== basis.cardClaimId || live.card_revision == null))
          || (live && (String(live.version) !== String(basis.version) || digest(live.quote) !== basis.quoteDigest
            || digest(live.statement) !== basis.statementDigest || live.source_ref !== basis.sourceRef || live.status !== 'active'))) state = 'suspended';
        else if (identifier && sourceChanges?.getMany && (!fact || fact.state === 'unknown')) state = 'pending';
        else state = 'active';
        states.set(basis.identity ?? geoClaimAssessmentIdentity(basis), state);
        const previousState = legacyStates.get(basis.id);
        if (!previousState || priority[state] > priority[previousState]) legacyStates.set(basis.id, state);
      }
      changed += await transaction(p.snapshotId, async client => {
        const current = await documents.get(row.user_id, 'knowledge', row.id);
        if (!current || current.payload.assessmentVersion !== p.assessmentVersion || current.payload.state !== 'active') return 0;
        const contributions = current.payload.contributions.map(entry => {
          const state = entry.claimIdentity ? states.get(entry.claimIdentity) : legacyStates.get(entry.claimId);
          if (!state || entry.state === 'invalidated' || (entry.state === 'suspended' && state !== 'invalidated')) return entry;
          if (state === 'active' && entry.state !== 'pending') return entry;
          return { ...entry, state };
        });
        const different = canonicalJson(contributions) !== canonicalJson(current.payload.contributions);
        await documents.put(row.user_id, 'knowledge', row.id, { ...current.payload, contributions,
          generation: current.payload.generation + Number(different), dependencyCheckedGeneration: current.payload.generation + Number(different), dependencyCheckedAt: new Date().toISOString() },
        { expectedRevision: current.revision, projectId: current.projectId, transactionClient: client, telemetry: !different });
        return Number(different);
      });
    }
    return changed;
  }
  async function tick() {
    const backfilled = await backfill();
    const withdrawn = await reconcileDependencies();
    const published = await flush();
    return { backfilled, withdrawn, published };
  }
  return { flush, invalidate, backfill, reconcileDependencies, tick };
}
