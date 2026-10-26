/** Native transcript proof for VCR. Runtime-supplied session ids are only claims
 * until the pending tool and its immutable arguments are checked, as in resultGateway. */
import { canonicalJson, mcpToolName } from '@evimed/domain';
import { HttpError } from './security.mjs';
const unavailable = () => new HttpError(403, 'vcr_invocation_unavailable', 'A current native research call is required.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function projected(tool, operation, actual, body) {
  if (tool === 'trial_registry_record' && operation === 'read') return { what: 'trial_registry_record', filter: {
    registryId: actual.registryId?.trim(), ...(actual.registry?.trim() ? { registry: actual.registry.trim() } : {}) } };
  if (tool === 'curve_digitize' && operation === 'digitize') return actual;
  if (tool === 'evidence_pool' && operation === 'simulate') return (actual.action ?? 'start') === 'start'
    ? {action:'start',kind:'pool_evidence',subjectId:actual.parameter.trim().slice(0,120),scenario:{parameter:actual.parameter.trim(),endpointKey:actual.endpointKey,
      ...(actual.calibres != null ? {calibres:actual.calibres} : {}),...(actual.method != null ? {method:actual.method} : {})}}
    : {action:actual.action,jobId:actual.jobId};
  if (tool !== `vcr_${operation}`) throw unavailable();
  const keys = operation === 'read' ? ['what', 'filter'] : operation === 'write' ? ['what', 'data', 'items']
    : (actual.action ?? 'start') === 'start' ? ['action', 'kind', 'scenario', 'inputs', 'seed', 'replicates', 'cpuSecondsLimit', 'subjectId', 'reconstructionResultId', 'selection', 'modelId', 'modelVersion'] : ['action', 'jobId'];
  const result = Object.fromEntries(keys.filter(key => actual[key] != null).map(key => [key, actual[key]]));
  if (operation === 'simulate') result.action ??= 'start';
  if (operation === 'read' && object(result.filter) && !Object.keys(result.filter).length && !body.filter) delete result.filter;
  return result;
}

export async function verifyVcrInvocation({ header, project, runtimeManager, resolveSession, runs, operation, body, readBenchmark = null, authenticatedUserId = null }) {
  let context;
  try { context = JSON.parse(String(header ?? '')); } catch { throw unavailable(); }
  if (context?.v !== 1 || typeof context.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(context.sessionId)
    || typeof context.callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/.test(context.callId)) throw unavailable();
  const owned = resolveSession(project, context.sessionId);
  const transcript = await runtimeManager.sessionTranscript(project, context.sessionId, { wake: false,
    ...(owned?.child ? { parentSessionId: owned.parentSessionId } : {}) });
  const turn = transcript?.turns?.at(-1);
  const calls = (transcript?.messages ?? []).flatMap(message => (message.parts ?? []).map(part => ({ message, part })))
    .filter(item => item.part.type === 'tool' && item.part.callId === context.callId);
  if (transcript?.sessionId !== context.sessionId || transcript.truncated || !turn || turn.end !== null || calls.length !== 1
    || calls[0].part.status !== 'pending' || calls[0].message.turnStartSeq !== turn.startSeq) throw unavailable();
  const part = calls[0].part;
  const tool = ['vcr_read', 'vcr_write', 'vcr_simulate', 'trial_registry_record', 'curve_digitize', 'evidence_pool']
    .find(name => [name, mcpToolName(name)].includes(part.tool));
  if (!tool || !object(part.input)) throw unavailable();
  let expected = projected(tool,operation,part.input,body);
  if (tool==='vcr_write' && part.input.what==='trial_benchmark' && part.input.data?.predictionsFile) {
    if (!readBenchmark) throw unavailable();
    expected={...expected,data:await readBenchmark(project,part.input.data.predictionsFile)};
  }
  if (canonicalJson(expected)!==canonicalJson(body)) throw unavailable();
  const run = runs.find(row => row.id === owned?.runId || row.sessionId === context.sessionId);
  if (!run?.sessionId) throw unavailable();
  return { userId: authenticatedUserId ?? project.userId, projectId: project.id, sessionId: context.sessionId, rootSessionId: run.sessionId,
    runId: run.id, callId: context.callId, dispatchId:run.dispatchId ?? null, routeReason:run.effectiveRouteReason ?? null,
    programme:typeof run.effectiveRouteReason === 'string' && run.effectiveRouteReason.startsWith('vcr:') };
}
