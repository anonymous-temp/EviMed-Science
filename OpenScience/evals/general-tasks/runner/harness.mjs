// Local real-kernel harness (verification scaffolding; scratch only, never the repo, never production).
//
// The real control plane runs in kernel mode and drives a real DSH kernel started on this host from the seeded profile
// (seed.sh; its dump-config equals the committed baseline). Only the container launch is replaced: HostKernelProvider takes
// the platform's own Docker launch plan and bootstrap files and starts the same kernel as a host process, with the image's
// absolute paths mapped to their sources in the merged tree. Plan, patch, credentials, tokens, readiness, dispatch, the
// gateways (model, capsule, public source) and the run ledger are the platform's own code paths.
//
//   node harness.mjs            serve on LIVE_PORT (default 48841) until killed. Adapted from the WP-PROMPT harness (course
//   correction 2026-10-12); parameters come from the environment run.mjs sets: OS, TREE_DIR, LIVE_DIR, LIVE_DATA, LIVE_PORT,
//   LIVE_DATABASE_URL, LIVE_ENV, LIVE_OVERRIDES, EVAL_PERSONA.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { applyPersona } from './persona.mjs';

const OS = process.env.OS;
if (!OS) throw new Error('set OS to the OpenScience tree under test');
const L = process.env.LIVE_DIR ?? '/tmp/eval/live';
const TREE = process.env.TREE_DIR;
if (!TREE) throw new Error('set TREE_DIR to the staged tree directory seed.sh printed');
const DATA = process.env.LIVE_DATA ?? `${L}/data`;
const PORT = Number(process.env.LIVE_PORT ?? 48841);
const DB_URL = process.env.LIVE_DATABASE_URL;
if (!DB_URL) throw new Error('set LIVE_DATABASE_URL');
const DSH_BIN = process.env.DSH_BIN ?? '/tmp/evimed-openmed-dsh/node_modules/.bin/dsh';
const SEED = `${TREE}/dsh-seed`;
const SOCK = `${TREE}/opt/socket`;
const PERSONA = process.env.EVAL_PERSONA ?? '';
const log = (...parts) => process.stderr.write(`${new Date().toISOString()} harness ${parts.join(' ')}\n`);

// --- secrets (random, scratch) and the operator's DeepSeek key file (read by config only, never printed) -----------------
await fs.mkdir(`${L}/secrets`, { recursive: true, mode: 0o700 });
for (const name of ['model-gateway', 'workload']) {
  const file = `${L}/secrets/${name}`;
  if (!fsSync.existsSync(file)) await fs.writeFile(file, randomBytes(48).toString('base64url'), { mode: 0o600 });
}
// A fake container CLI: the plan builder and readiness ask Docker about the image; nothing here runs a container.
const fakeDocker = `${L}/fake-docker.sh`;
await fs.writeFile(fakeDocker, `#!/bin/sh\nif [ "$1" = image ] && [ "$2" = inspect ]; then echo sha256:${'a'.repeat(64)}; fi\nexit 0\n`, { mode: 0o755 });

Object.assign(process.env, {
  OPEN_SCIENCE_DATABASE_URL: DB_URL,
  OPEN_SCIENCE_STATE_STORE: 'postgres',
  // The key is read by the control plane from this file; nothing here reads or prints it.
  OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE: process.env.EVAL_DEEPSEEK_KEY_FILE ?? '/home/coder/workspace/EviMedScience/.evimed-local/secrets/deepseek.api-key',
  OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_FILE: `${L}/secrets/model-gateway`,
  OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_FILE: `${L}/secrets/workload`,
  OPEN_SCIENCE_DEV_AUTH: 'true',
  ...(process.env.LIVE_ENV ? JSON.parse(process.env.LIVE_ENV) : {}),
});


