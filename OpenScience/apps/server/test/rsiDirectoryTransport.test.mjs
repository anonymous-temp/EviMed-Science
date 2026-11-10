// The bundle channel without a cloud: production reads what its pull timer brought from a local directory, through the OSS transport's read port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRsiDirectoryTransport, rsiDirectoryTransportIssues } from '../src/rsiDirectoryTransport.mjs';
import { RSI_BUNDLE_MAX_BYTES } from '../src/rsiOssTransport.mjs';
import { loadRsiOnlineConfiguration, rsiOnlineConfigurationIssues } from '../src/rsiOnlineConfiguration.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const key = digest => `rsi/v1/bundles/${digest}.json`;
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'rsi-directory-'));
  const dir = path.join(root, 'bundles');
  await mkdir(dir);
  const put = async (text, name) => { const digest = sha(text); await writeFile(path.join(dir, name ?? `${digest}.json`), text); return digest; };
  try { await run({ root, dir, put, transport: await createRsiDirectoryTransport({ kind: 'directory', role: 'production', path: dir }) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('a bundle is read by its digest: the bytes under their own name, nothing for a name that is not there', () => fixture(async ({ dir, put, transport }) => {
  const digest = await put('{"bundle":1}\n');
  const stored = await transport.readBundle(digest);
  assert.equal(stored.digest, digest);
  assert.equal(stored.bytes.toString(), '{"bundle":1}\n');
  assert.equal(await transport.readBundle(sha('absent')), null);
  await assert.rejects(transport.readBundle('../escape'), { message: 'rsi_oss_digest_invalid' });
  await assert.rejects(transport.readBundle(digest.toUpperCase()), { message: 'rsi_oss_digest_invalid' });
  await assert.rejects(transport.readBundle(undefined), { message: 'rsi_oss_digest_invalid' });
  // Mounted read-only in production: nothing here needs to write.
  await chmod(dir, 0o555);
  assert.equal((await transport.readBundle(digest)).digest, digest);
  await chmod(dir, 0o755);
}));

test('a file whose bytes are not its name, a link, a device-like entry or a size out of bound is refused by the closed codes the poller treats as final', () => fixture(async ({ dir, put, transport }) => {
  const good = await put('{"bundle":1}');
  const changed = sha('what the name says');
  await writeFile(path.join(dir, `${changed}.json`), 'other bytes');
  await assert.rejects(transport.readBundle(changed), { message: 'rsi_oss_object_changed' });
  // A link is refused even when it points at the very bytes its name promises.
  const target = path.join(dir, `${good}.json`);
  const linked = sha('linked'); await writeFile(path.join(dir, 'linked-bytes'), 'linked'); await symlink(path.join(dir, 'linked-bytes'), path.join(dir, `${linked}.json`));
  await assert.rejects(transport.readBundle(linked), { message: 'rsi_oss_object_changed' });
  const absolute = sha('outside'); await symlink(target, path.join(dir, `${absolute}.json`));
  await assert.rejects(transport.readBundle(absolute), { message: 'rsi_oss_object_changed' });
  const directory = sha('a directory'); await mkdir(path.join(dir, `${directory}.json`));
  await assert.rejects(transport.readBundle(directory), { message: 'rsi_oss_object_changed' });
  const fifo = sha('a fifo'); execFileSync('mkfifo', [path.join(dir, `${fifo}.json`)]);
  await assert.rejects(transport.readBundle(fifo), { message: 'rsi_oss_object_changed' }, 'answered at once, not held in open()');
  const empty = sha(''); await writeFile(path.join(dir, `${empty}.json`), '');
  await assert.rejects(transport.readBundle(empty), { message: 'rsi_oss_object_unbounded' });
  const large = sha('large'); await writeFile(path.join(dir, `${large}.json`), ''); await truncate(path.join(dir, `${large}.json`), RSI_BUNDLE_MAX_BYTES + 1);
  await assert.rejects(transport.readBundle(large), { message: 'rsi_oss_object_unbounded' });
  // At the bound the file is read and judged by its bytes: the same bound as the OSS port.
  const atBound = Buffer.alloc(RSI_BUNDLE_MAX_BYTES, 0x20);
  await writeFile(path.join(dir, `${sha(atBound)}.json`), atBound);
  assert.equal((await transport.readBundle(sha(atBound))).bytes.length, RSI_BUNDLE_MAX_BYTES);
  assert.equal(RSI_BUNDLE_MAX_BYTES, 5 * 1024 * 1024);
}));

test('the listing names only regular files under a digest name, in order, a page at a time, and never walks without end', () => fixture(async ({ dir, put, transport }) => {
  assert.deepEqual(await transport.listBundles(), { keys: [], cursor: null });
  const digests = [];
  for (let n = 0; n < 3; n++) digests.push(await put(`{"bundle":${n}}`));
  digests.sort();
  // What rsync leaves while it writes, a stray file, a directory and a link: none of them is a bundle.
  await writeFile(path.join(dir, `.${digests[0]}.json.AbCdEf`), 'partial');
  await writeFile(path.join(dir, 'notes.json'), '{}');
  await writeFile(path.join(dir, `${digests[0].toUpperCase()}.json`), '{}');
  await mkdir(path.join(dir, `${sha('directory')}.json`));
  await symlink(path.join(dir, `${digests[0]}.json`), path.join(dir, `${sha('link')}.json`));
  assert.deepEqual(await transport.listBundles(), { keys: digests.map(key), cursor: null });
  for (const cursor of ['../..', '', 'rsi/v1/bundles/x.json', key('A'.repeat(64)), 7]) await assert.rejects(transport.listBundles(cursor), { message: 'rsi_oss_cursor_invalid' });
  // Pages of 100, as the OSS listing, joined by a cursor that is the last key of the page.
  for (let n = 3; n < 205; n++) await put(`{"bundle":${n}}`);
  const seen = [];
  let cursor;
  for (let pages = 0; ; pages++) {
    const page = await transport.listBundles(cursor);
    assert.ok(page.keys.length <= 100);
    seen.push(...page.keys);
    cursor = page.cursor;
    if (!cursor) { assert.equal(pages, 2); break; }
  }
  assert.equal(seen.length, 205);
  assert.deepEqual(seen, [...seen].sort());
  assert.equal(new Set(seen).size, 205);
  for (let n = 0; n < 3900; n++) await writeFile(path.join(dir, `stray-${n}`), '');
  await assert.rejects(transport.listBundles(), { message: 'rsi_oss_listing_invalid' }, 'a directory past the bound is refused, whatever its entries are');
}));

test('the direction is the object: a read port with no way to write, export or touch an incident', () => fixture(async ({ transport }) => {
  assert.deepEqual(Object.keys(transport).sort(), ['available', 'listBundles', 'preflight', 'readBundle']);
  assert.equal(transport.available, true);
}));

test('the transport needs a real absolute directory for production: no link, no lab role, no other shape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rsi-directory-root-'));
  try {
    const dir = path.join(root, 'bundles'); await mkdir(dir);
    const link = path.join(root, 'linked'); await symlink(dir, link);
    await assert.rejects(createRsiDirectoryTransport({ kind: 'directory', role: 'production', path: link }), { message: 'rsi_directory_unavailable' });
    await assert.rejects(createRsiDirectoryTransport({ kind: 'directory', role: 'production', path: path.join(root, 'missing') }));
    for (const section of [{ kind: 'directory', role: 'lab', path: dir }, { kind: 'directory', role: 'production', path: 'bundles' }, { kind: 'directory', role: 'production', path: `${dir}/../bundles` },
      { kind: 'directory', role: 'production', path: `${dir}/` }, { kind: 'directory', role: 'production', path: '/' }, { kind: 'directory', role: 'production' }]) {
      assert.deepEqual(rsiDirectoryTransportIssues(section), ['rsi_online_transport_invalid'], JSON.stringify(section));
      const unavailable = await createRsiDirectoryTransport(section);
      assert.equal(unavailable.available, false);
      assert.equal(unavailable.readBundle, undefined);
    }
    assert.deepEqual(rsiDirectoryTransportIssues({ kind: 'directory', role: 'production', path: dir, incidentBucket: 'x' }), ['rsi_online_configuration_invalid']);
    // A later swap of the directory for a link stops the reads too.
    const transport = await createRsiDirectoryTransport({ kind: 'directory', role: 'production', path: dir });
    await rm(dir, { recursive: true }); await symlink(root, dir);
    await assert.rejects(transport.listBundles(), { message: 'rsi_directory_unavailable' });
    await assert.rejects(transport.readBundle(sha('x')), { message: 'rsi_directory_unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

const directoryDeployment = { schemaVersion: 1, transport: { kind: 'directory', role: 'production', path: '/run/evimed-rsi/bundles' }, trustedKeyRefs: ['/run/evimed-rsi/publisher.json'], evaluatorRegistryRef: '/run/evimed-rsi/evaluators.json' };
const ossDeployment = { schemaVersion: 1, agreementRef: '/run/agreement.json', trustedKeyRefs: ['/run/publisher.json'], evaluatorRegistryRef: '/run/evaluators.json', extractionDailyCny: 5,
  transport: { role: 'production', region: 'cn-beijing', endpoint: 'https://oss-cn-beijing.aliyuncs.com', incidentBucket: 'fixture-incidents', bundleBucket: 'fixture-bundles', identityRefs: { production: '/run/prod', lab: '/run/lab' } } };

test('a directory deployment file names the directory and the trust records and nothing of an incident channel; an OSS file reads as before', () => {
  assert.deepEqual(rsiOnlineConfigurationIssues(directoryDeployment), []);
  assert.deepEqual(rsiOnlineConfigurationIssues(ossDeployment), []);
  const bad = change => rsiOnlineConfigurationIssues({ ...directoryDeployment, ...change });
  assert.deepEqual(bad({ agreementRef: '/run/agreement.json' }), ['rsi_online_configuration_invalid'], 'an agreement beside a deployment that cannot export');
  assert.deepEqual(bad({ extractionDailyCny: 5 }), ['rsi_online_configuration_invalid']);
  assert.deepEqual(bad({ schemaVersion: 2 }), ['rsi_online_configuration_missing']);
  assert.deepEqual(bad({ trustedKeyRefs: [] }), ['rsi_online_trust_missing']);
  assert.deepEqual(bad({ trustedKeyRefs: ['publisher.json'] }), ['rsi_online_trust_missing']);
  assert.deepEqual(bad({ evaluatorRegistryRef: undefined }), ['rsi_online_evaluator_registry_missing']);
  assert.deepEqual(bad({ transport: { ...directoryDeployment.transport, path: 'relative' } }), ['rsi_online_transport_invalid']);
  assert.deepEqual(bad({ transport: { ...directoryDeployment.transport, role: 'lab' } }), ['rsi_online_transport_invalid']);
  // OSS fields are no directory's, and a `kind` is no OSS section's.
  assert.deepEqual(bad({ transport: { ...directoryDeployment.transport, bundleBucket: 'fixture-bundles' } }), ['rsi_online_configuration_invalid']);
  assert.ok(rsiOnlineConfigurationIssues({ ...ossDeployment, transport: { ...ossDeployment.transport, kind: 'oss' } }).includes('rsi_online_configuration_invalid'));
});

test('the loader hands a directory deployment its transport whole or not at all, and never an agreement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-directory-config-'));
  try {
    const file = path.join(dir, 'online.json');
    await writeFile(file, JSON.stringify(directoryDeployment), { mode: 0o600 });
    const loaded = await loadRsiOnlineConfiguration(file);
    assert.deepEqual([loaded.transport, loaded.agreementRef, loaded.issues], [directoryDeployment.transport, null, []]);
    assert.deepEqual(loaded.configuration, directoryDeployment);
    await writeFile(file, JSON.stringify({ ...directoryDeployment, agreementRef: '/run/agreement.json' }), { mode: 0o600 });
    const refused = await loadRsiOnlineConfiguration(file);
    assert.deepEqual([refused.configuration, refused.transport, refused.agreementRef, refused.issues], [null, null, null, ['rsi_online_configuration_invalid']]);
    // The deployment records' own rule stands: private, no link.
    await chmod(file, 0o644);
    assert.deepEqual((await loadRsiOnlineConfiguration(file)).issues, ['rsi_online_configuration_unreadable']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
