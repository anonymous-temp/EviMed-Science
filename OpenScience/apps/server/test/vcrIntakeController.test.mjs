import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RUNTIME_CONTROLLER_PROTOCOL_VERSION, RuntimeControllerClient } from '../src/runtimeControllerClient.mjs';
import { createRuntimeController } from '../src/runtimeControllerServer.mjs';
import {
  VCR_INTAKE_KINDS, VCR_INTAKE_SCRIPT_DIR, VCR_INTAKE_VOLUME_KINDS, createVcrIntakeController, dockerMemoryBytes, vcrIntakeDirectory, vcrIntakeHostRoot, vcrIntakePlan, vcrIntakeRoot,
  vcrIntakeTimeoutOf,
} from '../src/vcrIntakeController.mjs';
import { VCR_INTAKE_LIMITS, VCR_TABLE_LIMITS } from '../src/vcrIntakeLayout.mjs';

const ATTEMPT = 'a1b2c3d4-0000-4000-8000-000000000001';
const DIGEST = 'f'.repeat(64);
const STUDY = 'std_0123abcd';
const PLANE = '/srv/evimed/vcr-plane';
const DATA = '/srv/open-science-data';

function planConfig(extra = {}) {
  return {
    dataDir: DATA, runtimeContainerBin: 'docker', runtimeContainerImage: 'open-science-runtime:test',
    runtimeContainerUser: '1000:1000', runtimeDataVolume: '', vcrIntakeMemory: '768m', vcrIntakeTimeoutMs: 60_000,
    vcrIntakeConcurrency: 2, vcrIntakeMaxBytes: 25 * 1024 * 1024, vcrIntakeMaxPages: 300, vcrDataPlaneHostDir: PLANE, ...extra,
  };
}

/** A record's reference as the API sends it: the staged file's path inside the plane, its digest and size. */
function recordReference(attemptId = ATTEMPT, format = 'pdf', extra = {}) {
  return { path: `studies/${STUDY}/.intake/${attemptId}/in/document.${format}`, sha256: DIGEST, bytes: 4096, ...extra };
}

/** An import's reference as the API sends it: the staged file's path inside the plane, its digest and size, and the standard it is claimed to be. */
function importReference(attemptId = ATTEMPT, extension = 'zip', format = 'omop', extra = {}) {
  return { path: `studies/${STUDY}/.intake/${attemptId}/in/import.${extension}`, sha256: DIGEST, bytes: 4096, format, ...extra };
}

/** The `--flag value` pairs of a Docker argument list, in order. @param {string[]} args @param {string} flag */
const valuesOf = (args, flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));

