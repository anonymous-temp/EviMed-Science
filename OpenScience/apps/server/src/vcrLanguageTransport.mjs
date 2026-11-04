// Experimental transport primitive for a future authorization-fenced job.
// It is not wired to any route or worker. The caller must own reservation and
// settlement and hold the authorization fence through `handoff`.
import { request as httpsRequest } from 'node:https';

/**
 * The writable finish event is local body handoff, never provider acceptance.
 * The response remains bounded and redirects are returned, never followed.
 * @param {{apiKey:string, encodedBody:string, signal?:AbortSignal, timeoutMs?:number,
 *   maxResponseBytes?:number, requestImpl?:typeof httpsRequest}} input
 */
export function startVcrLanguageTransport({ apiKey, encodedBody, signal, timeoutMs = 30000, maxResponseBytes = 1024 * 1024, requestImpl = httpsRequest }) {
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) throw new TypeError('A valid provider credential is required.');
  if (typeof encodedBody !== 'string' || Buffer.byteLength(encodedBody) > 1024 * 1024) throw new TypeError('The request body exceeds the transport bound.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 32 * 1024 * 1024) throw new TypeError('Invalid transport limits.');
  signal?.throwIfAborted();
  let resolveHandoff, rejectHandoff, resolveResponse, rejectResponse;
  const handoff = new Promise((resolve, reject) => { resolveHandoff = resolve; rejectHandoff = reject; });
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  // A caller may await these in either order. Observing a rejection here does
  // not change the original promise returned to the caller.
  handoff.catch(() => {}); response.catch(() => {});
  let handed = false, done = false;
  const finish = (error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!handed) rejectHandoff(error);
    rejectResponse(error);
  };
  const req = requestImpl(new URL('https://api.deepseek.com/chat/completions'), {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
  }, (incoming) => {
    if (!handed) { const error = new Error('Provider answered before body handoff.'); finish(error); req.destroy(error); incoming.resume(); return; }
    const chunks = [];
    let size = 0;
    incoming.on('data', chunk => {
      size += chunk.length;
      if (size > maxResponseBytes) { const error = new Error('Provider response exceeds transport bound.'); finish(error); req.destroy(error); return; }
      chunks.push(Buffer.from(chunk));
    });
    incoming.once('error', finish);
    incoming.once('aborted', () => finish(new Error('Provider response interrupted.')));
    incoming.once('close', () => { if (!incoming.complete) finish(new Error('Provider response interrupted.')); });
    incoming.once('end', () => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolveResponse({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) });
    });
  });
  const abort = () => { const error = new Error('Provider request aborted.'); finish(error); req.destroy(error); };
  const timer = setTimeout(() => { const error = new Error('Provider request timed out.'); finish(error); req.destroy(error); }, timeoutMs);
  timer.unref?.();
  req.once('error', finish);
  req.once('finish', () => { if (!done) { handed = true; resolveHandoff(); } });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else req.end(encodedBody);
  return { handoff, response };
}
