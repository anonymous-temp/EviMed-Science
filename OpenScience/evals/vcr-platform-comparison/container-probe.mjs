#!/usr/bin/env node
// Startup smoke test using the real ordinary-account session entry point.
// The driver dispatches no prompt. Docker inspection and shell probes happen
// outside the product, before the disposable account is removed.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openThrowawayAccount, fetchTransport } from '../../scripts/ops/throwaway-account.mjs';

const [state] = process.argv.slice(2);
if (!state || !path.isAbsolute(state)) throw new Error('Provide the absolute launcher state directory');
const { context, origin, startup, network, egress, volume, name } = JSON.parse(await fs.readFile(path.join(state, 'resources.json')));
const receipt = JSON.parse(await fs.readFile(startup));
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', timeout: 20_000 }).trim();
const health = await fetch(origin+'/api/health', { signal: AbortSignal.timeout(10_000) });
if (!health.ok || health.headers.get('x-evimed-benchmark-instance') !== receipt.instance) throw new Error('Startup receipt is stale');
const readBudget = async () => JSON.parse(await fs.readFile(receipt.budget.file));
const budgetBefore = await readBudget();
const projectId = 'vcr-probe-'+randomUUID().slice(0, 12);
const runtimeIds = () => docker('container', 'ls', '-aq', '--filter', 'label=open-science.project='+projectId).split('\n').filter(Boolean);
const interrupted = new AbortController();
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const abort = () => interrupted.abort(new Error('Container probe interrupted'));
for (const signal of signals) process.on(signal, abort);
const account = await openThrowawayAccount({ base: origin, send: fetchTransport(origin, { timeoutMs: 8_000 }),
  prefix: 'vcrprobe', signals: false, attempts: 4, waitMs: 500 }).catch(error => {
    for (const signal of signals) process.off(signal, abort);
    throw error;
  });
