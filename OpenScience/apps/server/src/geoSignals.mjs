import { createHash } from 'node:crypto';
import { GEO_SIGNAL_KINDS, GEO_SIGNAL_DISPOSITIONS, GEO_SIGNAL_STATES, GEO_SIGNAL_STEPS, GEO_STEPS, geoSignalLifecycle } from '@evimed/domain';
import { canonicalJson } from './geoStore.mjs';
import { HttpError } from './security.mjs';
import { packGeoSignalTargets, readGeoSignalTargets } from './geoSignalTargets.mjs';
import { summarizeGeoSourceReviews } from './geoSourceReviews.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code, message, status = 409) => new HttpError(status, code, message);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const shape = (input, allowed) => input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => allowed.includes(key));
const iso = value => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString();

/** The event's identity excludes presentation, polling clocks and notification delivery attempts. */
export const geoSignalId = (projectId, kind, objectKey, eventVersion) => `gs_${digest([projectId, kind, objectKey, eventVersion])}`;

/** A later recurrence has its own event. It does not reopen the historical handling episode. */
export function geoSignalErrorOutcome(error, basis) {
  if (!error) return { state: 'unknown' };
  const history = Array.isArray(error.judgment_history) ? error.judgment_history : [];
  const occurrence = basis.occurrence;
  const index = occurrence?.kind === 'first' ? -1 : history.findIndex(entry => canonicalJson(entry) === canonicalJson(occurrence));
  if (occurrence?.kind !== 'first' && index < 0) return { state: 'unknown', observation: 'episode_unavailable' };
  for (const entry of history.slice(index + 1)) {
    if (entry.kind === 'business_reopened') return { state: 'closed', observation: 'historical_episode', closedSnapshotId: entry.previousClosedSnapshotId ?? null };
    if (['new_wrong_occurrence', 'judgment_reactivated'].includes(entry.kind)) return { state: 'withdrawn', observation: 'historical_episode' };
  }
  return { state: error.judgment_state === 'withdrawn' ? 'withdrawn' : error.status, observation: 'current' };
}

/**
 * Associations and reversible dispositions over existing event and run owners. No model, payment or new job engine.
 * Producers supply the immutable event basis; public routes accept only selection and disposition.
 */
export class GeoSignals {
  constructor({ documents, store, service, runs, resultForRun, sourceReviewForRun = null, notify = null, now = () => new Date() }) {
    this.documents = documents; this.store = store; this.service = service; this.runs = runs;
    this.resultForRun = resultForRun; this.notify = notify; this.now = now;
    this.sourceReviewForRun = sourceReviewForRun;
  }

  async record(project, event) {
    if (!GEO_SIGNAL_KINDS.includes(event.kind) || typeof event.objectKey !== 'string' || !event.objectKey || event.objectKey.length > 3000
      || typeof event.eventVersion !== 'string' || !event.eventVersion || event.eventVersion.length > 200
      || !shape(event.basis, Object.keys(event.basis ?? {})) || event.kind !== 'source_changed' && Buffer.byteLength(JSON.stringify(event.basis)) > 200_000
      || typeof event.title !== 'string' || !event.title.trim() || event.title.length > 1000) throw fail('geo_payload_invalid', 'Invalid preserved signal.', 400);
    const id = geoSignalId(project.id, event.kind, event.objectKey, event.eventVersion);
    const prior = await this.documents.get(project.userId, 'geo-signal', id);
    if (prior) return this.requireRow(project, prior);
    const packed = event.kind === 'source_changed' ? packGeoSignalTargets(project, id, event.basis) : { basis: event.basis, pages: [] };
    const payload = { recordType: 'geo-signal', schemaVersion: 1, geoId: project.id, kind: event.kind, step: GEO_SIGNAL_STEPS[event.kind],
      objectKey: event.objectKey, eventVersion: event.eventVersion, title: event.title, basis: packed.basis, basisDigest: digest(packed.basis),
      observedAt: iso(event.observedAt), detectedAt: this.now().toISOString(), disposition: 'active', dispositionBy: null,
      dispositionAt: null, dispositionReason: null };
    try {
      if (packed.pages.length) {
        await this.documents.createBatch(project.userId, [{ kind: 'geo-signal', id, projectId: project.projectId, payload }, ...packed.pages]);
        return this.requireRow(project, await this.documents.get(project.userId, 'geo-signal', id));
      }
      return await this.documents.put(project.userId, 'geo-signal', id, payload, { projectId: project.projectId, expectedRevision: 0 });
    }
    catch (error) {
      const existing = await this.documents.get(project.userId, 'geo-signal', id);
      if (existing) return this.requireRow(project, existing);
      throw error;
    }
  }

