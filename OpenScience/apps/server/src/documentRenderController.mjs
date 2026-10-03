import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { documentExportDigest } from '@evimed/domain';
import path from 'node:path';
import os from 'node:os';
import { dockerRuntimeMount } from './dockerMounts.mjs';
import { HttpError, safeId, assertNoSymlinkPath } from './security.mjs';

export const DOCUMENT_RENDER_TIMEOUT_MS = 180_000;
const NAME = 'evimed-document-render';
/** @param {any} config @param {any} reference */
export function documentExportDirectory(config, reference) {
  return path.join(config.dataDir, 'users', safeId(reference.ownerId, 'ownerId'), 'projects', safeId(reference.projectId, 'projectId'), '.openscience', 'document-exports', safeId(reference.exportId, 'exportId'));
}
/** Fixed operation, never a caller-defined command, mount or image. @param {any} config @param {any} reference */
export function documentRenderPlan(config, reference) {
  const root = documentExportDirectory(config, reference);
  const attempt = safeId(reference.attemptId, 'attemptId');
  const dir = path.join(root, 'attempts', attempt);
  const label = createHash('sha256').update(documentExportDigest(reference)).digest('hex');
  const args = ['create', '--name', NAME, '--label', 'open-science.document-render=true', '--label', `open-science.render-attempt=${label}`,
    '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--cpus=1', '--memory=768m', '--memory-swap=768m',
    '--user', String(config.runtimeContainerUser || `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`),
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
    // The shared runtime image declares persistent workspace/runtime volumes
    // and XDG paths. A renderer owns only disposable scratch and its output.
    '--tmpfs', '/workspace:ro,noexec,nosuid,nodev,size=1m', '--tmpfs', '/runtime:ro,noexec,nosuid,nodev,size=1m',
    '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/xdg-config', '--env', 'XDG_DATA_HOME=/tmp/xdg-data',
    '--env', 'XDG_CACHE_HOME=/tmp/xdg-cache', '--env', 'XDG_STATE_HOME=/tmp/xdg-state', '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--mount', `${dockerRuntimeMount(config, path.join(dir, 'input'), '/input')},readonly`,
    '--mount', dockerRuntimeMount(config, path.join(dir, 'output'), '/output'),
    '--entrypoint', 'python3', config.runtimeContainerImage, '/opt/evimed/export/render_document.py', '--input', '/input/document.json', '--output-dir', '/output'];
  return { args, dir, label, name: NAME };
}
/** One container name is an atomic host-wide slot even across controller restarts. @param {any} config */
export function createDocumentRenderController(config, { availableMemory = async () => {
  const memory = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
  return Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024 || os.freemem();
}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const active = new Map();
  const docker = (args) => spawnSync(config.runtimeContainerBin, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  const inspect = () => {
    const result = docker(['inspect', '--format', '{{json .}}', NAME]);
    if (result.status !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) return null;
      throw new HttpError(503, 'document_render_inventory_failed', 'Renderer availability could not be verified.');
    }
    return JSON.parse(result.stdout);
  };
  async function cancel(reference) {
    const plan = documentRenderPlan(config, reference);
    await assertNoSymlinkPath(config.dataDir, plan.dir, { allowMissingTail: true });
    await fs.writeFile(path.join(plan.dir, '.canceled'), '', { mode: 0o400, flag: 'wx' }).catch(error => { if (!['EEXIST','ENOENT'].includes(error.code)) throw error; });
    const current = inspect();
    if (current && current.Config?.Labels?.['open-science.render-attempt'] === plan.label) {
      if (docker(['rm', '-f', NAME]).status !== 0) throw new HttpError(503, 'document_render_cancel_failed', 'Renderer cancellation is pending.');
    }
    active.get(plan.label)?.child.kill('SIGKILL');
    const remaining = inspect();
    if (remaining?.Config?.Labels?.['open-science.render-attempt'] === plan.label) throw new HttpError(503, 'document_render_cancel_failed', 'Renderer cancellation is pending.');
    const uncertain = path.join(plan.dir, '.creation-uncertain');
    if (existsSync(uncertain)) {
      if (!current || current.Config?.Labels?.['open-science.render-attempt'] !== plan.label) throw new HttpError(503, 'document_render_state_unknown', 'Renderer creation could not be confirmed; capacity remains reserved.');
      await fs.rm(uncertain);
    }
    return { canceled: true };
  }
  async function render(reference, signal) {
    if (Object.keys(reference).some(key => !['ownerId','projectId','exportId','attemptId','inputDigest'].includes(key))) throw new HttpError(400, 'document_render_reference_invalid', 'Invalid render reference.');
    const plan = documentRenderPlan(config, reference);
    await assertNoSymlinkPath(config.dataDir, plan.dir);
    const input = path.join(plan.dir, 'input', 'document.json');
    await assertNoSymlinkPath(config.dataDir, input);
    const stat = await fs.lstat(input);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new HttpError(413, 'document_input_invalid', 'Frozen document is invalid.');
    const bytes = await fs.readFile(input);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.inputDigest) throw new HttpError(409, 'document_input_changed', 'Frozen document changed.');
    const document = JSON.parse(bytes.toString('utf8'));
    const image = docker(['image', 'inspect', '--format', '{{.Id}}', config.runtimeContainerImage]);
    const imageId = image.stdout.trim();
    if (image.status !== 0 || !imageId || document.rendererImage !== imageId) throw new HttpError(409, 'document_renderer_changed', 'The renderer image changed; request a new export.');
    plan.args[plan.args.indexOf(config.runtimeContainerImage)] = imageId;
    const output = path.join(plan.dir, 'output');
    await assertNoSymlinkPath(config.dataDir, output);
    if ((await fs.readdir(output)).length) throw new HttpError(409, 'document_output_not_empty', 'Render output must start empty.');
    const current = inspect();
    if (current) {
      const age = Date.now() - Date.parse(current.State?.StartedAt ?? current.Created);
      if (current.Config?.Labels?.['open-science.document-render'] !== 'true' || !Number.isFinite(age) || age < DOCUMENT_RENDER_TIMEOUT_MS + 30000) {
        throw new HttpError(429, 'document_render_busy', 'Another document is being rendered.');
      }
      if (docker(['rm', '-f', NAME]).status !== 0) throw new HttpError(503, 'document_render_cancel_failed', 'Expired renderer cleanup is pending.');
    }
    // Leave headroom for the API and database on the current host; admission
    // callbacks coordinate compute/build/restore before this final host check.
    if (signal?.aborted || existsSync(path.join(plan.dir, '.canceled'))) throw new DOMException('Render canceled.', 'AbortError');
    const available = await availableMemory();
    if (available < 1536 * 1024 * 1024) throw new HttpError(429, 'document_render_capacity', 'Rendering is waiting for host memory.');
    if (signal?.aborted || existsSync(path.join(plan.dir, '.canceled'))) throw new DOMException('Render canceled.', 'AbortError');
    // Creation is synchronous and bounded: cancellation cannot acknowledge a
    // missing container while an asynchronous docker run is still creating it.
    const uncertain = path.join(plan.dir, '.creation-uncertain');
    writeFileSync(uncertain, '', { mode: 0o400 });
    const created = docker(plan.args);
    if (created.status != null) unlinkSync(uncertain);
    if (created.status !== 0) {
      await cancel(reference);
      throw new HttpError(503, /already in use/i.test(created.stderr) ? 'document_render_busy' : 'document_render_start_failed', 'Renderer could not start.');
    }
    let timer;
    let timedOut = false;
    let interrupt = (_error) => {};
    const stop = () => {
      timedOut = !signal?.aborted;
      const failure = new HttpError(504, timedOut ? 'document_render_timeout' : 'document_render_canceled', 'Document conversion stopped.');
      void cancel(reference).then(() => interrupt(failure), error => interrupt(error));
    };
    try {
      return await new Promise((resolve, reject) => {
        interrupt = reject;
        const child = spawn(config.runtimeContainerBin, ['start', '--attach', NAME], { stdio: ['ignore', 'ignore', 'pipe'] });
        active.set(plan.label, { child, reference });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
        signal?.addEventListener('abort', stop, { once: true });
        timer = setTimer(stop, DOCUMENT_RENDER_TIMEOUT_MS);
        child.once('error', () => reject(new HttpError(503, 'document_render_start_failed', 'Renderer could not start.')));
        child.once('exit', code => code === 0 && !signal?.aborted && !timedOut ? resolve({ rendered: true }) : reject(new HttpError(502,
          /already in use/i.test(stderr) ? 'document_render_busy' : 'document_render_failed', 'Document conversion did not finish.')));
      });
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', stop);
      await cancel(reference);
      active.delete(plan.label);
    }
  }
  return { render, cancel, async close() { await Promise.all([...active.values()].map(value => cancel(value.reference))); } };
}
