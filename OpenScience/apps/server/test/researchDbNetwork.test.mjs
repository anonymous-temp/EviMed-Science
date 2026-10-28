import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedResearchDbAddresses, researchDbHostName, resolveResearchDbAddress } from '../src/researchDbNetwork.mjs';

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

test('a host name is matched in lower case, whichever way the person or the operator wrote it', async () => {
  assert.equal(researchDbHostName('  DB.Example.ORG '), 'db.example.org');
  assert.equal(researchDbHostName(undefined), '');
  const seen = [];
  const resolve = async (name, options) => { seen.push([name, options]); return [{ address: '8.8.8.8', family: 4 }]; };
  // A capital in the typed host, in the allowlist entry, or in both.
  for (const [host, policy] of [['DB.Example.org', 'db.example.org:5432=8.8.8.8'], ['db.example.org', 'DB.EXAMPLE.ORG:5432=8.8.8.8'], ['Db.Example.Org', 'DB.example.org:5432=8.8.8.8']]) {
    assert.equal(await resolveResearchDbAddress(host, 5432, policy, resolve), '8.8.8.8');
  }
  assert.deepEqual([...admittedResearchDbAddresses('DB.EXAMPLE.org', 5432, 'db.example.org:5432=8.8.8.8')], ['8.8.8.8']);
  assert.equal(seen[0][0], 'db.example.org', 'the name is resolved in lower case');
  // Case does not widen the policy: another name, a port, an address literal or a non-string stay refused.
  for (const host of ['OTHER.example.org', 'db.example.org.evil.test', '8.8.8.8', '', null, 5]) {
    assert.throws(() => admittedResearchDbAddresses(host, 5432, 'db.example.org:5432=8.8.8.8'), { code: 'research_db_network_denied' });
  }
});

test('only IPv4 answers are asked for, so a dual-stack host is admitted by its allowlisted IPv4 address', async () => {
  const asked = [];
  // A resolver that honours `family` like the operating system's: the same host has an A and an AAAA record.
  const dualStack = async (name, options) => {
    asked.push(options);
    const all = [{ address: '2001:4860:4860::8888', family: 6 }, { address: '8.8.8.8', family: 4 }];
    return options.family ? all.filter(row => row.family === options.family) : all;
  };
  assert.equal(await resolveResearchDbAddress('db.example.org', 5432, 'db.example.org:5432=8.8.8.8', dualStack), '8.8.8.8');
  assert.deepEqual(asked, [{ all: true, family: 4 }]);
  // The defence stays: a resolver that answers an IPv6 address anyway, or an IPv4 address that is not allowlisted, is refused.
  await assert.rejects(resolveResearchDbAddress('db.example.org', 5432, 'db.example.org:5432=8.8.8.8', lookup(['8.8.8.8', '2001:4860:4860::8888'])), { code: 'research_db_network_denied' });
  await assert.rejects(resolveResearchDbAddress('db.example.org', 5432, 'db.example.org:5432=8.8.8.8', lookup(['8.8.8.8', '8.8.4.4'])), { code: 'research_db_network_denied' });
});
