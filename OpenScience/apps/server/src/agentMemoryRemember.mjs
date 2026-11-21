import { HttpError } from './security.mjs';

/** External references are labels, not authority to read another conversation or namespace. */
export function rememberSource(input) {
  const invalid = () => new HttpError(400, 'agent_memory_payload_invalid', 'A statement and external source client, sessionId and saidAt are required.');
  if (typeof input.statement !== 'string' || !input.statement.trim() || input.statement.length > 2000) throw invalid();
  const source = input.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['client', 'sessionId', 'messageId', 'saidAt'].includes(key))) throw invalid();
  for (const key of ['client', 'sessionId', ...(source.messageId !== undefined ? ['messageId'] : [])]) {
    if (typeof source[key] !== 'string' || !source[key].trim() || source[key].length > (key === 'client' ? 80 : 200) || [...source[key]].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid();
  }
  if (typeof source.saidAt !== 'string' || source.saidAt.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(source.saidAt) || !Number.isFinite(Date.parse(source.saidAt))) throw invalid();
  return { ...source };
}

/** Used at HTTP admission and again by durable retries before each engine side effect. */
export async function rememberAdmission({ native, admission }, { user, project, at, engineSessionId = null }) {
  if (!native?.memoryContexts || !admission) throw new HttpError(503, 'memory_engine_unavailable', 'Memory admission is unavailable.');
  const context = await native.memoryContexts.forProject(project);
  if (context.kind !== 'owned') throw new HttpError(403, 'memory_scope_denied', 'Shared memory is unavailable through this operation.');
  await native.memoryContexts.assertLive(context);
  const decision = await admission.admit({ user, project, at, ...(engineSessionId ? {engineSessionId} : {}), allowRunningFallback: false });
  if (!decision.learn) throw new HttpError(decision.learnReason === 'engine_unavailable' ? 503 : 403, 'memory_scope_denied',
    `Memory operation refused: ${decision.learnReason}.`, { reason: decision.learnReason });
  return context;
}
