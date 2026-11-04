/**
 * A local stand-in for the model provider, for tests and dry runs: a chat-completions endpoint on 127.0.0.1 that answers
 * canned JSON in the two shapes the judge reads (one trial-level score, one answer per numbered clause) and checks what each
 * request asked for. It never sees a real key and answers nothing a label could have influenced: a score is a function of the
 * request text alone.
 *
 *   node fake_provider.mjs --port 48555 --expect-thinking high
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** @param {string} text @param {number} modulo */
const bucket = (text, modulo) => createHash('sha256').update(text).digest().readUInt32BE(0) % modulo;

/** The numbered clauses of a criteria prompt, with the side they were listed under: the lines after the trial header. @param {string} user */
export function clausesOfPrompt(user) {
  /** @type {Array<{ number: number, kind: string }>} */
  const out = [];
  const header = user.indexOf('Here is the clinical trial:');
  let kind = 'inclusion';
  for (const line of user.slice(header < 0 ? 0 : header).split('\n')) {
    if (/^Inclusion criteria:/u.test(line)) kind = 'inclusion';
    else if (/^Exclusion criteria:/u.test(line)) kind = 'exclusion';
    else if (/^Other criteria:/u.test(line)) kind = 'inclusion';
    const found = /^(\d+)\.\s/u.exec(line);
    if (found) out.push({ number: Number(found[1]), kind });
  }
  return out;
}

/**
 * @param {{ expectThinking?: 'off' | 'high' | null, expectKey?: string | null, latencyMs?: number, failWhen?: ((index: number, body: any) => number | null) | null, contentWhen?: ((index: number, body: any) => string | null) | null, keepPrompts?: boolean, port?: number }} [options]
 * @returns {Promise<{ url: string, requests: any[], violations: string[], close: () => Promise<void> }>}
 */
export async function startFakeProvider({ expectThinking = null, expectKey = null, latencyMs = 0, failWhen = null, contentWhen = null, keepPrompts = false, port = 0 } = {}) {
  /** @type {any[]} */ const requests = [];
  /** @type {string[]} */ const violations = [];
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */ const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const index = requests.length;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('{}'); return; }
      const thinking = body.thinking?.type === 'disabled' ? 'off' : body.thinking?.type === 'enabled' ? 'high' : null;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = String(messages[0]?.content ?? ''), user = String(messages.at(-1)?.content ?? '');
      const criteria = system.includes('at the criterion level');
      requests.push({ path: req.url, model: body.model, thinking, reasoningEffort: body.reasoning_effort ?? null, jsonMode: body.response_format?.type === 'json_object', maxTokens: body.max_tokens ?? null, criteria, userChars: user.length, ...(keepPrompts ? { system, user } : {}) });
      if (expectThinking && thinking !== expectThinking) violations.push(`request ${index}: thinking ${thinking}, wanted ${expectThinking}`);
      if (expectKey && req.headers.authorization !== `Bearer ${expectKey}`) violations.push(`request ${index}: wrong credentials`);
      if (/\/anthropic\/v1\/messages$/u.test(String(req.url))) {
        // A conversation's own turns reach the provider on its Anthropic-shaped route: one short text answer, streamed, and no tool call.
        const event = (/** @type {string} */ name, /** @type {any} */ data) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
        setTimeout(() => {
          if (body.stream === true) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.write(event('message_start', { message: { id: `msg_fake_${index}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } }));
            res.write(event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
            res.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '收到。' } }));
            res.write(event('content_block_stop', { index: 0 }));
            res.write(event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }));
            res.end(event('message_stop', {}));
          } else {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `msg_fake_${index}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '收到。' }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 12 } }));
          }
        }, latencyMs);
        return;
      }
      if (!/\/chat\/completions$/u.test(String(req.url))) { res.writeHead(404).end('{}'); return; }
      const injected = failWhen ? failWhen(index, body) : null;
      setTimeout(() => {
        if (!injected && body.stream === true) {
          // A streamed request (a conversation's own turns): one short assistant message and the usage, as the provider streams them. No tool is ever called.
          const usage = { prompt_tokens: 900, completion_tokens: 12, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900, total_tokens: 912 };
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const chunk = (/** @type {any} */ delta, /** @type {string | null} */ finish, /** @type {any} */ extra = {}) => `data: ${JSON.stringify({ id: `fake-${index}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
          res.write(chunk({ role: 'assistant', content: '收到。' }, null));
          res.write(chunk({}, 'stop'));
          res.write(`data: ${JSON.stringify({ id: `fake-${index}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        if (injected) { res.writeHead(injected, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'injected' } })); return; }
        const said = contentWhen ? contentWhen(index, body) : null;
        const content = said != null ? said : criteria
          ? JSON.stringify(Object.fromEntries(clausesOfPrompt(user).map(({ number, kind }) => [String(number), [`Judged from the note (${bucket(user + number, 97)}).`, [0], kind === 'exclusion' ? 'not excluded' : 'included']])))
          : JSON.stringify({ score: bucket(user, 101), confidence: Number((0.5 + bucket(`${user}c`, 50) / 100).toFixed(2)), eligible_reasons: '1. The note states a matching condition.', ineligible_reasons: '', missing_information: '', rationale: 'Judged from the note.' });
        const promptTokens = 700 + Math.floor(user.length / 4);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: `fake-${index}`, model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 120, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: promptTokens, completion_tokens_details: { reasoning_tokens: thinking === 'high' ? 80 : 0 } },
        }));
      }, latencyMs);
    });
  });
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', () => resolve(null)); });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    violations,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = (/** @type {string} */ flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const expect = at('--expect-thinking');
  const provider = await startFakeProvider({ port: Number(at('--port') ?? 0), expectThinking: expect === 'off' || expect === 'high' ? expect : null });
  process.stdout.write(`fake provider on ${provider.url}\n`);
}
