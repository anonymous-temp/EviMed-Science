/** Native transcript proof for VCR. Runtime-supplied session ids are only claims
 * until the pending tool and its immutable arguments are checked, as in resultGateway. */
import { canonicalJson, mcpToolName } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { VCR_JOB_METHODS, VCR_ENGINE_METHODS } from '@evimed/domain';
import { isResearchPluginTool, projectResearchInvocation, researchPluginOfTool } from '@evimed/research-plugin-runtime/hosted-protocol';
import { VCR_LAB_ACTION_FIELDS } from './vcrGateway.mjs';
const unavailable = () => new HttpError(403, 'vcr_invocation_unavailable', 'A current native research call is required.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function projected(tool, operation, actual, body) {
  if (isResearchPluginTool(tool)) {
    try {
      const request = projectResearchInvocation(tool, actual, { jobMethods: VCR_JOB_METHODS, methods: VCR_ENGINE_METHODS });
      if (request.operation !== operation) throw unavailable();
      return request.body;
    } catch { throw unavailable(); }
  }
  if (tool === 'trial_registry_record' && operation === 'read') return { what: 'trial_registry_record', filter: {
    registryId: actual.registryId?.trim(), ...(actual.registry?.trim() ? { registry: actual.registry.trim() } : {}) } };
  if (tool === 'curve_digitize' && operation === 'digitize') return Object.fromEntries(Object.entries(actual).filter(([,value]) => value != null));
  if (tool === 'evidence_pool' && operation === 'simulate') return (actual.action ?? 'start') === 'start'
    ? {action:'start',kind:'pool_evidence',subjectId:[...actual.parameter.trim()].slice(0,120).join(''),scenario:{parameter:actual.parameter.trim(),endpointKey:actual.endpointKey,
      ...(actual.calibres != null ? {calibres:actual.calibres} : {}),...(actual.method != null ? {method:actual.method} : {})}}
    : {action:actual.action,jobId:actual.jobId};
  if (tool !== `vcr_${operation}`) throw unavailable();
  // A lab action is proved by the fields the gateway reads for it (live 2026-11-07: with only action and jobId kept, every compare,
  // search and their reads from a real conversation was refused here).
  const lab = operation === 'simulate' && Object.hasOwn(VCR_LAB_ACTION_FIELDS, actual.action) ? /** @type {Record<string, readonly string[]>} */ (VCR_LAB_ACTION_FIELDS)[actual.action] : null;
  const keys = operation === 'read' ? ['what', 'filter'] : operation === 'write' ? ['what', 'data', 'items'] : lab ? lab
    : ['start', 'validate'].includes(actual.action ?? 'start') ? ['action', 'kind', 'scenario', 'inputs', 'seed', 'replicates', 'cpuSecondsLimit', 'subjectId', 'reconstructionResultId', 'selection', 'modelId', 'modelVersion', 'sources'] : ['action', 'jobId'];
  const result = Object.fromEntries(keys.filter(key => operation === 'write' ? Object.hasOwn(actual,key) : actual[key] != null).map(key => [key, actual[key]]));
  if (operation === 'simulate') result.action ??= 'start';
  // the study a call names explicitly (one handed to this conversation) is part of what the proof covers
  if (actual.studyId != null) result.studyId = actual.studyId;
  if (operation === 'read' && object(result.filter) && !Object.keys(result.filter).length && !body.filter) delete result.filter;
  return result;
}

/** A turn typed in the kernel's own composer reaches the ledger only when it is adopted, after the routing decision: about nine
 * seconds on 2026-11-01, while a first tool call goes out in two or three. The call's proof is the transcript, which already
 * holds it; only the run is late. So the run is waited for, up to `adoptionWaitMs`, and a turn that never comes is still refused. */
async function currentRun(runs, matches, adoptionWaitMs) {
  const list = async () => (await (typeof runs === 'function' ? runs() : runs)).find(matches);
  const deadline = Date.now() + adoptionWaitMs;
  for (;;) {
    const run = await list();
    if (run?.sessionId || typeof runs !== 'function' || Date.now() >= deadline) return run;
    await new Promise(done => setTimeout(done, 400));
  }
}

