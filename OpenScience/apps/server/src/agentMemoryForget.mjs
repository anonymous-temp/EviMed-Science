import { privateByDefault } from '@evimed/domain';
import { NATIVE_RECORD_ID } from './nativeMemoryStore.mjs';
import { HttpError } from './security.mjs';

/** The public adapter selects owned records; the native tool owns every deletion and withdrawal. */
export async function forgetForAgent({ config, native, admission }, { user, project, boundProject, input }) {
  const invalid = () => new HttpError(400, 'agent_memory_payload_invalid', 'Choose recordId with optional non-empty exact lines, or statement alone.');
  const statement = input.statement !== undefined;
  if (statement ? (typeof input.statement !== 'string' || !input.statement.trim() || input.statement.length > 6000 || input.recordId !== undefined || input.lines !== undefined)
    : (typeof input.recordId !== 'string' || !NATIVE_RECORD_ID.test(input.recordId))) throw invalid();
  if (input.lines !== undefined && (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100
    || input.lines.some(line => typeof line !== 'string' || !line.trim() || line.length > 6000 || /[\r\n]/.test(line)))) throw invalid();
  // Native withdrawal follows copies across the owned namespace. A project key cannot authorize that scope.
  if (boundProject) throw new HttpError(403, 'agent_key_project_denied', 'Withdrawal requires an account-scoped key.');
  if (config.memoryForgetTargetsEnabled !== true || !native?.forgetTargetsEnabled || !admission || !native.memoryContexts) {
    throw new HttpError(503, 'memory_engine_unavailable', 'Targeted forgetting is unavailable.');
  }
  const context = await native.memoryContexts.forProject(project);
  if (context.kind !== 'owned') throw new HttpError(403, 'memory_scope_denied', 'Shared memory is not available through this operation.');
  await native.memoryContexts.assertLive(context);
  const admitted = await admission.admit({ user, project, allowRunningFallback: false });
  if (['memory_off', 'internal_project', 'trial'].includes(admitted.learnReason)) {
    throw new HttpError(403, 'memory_scope_denied', `Memory operation refused: ${admitted.learnReason}.`);
  }
  // A bare statement has account-wide rejection authority, not a project-labelled file.
  if (statement && project.id !== 'default') throw new HttpError(403, 'agent_key_project_denied', 'Statement withdrawal uses the ordinary account namespace; omit projectId.');
  /** @type {{statement?: string, lines?: string[]}} */
  let options = statement ? { statement: input.statement } : {};
  let uri = null, profileLine = false;
  if (!statement) {
    const record = await native.getRecord(user.id, input.recordId);
    if (record.sensitive === true || privateByDefault(record)) throw new HttpError(404, 'memory_not_found', 'No such memory.');
    if (input.projectId && (record.scope !== 'project' || record.scopeId !== project.id)) {
      throw new HttpError(403, 'agent_key_project_denied', 'This memory belongs to a different scope.');
    }
    uri = record.document?.uri ?? record.uri;
    if (!uri || (await native.memoryContexts.forUri(user.id, uri)).kind !== 'owned') {
      throw new HttpError(404, 'memory_not_found', 'No such memory.');
    }
    // A profile entry names one line in a larger file, never authority over its neighbours.
    profileLine = Boolean(record.document);
    if (profileLine && input.lines && (input.lines.length !== 1 || input.lines[0] !== record.value)) throw invalid();
    const lines = input.lines ?? (record.document ? [record.value] : undefined);
    options = lines === undefined ? {} : { lines };
  }
  // Carry the verified context into the native live-context check. Re-resolving
  // without it could adopt a project whose namespace changed during admission.
  const outcome = await native.forget(user, project, uri, { ...options, context });
  // A stale line selection may not reveal the rest of its profile as retry hints.
  if (profileLine && outcome.availableLines) {
    const { availableLines: _available, ...confirmed } = outcome;
    return confirmed;
  }
  return outcome;
}

/** Management reads intentionally include withdrawn text so its owner can undo the withdrawal. */
export async function forgottenForAgent(native, user, { projectId = null, canRestore = false } = {}) {
  const items = [];
  for (const record of await native.forgotten(user.id)) {
    if (record.sensitive === true || privateByDefault(record) || (projectId && (record.scope !== 'project' || record.scopeId !== projectId))) continue;
    if (!native.memoryContexts || (await native.memoryContexts.forUri(user.id, record.uri)).kind !== 'owned') continue;
    items.push({ id: record.id, text: record.value, version: record.version, forgottenAt: record.updatedAt,
      ...(canRestore ? { restore: { path: `/api/agent-memory/v1/records/${encodeURIComponent(record.id)}/restore`, expectedVersion: record.version } } : {}) });
  }
  return items;
}
