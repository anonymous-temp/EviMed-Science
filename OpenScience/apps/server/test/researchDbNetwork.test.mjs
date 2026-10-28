import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveResearchDbAddress } from '../src/researchDbNetwork.mjs';

const lookup = rows => async () => rows.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

test('database egress requires an exact operator host, port and address policy', async () => {
  const policy = 'db.example.org:5432=8.8.8.8';
  assert.equal(await resolveResearchDbAddress('db.example.org', 5432, policy, lookup(['8.8.8.8'])), '8.8.8.8');
  for (const [host, port, config, addresses] of [
    ['db.example.org', 5432, '', ['8.8.8.8']],
    ['other.example.org', 5432, policy, ['8.8.8.8']],
    ['db.example.org', 5433, policy, ['8.8.8.8']],
    ['db.example.org', 5432, policy, ['8.8.4.4']],
    ['db.example.org', 5432, policy, ['8.8.8.8', '127.0.0.1']],
    ['db.example.org', 5432, policy, ['8.8.8.8', '::ffff:7f00:1']],
    ['db.example.org', 5432, 'db.example.org:5432=127.0.0.1', ['127.0.0.1']],
  ]) await assert.rejects(resolveResearchDbAddress(host, port, config, lookup(addresses)));
});
