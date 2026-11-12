#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanupResources } from './container-resources.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  name: { type: 'string' }, state: { type: 'string' }, collection: { type: 'string' },
  'docker-client': { type: 'string' }, 'budget-dir': { type: 'string' }, 'seed-budget': { type: 'string' },
  'deepseek-key-file': { type: 'string' }, paid: { type: 'boolean', default: false },
  port: { type: 'string', default: '58913' }, 'ui-port': { type: 'string', default: '58914' },
  context: { type: 'string', default: 'colima' },
  'base-image': { type: 'string', default: 'evimed-paper-ink-runtime:bridge-final' },
  'control-image': { type: 'string', default: 'node:22.23.2-bookworm-slim' },
  'postgres-image': { type: 'string', default: 'postgres:16-bookworm' },
} });
const { name, paid } = values;
if (!/^vcrbench-[a-z0-9][a-z0-9-]{3,33}$/.test(name)) throw new Error('Use a unique vcrbench-* resource name');
const absolute = key => {
  if (!values[key] || !path.isAbsolute(values[key]) || /[,\n\r]/.test(values[key])) throw new Error(`Absolute --${key} required`);
  return path.resolve(values[key]);
};
const state = absolute('state');
const sourceManifest = absolute('collection');
const dockerClient = absolute('docker-client');
const budgetDir = absolute('budget-dir');
const ports = [values.port, values['ui-port']].map(Number);
if (ports.some(port => !Number.isSafeInteger(port) || port < 1024 || port > 65535) || ports[0] === ports[1]) throw new Error('Invalid local ports');
if (paid !== Boolean(values['deepseek-key-file'])) throw new Error('Provide the provider key file only in paid mode');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync('docker', ['--context', values.context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 45_000 }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async file => {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
};
const sourceSha = git('rev-parse', 'HEAD');
const dirty = Boolean(git('status', '--porcelain'));
if (paid) {
  const branch = git('branch', '--show-current');
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? 'http://127.0.0.1:7890';
  if (!branch || dirty || git('rev-parse', '@{upstream}') !== sourceSha
      || git('-c', 'http.proxy='+proxy, 'ls-remote', '--heads', 'origin', branch).split(/\s+/)[0] !== sourceSha) {
    throw new Error('Paid mode requires the clean, pushed benchmark revision');
  }
}
const collection = JSON.parse(await fs.readFile(sourceManifest));
const database = collection.databasePath;
if (collection.version !== 1 || !['trialgpt-json', 'clinicaltrials-xml'].includes(collection.sourceFormat)
    || typeof database !== 'string' || !path.isAbsolute(database) || /[,\n\r]/.test(database)
    || await fileHash(database) !== collection.databaseSha256) throw new Error('Public collection database differs from its frozen manifest');
const collectionBytes = JSON.stringify({ ...collection, databasePath: '/collections/index.sqlite' }, null, 2)+'\n';

const audit = path.join(state, 'audit');
const secrets = path.join(audit, 'secrets');
const build = path.join(state, 'build');
const manifestFile = path.join(audit, 'collection.json');
const budgetFile = path.join(budgetDir, 'budget.json');
const network = name+'-internal', egress = name+'-egress';
const volume = name+'-data', pgVolume = name+'-pgdata';
const pgName = name+'-pg', imageTag = name+':runtime';
const label = 'org.evimed.benchmark.owner='+name+':'+randomBytes(12).toString('hex');
const imageInfo = ref => JSON.parse(docker('image', 'inspect', '--format', '{{json .}}', ref));
const baseImage = imageInfo(values['base-image']);
const controlImage = imageInfo(values['control-image']);
const postgresImage = imageInfo(values['postgres-image']);
if (new Set([baseImage.Architecture, controlImage.Architecture, postgresImage.Architecture]).size !== 1) throw new Error('Local image architectures differ');
const endpoints = JSON.parse(execFileSync('docker', ['context','inspect',values.context,'--format','{{json .Endpoints}}'], { encoding: 'utf8' }));
if (!endpoints.docker.Host.startsWith('unix://')) throw new Error('A local Docker context is required');
await fs.mkdir(state, { mode: 0o700 });
await fs.mkdir(audit, { mode: 0o700 });
await fs.mkdir(secrets, { mode: 0o700 });
await fs.mkdir(build, { mode: 0o700 });
await fs.mkdir(budgetDir, { recursive: true, mode: 0o700 });
if ((await fs.readdir(budgetDir)).some(entry => entry !== 'budget.json')
    || !(await fs.lstat(budgetDir)).isDirectory()) throw new Error('Use a dedicated, unlocked budget directory');
if ((await fs.readdir(budgetDir)).length && !(await fs.lstat(budgetFile)).isFile()) {
  throw new Error('Budget journal must be a regular file');
}
if (values['seed-budget']) {
  const seed = absolute('seed-budget');
  try { await fs.access(seed+'.lock'); throw new Error('Source budget still has a lock'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.writeFile(budgetFile, await fs.readFile(seed), { flag: 'wx', mode: 0o600 });
}
if (paid) await fs.access(budgetFile);
for (const key of ['postgres', 'model', 'workload']) {
  await fs.writeFile(path.join(secrets, key), randomBytes(32).toString('hex')+'\n', { mode: 0o600 });
}
await fs.copyFile(dockerClient, path.join(audit, 'docker'));
await fs.chmod(path.join(audit, 'docker'), 0o700);
await fs.writeFile(manifestFile, collectionBytes, { mode: 0o600 });
const selected = [
  'packages/socket', 'packages/domain', 'packages/harness-port', 'packages/design-tokens',
  'deploy/runtime-dsh/capabilities', 'capability-skills', 'runtime/mcp/evimed-research',
  'scripts/runtime/validate-personal-skill.mjs',
];
const tracked = execFileSync('git', ['ls-files', '-z', '--', ...selected], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
const overlay = createHash('sha256');
for (const file of tracked) {
  const source = path.join(root, file);
  const target = path.join(build, file);
  const stat = await fs.lstat(source);
  if (!stat.isFile()) throw new Error(`Non-regular runtime overlay input: ${file}`);
  const bytes = await fs.readFile(source);
  overlay.update(file+'\0'+hash(bytes)+'\n');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { mode: stat.mode & 0o777 });
}
const recipe = await fs.readFile(new URL('./container-runtime.Dockerfile', import.meta.url));
overlay.update(recipe);
await fs.writeFile(path.join(build, 'Dockerfile'), recipe);
const overlaySha256 = overlay.digest('hex');
const kernelVersion = JSON.parse(await fs.readFile(path.join(root, 'deps-version.json'))).dsh.version;
const inventory = {
  context: values.context, name, postgres: pgName, network, egress, volume, pgVolume, imageTag, label,
  origin: 'http://127.0.0.1:'+ports[0], startup: path.join(audit, 'startup.json'),
};
await fs.writeFile(path.join(state, 'resources.json'), JSON.stringify(inventory, null, 2)+'\n', { mode: 0o600 });

if (docker('container', 'ls', '-aq', '--filter', 'name=^/'+name+'$').length
    || docker('container', 'ls', '-aq', '--filter', 'name=^/'+pgName+'$').length
    || [network, egress].some(owned => docker('network', 'ls', '-q', '--filter', 'name=^'+owned+'$').length)
    || docker('volume', 'ls', '-q', '--filter', 'name=^'+volume+'$').length
    || docker('volume', 'ls', '-q', '--filter', 'name=^'+pgVolume+'$').length
    || docker('image', 'ls', '-q', imageTag).length) throw new Error('Owned resource names already exist');
const interruption = new AbortController();
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const interrupt = () => interruption.abort(new Error('Benchmark launch interrupted'));
for (const signal of signals) process.on(signal, interrupt);
const checkpoint = async () => {
  // Docker metadata operations are synchronous and bounded. Give a pending
  // signal a chance to stop the launch before the next mutation or handoff.
  await new Promise(resolve => setImmediate(resolve));
  interruption.signal.throwIfAborted();
};
try {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['--context', values.context, 'build', '--network', 'none', '--tag', imageTag, '--label', label,
      '--build-arg', 'BASE_IMAGE='+values['base-image'], '--build-arg', 'SOURCE_SHA='+sourceSha,
      '--build-arg', 'OVERLAY_SHA='+overlaySha256, '--build-arg', 'KERNEL_VERSION='+kernelVersion, build],
    { stdio: 'inherit', signal: interruption.signal, timeout: 600_000 });
    let buildError;
    child.once('error', error => { buildError = error; });
    child.once('close', (code, signal) => {
      if (buildError || code !== 0) reject(buildError ?? new Error(`Runtime image build failed: ${signal ?? code}`));
      else resolve();
    });
  });
  await checkpoint();
  const image = imageInfo(imageTag);
  if (image.Config.Labels['org.opencontainers.image.revision'] !== sourceSha
      || image.Config.Labels['org.evimed.benchmark.overlay'] !== overlaySha256) throw new Error('Built image does not match the staged source');
  docker('network', 'create', '--internal', '--label', label, network);
  docker('network', 'create', '--label', label, egress);
  const ipam = JSON.parse(docker('network', 'inspect', '--format', '{{json .IPAM.Config}}', network));
  const [internalSubnet, ...extraSubnets] = ipam.map(entry => entry.Subnet);
  if (!internalSubnet || extraSubnets.length) throw new Error('Benchmark expects one isolated IPv4 subnet');
  const launch = {
    sourceSha, dirty, name, paid, volume, network, internalSubnet, image: image.Id, baseImage: baseImage.Id, kernelVersion, overlaySha256,
    origin: 'http://127.0.0.1:'+ports[0], uiOrigin: 'http://127.0.0.1:'+ports[1],
    collectionManifestHostPath: manifestFile, collectionManifestSha256: hash(collectionBytes),
    collectionDatabaseSha256: collection.databaseSha256, budgetHostPath: budgetFile,
  };
  await fs.writeFile(path.join(audit, 'launch.json'), JSON.stringify(launch)+'\n', { mode: 0o600 });
  const bind = (source, target, readOnly = true) => ['--mount', `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`];
  const volumeMount = (source, target) => ['--mount', `type=volume,src=${source},dst=${target}`];
  await checkpoint();
  for (const ownedVolume of [volume, pgVolume]) docker('volume', 'create', '--label', label, ownedVolume);
  docker('run', '-d', '--name', pgName, '--label', label, '--network', network,
    ...volumeMount(pgVolume, '/var/lib/postgresql/data'), ...bind(path.join(secrets, 'postgres'), '/run/secrets/pg'),
    '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/pg', '-e', 'POSTGRES_USER=vcr_bench', '-e', 'POSTGRES_DB=evimed_test_vcr', postgresImage.Id);
  const dockerSocket = endpoints.docker.Host.slice('unix://'.length);
  // The Colima API socket lives on the host. Docker daemon bind paths are inside
  // the VM, where /var/run/docker.sock is the same daemon's native Unix socket.
  await fs.access(dockerSocket);
  await checkpoint();
  docker('create', '--name', name, '--label', label, '--network', egress,
    '-p', `127.0.0.1:${ports[0]}:8787`, '-p', `127.0.0.1:${ports[1]}:8788`,
    ...bind(root, '/app'), ...bind(audit, '/audit', false), ...bind(budgetDir, '/budget', false),
    ...bind(database, '/collections/index.sqlite'), ...bind('/var/run/docker.sock', '/var/run/docker.sock'),
    ...(paid ? bind(absolute('deepseek-key-file'), '/audit/deepseek.api-key') : []),
    ...volumeMount(volume, '/data'), '--workdir', '/app', controlImage.Id,
    'node', '/app/evals/vcr-platform-comparison/container-server.mjs');
  docker('network', 'connect', network, name);
  const until = Date.now()+45_000;
  while (true) {
    await checkpoint();
    try {
      docker('exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'vcr_bench', '-d', 'evimed_test_vcr');
      break;
    } catch (error) {
      if (Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  docker('start', name);
  const startup = path.join(audit, 'startup.json');
  const startupDeadline = Date.now()+60_000;
  while (true) {
    await checkpoint();
    try { await fs.access(startup); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= startupDeadline || docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') {
        throw new Error(`Control plane did not start; inspect the logs for ${name}`);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  await checkpoint();
  console.log(JSON.stringify({ origin: launch.origin, startup, image: image.Id, paid }));
} catch (error) {
  try { cleanupResources(inventory); }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Benchmark launch failed and cleanup needs attention'); }
  throw error;
} finally {
  for (const signal of signals) process.off(signal, interrupt);
}