  requireRow(project, row) {
    if (!row || row.projectId !== project.projectId || row.payload.recordType !== 'geo-signal' || row.payload.geoId !== project.id
      || row.id !== geoSignalId(project.id, row.payload.kind, row.payload.objectKey, row.payload.eventVersion)
      || row.payload.basisDigest !== digest(row.payload.basis)) throw fail('geo_signal_not_found', 'Signal unavailable.', 404);
    return row;
  }

  async row(project, id) {
    if (!/^gs_[a-f0-9]{64}$/.test(id ?? '')) throw fail('geo_signal_not_found', 'Signal unavailable.', 404);
    return this.requireRow(project, await this.documents.get(project.userId, 'geo-signal', id));
  }

  async all(project, kind, filter) {
    const items = [];
    let cursor = null;
    do {
      const page = await this.documents.list(project.userId, kind, { projectId: project.projectId, limit: 100, cursor, filter });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  async executions(project) {
    const contexts = await this.all(project, 'geo-plan-context', { recordType: 'geo-plan-context', geoId: project.id, mode: 'signal' });
    let runs = [], available = true;
    try { runs = await this.runs(project); } catch { available = false; }
    return { contexts, runs, available, results: new Map() };
  }

  async projectRow(project, row, execution) {
    this.requireRow(project, row);
    const contexts = execution.contexts.filter(context => context.payload.basis?.signal?.id === row.id
      && context.payload.basis.signal.basisDigest === row.payload.basisDigest);
    const attempts = [];
    const targets = row.payload.kind === 'source_changed' ? await readGeoSignalTargets(this.documents, project, row) : [];
    for (const context of contexts) {
      const candidates = execution.runs.filter(run => run.sessionId === context.payload.sessionId
        && run.kernelRequestIds?.includes(context.payload.requestId));
      const run = candidates.length === 1 ? candidates[0] : null;
      let result = null, available = execution.available && candidates.length <= 1;
      if (run) {
        try {
          if (!execution.results.has(run.id)) execution.results.set(run.id, Promise.resolve().then(() => this.resultForRun(project, run)));
          result = await execution.results.get(run.id);
        } catch { available = false; }
      }
      let sourceReview = null;
      if (row.payload.kind === 'source_changed' && run && this.sourceReviewForRun) {
        try { sourceReview = await this.sourceReviewForRun(project, row, run, targets); }
        catch { sourceReview = { availability: 'unknown', selectedTargetKeys: context.payload.basis.focusRefs ?? targets.map(target => target.key), records: [], issues: ['review_result_unavailable'] }; }
      }
      attempts.push({ contextRef: context.id, sessionId: context.payload.sessionId, requestId: context.payload.requestId,
        runId: run?.id ?? null, submitted: context.payload.state === 'bound', createdAt: context.createdAt,
        startedAt: run?.startedAt ?? null, finishedAt: run?.finishedAt ?? null, status: run?.status ?? null,
        result, sourceReview, ...geoSignalLifecycle({ context: context.payload, run, resultPresent: Boolean(result?.present), lookupAvailable: available }) });
    }
    attempts.sort((a, b) => String(b.startedAt ?? b.createdAt).localeCompare(String(a.startedAt ?? a.createdAt)) || b.contextRef.localeCompare(a.contextRef));
    // Opening another unsent draft must not hide the accepted attempt still running.
    const current = attempts.find(attempt => attempt.submitted) ?? attempts[0] ?? null;
    const lifecycle = current ? { state: row.payload.disposition === 'ignored' ? 'ignored' : current.state,
      executionState: current.executionState, availability: current.availability, reason: current.reason }
      : geoSignalLifecycle({ disposition: row.payload.disposition, lookupAvailable: execution.available });
    const sourceReview = row.payload.kind === 'source_changed' ? summarizeGeoSourceReviews(targets, attempts) : null;
    const businessOutcome = sourceReview ? { state: sourceReview.state, verification: sourceReview.verification,
      total: sourceReview.total, handled: sourceReview.handled, remaining: sourceReview.remaining } : await this.businessOutcome(project, row);
    if (sourceReview && lifecycle.state === 'completed' && sourceReview.state !== 'handled') {
      lifecycle.state = 'pending'; lifecycle.reason = 'source_scope_remaining';
    }
    if (row.payload.kind === 'order_anomaly' && businessOutcome.observation !== 'unknown') {
      lifecycle.executionState = businessOutcome.observation === 'historical_episode' || ['cancelled', 'refunded', 'published', 'verified', 'settled'].includes(businessOutcome.state) ? 'completed' : 'failed_recoverable';
      lifecycle.state = row.payload.disposition === 'ignored' ? 'ignored' : lifecycle.executionState;
      lifecycle.availability = 'available';
      lifecycle.reason = lifecycle.executionState === 'completed' ? null : 'order_needs_attention';
    }
    const affectedSteps = [...new Set([row.payload.step,
      ...(row.payload.kind === 'citation_observed' ? ['sources'] : []),
      ...(row.payload.kind === 'error_observed' || row.payload.basis.targets?.some(target => target.type === 'article') || row.payload.basis.targetKinds?.includes('article') || row.payload.basis.articleId ? ['content'] : [])])];
    return { id: row.id, revision: row.revision, kind: row.payload.kind, step: row.payload.step, affectedSteps, title: row.payload.title,
      createdAt: row.createdAt, observedAt: row.payload.observedAt, detectedAt: row.payload.detectedAt, disposition: row.payload.disposition,
      ...lifecycle, businessOutcome, actionable: ['pending', 'failed_recoverable'].includes(lifecycle.state) && !['closed', 'withdrawn'].includes(businessOutcome.state)
        && !(row.payload.kind === 'error_observed' && businessOutcome.state === 'unknown'),
      sourceReview, currentAttempt: current, attempts };
  }

  async businessOutcome(project, row) {
    const basis = row.payload.basis;
    if (row.payload.kind === 'error_observed') {
      const error = (await this.store.query('SELECT status,judgment_state,judgment_history FROM evimed_geo.errors WHERE geo_project_id=$1 AND id=$2', [project.id, basis.errorId])).rows[0];
      return geoSignalErrorOutcome(error, basis);
    }
    if (row.payload.kind === 'order_anomaly') {
      const order = (await this.store.query('SELECT state FROM evimed_geo.orders WHERE geo_project_id=$1 AND id=$2', [project.id, basis.orderId])).rows[0];
      if (order && basis.eventId) {
        const resolution = (await this.store.query(`SELECT e.id,e.to_state FROM evimed_geo.order_events origin
          JOIN evimed_geo.order_events e ON e.order_id=origin.order_id AND (e.at,e.id)>(origin.at,origin.id)
          WHERE origin.order_id=$1 AND origin.id=$2 AND e.from_state IS DISTINCT FROM e.to_state
            AND (e.to_state IN ('cancelled','refunded','published','verified','settled')
              OR $3='unknown' AND e.to_state IN ('submitted','accepted')) ORDER BY e.at,e.id LIMIT 1`,
        [basis.orderId, basis.eventId, basis.toState])).rows[0];
        if (resolution) return { state: resolution.to_state, currentState: order.state, observation: 'historical_episode', resolutionEventId: resolution.id };
      }
      return { state: order?.state ?? 'unknown', observation: order ? 'current' : 'unknown' };
    }
    return { state: row.payload.kind === 'source_changed' ? 'unreviewed' : 'observed' };
  }

  async list(user, geoId, input = {}) {
    const project = await this.service.requireProject(user, geoId);
    if (!shape(input, ['limit', 'cursor', 'kind', 'state', 'step', 'actionable'])) throw fail('geo_payload_invalid', 'Invalid signal page.', 400);
    const limit = Number(input.limit ?? 20);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || input.kind != null && !GEO_SIGNAL_KINDS.includes(input.kind) || input.state != null && !GEO_SIGNAL_STATES.includes(input.state)
      || input.step != null && !GEO_STEPS.includes(input.step) || input.actionable != null && ![true, false, 'true', 'false'].includes(input.actionable)) throw fail('geo_payload_invalid', 'Invalid signal page.', 400);
    const actionable = input.actionable == null ? null : input.actionable === true || input.actionable === 'true';
    const scope = digest([project.id, input.kind ?? null, input.state ?? null, input.step ?? null, actionable]);
    let after = null;
    if (input.cursor != null) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 1000) throw new Error();
        after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(after) || after.length !== 3 || after[0] !== scope || typeof after[1] !== 'string' || !Number.isFinite(Date.parse(after[1])) || !/^gs_[a-f0-9]{64}$/.test(after[2])) throw new Error();
      } catch { throw fail('geo_payload_invalid', 'Refresh this signal page.', 400); }
    }
    const [rows, execution] = await Promise.all([this.all(project, 'geo-signal', { recordType: 'geo-signal', geoId: project.id }), this.executions(project)]);
    const projected = [];
    // Keep database and transcript reads bounded; do not fan out every historical signal at once.
    for (const row of rows) projected.push(await this.projectRow(project, row, execution));
    const counts = Object.fromEntries(GEO_SIGNAL_STATES.map(state => [state, projected.filter(row => row.state === state).length]));
    const selected = projected.filter(row => (!input.kind || row.kind === input.kind) && (!input.state || row.state === input.state) && (!input.step || row.affectedSteps.includes(input.step)) && (actionable == null || row.actionable === actionable));
    const remaining = selected.filter(row => !after || row.createdAt < after[1] || row.createdAt === after[1] && row.id < after[2]);
    const items = remaining.slice(0, limit), last = items.at(-1);
    return { items, total: selected.length, counts, actionable: projected.filter(row => row.actionable).length,
      nextCursor: remaining.length > limit && last ? Buffer.from(JSON.stringify([scope, last.createdAt, last.id])).toString('base64url') : null };
  }

  async detail(user, geoId, id) {
    const project = await this.service.requireProject(user, geoId);
    const [row, execution] = await Promise.all([this.row(project, id), this.executions(project)]);
    return { ...await this.projectRow(project, row, execution), basis: row.payload.basis, basisDigest: row.payload.basisDigest,
      targets: await readGeoSignalTargets(this.documents, project, row),
      dispositionReason: row.payload.dispositionReason };
  }

  /** The AI-run record includes attended requests only when this project owns their exact context binding. */
  async attendedRuns(project) {
    const [contexts, runs] = await Promise.all([this.all(project, 'geo-plan-context', { recordType: 'geo-plan-context', geoId: project.id, state: 'bound' }), this.runs(project)]);
    return runs.flatMap(run => {
      const context = contexts.find(row => row.payload.sessionId === run.sessionId && run.kernelRequestIds?.includes(row.payload.requestId));
      if (!context) return [];
      return [{ sessionId: run.sessionId, runId: run.id, label: context.payload.basis?.signal?.title
        ?? ({ strategy: '所选范围的实施方案', content: '所选行动的内容处理', analysis: '所选数据分析' }[context.payload.mode] ?? '所选发现的处理'),
      reason: null, status: run.status, startedAt: run.startedAt ?? null }];
    });
  }

  /** Authoritative input for the existing native context adapter; no new composer or execution API. */
  async stageInput(project, input) {
    const row = await this.row(project, input.signalId);
    if (!Number.isSafeInteger(input.expectedSignalRevision) || row.revision !== input.expectedSignalRevision) throw fail('geo_signal_conflict', 'The signal changed; refresh its details.');
    if (row.payload.kind === 'order_anomaly') throw fail('geo_payload_invalid', 'Open the existing order to resolve its state.', 400);
    const intents = row.payload.kind === 'source_changed' ? ['review', 'analyse'] : row.payload.kind === 'error_observed' ? ['correct', 'analyse'] : ['analyse'];
    if (!intents.includes(input.intent)) throw fail('geo_payload_invalid', 'Choose a supported action for this signal.', 400);
    const targets = await readGeoSignalTargets(this.documents, project, row);
    const focus = input.focusRefs ?? targets.map(target => target.key);
    if (!Array.isArray(focus) || focus.length > 100 || new Set(focus).size !== focus.length || focus.some(key => typeof key !== 'string' || !targets.some(target => target.key === key))) {
      throw fail('geo_payload_invalid', 'Choose only preserved affected versions.', 400);
    }
    let previous = null;
    if (input.previousContextRef != null) {
      previous = await this.documents.get(project.userId, 'geo-plan-context', input.previousContextRef);
      if (!previous || previous.projectId !== project.projectId || previous.payload.geoId !== project.id || previous.payload.mode !== 'signal'
        || previous.payload.state !== 'bound' || previous.payload.basis?.signal?.id !== row.id) throw fail('geo_plan_context_not_found', 'Previous handling is unavailable.', 404);
      const execution = await this.executions(project);
      if (!execution.available) throw fail('geo_unavailable', 'Refresh the previous execution before continuing.', 503);
      const exact = execution.runs.filter(run => run.sessionId === previous.payload.sessionId && run.kernelRequestIds?.includes(previous.payload.requestId));
      if (exact.length !== 1 || !['failed', 'cancelled', 'canceled', 'budget_exhausted', 'succeeded'].includes(exact[0].status)) throw fail('geo_signal_conflict', 'The previous request is still running or unavailable.');
      previous = { contextRef: previous.id, sessionId: previous.payload.sessionId, requestId: previous.payload.requestId, runId: exact[0].id, status: exact[0].status };
      if (previous.sessionId !== input.sessionId) throw fail('geo_plan_context_mismatch', 'Continue in the existing conversation.');
    }
    const basis = { schemaVersion: 1, signal: { id: row.id, revision: row.revision, kind: row.payload.kind, title: row.payload.title,
      basisDigest: row.payload.basisDigest, observedAt: row.payload.observedAt, detectedAt: row.payload.detectedAt },
      event: { ...row.payload.basis, targets: targets.filter(target => focus.includes(target.key)),
        targetSelection: { total: targets.length, selected: focus.length, fullDigest: digest(targets) } }, focusRefs: focus, intent: input.intent, previous, groups: [],
      handlingKey: digest([row.id, row.payload.basisDigest, input.intent, [...focus].sort(), previous?.contextRef ?? null]) };
    return { basis, draft: `${input.intent === 'correct' ? '请根据原回答和适用条件写纠错内容' : input.intent === 'review' ? '请核查这次资料变化影响的指定结论和稿件版本，说明需要更新、已更新以及仍待核实的部分' : '请解释这条发现及其依据，提出下一步建议'}：${row.payload.title}` };
  }

  async disposition(user, geoId, id, input) {
    const project = await this.service.requireProject(user, geoId, 'edit');
    if (!shape(input, ['expectedRevision', 'requestKey', 'disposition', 'reason']) || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1 || !validId(input.requestKey) || !GEO_SIGNAL_DISPOSITIONS.includes(input.disposition)
      || input.reason != null && (typeof input.reason !== 'string' || input.reason.length > 1000)) throw fail('geo_payload_invalid', 'Invalid signal disposition.', 400);
    const key = `gsd_${digest([project.id, user.id, input.requestKey])}`, fingerprint = digest([id, input]);
    const replay = await this.documents.get(project.userId, 'geo-signal', key);
    if (replay) {
      if (replay.projectId !== project.projectId || replay.payload.fingerprint !== fingerprint) throw fail('geo_signal_conflict', 'This request key names another disposition.');
      return this.detail(user, geoId, id);
    }
    try {
      await this.store.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('geo-signal:' || $1))", [id]);
        const row = this.requireRow(project, (await client.query(`SELECT payload,revision,project_id AS "projectId",id FROM evimed_product.documents
          WHERE user_id=$1 AND kind='geo-signal' AND id=$2 AND deleted_at IS NULL FOR UPDATE`, [project.userId, id])).rows[0]);
        if (row.revision !== input.expectedRevision) throw fail('geo_signal_conflict', 'The signal changed; refresh before changing its disposition.');
        await this.documents.put(project.userId, 'geo-signal', row.id, { ...row.payload, disposition: input.disposition,
          dispositionBy: user.id, dispositionAt: this.now().toISOString(), dispositionReason: input.reason?.trim() || null },
        { projectId: project.projectId, expectedRevision: row.revision, transactionClient: client });
        await this.documents.put(project.userId, 'geo-signal', key, { recordType: 'geo-signal-disposition', geoId, actorId: user.id, signalId: id, fingerprint },
          { projectId: project.projectId, expectedRevision: 0, transactionClient: client });
      });
    } catch (error) {
      const receipt = await this.documents.get(project.userId, 'geo-signal', key);
      if (receipt?.projectId !== project.projectId || receipt.payload.fingerprint !== fingerprint) throw error;
    }
    return this.detail(user, geoId, id);
  }

  /** Called only by the existing leased GEO loop; reads never create notices. */
  async deliver(project, row) {
    this.requireRow(project, row);
    if (!this.notify || row.payload.disposition === 'ignored') return null;
    const outcome = await this.businessOutcome(project, row);
    if (row.payload.kind === 'error_observed' && ['closed', 'withdrawn', 'unknown'].includes(outcome.state)) return null;
    if (row.payload.kind === 'order_anomaly' && (outcome.observation === 'historical_episode' || ['cancelled', 'refunded', 'published', 'verified', 'settled'].includes(outcome.state))) return null;
    return this.notify(project, row);
  }
}