/** What both operations share: no network, no privileges, a read-only root, bounded, a fixed environment. @param {string[]} args @param {string} kind */
function assertHardening(args, kind) {
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(args.includes('--memory=768m') && args.includes('--memory-swap=768m'));
  assert.ok(args.includes('--pids-limit=64') && args.includes('--cpus=1'));
  assert.deepEqual(valuesOf(args, '--user'), ['1000:1000']);
  for (const forbidden of ['-v', '--volume', '--volumes-from', '--device', '--privileged', '--network', '--net', '--pid', '--ipc', '--add-host', '--dns']) {
    assert.ok(!args.includes(forbidden), `${forbidden} is not part of the plan`);
  }
  // The shared image declares workspace and runtime volumes; both are shadowed
  // by empty read-only mounts, so there is no workspace to read or write.
  const tmpfs = valuesOf(args, '--tmpfs');
  assert.ok(tmpfs.includes('/workspace:ro,noexec,nosuid,nodev,size=1m'));
  assert.ok(tmpfs.includes('/runtime:ro,noexec,nosuid,nodev,size=1m'));
  // No model, no gateway, no credential: the environment is a fixed list of
  // scratch locations and thread counts.
  const environment = valuesOf(args, '--env');
  assert.deepEqual(environment.map(item => item.split('=')[0]).sort(), [
    'HOME', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'PYTHONDONTWRITEBYTECODE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  ]);
  assert.ok(!environment.some(item => /OPEN_SCIENCE|EVIMED|KEY|TOKEN|SECRET|PASSWORD|GATEWAY|URL/i.test(item)));
  // A fixed operation: the image's own interpreter and one script.
  const image = args.indexOf('python3') + 1;
  assert.equal(args[image], 'open-science-runtime:test');
  assert.equal(args[image + 1], `${VCR_INTAKE_SCRIPT_DIR}/${{ extract: 'vcr_record_extract.py', digitize: 'vcr_curve_digitize.py', materials: 'source_material_extract.py', convert: 'vcr_import_convert.py' }[kind]}`);
  return args.slice(image + 2);
}

test('a record: the container sees one read-only file and one output directory, both of the plane, and nothing else', () => {
  const config = planConfig();
  const plan = vcrIntakePlan(config, 'extract', recordReference());
  assert.ok(plan.name.startsWith('evimed-vcr-intake-extract-'));
  assert.equal(plan.dir, null, 'a record has no directory on the data volume');
  const command = assertHardening(plan.args, 'extract');

  // Exactly two mounts: the one staged file, read-only, onto a fixed path, and the
  // attempt's own empty output directory — both by their HOST path in the plane.
  const attempt = `${PLANE}/studies/${STUDY}/.intake/${ATTEMPT}`;
  assert.deepEqual(valuesOf(plan.args, '--mount'), [
    `type=bind,src=${attempt}/in/document.pdf,dst=/input/document.pdf,readonly`,
    `type=bind,src=${attempt}/out,dst=/output`,
  ]);
  // The script is told what to hold the file to; the controller read nothing.
  assert.deepEqual(command, ['--file', '/input/document.pdf', '--format', 'pdf', '--expect-sha256', DIGEST, '--expect-bytes', '4096',
    '--max-pages', '300', '--max-chars', String(VCR_INTAKE_LIMITS.maxChars), '--max-xml-bytes', String(VCR_INTAKE_LIMITS.maxXmlBytes),
    '--output-dir', '/output', '--deadline', '58']);
  // A Word record is the same operation under its own extension.
  const word = vcrIntakePlan(config, 'extract', recordReference(ATTEMPT, 'docx'));
  assert.equal(valuesOf(word.args, '--mount')[0], `type=bind,src=${attempt}/in/document.docx,dst=/input/document.docx,readonly`);
  assert.deepEqual([valuesOf(word.args, '--file')[0], valuesOf(word.args, '--format')[0]], ['/input/document.docx', 'docx']);
});

test('a record is bound out of the plane by host path: every source is under the plane, no path of the data volume appears, volume or not', () => {
  for (const runtimeDataVolume of ['', 'open-science-data']) {
    const config = planConfig({ runtimeDataVolume, vcrDataPlaneDir: '/data-plane' });
    const { args } = vcrIntakePlan(config, 'extract', recordReference());
    const mounts = valuesOf(args, '--mount');
    assert.equal(mounts.length, 2);
    for (const mount of mounts) {
      assert.match(mount, /^type=bind,/, 'a bind of a host path, never a volume');
      const source = /src=([^,]+)/.exec(mount)?.[1] ?? '';
      assert.ok(source.startsWith(`${PLANE}/studies/${STUDY}/${'.intake'}/${ATTEMPT}/`), `${source} is in the plane's scratch area`);
      assert.ok(!source.startsWith(DATA) && !source.includes('vcr-intake'), `${source} is not under the data volume`);
      assert.ok(!/\/(workspace|projects|users|knowledge-base)\b/.test(source));
      assert.ok(!source.startsWith('/data-plane'), 'the web container\'s view of the plane is not a host path');
    }
    // Nothing of the data directory or the volume appears anywhere in the plan.
    for (const arg of args) {
      assert.ok(!arg.includes(DATA), `${arg} names the data directory`);
      assert.ok(!/volume-subpath|type=volume|src=open-science-data/.test(arg), `${arg} names the data volume`);
    }
  }
});

test('an import: the container sees one read-only file and one output directory of the plane, and the plane\'s own table ceilings', () => {
  const config = planConfig({ vcrDataMaxBytes: 40 * 1024 * 1024 });
  const plan = vcrIntakePlan(config, 'convert', importReference());
  assert.ok(plan.name.startsWith('evimed-vcr-intake-convert-'));
  assert.equal(plan.dir, null, 'an import has no directory on the data volume');
  const command = assertHardening(plan.args, 'convert');
  const attempt = `${PLANE}/studies/${STUDY}/.intake/${ATTEMPT}`;
  // Exactly two mounts, as a record has: the one staged file, read-only, and the attempt's own empty output, by host path in the plane.
  assert.deepEqual(valuesOf(plan.args, '--mount'), [
    `type=bind,src=${attempt}/in/import.zip,dst=/input/import.zip,readonly`,
    `type=bind,src=${attempt}/out,dst=/output`,
  ]);
  for (const arg of plan.args) assert.ok(!arg.includes(DATA), `${arg} names the data directory`);
  // The script is told what to hold the file to and the plane's own ceilings; the controller read nothing.
  assert.deepEqual(command, ['--file', '/input/import.zip', '--format', 'omop', '--extension', 'zip', '--expect-sha256', DIGEST, '--expect-bytes', '4096',
    '--max-table-bytes', String(40 * 1024 * 1024), '--max-rows', String(VCR_TABLE_LIMITS.rows), '--max-columns', String(VCR_TABLE_LIMITS.columns),
    '--output-dir', '/output', '--deadline', '118']);
  assert.equal(vcrIntakeTimeoutOf(config, 'convert'), 120_000, 'a whole export is read: twice a conversion\'s time');
  // Without a configured ceiling the default is the plane's default upload size.
  assert.equal(valuesOf(vcrIntakePlan(planConfig(), 'convert', importReference()).args, '--max-table-bytes')[0], String(50 * 1024 * 1024));
  // Each standard is staged under its own extensions.
  for (const [format, extension] of [['fhir', 'ndjson'], ['fhir', 'json'], ['fhir', 'zip'], ['omop', 'zip'], ['adam', 'xpt'], ['adam', 'zip']]) {
    const built = vcrIntakePlan(config, 'convert', importReference(ATTEMPT, extension, format));
    assert.deepEqual([valuesOf(built.args, '--format')[0], valuesOf(built.args, '--extension')[0], valuesOf(built.args, '--file')[0]], [format, extension, `/input/import.${extension}`]);
  }
});

test('an import is bound out of the plane by host path, volume configured or not', () => {
  for (const runtimeDataVolume of ['', 'open-science-data']) {
    const { args } = vcrIntakePlan(planConfig({ runtimeDataVolume }), 'convert', importReference(ATTEMPT, 'xpt', 'adam'));
    const mounts = valuesOf(args, '--mount');
    assert.equal(mounts.length, 2);
    for (const mount of mounts) {
      assert.match(mount, /^type=bind,/, 'a bind of a host path, never a volume');
      const source = /src=([^,]+)/.exec(mount)?.[1] ?? '';
      assert.ok(source.startsWith(`${PLANE}/studies/${STUDY}/.intake/${ATTEMPT}/`), `${source} is in the plane's scratch area`);
      assert.ok(!source.startsWith(DATA) && !source.includes('vcr-intake'), `${source} is not under the data volume`);
    }
    assert.ok(args.includes('--network=none') && args.includes('--read-only'));
  }
});

test('a caller names a staged import and a standard, and cannot steer a path, a command, a mount or an image', () => {
  const config = planConfig();
  const bad = [
    importReference(ATTEMPT, 'zip', 'omop', { image: 'attacker/image' }), importReference(ATTEMPT, 'zip', 'omop', { command: 'sh' }),
    importReference(ATTEMPT, 'zip', 'omop', { mounts: ['/:/host'] }), importReference(ATTEMPT, 'zip', 'omop', { sha256: 'not-a-digest' }),
    importReference(ATTEMPT, 'zip', 'omop', { bytes: 0 }), importReference(ATTEMPT, 'zip', 'omop', { bytes: 1.5 }),
    importReference(ATTEMPT, 'zip', 'omop', { bytes: 26 * 1024 * 1024 }),
    // The standard is one of three words, and each is uploaded as its own extensions.
    importReference(ATTEMPT, 'zip', 'hl7'), importReference(ATTEMPT, 'zip', ''), { ...importReference(), format: undefined },
    importReference(ATTEMPT, 'xpt', 'omop'), importReference(ATTEMPT, 'ndjson', 'adam'), importReference(ATTEMPT, 'json', 'omop'),
    // Only the layout's own path: an import file name, and never a record's.
    { ...importReference(), path: `studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf` },
    { ...importReference(), path: `studies/${STUDY}/.intake/${ATTEMPT}/in/import.exe` },
    { ...importReference(), path: `studies/${STUDY}/.intake/${ATTEMPT}/in/import.zip,readonly` },
    { ...importReference(), path: `studies/${STUDY}/.intake/${ATTEMPT}/in/../in/import.zip` },
    { ...importReference(), path: `studies/${STUDY}/.intake/${ATTEMPT}/out/import.zip` },
    { ...importReference(), path: `${PLANE}/studies/${STUDY}/.intake/${ATTEMPT}/in/import.zip` },
    { path: importReference().path, sha256: DIGEST, bytes: 10 }, { sha256: DIGEST, bytes: 10, format: 'omop' }, null, 'text', [],
  ];
  for (const reference of bad) assert.throws(() => vcrIntakePlan(config, 'convert', reference), { code: 'vcr_intake_input_invalid' }, JSON.stringify(reference));
  // The two operations refuse each other's file: a record is not an import and an import is not a record.
  assert.throws(() => vcrIntakePlan(config, 'extract', recordReference(ATTEMPT, 'pdf', { path: importReference().path })), { code: 'vcr_intake_input_invalid' });
  assert.throws(() => vcrIntakePlan(config, 'convert', { ...recordReference(), format: 'fhir' }), { code: 'vcr_intake_input_invalid' });
  assert.throws(() => vcrIntakePlan(config, 'extract', importReference()), { code: 'vcr_intake_input_invalid' });
  // No plane host path: the import says so, as a record does.
  assert.throws(() => vcrIntakePlan(planConfig({ vcrDataPlaneHostDir: '' }), 'convert', importReference()), { status: 503, code: 'vcr_document_converter_unavailable' });
  assert.deepEqual([...VCR_INTAKE_KINDS], ['extract', 'digitize', 'materials', 'convert']);
});

test('a figure: the container sees one read-only input and one empty output under the data volume, and nothing else', () => {
  const config = planConfig();
  const { args, dir, name } = vcrIntakePlan(config, 'digitize', { attemptId: ATTEMPT, inputDigest: DIGEST });
  assert.equal(dir, path.join(DATA, 'vcr-intake', 'digitize', ATTEMPT));
  assert.ok(name.startsWith('evimed-vcr-intake-digitize-'));
  const command = assertHardening(args, 'digitize');
  const mounts = valuesOf(args, '--mount');
  assert.deepEqual(mounts, [`type=bind,src=${path.join(dir, 'input')},dst=/input,readonly`, `type=bind,src=${path.join(dir, 'output')},dst=/output`]);
  for (const mount of mounts) {
    const source = /src=([^,]+)/.exec(mount)?.[1] ?? '';
    assert.ok(source.startsWith(`${vcrIntakeRoot(config)}${path.sep}`));
    assert.ok(!/\/(workspace|projects|users|knowledge-base)\b/.test(source));
    assert.ok(!source.startsWith(PLANE), 'a published figure never goes through the plane');
  }
  assert.deepEqual(command, ['--request', '/input/request.json', '--input-dir', '/input', '--output-dir', '/output', '--deadline', '58']);
});

test('a source document: the same staged attempt on the data volume, a script of its own and twice the time', () => {
  const config = planConfig();
  const { args, dir, name } = vcrIntakePlan(config, 'materials', { attemptId: ATTEMPT, inputDigest: DIGEST });
  assert.equal(dir, path.join(DATA, 'vcr-intake', 'materials', ATTEMPT));
  assert.ok(name.startsWith('evimed-vcr-intake-materials-'));
  // The hardening is the one every conversion gets: no network, no privileges, a read-only root, bounded, no model or credential.
  const command = assertHardening(args, 'materials');
  const mounts = valuesOf(args, '--mount');
  assert.deepEqual(mounts, [`type=bind,src=${path.join(dir, 'input')},dst=/input,readonly`, `type=bind,src=${path.join(dir, 'output')},dst=/output`]);
  for (const mount of mounts) {
    const source = /src=([^,]+)/.exec(mount)?.[1] ?? '';
    assert.ok(source.startsWith(`${vcrIntakeRoot(config)}${path.sep}`));
    assert.ok(!/\/(workspace|projects|users|knowledge-base)\b/.test(source), 'no workspace of a project is mounted');
    assert.ok(!source.startsWith(PLANE), 'a source document never goes through the data plane');
  }
  // A document is read whole: the script's own deadline is a document's time, not a conversion's.
  assert.deepEqual(command, ['--request', '/input/request.json', '--input-dir', '/input', '--output-dir', '/output', '--deadline', '118']);
  assert.equal(vcrIntakeTimeoutOf(config, 'materials'), 120_000);
  assert.equal(vcrIntakeTimeoutOf(config, 'digitize'), 60_000);
  assert.equal(vcrIntakeTimeoutOf({ vcrIntakeTimeoutMs: 1 }, 'extract'), 5_000);
  assert.deepEqual([...VCR_INTAKE_VOLUME_KINDS], ['digitize', 'materials']);
  // The same reference rules as a figure's: an attempt and a digest, and nothing a caller can steer.
  for (const bad of [{ attemptId: ATTEMPT, inputDigest: DIGEST, image: 'attacker/image' }, { attemptId: '../../etc', inputDigest: DIGEST }, { attemptId: ATTEMPT }, recordReference(), null]) {
    assert.throws(() => vcrIntakePlan(config, 'materials', bad), { code: /^(vcr_intake_input_invalid|invalid_id)$/ }, JSON.stringify(bad));
  }
  assert.equal(vcrIntakeDirectory(config, 'materials', ATTEMPT), dir);
  const shared = vcrIntakePlan(planConfig({ runtimeDataVolume: 'open-science-data' }), 'materials', { attemptId: ATTEMPT, inputDigest: DIGEST });
  assert.deepEqual(valuesOf(shared.args, '--mount'), [
    `type=volume,src=open-science-data,dst=/input,volume-subpath=vcr-intake/materials/${ATTEMPT}/input,readonly`,
    `type=volume,src=open-science-data,dst=/output,volume-subpath=vcr-intake/materials/${ATTEMPT}/output`,
  ]);
});

test('with the shared data volume a figure\'s two mounts are subpaths of it', () => {
  const config = planConfig({ runtimeDataVolume: 'open-science-data' });
  const { args } = vcrIntakePlan(config, 'digitize', { attemptId: ATTEMPT, inputDigest: DIGEST });
  assert.deepEqual(valuesOf(args, '--mount'), [
    `type=volume,src=open-science-data,dst=/input,volume-subpath=vcr-intake/digitize/${ATTEMPT}/input,readonly`,
    `type=volume,src=open-science-data,dst=/output,volume-subpath=vcr-intake/digitize/${ATTEMPT}/output`,
  ]);
});

test('a record can never be given a directory on the data volume', () => {
  assert.throws(() => vcrIntakeDirectory(planConfig(), 'extract', ATTEMPT), { code: 'vcr_intake_input_invalid' });
  assert.throws(() => vcrIntakeDirectory(planConfig(), '../digitize', ATTEMPT), { code: 'vcr_intake_input_invalid' });
  assert.equal(vcrIntakeDirectory(planConfig(), 'digitize', ATTEMPT), path.join(DATA, 'vcr-intake', 'digitize', ATTEMPT));
});

test('a caller names a staged file or an attempt and cannot steer a path, a command, a mount or an image', () => {
  const config = planConfig();
  const badRecords = [
    recordReference(ATTEMPT, 'pdf', { image: 'attacker/image' }),
    recordReference(ATTEMPT, 'pdf', { command: 'sh' }),
    recordReference(ATTEMPT, 'pdf', { mounts: ['/:/host'] }),
    recordReference(ATTEMPT, 'pdf', { sha256: 'not-a-digest' }),
    recordReference(ATTEMPT, 'pdf', { bytes: 0 }),
    recordReference(ATTEMPT, 'pdf', { bytes: -1 }),
    recordReference(ATTEMPT, 'pdf', { bytes: 1.5 }),
    recordReference(ATTEMPT, 'pdf', { bytes: '4096' }),
    { path: `studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf`, sha256: DIGEST },
    { sha256: DIGEST, bytes: 10 },
    // The only path accepted is the one the layout spells.
    ...[
      `studies/${STUDY}/.intake/${ATTEMPT}/in/document.exe`, `studies/${STUDY}/.intake/${ATTEMPT}/in/other.pdf`,
      `studies/${STUDY}/.intake/${ATTEMPT}/out/document.pdf`, `studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf/extra`,
      `studies/${STUDY}/.intake/${ATTEMPT}/in/../in/document.pdf`, `studies/../.intake/${ATTEMPT}/in/document.pdf`,
      `studies/${STUDY}/incoming/${ATTEMPT}.upload`, `studies/${STUDY}/.intake/not-an-attempt/in/document.pdf`,
      `/${PLANE}/studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf`, `${PLANE}/studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf`,
      `studies/a,dst=/etc/.intake/${ATTEMPT}/in/document.pdf`, `studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf,readonly`,
      `studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf\n`, '', 7, null,
    ].map(bad => recordReference(ATTEMPT, 'pdf', { path: bad })),
    null, 'text', [],
  ];
  for (const reference of badRecords) assert.throws(() => vcrIntakePlan(config, 'extract', reference), { code: 'vcr_intake_input_invalid' }, JSON.stringify(reference));
  assert.throws(() => vcrIntakePlan(config, 'extract', recordReference(ATTEMPT, 'pdf', { bytes: 26 * 1024 * 1024 })), { status: 413, code: 'vcr_intake_input_invalid' });

  const badFigures = [
    { attemptId: ATTEMPT, inputDigest: DIGEST, image: 'attacker/image' },
    { attemptId: ATTEMPT, inputDigest: DIGEST, command: 'sh' },
    { attemptId: ATTEMPT, inputDigest: DIGEST, mounts: ['/:/host'] },
    { attemptId: '../../etc', inputDigest: DIGEST },
    { attemptId: 'a/b', inputDigest: DIGEST },
    { attemptId: ATTEMPT, inputDigest: 'not-a-digest' },
    { attemptId: ATTEMPT },
    // A figure is not named the way a record is, and the other way round.
    recordReference(),
    null, 'text', [],
  ];
  for (const reference of badFigures) assert.throws(() => vcrIntakePlan(config, 'digitize', reference), { code: /^(vcr_intake_input_invalid|invalid_id)$/ }, JSON.stringify(reference));
  assert.throws(() => vcrIntakePlan(config, 'extract', { attemptId: ATTEMPT, inputDigest: DIGEST }), { code: 'vcr_intake_input_invalid' });
  assert.throws(() => vcrIntakePlan(config, 'render', recordReference()), { code: 'vcr_intake_input_invalid' });
});

test('the plane\'s host directory is a plain absolute path, and a controller without one converts nothing', () => {
  assert.equal(vcrIntakeHostRoot(planConfig()), PLANE);
  assert.equal(vcrIntakeHostRoot(planConfig({ vcrDataPlaneHostDir: ' /mnt/disk-2/vcr_plane@a+b.c ' })), '/mnt/disk-2/vcr_plane@a+b.c');
  for (const unset of ['', undefined, '   ']) {
    assert.throws(() => vcrIntakePlan(planConfig({ vcrDataPlaneHostDir: unset }), 'extract', recordReference()), { status: 503, code: 'vcr_document_converter_unavailable' });
  }
  // A comma would end a `--mount` option; the rest would let a path leave or hide where it points.
  for (const bad of ['relative/plane', './plane', '/', '/plane/', '/plane//x', '/plane/../x', '/plane/./x', '/plane,dst=/etc', '/plane x', '/plane"x', "/plane'x", '/plane\nx', '/plane:ro', '/pläne', '~/plane']) {
    assert.throws(() => vcrIntakePlan(planConfig({ vcrDataPlaneHostDir: bad }), 'extract', recordReference()), { status: 503, code: 'vcr_document_converter_unavailable' }, JSON.stringify(bad));
  }
  // A figure does not use the plane, so its plan does not need the setting.
  assert.doesNotThrow(() => vcrIntakePlan(planConfig({ vcrDataPlaneHostDir: '' }), 'digitize', { attemptId: ATTEMPT, inputDigest: DIGEST }));
});

test('docker sizes are whole megabytes or gigabytes', () => {
  assert.equal(dockerMemoryBytes('768m'), 768 * 1024 * 1024);
  assert.equal(dockerMemoryBytes('2g'), 2 * 1024 ** 3);
  for (const bad of ['', '0m', '1.5g', '512', '1t', '-1m']) assert.throws(() => dockerMemoryBytes(bad), { code: 'vcr_intake_failed' });
});

// --- the run, against a scripted docker ---------------------------------------

async function fixture(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-intake-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'docker.log');
  const mode = path.join(root, 'mode');
  const bin = path.join(root, 'docker.mjs');
  await fs.writeFile(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const mode = fs.existsSync(${JSON.stringify(mode)}) ? fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() : 'ok';
if (args[0] === 'info') { console.log('26.1.4'); process.exit(0); }
if (args[0] === 'image') { if (mode === 'no-image') process.exit(1); console.log('sha256:feedface'); process.exit(0); }
if (args[0] === 'create') {
  if (mode === 'create-fails') { console.error('daemon refused'); process.exit(1); }
  if (mode === 'name-in-use') { console.error('Conflict. The container name is already in use'); process.exit(1); }
  process.exit(0);
}
if (args[0] === 'start') {
  if (mode === 'hang') { setInterval(() => {}, 1000); }
  else if (mode === 'exit-1') process.exit(1);
  else process.exit(0);
}
else process.exit(0);
`, { mode: 0o700 });
  const config = { ...planConfig({ dataDir: path.join(root, 'data'), runtimeContainerBin: bin }), ...extra };
  await fs.mkdir(config.dataDir, { recursive: true });
  // A figure's attempt on the data volume, as the API stages it. A record has no
  // such attempt: it is named by a path in the plane, which the controller never reads.
  const stage = async (attemptId = ATTEMPT, file = { name: 'figure.png', body: Buffer.from('\x89PNG figure') }, kind = 'digitize') => {
    const dir = vcrIntakeDirectory(config, kind, attemptId);
    await fs.mkdir(path.join(dir, 'input'), { recursive: true });
    await fs.mkdir(path.join(dir, 'output'));
    await fs.writeFile(path.join(dir, 'input', file.name), file.body);
    const request = Buffer.from(JSON.stringify({ file: { name: file.name, sha256: createHash('sha256').update(file.body).digest('hex'), bytes: file.body.length } }));
    await fs.writeFile(path.join(dir, 'input', 'request.json'), request);
    return { dir, reference: { attemptId, inputDigest: createHash('sha256').update(request).digest('hex') } };
  };
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, config, stage, calls, setMode: value => fs.writeFile(mode, value) };
}
const roomy = { availableMemory: async () => 8 * 1024 ** 3 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, limit = 4000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await predicate()) return true; await pause(15); }
  return false;
}

test('a conversion runs the fixed container from the resolved image id and removes it afterwards', async t => {
  const f = await fixture(t);
  const reference = recordReference();
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  assert.deepEqual(await controller.run('extract', reference), { finished: true });
  const calls = await f.calls();
  const verbs = calls.map(call => (call[0] === 'container' ? 'prune' : call[0] === 'image' ? 'inspect' : call[0] === 'rm' ? 'remove' : call[0]));
  assert.deepEqual(verbs, ['inspect', 'prune', 'create', 'start', 'remove']);
  const create = calls.find(call => call[0] === 'create');
  assert.ok(create.includes('sha256:feedface'), 'the image id, not the tag that may move');
  assert.ok(!create.includes('open-science-runtime:test'));
  assert.deepEqual(calls.find(call => call[0] === 'start').slice(0, 2), ['start', '--attach']);
  assert.deepEqual(calls.find(call => call[0] === 'container'), ['container', 'prune', '-f', '--filter', 'label=open-science.vcr-intake', '--filter', 'until=10m']);
  assert.deepEqual(controller.status(), { running: 0, queued: 0 });
  // A record is bound out of the plane by host path, and the data directory is not in the command.
  assert.ok(create.some(arg => arg.startsWith(`type=bind,src=${PLANE}/studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf,`)));
  assert.ok(!create.some(arg => arg.includes(f.config.dataDir)), 'nothing of the data directory reaches the daemon');
  // The controller never reads the plane: the same run works with no such directory on this host.
  await assert.rejects(fs.stat(PLANE), { code: 'ENOENT' });
});

test('a figure is checked where the controller can see it, a record is held to its digest by the script', async t => {
  const f = await fixture(t);
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  const { reference } = await f.stage();
  assert.deepEqual(await controller.run('digitize', reference), { finished: true });
  assert.ok((await f.calls()).some(call => call[0] === 'create' && call.includes('--request')));
});

test('a container that fails, a daemon that refuses and a name in use are named, and the container is removed', async t => {
  const f = await fixture(t);
  const reference = recordReference();
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  await f.setMode('exit-1');
  await assert.rejects(controller.run('extract', reference), { status: 502, code: 'vcr_intake_failed' });
  await f.setMode('create-fails');
  await assert.rejects(controller.run('extract', reference), { status: 503, code: 'vcr_intake_failed' });
  await f.setMode('name-in-use');
  await assert.rejects(controller.run('extract', reference), { status: 429, code: 'vcr_intake_busy' });
  await f.setMode('no-image');
  await assert.rejects(controller.run('extract', reference), { status: 503, code: 'vcr_intake_failed' });
  const removed = (await f.calls()).filter(call => call[0] === 'rm');
  assert.ok(removed.length >= 3 && removed.every(call => call.slice(0, 2).join(' ') === 'rm -f'));
});

test('the deadline stops the container and answers a timeout', async t => {
  let expire;
  const f = await fixture(t);
  const reference = recordReference();
  const controller = createVcrIntakeController(f.config, { ...roomy, setTimer: callback => { expire = callback; return 1; }, clearTimer: () => {} });
  t.after(() => controller.close());
  await f.setMode('hang');
  const running = controller.run('extract', reference).then(() => null, error => error);
  assert.ok(await until(async () => (await f.calls()).some(call => call[0] === 'start')));
  expire();
  const error = await running;
  assert.equal(error.code, 'vcr_intake_timeout');
  assert.equal(error.status, 504);
  assert.ok((await f.calls()).filter(call => call[0] === 'rm').length >= 1);
  assert.deepEqual(controller.status(), { running: 0, queued: 0 });
});

test('a caller that goes away stops its container, and a waiting request leaves the queue without starting one', async t => {
  const f = await fixture(t, { vcrIntakeConcurrency: 1 });
  const first = { reference: recordReference(ATTEMPT) };
  const second = { reference: recordReference('a1b2c3d4-0000-4000-8000-000000000002') };
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  await f.setMode('hang');
  const abortFirst = new AbortController();
  const abortSecond = new AbortController();
  const one = controller.run('extract', first.reference, abortFirst.signal).then(() => null, error => error);
  assert.ok(await until(async () => (await f.calls()).some(call => call[0] === 'start')));
  const two = controller.run('extract', second.reference, abortSecond.signal).then(() => null, error => error);
  assert.ok(await until(() => controller.status().queued === 1), 'with one slot the second request waits');
  abortSecond.abort();
  assert.equal((await two).name, 'AbortError');
  assert.equal((await f.calls()).filter(call => call[0] === 'create').length, 1, 'the one that left never started a container');
  abortFirst.abort();
  assert.equal((await one).name, 'AbortError');
  assert.deepEqual(controller.status(), { running: 0, queued: 0 });
});

test('one slot runs one conversion at a time and the next starts when it ends', async t => {
  const f = await fixture(t, { vcrIntakeConcurrency: 1 });
  const first = { reference: recordReference(ATTEMPT) };
  const second = { reference: recordReference('a1b2c3d4-0000-4000-8000-000000000002') };
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  await f.setMode('hang');
  const abort = new AbortController();
  const one = controller.run('extract', first.reference, abort.signal).then(() => null, error => error);
  assert.ok(await until(async () => (await f.calls()).some(call => call[0] === 'start')));
  await f.setMode('ok');
  const two = controller.run('extract', second.reference);
  assert.ok(await until(() => controller.status().queued === 1));
  abort.abort();
  await one;
  assert.deepEqual(await two, { finished: true });
});

test('a source document is verified like a figure before a container starts, and runs the extractor of its own', async t => {
  const f = await fixture(t);
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  const pdf = { name: 'document.pdf', body: Buffer.from('%PDF-1.4 stand-in') };
  const staged = await f.stage(ATTEMPT, pdf, 'materials');
  assert.deepEqual(await controller.run('materials', staged.reference), { finished: true });
  const created = (await f.calls()).find(call => call[0] === 'create');
  assert.ok(created.includes(`${VCR_INTAKE_SCRIPT_DIR}/source_material_extract.py`));
  assert.ok(created.some(arg => arg.includes('/vcr-intake/materials/')), 'the mounts are the materials attempt\'s');
  // A request changed after it was digested, a link in place of the file, a missing attempt and a dirty output never start one.
  const changed = await f.stage('a1b2c3d4-0000-4000-8000-000000000004', pdf, 'materials');
  await assert.rejects(controller.run('materials', { ...changed.reference, inputDigest: '0'.repeat(64) }), { status: 409, code: 'vcr_intake_input_invalid' });
  const linked = await f.stage('a1b2c3d4-0000-4000-8000-000000000005', pdf, 'materials');
  await fs.rm(path.join(linked.dir, 'input', 'document.pdf'));
  await fs.symlink('/etc/passwd', path.join(linked.dir, 'input', 'document.pdf'));
  await assert.rejects(controller.run('materials', linked.reference), { code: /^(vcr_intake_input_invalid|path_forbidden)$/ });
  const dirty = await f.stage('a1b2c3d4-0000-4000-8000-000000000006', pdf, 'materials');
  await fs.writeFile(path.join(dirty.dir, 'output', 'left-behind'), 'x');
  await assert.rejects(controller.run('materials', dirty.reference), { status: 409, code: 'vcr_intake_input_invalid' });
  await assert.rejects(controller.run('materials', { attemptId: 'a1b2c3d4-0000-4000-8000-000000000007', inputDigest: DIGEST }), { code: 'vcr_intake_input_invalid' });
  assert.equal((await f.calls()).filter(call => call[0] === 'create').length, 1, 'only the first, intact attempt started a container');
});

test('host memory below the container ceiling plus headroom is a busy answer, and nothing is created', async t => {
  const f = await fixture(t);
  const reference = recordReference();
  const controller = createVcrIntakeController(f.config, { availableMemory: async () => 1024 * 1024 * 1024 });
  t.after(() => controller.close());
  await assert.rejects(controller.run('extract', reference), { status: 429, code: 'vcr_intake_busy' });
  assert.ok(!(await f.calls()).some(call => call[0] === 'create'));
});

test('a figure that is not the one the digest names, a link, a missing file or a dirty output directory never starts a container', async t => {
  const f = await fixture(t);
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  const created = async () => (await f.calls()).some(call => call[0] === 'create');

  const changed = await f.stage();
  await assert.rejects(controller.run('digitize', { ...changed.reference, inputDigest: '0'.repeat(64) }), { status: 409, code: 'vcr_intake_input_invalid' });

  const linked = await f.stage('a1b2c3d4-0000-4000-8000-000000000003');
  await fs.rm(path.join(linked.dir, 'input', 'figure.png'));
  await fs.symlink('/etc/passwd', path.join(linked.dir, 'input', 'figure.png'));
  await assert.rejects(controller.run('digitize', linked.reference), { code: /^(vcr_intake_input_invalid|path_forbidden)$/ });

  const missing = await f.stage('a1b2c3d4-0000-4000-8000-000000000004');
  await fs.rm(path.join(missing.dir, 'input', 'figure.png'));
  await assert.rejects(controller.run('digitize', missing.reference), { code: 'vcr_intake_input_invalid' });

  const dirty = await f.stage('a1b2c3d4-0000-4000-8000-000000000005');
  await fs.writeFile(path.join(dirty.dir, 'output', 'left-over'), 'x');
  await assert.rejects(controller.run('digitize', dirty.reference), { status: 409, code: 'vcr_intake_input_invalid' });

  const noRequest = await f.stage('a1b2c3d4-0000-4000-8000-000000000006');
  await fs.rm(path.join(noRequest.dir, 'input', 'request.json'));
  await assert.rejects(controller.run('digitize', noRequest.reference), { code: 'vcr_intake_input_invalid' });

  assert.equal(await created(), false);
});

test('a record whose reference is malformed, or a controller with no host path for the plane, never starts a container', async t => {
  const f = await fixture(t);
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  await assert.rejects(controller.run('extract', recordReference(ATTEMPT, 'pdf', { path: `studies/${STUDY}/incoming/x.upload` })), { code: 'vcr_intake_input_invalid' });
  await assert.rejects(controller.run('extract', recordReference(ATTEMPT, 'pdf', { sha256: 'xyz' })), { code: 'vcr_intake_input_invalid' });
  await assert.rejects(controller.run('extract', { attemptId: ATTEMPT, inputDigest: DIGEST }), { code: 'vcr_intake_input_invalid' });
  const unset = createVcrIntakeController({ ...f.config, vcrDataPlaneHostDir: '' }, roomy);
  t.after(() => unset.close());
  await assert.rejects(unset.run('extract', recordReference()), { status: 503, code: 'vcr_document_converter_unavailable' });
  assert.deepEqual((await f.calls()).filter(call => call[0] === 'create'), []);
  assert.deepEqual((await f.calls()).filter(call => call[0] === 'image'), [], 'the refusal comes before the daemon is asked anything');
});

// --- the route, through the controller's own socket ---------------------------

test('the controller serves the intake operations at protocol 11 and refuses anything else', async t => {
  const f = await fixture(t);
  const shortRoot = await fs.realpath(await fs.mkdtemp(path.join('/tmp', 'vi-')));
  t.after(() => fs.rm(shortRoot, { recursive: true, force: true }));
  const socketPath = path.join(shortRoot, 'c.sock');
  const server = createRuntimeController({
    ...f.config, production: false, runtimeMode: 'kernel', runtimeSandboxMode: 'docker', runtimeControllerMode: 'direct', runtimeControllerSocket: socketPath,
    deepseekProviderEnabled: false, deepseekApiKey: '', maxJsonBytes: 1024 * 1024,
  });
  t.after(() => server.close());
  await server.listen();
  const client = new RuntimeControllerClient({ runtimeControllerSocket: socketPath, runtimeControllerTimeoutMs: 5_000, vcrIntakeTimeoutMs: 20_000 });
  assert.equal(RUNTIME_CONTROLLER_PROTOCOL_VERSION, 11);
  assert.equal((await client.health()).protocolVersion, 11);

  const record = recordReference();
  assert.deepEqual(await client.runVcrIntake('extract', record), { finished: true });
  const created = (await f.calls()).find(call => call[0] === 'create');
  assert.ok(created.includes('--expect-sha256'), 'the record reached the script by its digest');
  const { reference } = await f.stage();
  assert.deepEqual(await client.runVcrIntake('digitize', reference), { finished: true });
  // A knowledge-base source's PDF or spreadsheet is the third operation (protocol 10): named like a figure.
  const document = await f.stage('a1b2c3d4-0000-4000-8000-000000000008', { name: 'document.pdf', body: Buffer.from('%PDF-1.4 stand-in') }, 'materials');
  assert.deepEqual(await client.runVcrIntake('materials', document.reference), { finished: true });
  await assert.rejects(client.request('POST', '/v1/vcr/materials', { ...document.reference, image: 'x' }), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/materials', record), { code: 'runtime_controller_payload_invalid' });

  // A source held in a standard format is the fourth (protocol 11): named like a record, plus the standard it is claimed to be.
  const imported = importReference();
  assert.deepEqual(await client.runVcrIntake('convert', imported), { finished: true });
  const converted = (await f.calls()).filter(call => call[0] === 'create').at(-1);
  assert.ok(converted.includes('/opt/evimed/mcp/evimed-research/vcr_import_convert.py') && converted.includes('--expect-sha256'), 'the import reached its own script by its digest');
  await assert.rejects(client.request('POST', '/v1/vcr/convert', { ...imported, image: 'x' }), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/convert', record), { status: 400, code: 'vcr_intake_input_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/convert', { attemptId: ATTEMPT, inputDigest: DIGEST }), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/extract', imported), { code: 'runtime_controller_payload_invalid' });

  // Each operation takes exactly its own reference, and nothing else.
  await assert.rejects(client.request('POST', '/v1/vcr/extract', { ...record, image: 'x' }), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/extract', { attemptId: ATTEMPT, inputDigest: DIGEST }), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/digitize', { ...reference, image: 'x' }), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/digitize', record), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/extract', { ...record, path: `studies/../../etc/${ATTEMPT}` }), { status: 400, code: 'vcr_intake_input_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/digitize', { attemptId: '../x', inputDigest: DIGEST }), { status: 400 });
  await assert.rejects(client.request('POST', '/v1/vcr/render', reference), { code: 'runtime_controller_route_not_found' });
  await assert.rejects(client.request('POST', '/v1/vcr/digitize', { attemptId: ATTEMPT, inputDigest: DIGEST }), { code: 'vcr_intake_input_invalid' });
});