// --- what reaches the model provider, measured where it leaves (sizes only; headers are never read or written) ------------
// The model gateway calls the provider with the global fetch. Every chat request is logged as one line of sizes, and the
// first request of each conversation (no assistant message yet) is kept whole, so "first-request size" is what was sent.
{
  const realFetch = globalThis.fetch;
  const requestLog = `${DATA}/model-requests.jsonl`;
  fsSync.mkdirSync(`${DATA}/first-requests`, { recursive: true });
  let seq = 0;
  globalThis.fetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
if (/\/(chat\/completions|messages)$/.test(new URL(url).pathname) && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const text = (value) => typeof value === 'string' ? value : JSON.stringify(value ?? '');
        // Chat Completions carries the system prompt as messages; the Messages API as a top-level `system`.
        const system = [text(body.system ?? ''), ...messages.filter((m) => m.role === 'system').map((m) => text(m.content))].filter(Boolean).join('\n');
        const systemText = Array.isArray(body.system) ? body.system.map((block) => block?.text ?? '').join('\n') : system;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const first = !messages.some((m) => m.role === 'assistant');
        const row = { at: new Date().toISOString(), seq: seq += 1, path: new URL(url).pathname, model: body.model, bytes: Buffer.byteLength(init.body), messages: messages.length,
          systemChars: systemText.length, tools: tools.length, toolsChars: JSON.stringify(tools).length, first,
          toolNames: first ? tools.map((t) => t?.function?.name ?? t?.name) : undefined,
          userChars: messages.filter((m) => m.role === 'user').map((m) => text(m.content)).join('\n').length, maxTokens: body.max_tokens ?? null, thinking: body.thinking ?? null };
        fsSync.appendFileSync(requestLog, `${JSON.stringify(row)}\n`);
        if (first && tools.length > 0) fsSync.writeFileSync(`${DATA}/first-requests/${String(row.seq).padStart(4, '0')}.json`, JSON.stringify({ at: row.at, path: row.path, model: body.model, system: body.system ?? null, messages, tools }, null, 1));
      }
    } catch { /* measurement only */ }
    return realFetch(input, init);
  };
}

const rm = await import(`${OS}/apps/server/src/runtimeManager.mjs`);
const { createWebApiApp } = await import(`${OS}/apps/server/src/server.mjs`);

/** Container paths the image bakes in, and where their sources are in the merged tree. Mounts are added per plan. */
const IMAGE_PATHS = [
  ['/opt/evimed/socket', SOCK],
  ['/opt/evimed/mcp/evimed-research', `${OS}/runtime/mcp/evimed-research`],
  ['/opt/evimed/capabilities', `${OS}/deploy/runtime-dsh/capabilities`],
  ['/opt/evimed/capability-skills', `${OS}/capability-skills`],
  ['/opt/evimed/skills', `${OS}/runtime/skills`],
];

/** @param {string[]} args */
function parsePlanArgs(args) {
  const mounts = []; const env = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--mount') {
      const fields = Object.fromEntries(String(args[i + 1]).split(',').map((part) => part.split('=')).map(([k, v]) => [k, v ?? true]));
      if (fields.type === 'bind' && fields.src && fields.dst) mounts.push([String(fields.dst), String(fields.src)]);
      i += 1;
    } else if (args[i] === '--env') {
      const text = String(args[i + 1]); const at = text.indexOf('=');
      env[text.slice(0, at)] = text.slice(at + 1);
      i += 1;
    }
  }
  return { mounts, env };
}

