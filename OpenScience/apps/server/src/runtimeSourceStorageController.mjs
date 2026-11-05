/** Privileged source maintenance. Paths are derived from protected project and
 * generation roots; neither the browser nor the API may supply a host path. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sourceStorageHelperProgram } from '@evimed/harness-port/source-conversation-storage';
import { canonicalJson } from '@evimed/domain';
import { dockerRuntimeMount, assertDockerDataVolumeSupport } from './dockerMounts.mjs';
import { contextGenerationRoot, verifyContextGeneration } from './runtimeContextGeneration.mjs';
import { assertNoSymlinkPath, HttpError, safeId } from './security.mjs';

const fail = (code = 'runtime_source_identity_changed', status = 409) => new HttpError(status, code, 'Conversation source storage is unavailable, changed or busy.');
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const headerIdentity = value => canonicalJson([value?.id, value?.createdAt, value?.cwd ?? null, value?.isSeeded, value?.origin ?? null, value?.parentSession ?? null, value?.delegationDepth ?? 0]);
/** Preserve microseconds while accepting the two database timestamp renderings. */
function instant(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/);
  if (!match) throw fail();
  const zone = /^[+-]\d\d$/.test(match[4]) ? `${match[4]}:00` : match[4];
  const seconds = Date.parse(`${match[1]}T${match[2]}${zone}`); if (!Number.isFinite(seconds)) throw fail();
  return `${BigInt(seconds) * 1000n + BigInt((match[3] ?? '').padEnd(6, '0'))}`;
}
async function directory(config, full) {
  await assertNoSymlinkPath(config.dataDir, full, { allowMissingTail: true });
  const stat = await fs.lstat(full).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && !stat.isDirectory()) throw fail();
  return stat ? full : null;
}
async function storageRoots(config, project, incarnation, contextReference) {
  if (!incarnation || Object.keys(incarnation).sort().join(',') !== 'ownerCreatedAt,projectCreatedAt') throw fail();
  const owner = instant(incarnation.ownerCreatedAt), created = instant(incarnation.projectCreatedAt);
  const ordinary = path.join(project.runtimeDir, 'container-runtime', 'dsh-home');
  const roots = [{ contextReference: null, memoryNamespaceId: null, home: ordinary }];
  const contextRoot = contextGenerationRoot(config, project), generations = path.join(contextRoot, 'generations');
  await assertNoSymlinkPath(config.dataDir, generations, { allowMissingTail: true });
  if (contextReference !== null && contextReference !== undefined) await verifyContextGeneration(config, project, contextReference);
  const entries = await fs.readdir(generations, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (entries.length > 1000) throw fail('runtime_source_inventory_limit', 503);
  const policies = new Set();
  for (const entry of entries) {
    if (entry.name.startsWith('.stage-') && entry.isDirectory()) continue;
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) throw fail();
    const file = path.join(generations, entry.name, 'manifest.json'); await assertNoSymlinkPath(config.dataDir, file);
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw fail();
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    const reference = { digest: entry.name, policyDigest: digest(manifest.policy) };
    const verified = await verifyContextGeneration(config, project, reference);
    const policy = verified.manifest.policy;
    if (instant(policy.ownerCreatedAt) !== owner || instant(policy.projectCreatedAt) !== created || policies.has(reference.policyDigest)) continue;
    policies.add(reference.policyDigest);
    roots.push({ contextReference: reference, memoryNamespaceId: policy.namespaceId ?? null, home: path.join(verified.stateDirectory, 'dsh-home') });
  }
  return Promise.all(roots.map(async row => ({ ...row, paths: { sessions: await directory(config, path.join(row.home, 'sessions')), storages: await directory(config, path.join(row.home, 'storages')) } })));
}

/** @param {any} config @param {any} image @param {any} paths @param {string} operation */
export function sourceStorageHelperPlan(config, image, paths, operation, project = null) {
  const args = ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=10001:10001', '--memory=256m', '--cpus=0.5', '--pids-limit=64', '--tmpfs=/tmp:rw,nosuid,nodev,size=32m,uid=10001,gid=10001', '-i'];
  if (project) args.push('--name', `evimed-source-maintenance-${randomUUID()}`, '--label', 'io.open-science.source-maintenance=1',
    '--label', `io.open-science.source-owner=${project.userId}`, '--label', `io.open-science.source-project=${project.id}`);
  for (const kind of ['sessions', 'storages']) {
    if (paths[kind]) args.push('--mount', `${dockerRuntimeMount(config, paths[kind], `/source/${kind}`)}${operation === 'capture' ? ',readonly' : ''}`);
    else args.push(`--tmpfs=/source/${kind}:rw,nosuid,nodev,size=1m,uid=10001,gid=10001`);
  }
  args.push('--entrypoint=node', image.imageId, '--input-type=module', '--eval', sourceStorageHelperProgram());
  return { command: config.runtimeContainerBin, args };
}
async function executeHelper(config, input) {
  assertDockerDataVolumeSupport(config);
  const plan = sourceStorageHelperPlan(config, input.image, input.paths, input.operation, input.project);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', bytes = 0, failed = false;
    const stop = () => { failed = true; child.kill('SIGKILL'); };
    const timeout = setTimeout(stop, 60000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop(); else output += chunk; });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop(); });
    child.once('error', () => { clearTimeout(timeout); reject(fail('runtime_source_helper_unavailable', 503)); });
    child.stdin.on('error', () => {});
    child.once('close', code => {
      clearTimeout(timeout);
      try { cleanupSourceHelpers(config, input.project); const result = JSON.parse(output); if (failed || code !== 0 || result.ok !== true || !result.data) throw fail(); resolve(result.data); }
      catch { reject(fail('runtime_source_helper_unavailable', 503)); }
    });
    child.stdin.end(JSON.stringify({ operation: input.operation, sessionId: input.sessionId, frozen: input.frozen }));
  });
}
/** A killed Docker CLI can leave its container alive. The same project mutex
 * covers this check and every start, including after a controller restart. */
