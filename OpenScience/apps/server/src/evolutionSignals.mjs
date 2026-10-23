import { randomUUID } from 'node:crypto';
import { GEO_ERROR_TYPES, GEO_STATEMENT_TOPICS } from '@evimed/domain';
import { evolutionKey } from './evolutionService.mjs';
import { EVOLUTION_MODULE_IDS } from './evolutionUsage.mjs';
import { isInternalProject } from './internalProjects.mjs';
import { EVOLUTION_ACCOUNT_CLASSES, EVOLUTION_DEMAND_MIN_ACCOUNTS, evolutionAccountClass, evolutionAccountFloors } from './evolutionAccountClasses.mjs';

export { EVOLUTION_ACCOUNT_CLASSES, EVOLUTION_DEMAND_MIN_ACCOUNTS, evolutionAccountClass, evolutionAccountFloors };
export const EVOLUTION_OPERATIONS = Object.freeze(['answer', 'search', 'synthesize', 'extract', 'transform', 'classify', 'route', 'plan', 'recall', 'edit', 'rank', 'simulate', 'compare-groups', 'paired-analysis', 'longitudinal-analysis', 'survival-analysis', 'competing-risk', 'meta-analysis', 'causal-inference', 'network-analysis', 'unknown']);
export const EVOLUTION_DATA_SHAPES = Object.freeze(['none', 'text', 'table', 'paired', 'longitudinal', 'time-to-event', 'competing-events', 'expression-matrix', 'network', 'image', 'mixed', 'unknown']);
export const EVOLUTION_DEMAND_REASONS = Object.freeze(['unsupported', 'refusal', 'missing-data', 'missing-tool']);
export const EVOLUTION_SIGNAL_KINDS = Object.freeze(['unmet-demand', 'route-override', 'classifier-failure', 'planner-fallback', 'source-omission', 'semantics-contested', 'semantics-correction', 'availability', 'workflow-success', 'memory-accepted', 'memory-modified', 'memory-rejected', 'review-accepted', 'review-rejected', 'programme-outcome', 'result-correction', 'citation-rejected', 'question-rephrased', 'geo-misconception']);

/** Project metadata is reduced to a closed shape; no names, categories, values or identifiers escape. @param {any} dataset */
export function evolutionDataShape(dataset) {
  const shape = dataset?.shapeCode;
  if (EVOLUTION_DATA_SHAPES.includes(shape)) return shape;
  const unit = dataset?.rowRepresents;
  if (unit === 'repeated-observation') return 'longitudinal';
  if (Array.isArray(dataset?.fields) && dataset.fields.length) return 'table';
  return 'unknown';
}

/** All user signals stay owner scoped. Only thresholded counts and closed codes become platform inputs. `operatorIds` names the
 * accounts of the operator class and `floors` the number of different accounts each class needs (`evolutionAccountFloors`).
 * @param {{service:any,capabilityIds:()=>Promise<string[]>,operatorIds?:()=>string[],floors?:{user:number,operator:number}}} dependencies */
