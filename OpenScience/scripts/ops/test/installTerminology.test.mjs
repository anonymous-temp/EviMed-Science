import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { inspectTerminologyFile, installTerminology, terminologyStatus } from '../install-terminology.mjs';
import { TERMINOLOGY_RELEASE } from '../build-terminology.mjs';

function made({ release = TERMINOLOGY_RELEASE, entities = '2' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'term-install-'));
  const file = path.join(directory, 'terminology.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE sources (id TEXT PRIMARY KEY, concepts INTEGER)');
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('release', release);
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('entities', entities);
  db.prepare('INSERT INTO sources VALUES (?, ?)').run('mesh', 2);
  db.close();
  return { directory, file };
}

test('a terminology file is inspected before anything is sent: release, entities, size, digest; a link, a stranger and an empty file are refused with a reason', () => {
  const { directory, file } = made();
  try {
    const found = inspectTerminologyFile(file);
    assert.equal(found.ok, true);
    assert.equal(found.release, TERMINOLOGY_RELEASE);
    assert.equal(found.entities, 2);
    assert.deepEqual(found.sources, [{ id: 'mesh', concepts: 2 }]);
    assert.equal(found.sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    const link = path.join(directory, 'link.sqlite');
    fs.symlinkSync(file, link);
    assert.deepEqual(inspectTerminologyFile(link), { ok: false, reason: 'not_a_regular_file' });
    assert.deepEqual(inspectTerminologyFile(path.join(directory, 'absent')), { ok: false, reason: 'file_missing' });
    fs.writeFileSync(path.join(directory, 'empty.sqlite'), '');
    assert.deepEqual(inspectTerminologyFile(path.join(directory, 'empty.sqlite')), { ok: false, reason: 'size_out_of_bounds' });
    fs.writeFileSync(path.join(directory, 'text.sqlite'), 'not a database at all, only text');
    assert.deepEqual(inspectTerminologyFile(path.join(directory, 'text.sqlite')), { ok: false, reason: 'not_a_terminology_file' });
    const other = made({ release: 'someone-elses-1' });
    try { assert.deepEqual(inspectTerminologyFile(other.file), { ok: false, reason: 'release_unknown' }); } finally { fs.rmSync(other.directory, { recursive: true, force: true }); }
    const none = made({ entities: '0' });
    try { assert.deepEqual(inspectTerminologyFile(none.file), { ok: false, reason: 'no_entities' }); } finally { fs.rmSync(none.directory, { recursive: true, force: true }); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('it goes into the volume beside its name and is renamed once the digest that arrived is the digest sent; a dry run sends nothing', async () => {
  const { directory, file } = made();
  const calls = [];
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  /** @param {{ arrived?: string }} [how] */
  const docker = ({ arrived = sha } = {}) => async (args) => {
    calls.push(args);
    if (args[0] === 'exec' && args[2] === 'sha256sum') return { stdout: `${arrived}  ${args[3]}\n` };
    if (args[0] === 'cp') { assert.equal(fs.statSync(args[1]).mode & 0o777, 0o644, 'world-readable for the adapter'); assert.notEqual(args[1], file, 'a staged copy, not the file itself'); }
    return { stdout: '' };
  };
  try {
    const dry = await installTerminology({ file, container: 'web', dryRun: true, run: docker() });
    assert.equal(dry.dryRun, true);
    assert.equal(calls.length, 0);
    const done = await installTerminology({ file, container: 'web', run: docker() });
    assert.equal(done.installed, true);
    assert.equal(done.target, '/data/terminology.sqlite');
    assert.deepEqual(calls.map((call) => call[0] + ' ' + (call[2] ?? '')), ['cp web:/data/terminology.sqlite.partial', 'exec sha256sum', 'exec mv']);
    assert.equal(calls[0][2], 'web:/data/terminology.sqlite.partial');
    assert.deepEqual(calls[2].slice(3), ['-f', '/data/terminology.sqlite.partial', '/data/terminology.sqlite']);

    calls.length = 0;
    const damaged = await installTerminology({ file, container: 'web', run: docker({ arrived: 'f'.repeat(64) }) });
    assert.deepEqual([damaged.installed, damaged.reason], [false, 'digest_mismatch']);
    assert.ok(calls.some((call) => call[2] === 'rm'), 'the half-arrived file is removed');
    assert.ok(!calls.some((call) => call[2] === 'mv'), 'and never renamed into place');

    for (const container of ['', 'a b', 'x;rm -rf /']) assert.equal((await installTerminology({ file, container, run: docker() })).reason, 'container_invalid', container);
    assert.equal((await installTerminology({ file, container: 'web', target: "/data/x'y", run: docker() })).reason, 'target_invalid');
    assert.equal((await installTerminology({ file: path.join(directory, 'absent'), container: 'web', run: docker() })).reason, 'file_missing');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the adapter\'s health says whether the file is loaded, and an adapter that cannot be asked says so', async () => {
  const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await terminologyStatus('http://adapter:8026/api/v1/evimed/terminology-lookup', answer({ terminology: { available: true, release: TERMINOLOGY_RELEASE, entities: 291507 } })),
    { loaded: true, release: TERMINOLOGY_RELEASE, entities: 291507 });
  assert.deepEqual(await terminologyStatus('http://adapter:8026', answer({ terminology: { configured: true, available: false, reason: 'terminology_unavailable' } })), { loaded: false, reason: 'terminology_unavailable' });
  assert.deepEqual(await terminologyStatus('http://adapter:8026', answer({}, 503)), { loaded: false, reason: 'adapter_status_503' });
  assert.deepEqual(await terminologyStatus('http://adapter:8026', async () => { throw new Error('refused'); }), { loaded: false, reason: 'adapter_unreachable' });
  assert.deepEqual(await terminologyStatus('not a url'), { loaded: false, reason: 'adapter_unreachable' });
});