function cleanupSourceHelpers(config, project) {
  const result = spawnSync(config.runtimeContainerBin, ['ps', '--all', '--filter', 'label=io.open-science.source-maintenance=1',
    '--filter', `label=io.open-science.source-owner=${project.userId}`, '--filter', `label=io.open-science.source-project=${project.id}`, '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (result.status !== 0) throw fail('runtime_source_helper_unavailable', 503);
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean); if (ids.length > 32 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw fail('runtime_source_helper_unavailable', 503);
  for (const id of ids) {
    const removed = spawnSync(config.runtimeContainerBin, ['rm', '--force', id], { encoding: 'utf8', timeout: 10000 });
    if (removed.status !== 0 && !/no such (?:object|container)/i.test(removed.stderr)) throw fail('runtime_source_helper_unavailable', 503);
  }
}
/** Protected constructor hooks are test-only. The production composition uses
 * the fixed helper above, under the runtime controller's project mutex.
 * @param {any} config @param {any} hooks */
export function createSourceStorageController(config, hooks) {
  const execute = hooks.execute ?? (input => executeHelper(config, input));
  const cleanup = hooks.execute ? async () => {} : project => cleanupSourceHelpers(config, project);
  async function image() { const result = await hooks.inspectImage(); if (result.kernelVersion !== config.dshVersion || result.kernel && result.kernel !== 'dsh') throw fail('runtime_source_kernel_mismatch', 503); return result; }
  async function observe(project, sessionId, incarnation, contextReference, inspected) {
    const roots = await storageRoots(config, project, incarnation, contextReference), copies = [];
    for (const row of roots) {
      const snapshot = await execute({ operation: 'capture', project, sessionId, image: inspected, paths: row.paths });
      copies.push({ contextReference: row.contextReference, memoryNamespaceId: row.memoryNamespaceId, root: snapshot.root, sessions: snapshot.sessions });
    }
    const present = copies.filter(copy => copy.root.absent !== true);
    if (present.some(copy => headerIdentity(copy.root) !== headerIdentity(present[0].root))) throw fail();
    return { roots, copies, root: present[0]?.root ?? { id: sessionId, absent: true } };
  }
  return {
    beforeStart: cleanup,
    async capture(project, payload) {
      await cleanup(project);
      const sessionId = safeId(payload.sessionId, 'conversation id'), inspected = await image();
      const seen = await observe(project, sessionId, payload.incarnation, payload.contextReference ?? null, inspected);
      const sessions = [...new Map(seen.copies.flatMap(copy => copy.sessions).map(row => [row.id, row])).values()];
      const body = { schema: 'native-source-storage/1', kernelVersion: inspected.kernelVersion, incarnation: payload.incarnation,
        contextReference: payload.contextReference ?? null, root: seen.root, sessions, copies: seen.copies };
      return { ...body, storageIdentity: digest(body) };
    },
    async purge(project, frozen) {
      await cleanup(project);
      if ((await hooks.runtimeStatus(project)).state !== 'missing') throw fail('runtime_source_busy');
      const { storageIdentity, generation: _generation, ...body } = frozen ?? {};
      if (body.schema !== 'native-source-storage/1' || storageIdentity !== digest(body) || !Array.isArray(body.copies) || body.copies.length > 1001) throw fail();
      const inspected = await image(); if (body.kernelVersion !== inspected.kernelVersion) throw fail('runtime_source_kernel_mismatch', 503);
      const seen = await observe(project, safeId(body.root?.id, 'conversation id'), body.incarnation, body.contextReference, inspected);
      if (seen.root.absent !== true && (body.root.absent === true || headerIdentity(body.root) !== headerIdentity(seen.root))) throw fail();
      const ids = new Set(body.sessions.map(row => row.id));
      for (let i = 0; i < seen.roots.length; i++) {
        const row = seen.roots[i], current = seen.copies[i];
        const old = body.copies.find(copy => canonicalJson(copy.contextReference) === canonicalJson(row.contextReference));
        if (current.root.absent !== true && headerIdentity(current.root) !== headerIdentity(body.root)) throw fail();
        const snapshot = old ?? (current.root.absent === true ? current : { ...current, root: body.root });
        const result = await execute({ operation: 'purge', project, image: inspected, paths: row.paths, frozen: snapshot });
        if (result.sourceRemoved !== true) throw fail('runtime_source_helper_unavailable', 503);
        for (const id of result.removedSessionIds ?? []) ids.add(id);
      }
      return { sourceRemoved: true, storageIdentity, removedSessionIds: [...ids].sort() };
    },
  };
}