export function createEvolutionSignals({ service, capabilityIds, operatorIds = () => [], floors = evolutionAccountFloors() }) {
  const versioned = input => Number.isSafeInteger(input.sourceRevision) && input.sourceRevision > 0;
  const signalId = input => `evolution-signal-${evolutionKey([input.userId, ...(versioned(input) ? [input.projectId] : []), input.eventId, input.kind])}`;
  /** What the last `aggregate()` did with the groups it saw, per class: written as a summary, or held back below the class's floor
   * (a gauge of the latest pass, not a running total, because the pass repeats daily over the same signals). */
  const counters = { aggregated: { user: 0, operator: 0 }, heldBack: { user: 0, operator: 0 } };
  async function record(input) {
    if (!input.userId || !input.projectId || !input.eventId || isInternalProject(input.projectId)) return null;
    if (!EVOLUTION_MODULE_IDS.includes(input.moduleId) || !EVOLUTION_SIGNAL_KINDS.includes(input.kind)) return null;
    if (input.sourceRevision !== undefined && !versioned(input)) return null;
    const allowed = ['open-domain-answer', 'unknown', ...await capabilityIds()];
    const codes = { capability: allowed.includes(input.capability) ? input.capability : 'unknown',
      operation: EVOLUTION_OPERATIONS.includes(input.operation) ? input.operation : 'unknown',
      dataShape: EVOLUTION_DATA_SHAPES.includes(input.dataShape) ? input.dataShape : 'unknown',
      reason: EVOLUTION_DEMAND_REASONS.includes(input.reason) ? input.reason : 'unsupported' };
    if (input.kind === 'geo-misconception') Object.assign(codes, {
      errorType: GEO_ERROR_TYPES.includes(input.errorType) ? input.errorType : 'unknown',
      topic: GEO_STATEMENT_TOPICS.includes(input.topic) ? input.topic : 'other',
    });
    const id = signalId(input);
    return service.withLock(`signal:${input.userId}:${id}`,async()=>{
    const previous = await service.get(id, input.userId);
    if (previous && (!versioned(input) || Number(previous.payload.sourceRevision ?? 0) >= input.sourceRevision)) return previous;
    const payload = { kind: input.kind, moduleId: input.moduleId, codes, projectId: input.projectId,
      sourceEventId: input.eventId, sourceVersion: String(input.version ?? '').slice(0, 128),
      ...(versioned(input) ? { sourceRevision: input.sourceRevision, state: 'active',
        ...(typeof input.provenanceRef === 'string' ? { provenanceRef: input.provenanceRef } : {}),
        ...(previous ? { supersedesVersion: previous.payload.sourceVersion } : {}) } : {}),
      ...(input.kind === 'route-override' ? { fromCapability: allowed.includes(input.fromCapability) ? input.fromCapability : 'unknown' } : {}),
      firstSeenAt: previous?.payload.firstSeenAt ?? service.now().toISOString(), count: 1, scope: 'owner' };
    return service.save('signal', id, payload, previous, input.userId);
    });
  }

  /** Withdraw exactly the assessment read by the caller. A newer assessment alone may reactivate it. */
  async function transition(input) {
    if (!versioned(input) || !['suspended', 'invalidated'].includes(input.state)) return null;
    const id = signalId(input);
    return service.withLock(`signal:${input.userId}:${id}`, async () => {
      const previous = await service.get(id, input.userId);
      if (!previous || previous.payload.projectId !== input.projectId || previous.payload.sourceVersion !== input.expectedVersion
        || (input.expectedRevision !== undefined && previous.revision !== input.expectedRevision)) return null;
      if (previous.payload.state === 'invalidated' || previous.payload.state === input.state) return previous;
      return service.save('signal', id, { ...previous.payload, state: input.state, stateChangedAt: service.now().toISOString() }, previous, input.userId);
    });
  }

  async function aggregate() {
    const db = service.documents.database;
    if (!db) return [];
    const operators = [...new Set(operatorIds().map(String).filter(Boolean))];
    return service.withLock('signal-aggregate',async()=>{
    // SQL returns only aggregates; project ids and account ids are not selected. Accounts are counted inside their class: the
    // operator class on its own, everyone else on theirs, so a researcher is never counted towards an operator's floor.
    const rows = await db.query(`SELECT module_id, kind, codes, from_capability, operator_class,
      count(*)::integer AS occurrences, count(DISTINCT user_id)::integer AS accounts, min(created_at) AS first_seen, max(updated_at) AS last_seen,
      md5(string_agg(member, ',' ORDER BY member)) AS membership
      FROM (SELECT payload->>'moduleId' AS module_id, payload->>'kind' AS kind, payload->'codes' AS codes,
          payload->>'fromCapability' AS from_capability, user_id, created_at, updated_at, (user_id = ANY($1::text[])) AS operator_class,
          jsonb_build_array(user_id,id,revision)::text AS member
        FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL
          AND payload->>'recordType'='evolution-signal' AND coalesce(payload->>'state','active')='active') signals
      GROUP BY module_id, kind, codes, from_capability, operator_class`, [operators]);
    const result = [];
    const active = new Set();
    counters.aggregated = { user: 0, operator: 0 }; counters.heldBack = { user: 0, operator: 0 };
    for (const row of rows.rows) {
      if (!EVOLUTION_MODULE_IDS.includes(row.module_id) || !EVOLUTION_SIGNAL_KINDS.includes(row.kind)) continue;
      const accountClass = row.operator_class === true ? 'operator' : 'user';
      if (row.accounts < floors[accountClass]) { counters.heldBack[accountClass]++; continue; }
      counters.aggregated[accountClass]++;
      // A researcher's summary keeps the identity it had before the classes existed; the operator class has its own.
      const key = [row.module_id, row.kind, row.codes, row.from_capability ?? null, ...(accountClass === 'operator' ? ['operator'] : [])];
      const id = `evolution-signal-summary-${evolutionKey(key)}`, prior = await service.get(id);
      active.add(id);
      // Membership fingerprints remain internal. The public summary carries an unrelated opaque generation.
      const stateId = `evolution-signal-membership-${evolutionKey(id)}`, state = await service.get(stateId);
      if (state?.payload.membership === row.membership && prior?.payload.state === 'active'
        && prior.payload.occurrences === row.occurrences && prior.payload.distinctAccounts === row.accounts) { result.push(prior); continue; }
      await service.save('signal-membership', stateId, { membership: row.membership }, state);
      result.push(await service.save('signal-summary', id, { moduleId: row.module_id, kind: row.kind, codes: row.codes,
        ...(row.from_capability ? { fromCapability: row.from_capability } : {}), accountClass, state: 'active', generation: randomUUID(),
        occurrences: row.occurrences, distinctAccounts: row.accounts, firstSeenAt: new Date(row.first_seen).toISOString(),
        lastSeenAt: new Date(row.last_seen).toISOString(), scope: 'platform-aggregate' }, prior));
    }
    for (const prior of await service.list('signal-summary')) {
      if (active.has(prior.id) || prior.payload.state === 'inactive') continue;
      const { occurrences: _occurrences, distinctAccounts: _accounts, ...payload } = prior.payload;
      await service.save('signal-summary', prior.id, { ...payload, state: 'inactive', generation: randomUUID(), retiredAt: service.now().toISOString() }, prior);
    }
    return result;
    });
  }
  return { record, transition, aggregate, counters, floors };
}
