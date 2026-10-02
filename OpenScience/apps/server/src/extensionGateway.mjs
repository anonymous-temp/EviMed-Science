import { HttpError, sendJson, sendError } from './security.mjs';
import { extensionRequestObject, extensionIdentifier } from './extensionAccess.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
export const EXTENSION_GATEWAY_PATH = '/internal/extensions/v1';
/** @param {any} req @param {number} timeoutMs */
async function body(req, timeoutMs) {
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => req.destroy(), timeoutMs);
  timer.unref();
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new HttpError(413, 'extension_contract_invalid', 'The operation body is too large.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'extension_contract_invalid', 'The operation body is unavailable.');
  } finally {
    clearTimeout(timer);
  }
}
/** @param {{runtimeManager:any,service:any,bodyTimeoutMs?:number}} options */
export function createExtensionGatewayHandler({
  runtimeManager,
  service,
  bodyTimeoutMs = 10000
}) {
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 100 || bodyTimeoutMs > 30000) throw new Error('Invalid extension body deadline.');
  const identify = async token => {
    try {
      return await runtimeManager.assertActiveEviMedWorkloadToken(token);
    } catch {
      throw new HttpError(401, 'unauthorized', 'The runtime workload token is unavailable.');
    }
  };
  return async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!pathname.startsWith(EXTENSION_GATEWAY_PATH + '/')) return false;
    try {
      if (req.method !== 'POST' || !['execute', 'status', 'cancel'].includes(pathname.slice(EXTENSION_GATEWAY_PATH.length + 1))) throw new HttpError(404, 'not_found', 'Not found.');
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!token) throw new HttpError(401, 'unauthorized', 'A runtime workload token is required.');
      await identify(token);
      const input = await body(req, bodyTimeoutMs);
      const principal = await identify(token);
      if (!principal.runtimeGeneration) throw new HttpError(403, 'extension_access_denied', 'The runtime generation is unavailable.');
      const auth = {
        userId: principal.userId,
        projectId: principal.projectId,
        runtimeGeneration: principal.runtimeGeneration,
        invocation: req.headers['x-evimed-extension-invocation'] ?? null
      };
      let result;
      if (pathname.endsWith('/execute')) result = await service.submit(auth, input);else {
        extensionRequestObject(input, ['jobId']);
        result = await service[pathname.endsWith('/cancel') ? 'cancel' : 'status'](auth, input.jobId);
      }
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, error);
    }
    return true;
  };
}

/** Lookup must hydrate pending native call facts from existing session/run/tool records, not request metadata.
 * @param {{lookup:any}} options */
export function createExtensionInvocationResolver({
  lookup
}) {
  if (typeof lookup !== 'function') throw new Error('Trusted native invocation lookup is required.');
  return async (auth, raw, request) => {
    let invocation;
    try {
      invocation = typeof raw === 'string' ? JSON.parse(raw) : raw;
      extensionRequestObject(invocation, ['sessionId', 'callId', 'rootCallId', 'agentId', 'toolName', 'runtimeGeneration']);
      for (const key of ['sessionId', 'callId', 'rootCallId', 'agentId']) extensionIdentifier(invocation[key]);
    } catch {
      throw new HttpError(403, 'extension_access_denied', 'The native invocation is unavailable.');
    }
    if (invocation.rootCallId !== invocation.callId || invocation.agentId !== invocation.sessionId || invocation.toolName !== request.operation || invocation.runtimeGeneration !== auth.runtimeGeneration) throw new HttpError(403, 'extension_access_denied', 'The native invocation scope changed.');
    const actual = await lookup(auth, invocation);
    const digest = createHash('sha256').update(canonicalJson(request)).digest('hex');
    if (!actual || actual.userId !== auth.userId || actual.projectId !== auth.projectId || actual.runtimeGeneration !== auth.runtimeGeneration || actual.pending !== true || actual.toolPermitted !== true || actual.requestDigest !== digest || ['sessionId', 'callId', 'rootCallId', 'agentId', 'toolName'].some(key => actual[key] !== invocation[key])) throw new HttpError(403, 'extension_access_denied', 'The native invocation is unavailable.');
    return {
      userId: actual.userId,
      projectId: actual.projectId,
      runtimeGeneration: actual.runtimeGeneration,
      invocationId: actual.callId,
      allowedOperations: [actual.toolName],
      sessionId: actual.sessionId,
      rootCallId: actual.rootCallId,
      agentId: actual.agentId
    };
  };
}
