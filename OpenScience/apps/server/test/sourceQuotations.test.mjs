import assert from 'node:assert/strict';
import test from 'node:test';
import { locateSourceQuote, sourceQuoteExcerpt } from '../src/sourceQuotations.mjs';

const text = 'An introductory line. The trial reported 12 participants. A closing line.';
const quote = 'The trial reported 12 participants.';
const sha = 'b'.repeat(64);
const source = { id: `src_${'a'.repeat(32)}`, projectId: 'p1', payload: { generation: 3, paths: ['knowledge-base/trial.pdf'],
  analysis: { textSha256: sha }, metadata: { title: 'Trial' }, fingerprint: {}, outputs: {} } };
const service = { loadCapture: async (_user, _source) => ({ input: { text }, pageMap: [{ page: 2, start: 0, end: text.length }] }) };

test('a directly read source quotes and opens the captured passage without any retrieval hit', async () => {
  const location = await locateSourceQuote(service, 'owner', source, quote);
  assert.equal(location.status, 'verified');
  assert.equal(location.page, 2);
  assert.equal(location.textSha256, sha);
  const params = new URLSearchParams({ start: String(location.start), end: String(location.end), sha });
  const excerpt = await sourceQuoteExcerpt(service, 'owner', source, params);
  assert.equal(excerpt.quote, quote);
  assert.equal(excerpt.text.slice(excerpt.start, excerpt.end), quote);
  params.set('sha', 'c'.repeat(64));
  assert.equal((await sourceQuoteExcerpt(service, 'owner', source, params)).status, 'unavailable');
  assert.equal((await locateSourceQuote(service, 'owner', source, quote.replace('12', '120'))).status, 'quote_not_found');
});

test('a missing capture and invalid offsets cannot manufacture a highlighted quotation', async () => {
  const missing = { loadCapture: async () => null };
  assert.equal((await locateSourceQuote(missing, 'owner', source, quote)).status, 'source_unavailable');
  await assert.rejects(sourceQuoteExcerpt(service, 'owner', source, new URLSearchParams({ start: '-1', end: '10', sha })), { code: 'source_payload_invalid' });
});