const api = async (method, route, body, cleanup = false) => {
  const res = await fetch(origin+route, {
    method, redirect: 'error',
    signal: cleanup ? AbortSignal.timeout(30_000) : AbortSignal.any([interrupted.signal, AbortSignal.timeout(90_000)]),
    headers: { origin, 'content-type': 'application/json', 'x-evimed-automated': '1',
      'x-open-science-project': projectId, ...account.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await res.json();
  if (res.headers.get('x-evimed-benchmark-instance') !== receipt.instance || ![200, 201].includes(res.status)) {
    throw new Error(`${method} ${route}: ${res.status} ${value.code ?? ''}`);
  }
  return value.data;
};
let projectCreated = false;
let evidence;
try {
  interrupted.signal.throwIfAborted();
  await api('POST', '/api/projects', { id: projectId, name: 'Container isolation probe' });
  projectCreated = true;
  const upload = await api('POST', '/api/files/upload', { root: 'workspace', path: 'inputs/probe.txt',
    data: 'Synthetic probe; no patient data.', encoding: 'utf8' });
  if (!upload?.vcrInput || upload.vcrInputWarning) throw new Error('TXT original upload receipt unavailable');
  const session = await api('POST', '/api/runtime/sessions', {});
  const [runtime, ...extra] = runtimeIds();
  if (!session?.id || !runtime || extra.length) throw new Error('Real runtime session did not identify one container');
  const cp = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', name));
  const activeImage = docker('inspect', '--format', '{{.Image}}', runtime);
  const networks = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', runtime));
  const mounts = JSON.parse(docker('inspect', '--format', '{{json .HostConfig.Mounts}}', runtime));
  const { Privileged: privileged, ReadonlyRootfs: readOnlyRoot, CapDrop: capDrop, SecurityOpt: security, Binds: binds } =
    JSON.parse(docker('inspect', '--format', '{{json .HostConfig}}', runtime));
  const internal = docker('network', 'inspect', '--format', '{{.Internal}}', network) === 'true';
  if (!internal || !cp[network] || !cp[egress] || Object.keys(cp).length !== 2 || Object.keys(networks).join() !== network || activeImage !== receipt.image
      || privileged || !readOnlyRoot || !capDrop?.includes('ALL')
      || !security?.some(option => option.startsWith('no-new-privileges')) || binds?.length) {
    throw new Error('Unexpected runtime image, network or privilege');
  }
  const sha = value => createHash('sha256').update(value).digest('hex');
  const ownerRoot = 'users/'+account.id;
  const projectRoot = ownerRoot+'/projects/'+projectId;
  const control = '.runtime-sockets/'+sha(account.id+'\0'+projectId).slice(0, 24);
  const personal = '.openscience/personal-skill-generations/'+sha(account.id)+'/'+sha(projectId)+'/';
  const expected = new Map([
    ['/workspace', [projectRoot+'/workspace', false]],
    ['/workspace/knowledge-base', [projectRoot+'/workspace/knowledge-base', true]],
    ['/workspace/library', [ownerRoot+'/library-views/'+projectId, true]],
    ['/runtime', [projectRoot+'/runtime/container-runtime', false]],
    ['/runtime/capsule-methods', [projectRoot+'/runtime/capsule-methods', true]],
    ['/runtime-control', [control, false]],
    ['/opt/evimed/personal-skills', [new RegExp('^'+personal.replaceAll('.', '\\.')+'[a-f0-9]{64}/skills$'), true]],
  ]);
  for (const mount of mounts) {
    const [subpath, readOnly] = expected.get(mount.Target) ?? [];
    const actual = mount.VolumeOptions?.Subpath;
    const same = subpath instanceof RegExp ? subpath.test(actual ?? '') : subpath === actual;
    if (mount.Type !== 'volume' || mount.Source !== volume || !subpath || !same || Boolean(mount.ReadOnly) !== readOnly) {
      throw new Error('Unexpected runtime mount: '+JSON.stringify(mount));
    }
  }
  if (!['/workspace', '/runtime', '/runtime-control'].every(target => mounts.some(mount => mount.Target === target))) {
    throw new Error('Missing runtime project mount');
  }
  const shell = docker('exec', runtime, 'sh', '-ec', `
    for unavailable in /app /audit /budget /collections /data /var/run/docker.sock /Users; do
      test ! -e "$unavailable"
    done
    ! printenv DEEPSEEK_API_KEY >/dev/null
    marker=/workspace/.vcr-isolation-probe
    printf 'isolated' > "$marker"
    test "$(cat "$marker")" = isolated
    rm "$marker"
    node -e 'const s=require("node:net").connect({host:"1.1.1.1",port:443});s.on("error",()=>process.exit(0));s.on("connect",()=>process.exit(1));s.setTimeout(2000,()=>process.exit(0))'
    if timeout 3 getent ahostsv4 example.com >/dev/null; then exit 1; fi
    dsh --version
  `);
  if (shell !== receipt.kernelVersion) throw new Error('Live kernel pin differs');
  const liveSocket = '/runtime/dsh-home/profiles/evimed-runtime/node_modules/@evimed/dsh-socket/';
  const liveSources = [
    ['runtime/mcp/evimed-research/server.py', '/opt/evimed/mcp/evimed-research/server.py'],
    ['runtime/mcp/evimed-research/vcr_platform.py', '/opt/evimed/mcp/evimed-research/vcr_platform.py'],
    ['packages/socket/plugins/run-policy.mjs', liveSocket+'plugins/run-policy.mjs'],
    ['capability-skills/vcr-matching/SKILL.md', liveSocket+'capability-skills/vcr-matching/SKILL.md'],
    ['packages/domain/src/toolNames.mjs', liveSocket+'node_modules/@evimed/domain/src/toolNames.mjs'],
  ];
  const runtimeModuleHashes = {};
  for (const [source, live] of liveSources) {
    const actual = docker('exec', runtime, 'sha256sum', live).split(/\s+/)[0];
    const expectedHash = sha(await fs.readFile(new URL('../../'+source, import.meta.url)));
    if (actual !== expectedHash) throw new Error('Runtime source differs: '+source);
    runtimeModuleHashes[source] = actual;
  }

  const gatewayProbe = JSON.parse(docker('exec', runtime, 'node', '-e', `
    const fs = require('node:fs');
    const token = fs.readFileSync('/runtime/dsh-home/model-gateway.token', 'utf8').trim();
    const url = 'http://' + process.argv[1];
    async function request(route, body, port = 8787) {
      const res = await fetch(url + ':' + port + route, { method: 'POST', body: body === null ? '}' : JSON.stringify(body),
        signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json',
          authorization: 'Bearer ' + token, 'x-forwarded-for': '127.0.0.1' } });
      const value = await res.json();
      return { status: res.status, code: value.code ?? value.error?.code ?? null };
    }
    (async () => {
      const checks = await Promise.all([
        request('/internal/vcr/v1/read', { what: 'contracts' }),
        request('/internal/model/v1/chat/completions', null),
        request('/internal/sources/v1/fetch', { mode: 'web-read', url: 'https://raw.githubusercontent.com/ncbi-nlp/TrialGPT/main/README.md' }),
        request('/internal/search/v1/query', { query: 'trial gold labels' }),
        request('/api/auth/register', { username: 'untrusted-runtime' }),
        request('/api/health', {}, 8788),
        request('/internal/vcr/v1/read', { what: 'trial_registry_record', filter: { registry: 'clinicaltrials.gov', registryId: 'NCT00000000' } }),
      ]);
      console.log(JSON.stringify(checks));
    })().catch(error => { console.error(error.name); process.exitCode = 1; });
  `, name));
  const [contracts, model, webRead, webSearch, browser, ui, liveRegistry] = gatewayProbe;
  if (contracts.status !== 200 || model.status !== (receipt.paid ? 400 : 503)
      || model.code !== (receipt.paid ? 'model_gateway_body_invalid' : 'model_gateway_unavailable')
      || [webRead, webSearch].some(row => row.status !== 403 || row.code !== 'benchmark_closed_corpus')
      || [browser, ui].some(row => row.status !== 403 || row.code !== 'benchmark_runtime_route_forbidden')
      || liveRegistry.status !== 403 || liveRegistry.code !== 'vcr_invocation_unavailable') {
    throw new Error('Unexpected runtime gateway boundary: '+JSON.stringify(gatewayProbe));
  }
  interrupted.signal.throwIfAborted();
  evidence = { instance: receipt.instance, sourceSha: receipt.sourceSha, projectId, sessionId: session.id,
    container: runtime, image: activeImage, mounts, network, internal, privileged, kernelVersion: shell,
    workspaceReadWrite: true, forbiddenPathsAbsent: true, directPublicConnectionFailed: true, publicDnsBlocked: true,
    runtimeSourceBytesMatched: true, runtimeModuleHashes, gatewayBoundaryVerified: true, gatewayProbe, dispatchedPrompts: 0 };
} finally {
  try {
    if (projectCreated) await api('POST', '/api/commands/stop_runtime', {}, true);
  } finally {
    try {
      const cleanup = await account.close();
      if (!cleanup.deleted || runtimeIds().length) throw new Error('Runtime stop or account deletion was not confirmed');
    } finally {
      for (const signal of signals) process.off(signal, abort);
    }
  }
}
const budgetAfter = await readBudget();
if (JSON.stringify(budgetBefore) !== JSON.stringify(budgetAfter)) throw new Error('Readiness changed the model budget');
evidence.accountDeleted = true;
evidence.runtimeRemoved = true;
evidence.budgetUnchanged = true;
evidence.checkedAt = new Date().toISOString();
await fs.writeFile(path.join(state, 'probe.json'), JSON.stringify(evidence, null, 2)+'\n', { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
