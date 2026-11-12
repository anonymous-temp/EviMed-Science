import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { calculateClinicalScore } from './calculation.mjs';
import { fuseCandidates, validatePermutation } from './ranking.mjs';

/** Fixed contained operations. Clinical language and provider calls do not execute in this worker. */
export function createWorkerServer({ readToken, maxBytes = 262144 }) {
  return http.createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method === 'GET' && request.url === '/health') return reply(200, { service: 'patient-matching-worker', version: '0.1.0' });
    const supplied = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer /, ''));
    let expected;
    try { expected = Buffer.from(await readToken()); }
    catch { return reply(503, { code: 'matching_worker_credentials_unavailable' }); }
    if (expected.length < 32 || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return reply(401, { code: 'matching_worker_unauthorized' });
    if (request.method !== 'POST' || request.url !== '/execute') return reply(404, { code: 'not_found' });
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > maxBytes) return reply(413, { code: 'matching_worker_input_limit' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['operation', 'input'].includes(key))) return reply(400, { code: 'matching_worker_input_invalid' });
      if (body.operation === 'clinical-score') return reply(200, await calculateClinicalScore(body.input, { signal: controller.signal }));
      if (body.operation === 'fuse') return reply(200, { rows: fuseCandidates(body.input.channels, body.input.options) });
      if (body.operation === 'permutation') return reply(200, { order: validatePermutation(body.input.order, body.input.candidates) });
      return reply(400, { code: 'matching_worker_operation_invalid' });
    } catch (error) {
      return reply(400, { code: error?.code?.startsWith('matching_') ? error.code : 'matching_worker_input_invalid' });
    }
  });
}