/** Longest container prefix first, whole path segments only. @param {[string,string][]} pairs */
function mapper(pairs) {
  const sorted = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const one = (value) => {
    for (const [from, to] of sorted) {
      if (value === from) return to;
      if (value.startsWith(`${from}/`)) return to + value.slice(from.length);
    }
    return value;
  };
  // One pass, and only where a path starts (line start, space, quote, '=', ':', ',' or '['): a replaced path is never scanned
  // again, so `/runtime` cannot match inside a host path that already reads `.../OpenScience/runtime/...`.
  const table = new Map(sorted);
  const escape = (from) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[\\s'"=:,\\[])(${sorted.map(([from]) => escape(from)).join('|')})(?=[/'"\\s:,\\]]|$)`, 'gm');
  const text = (value) => String(value).replace(pattern, (_match, lead, from) => lead + table.get(from));
  return { one, text };
}

class HostKernelProvider extends rm.DockerRuntimeProvider {
  async preflight() {}
  async prepare(project, input) {
    const plan = await super.prepare(project, input);
    const { mounts, env } = parsePlanArgs(plan.args);
    plan.hostMounts = mounts;
    plan.hostEnv = env;
    plan.hostMap = mapper([...mounts, ...IMAGE_PATHS]);
    // The kernel runs on this host, so the session's cwd is the project's own directory (as the mock runtime's is).
    plan.proxyWorkspaceDir = project.workspaceDir;
    return plan;
  }
  async bootstrap(project, plan, options) {
    const result = await super.bootstrap(project, plan, options);
    const patchFile = path.join(plan.dshHomeDir, 'control-plane-patch.yml');
    const text = await fs.readFile(patchFile, 'utf8');
    await fs.writeFile(patchFile, plan.hostMap.text(text), { mode: 0o600 });
    return result;
  }
  async launch(project, plan, { port }) {
    const map = plan.hostMap;
    const dshHome = map.one('/runtime/dsh-home');
    // The serve script's profile sync, from the scratch seed into this runtime's $DSH_HOME.
    const sync = spawnSync('node', [`${OS}/deploy/runtime-dsh/profile-seed.mjs`, 'sync', SEED, dshHome, 'evimed-runtime'], { encoding: 'utf8' });
    if (sync.status !== 0) throw new Error(`profile sync failed: ${sync.stderr.slice(0, 400)}`);
    // Arm A only: the one neutral sentence in place of the preset's persona (persona.mjs).
    if (PERSONA) { const files = await applyPersona(dshHome, PERSONA); log('persona replaced in', files.length, 'preset files'); }
    const kernelPort = await freePort();
    const env = {
      PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC',
      ...Object.fromEntries(Object.entries(plan.hostEnv).filter(([key]) => !['PATH', 'DSH_HOME_SEED'].includes(key)).map(([key, value]) => [key, map.text(value)])),
      HOME: map.one('/runtime/home'), DSH_HOME: dshHome,
      NARB_DISABLE_NATIVE_CACHE: '1', DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: plan.hostEnv.DSH_PERMISSION_MODE ?? 'workspace-write',
    };
    // Arm A: extra environment for the kernel process (the citation tools follow the project's plugin settings, not a switch).
    if (process.env.EVAL_KERNEL_ENV) Object.assign(env, JSON.parse(process.env.EVAL_KERNEL_ENV));
    await fs.mkdir(env.HOME, { recursive: true });
    const authority = plan.hostEnv.OPEN_SCIENCE_RUNTIME_AUTHORITY ?? 'dsh.runtime';
    const args = ['--profile', 'evimed-runtime', '--patch', path.join(dshHome, 'control-plane-patch.yml'), '--no-open', '--port', String(kernelPort), '--trusted-host', authority];
    log('launch', project.id, 'kernel port', kernelPort, 'socket', plan.socketPath);
    const child = spawn(DSH_BIN, args, { cwd: project.workspaceDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const kernelLog = fsSync.createWriteStream(`${DATA}/kernel-${project.id}.log`, { flags: 'a' });
    child.stdout.pipe(kernelLog); child.stderr.pipe(kernelLog);
    const local = /** @type {any} */ (child); local.exitOutput = '';
    const collect = (chunk) => { local.exitOutput = (local.exitOutput + chunk).slice(-16384); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    // The serve script's socat: the manager reaches the kernel through the plan's unix socket.
    await fs.rm(plan.socketPath, { force: true });
    const bridge = net.createServer((client) => {
      const upstream = net.connect(kernelPort, '127.0.0.1');
      client.pipe(upstream); upstream.pipe(client);
      const end = () => { client.destroy(); upstream.destroy(); };
      client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
    });
    await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(plan.socketPath, resolve); });
    await fs.chmod(plan.socketPath, 0o600);
    local.bridge = bridge;
    child.on('exit', (code, signal) => { log('kernel exit', project.id, code, signal); bridge.close(); });
    return child;
  }
  async close(project, plan, child) {
    const local = /** @type {any} */ (child);
    try { local.bridge?.close(); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
    }
    if (plan.socketPath) await fs.rm(plan.socketPath, { force: true }).catch(() => {});
  }
  afterExit() {}
  async sampleResources() { return null; }
  async cleanupOrphan() { return { cleaned: false, missing: true, skipped: true, reason: 'host_kernel' }; }
  async confirmGone() { return true; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = /** @type {any} */ (server.address()); server.close(() => resolve(port)); });
  });
}

const overrides = {
  dataDir: DATA, port: PORT, runtimeMode: 'kernel', runtimeSandboxMode: 'docker', runtimeContainerImage: 'evimed-runtime:local',
  runtimeContainerBin: fakeDocker, runtimeControllerMode: 'direct', devAuth: true, stateStore: 'postgres',
  ...(process.env.LIVE_OVERRIDES ? JSON.parse(process.env.LIVE_OVERRIDES) : {}),
};
const app = createWebApiApp(overrides, {
  runtimeManagerFactory: (config, hooks) => {
    const manager = new rm.RuntimeManager(config, hooks);
    manager.provider = new HostKernelProvider(manager);
    return manager;
  },
});
const address = await app.listen(PORT, '127.0.0.1');
log('listening', `http://127.0.0.1:${address.port}`);
// An optional test-only hook (LIVE_HOOK=<module>): seeds what an import would have written, through the app's own stores.
if (process.env.LIVE_HOOK) { const { hook } = await import(process.env.LIVE_HOOK); await hook(app, log); }
const stop = async () => { log('stopping'); setTimeout(() => process.exit(0), 8000).unref(); try { await app.close(); } finally { process.exit(0); } };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
