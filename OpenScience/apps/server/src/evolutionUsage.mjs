import { createHash } from 'node:crypto';
/** Closed metadata from actual output; private output is never retained here. @param {any} output */
export function evolutionResultEvidence(output) {
  let value = output;
  if (typeof value === 'string') { try { value = JSON.parse(value.trim().split('\n').at(-1)); } catch { /* Text alone cannot establish a supported numerical result. */ } }
  const unsupported = node => node && typeof node === 'object' && ([node.status,node.code].some(state => ['unsupported','not_supported','not-supported','needs_input','unavailable','failed','error','refused','invalid_input','invalid-input'].includes(state)) || node.supported === false || typeof node.error === 'string' && node.error.trim());
  const substantive = (node, depth = 0) => {
    if (depth > 20 || unsupported(node)) return false;
    if (typeof node === 'number') return Number.isFinite(node);
    if (Array.isArray(node)) return node.some(item => substantive(item, depth + 1));
    if (!node || typeof node !== 'object') return false;
    if (typeof node.stdout === 'string' || typeof node.output === 'string') return evolutionResultEvidence(node.stdout ?? node.output).substantive;
    return Object.entries(node).some(([key,item]) => !['ok','status','code','exitCode','exit_code','duration','durationMs','elapsed','elapsedMs','stderr','warnings','logs'].includes(key) && substantive(item, depth + 1));
  };
  return { sha256: createHash('sha256').update(JSON.stringify(output) ?? 'null').digest('hex'), kind: value === null || value === undefined || value === '' ? 'empty' : typeof value === 'object' ? 'structured' : 'text',
    substantive: substantive(value), explicitlyUnsupported: Boolean(unsupported(value)) };
}
/** A supported result means an actual substantive tool output in a completed, nonempty run.
 * It does not assert scientific validity, empirical validation, or a quality-gate pass.
 * @param {any} use @param {any} run @param {any} transcript */
export function evolutionCompletedResult(use, run, transcript) {
  if (!['succeeded','delivered','failed','canceled','cancelled'].includes(run.status)) return { supported: null, resultState: 'pending' };
  const delivered = (run.artifacts ?? []).length > 0 || (run.unverifiedArtifacts ?? []).length > 0 || (run.deliverables ?? []).some(item => item.artifactPath || item.path || item.files?.length);
  const answer = transcript?.header?.completeness === 'complete' && transcript.messages?.some(message => message.role === 'assistant' && message.parts?.some(part => part.type === 'text' && part.text?.trim()));
  const completed = ['succeeded','delivered'].includes(run.status) && Boolean(delivered || answer);
  const noResult = !['succeeded','delivered'].includes(run.status) || (!delivered && transcript?.header?.completeness === 'complete' && !answer);
  const supported = noResult || use.result?.ok === false || use.resultEvidence?.explicitlyUnsupported ? false : completed && use.resultEvidence?.substantive === true ? true : null;
  return { supported, resultState: supported === true ? 'supported-completed-tool-result' : supported === false ? 'no-supported-completed-result' : 'result-evidence-unknown',
    resultScope: 'completed-run-with-substantive-tool-output', runStatus: run.status };
}

import { AsyncLocalStorage } from 'node:async_hooks';

// This context is set by the trusted worker, never by an agent's tool arguments.
const context = new AsyncLocalStorage();
export const EVOLUTION_MODULE_IDS = Object.freeze(['tools', 'frontier', 'geo', 'autopilot', 'sources', 'evidence', 'memory', 'runtime']);

/** @param {{missionId:string,moduleId:string}} value @param {()=>any} operation */
export function withEvolutionUsage(value, operation) {
  if (!/^evolution-mission-[a-zA-Z0-9_-]+$/.test(value.missionId) || !EVOLUTION_MODULE_IDS.includes(value.moduleId)) throw new Error('Invalid evolution accounting context.');
  return context.run(Object.freeze({ missionId: value.missionId, moduleId: value.moduleId }), operation);
}
/** The async context also covers nested reviewer/curator calls. */
export function evolutionUsageContext() { return context.getStore() ?? null; }

/** Resolve attribution for a runtime request in a different process. @param {any} client @param {any} request */
export async function resolveEvolutionUsage(client, request) {
  if (request.purpose !== 'evolution') return { missionId: null, moduleId: null };
  const local = evolutionUsageContext();
  if (local) return local;
  if (!request.runId) return { missionId: null, moduleId: null };
  const result = await client.query(`SELECT payload FROM evimed_product.documents
    WHERE user_id=$1 AND kind='knowledge' AND deleted_at IS NULL
      AND payload->>'recordType'='evolution-run-attribution' AND payload->>'projectId'=$2
      AND payload->'runIds' ? $3 LIMIT 1`, [request.userId, request.projectId, request.runId]);
  const payload = result.rows[0]?.payload;
  return payload && EVOLUTION_MODULE_IDS.includes(payload.moduleId)
    ? { missionId: payload.missionId, moduleId: payload.moduleId } : { missionId: null, moduleId: null };
}

/** A mission's reservation includes every unsettled request at its ceiling. @param {any} client @param {any} request @param {any} attribution */
export async function evolutionMissionBudget(client, request, attribution) {
  if (!attribution.missionId) return null;
  const result = await client.query(`SELECT d.payload->'budget'->>'reservedCny' AS limit,
    coalesce((SELECT sum(CASE WHEN r.status='settled' THEN coalesce(r.actual_cost,r.reserved_cost)
      WHEN r.status IN ('reserved','uncertain') THEN r.reserved_cost ELSE 0 END)
      FROM evimed_usage.model_requests r WHERE r.user_id=$1 AND r.purpose='evolution'
        AND r.evolution_mission_id=$2),0) AS committed
    FROM evimed_product.documents d WHERE d.user_id=$1 AND d.id=$2 AND d.kind='knowledge'
      AND d.deleted_at IS NULL AND d.payload->>'recordType'='evolution-mission'
      AND d.payload->>'moduleId'=$3`, [request.userId, attribution.missionId, attribution.moduleId]);
  const row = result.rows[0];
  return { limit: row && Number(row.limit) > 0 ? Number(row.limit) : 0, committed: Number(row?.committed ?? 0) };
}