export async function verifyVcrInvocation({ header, project, runtimeManager, resolveSession, runs, operation, body, readBenchmark = null, authenticatedUserId = null, assertResearchPluginSelection = null, adoptionWaitMs = 0 }) {
  let context;
  try { context = JSON.parse(String(header ?? '')); } catch { throw unavailable(); }
  if (context?.v !== 1 || typeof context.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(context.sessionId)
    || typeof context.callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/.test(context.callId)) throw unavailable();
  const owned = resolveSession(project, context.sessionId);
  const transcript = await runtimeManager.sessionTranscript(project, context.sessionId, { wake: false, currentTurn: true,
    ...(owned?.child ? { parentSessionId: owned.parentSessionId } : {}) });
  const turn = transcript?.turns?.at(-1);
  const calls = (transcript?.messages ?? []).flatMap(message => (message.parts ?? []).map(part => ({ message, part })))
    .filter(item => item.part.type === 'tool' && item.part.callId === context.callId);
  if (transcript?.sessionId !== context.sessionId || transcript.truncated || !turn || turn.end !== null || calls.length !== 1
    || calls[0].part.status !== 'pending' || calls[0].message.turnStartSeq !== turn.startSeq) throw unavailable();
  const part = calls[0].part;
  const tool = ['vcr_read', 'vcr_write', 'vcr_simulate', 'trial_registry_record', 'curve_digitize', 'evidence_pool']
    .find(name => [name, mcpToolName(name)].includes(part.tool)) ?? (isResearchPluginTool(part.tool) ? part.tool : null);
  if (!tool || !object(part.input)) throw unavailable();
  let expected = projected(tool,operation,part.input,body);
  if (tool==='vcr_write' && part.input.what==='trial_benchmark' && part.input.data?.predictionsFile) {
    if (!readBenchmark) throw unavailable();
    expected={...expected,data:await readBenchmark(project,part.input.data.predictionsFile)};
  }
  if (canonicalJson(expected)!==canonicalJson(body)) throw unavailable();
  const run = await currentRun(runs, row => row.id === owned?.runId || row.sessionId === context.sessionId, adoptionWaitMs);
  if (!run?.sessionId) throw unavailable();
  // Installation and a pending call alone confer no authority. Recheck the
  // effective generation and current desired selection on every native call,
  // including reads/cancellation while an old runtime is still alive.
  if (isResearchPluginTool(tool)) {
    if (!assertResearchPluginSelection) throw unavailable();
    await assertResearchPluginSelection(researchPluginOfTool(tool));
  }
  return { userId: authenticatedUserId ?? project.userId, projectId: project.id, sessionId: context.sessionId, rootSessionId: run.sessionId,
    runId: run.id, callId: context.callId, dispatchId:run.dispatchId ?? null, routeReason:run.effectiveRouteReason ?? null,
    programme:typeof run.effectiveRouteReason === 'string' && run.effectiveRouteReason.startsWith('vcr:') };
}

/** Read original human parameter statements, never ledger question previews.
 * Same authenticated root conversation and account/project as the current call;
 * automated/continuation turns cannot supply human evidence. Reading is bounded
 * to four transcript pages and one MiB; failure loses a label, not the work.
 * @param {{sessionId:string, transcript:any, runs:ReadonlyArray<Record<string,any>>}} input
 * @returns {Array<{sessionId:string,messageSeq:number,text:string}> | null} */
export function vcrOriginalHumanMessages({ sessionId, transcript, runs }) {
  if (transcript?.sessionId !== sessionId || !Array.isArray(transcript.messages)) return null;
  const eligible = runs.filter(run => run.sessionId === sessionId && run.automated !== true);
  const messages = transcript.messages.filter(message => message.role === 'user' && message.source === 'user'
    && Number.isSafeInteger(message.seq) && eligible.some(run =>
      Number.isSafeInteger(message.turnStartSeq) && run.nativeTurn?.startSeq === message.turnStartSeq
      || message.sourceRequestId && run.kernelRequestIds?.includes(message.sourceRequestId)));
  const result = [];
  let bytes = 0;
  for (const message of messages.sort((left,right) => left.seq-right.seq)) {
    const parts = (message.parts ?? []).filter(part => part.type === 'text');
    if (parts.some(part => typeof part.text !== 'string')) return null;
    const text = parts.map(part => part.text).join('\n');
    bytes += Buffer.byteLength(text);
    if (Buffer.byteLength(text) > 400*1024 || bytes > 1024*1024) return null;
    if (text.trim()) result.push({sessionId,messageSeq:message.seq,text});
  }
  return result;
}
