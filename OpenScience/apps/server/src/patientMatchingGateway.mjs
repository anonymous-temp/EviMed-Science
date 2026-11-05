/** Authenticated native host transport. Responses implement the core ABI directly. */
import { HOST_ABI, HOST_PORT_METHODS, canonicalJson, assertScope } from '@evimed/patient-matching-core';
import { HttpError, sendJson, sendError } from './security.mjs';
import { patientMatchingScope } from './patientMatchingHostAdapter.mjs';

export const PATIENT_MATCHING_GATEWAY_PATH = '/internal/patient-matching/v1/port';
const route = Object.freeze({ match_context: ['PatientDataPort', 'context'], match_discover: ['RegistryPort', 'search'], match_evidence: ['KnowledgePort', 'search'], match_compute: ['ExecutionPort', 'compute'], match_assess: ['ExecutionPort', 'assess'], match_job: ['JobPort', 'get'], match_results: ['ResultPort', 'get'], match_correct: ['PatientDataPort', 'correct'], match_report: ['ExecutionPort', 'report'] });
const denied = () => { throw new HttpError(403, 'patient_matching_invocation_unavailable', 'The host operation differs from its pending native tool call.'); };
const same = (a,b) => canonicalJson(a) === canonicalJson(b);
function validateOperation(body, origin) {
  if (body.abi !== HOST_ABI || !HOST_PORT_METHODS[body.port]?.includes(body.operation)) denied();
  const args = origin.args, tool = origin.tool, expected = route[tool];
  if (!expected) denied();
  if (body.port === 'IdentityPort') {
    if (body.operation === 'resolve') { if (!same(body.input, {})) denied(); return; }
    const envelope = body.input;
    if (!envelope || envelope.port === 'IdentityPort') denied();
    assertScope(patientMatchingScope(origin), envelope.scope);
    return validateOperation({ ...envelope, abi: HOST_ABI }, origin);
  }
  if (tool === 'match_assess') {
    const input = body.input;
    if (body.port === 'ExecutionPort' && body.operation === 'assess' && input.phase === 'prepare') {
      const { phase: _phase, ...selection } = input;
      if (!same(selection,args)) denied();
      return;
    }
    if (body.port === 'ExecutionPort' && body.operation === 'assess' && input.phase === 'refresh') {
      if (Object.keys(input).some(key => !['phase','taskId','executionId'].includes(key))) denied();
      if (args.taskId && args.taskId !== input.taskId) denied();
      return;
    }
    if (body.port === 'ResultPort' && body.operation === 'save' && ['commit','failure'].includes(input.phase)) {
      if (Object.keys(input).some(key => !['phase','taskId','executionId','profileDigest','decisions','native','diagnostics'].includes(key))) denied();
      if (input.phase==='failure' && Object.hasOwn(input,'decisions')) denied();
      if (args.taskId && args.taskId !== input.taskId) denied();
      return;
    }
    denied();
  }
  const port = tool === 'match_evidence' && args.source === 'patient' ? 'PatientDataPort' : expected[0];
  const operation = tool === 'match_evidence' && args.source === 'patient' ? 'read' : ['match_evidence','match_job','match_results'].includes(tool) ? args.action ?? expected[1] : expected[1];
  if (body.port !== port || body.operation !== operation || !same(body.input, args)) denied();
}
/** @param {any} config @param {any} runtimeManager @param {{vcr:any,adapter:any,resolveInvocation:any,report?:(code:string)=>void}} dependencies */
export function createPatientMatchingGatewayHandler(config, runtimeManager, { vcr, adapter, resolveInvocation, report = () => {} }) {
  return async (req, res) => {
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    const closed=()=>{if(!res.writableEnded)cancel();};
    req.once?.('aborted',cancel);res.once?.('close',closed);
    try {
      if (req.method !== 'POST' || new URL(req.url,'http://localhost').pathname !== PATIENT_MATCHING_GATEWAY_PATH) throw new HttpError(404,'not_found','Not found.');
      const token = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      let identity;
      try { if (!token) throw new Error(); identity = runtimeManager.assertActiveModelGatewayToken(token); }
      catch { throw new HttpError(401, 'patient_matching_token_invalid', 'Matching gateway authentication failed.'); }
      if (!config.vcrEnabled || !vcr?.service?.allows({id:String(identity.userId)}) || !adapter) throw new HttpError(503,'patient_matching_unavailable','Patient matching is unavailable.');
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new HttpError(413,'patient_matching_input_limit','Matching request exceeds its bound.'); chunks.push(Buffer.from(chunk)); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400,'patient_matching_input_invalid','Expected a JSON host request.'); }
      if (!body || Object.keys(body).some(key => !['abi','port','operation','input','invocation'].includes(key))) denied();
      const origin = { ...await resolveInvocation(identity, body) };
      if (origin.userId !== String(identity.userId) || origin.projectId !== String(identity.projectId)) denied();
      validateOperation(body, origin);
      Object.defineProperty(origin,'signal',{value:origin.signal?AbortSignal.any([controller.signal,origin.signal]):controller.signal,enumerable:false});
      const result = await adapter.dispatch({ port: body.port, operation: body.operation, input: body.input, origin });
      sendJson(res, 200, result);
    } catch (error) {
      report(String(error?.code ?? 'patient_matching_failed'));
      sendError(res, error instanceof HttpError ? error : new HttpError(400, String(error?.code ?? 'patient_matching_failed'), 'The matching request could not be completed.'));
    } finally {req.off?.('aborted',cancel);res.off?.('close',closed);}
  };
}
