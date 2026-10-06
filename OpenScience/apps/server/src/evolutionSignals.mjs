import { evolutionKey } from './evolutionService.mjs';
import { EVOLUTION_MODULE_IDS } from './evolutionUsage.mjs';
import { isInternalProject } from './internalProjects.mjs';

export const EVOLUTION_DEMAND_MIN_ACCOUNTS = 5;
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

/** All user signals stay owner scoped. Only thresholded counts and closed codes become platform inputs.
 * @param {{service:any,capabilityIds:()=>Promise<string[]>}} dependencies */
export function createEvolutionSignals({ service, capabilityIds }) {
  async function record(input) {
    if (!input.userId || !input.projectId || !input.eventId || isInternalProject(input.projectId)) return null;
    if (!EVOLUTION_MODULE_IDS.includes(input.moduleId) || !EVOLUTION_SIGNAL_KINDS.includes(input.kind)) return null;
    const allowed = ['open-domain-answer', 'unknown', ...await capabilityIds()];
    const codes = { capability: allowed.includes(input.capability) ? input.capability : 'unknown',
      operation: EVOLUTION_OPERATIONS.includes(input.operation) ? input.operation : 'unknown',
      dataShape: EVOLUTION_DATA_SHAPES.includes(input.dataShape) ? input.dataShape : 'unknown',
      reason: EVOLUTION_DEMAND_REASONS.includes(input.reason) ? input.reason : 'unsupported' };
    const id = `evolution-signal-${evolutionKey([input.userId, input.eventId, input.kind])}`;
    return service.withLock(`signal:${input.userId}:${id}`,async()=>{
    const previous = await service.get(id, input.userId);
    if (previous) return previous;
    const payload = { kind: input.kind, moduleId: input.moduleId, codes, projectId: input.projectId,
      sourceEventId: input.eventId, sourceVersion: String(input.version ?? '').slice(0, 128),
      ...(input.kind === 'route-override' ? { fromCapability: allowed.includes(input.fromCapability) ? input.fromCapability : 'unknown' } : {}),
      firstSeenAt: service.now().toISOString(), count: 1, scope: 'owner' };
    return service.save('signal', id, payload, null, input.userId);
    });
  }

  async function aggregate() {
    const db = service.documents.database;
    if (!db) return [];
    return service.withLock('signal-aggregate',async()=>{
    // SQL returns only aggregates; project ids and account ids are not selected.
    const rows = await db.query(`SELECT payload->>'moduleId' AS module_id, payload->>'kind' AS kind,
      payload->'codes' AS codes, payload->>'fromCapability' AS from_capability,
      count(*)::integer AS occurrences, count(DISTINCT user_id)::integer AS accounts,
      min(created_at) AS first_seen, max(created_at) AS last_seen
      FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL
        AND payload->>'recordType'='evolution-signal'
      GROUP BY payload->>'moduleId',payload->>'kind',payload->'codes',payload->>'fromCapability'
      HAVING count(DISTINCT user_id)>=$1`, [EVOLUTION_DEMAND_MIN_ACCOUNTS]);
    const result = [];
    for (const row of rows.rows) {
      if (!EVOLUTION_MODULE_IDS.includes(row.module_id) || !EVOLUTION_SIGNAL_KINDS.includes(row.kind)) continue;
      const key = [row.module_id, row.kind, row.codes, row.from_capability ?? null];
      const id = `evolution-signal-summary-${evolutionKey(key)}`, prior = await service.get(id);
      if (prior?.payload.occurrences === row.occurrences && prior.payload.distinctAccounts === row.accounts) { result.push(prior); continue; }
      result.push(await service.save('signal-summary', id, { moduleId: row.module_id, kind: row.kind, codes: row.codes,
        ...(row.from_capability ? { fromCapability: row.from_capability } : {}),
        occurrences: row.occurrences, distinctAccounts: row.accounts, firstSeenAt: new Date(row.first_seen).toISOString(),
        lastSeenAt: new Date(row.last_seen).toISOString(), scope: 'platform-aggregate' }, prior));
    }
    return result;
    });
  }
  return { record, aggregate };
}
