// Every fixed host backup operation owns a POSIX process group. Completion,
// cancellation and timeout all fence that group before acknowledging return.
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const failure = code => Object.assign(new Error(code), { code });

async function liveGroup(group) {
  try {
    const result = await execute('ps', ['-axo', 'pgid=,stat='], { timeout: 2000, maxBuffer: 1024 * 1024 });
    return result.stdout.split('\n').some(line => {
      const [id, state] = line.trim().split(/\s+/);
      // Zombies cannot write or compute. The direct child is also explicitly
      // reaped before return; an orphan zombie waits for the host's reaper.
      return Number(id) === group && state && !state.startsWith('Z');
    });
  } catch { throw failure('vcr_backup_process_stop_unconfirmed'); }
}

function signalGroup(group, signal) {
  try { process.kill(-group, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw failure('vcr_backup_process_stop_unconfirmed'); }
}

async function stopGroup(group, graceMs) {
  if (!await liveGroup(group)) return;
  signalGroup(group, 'SIGTERM');
  const grace = Date.now() + graceMs;
  while (Date.now() < grace) {
    if (!await liveGroup(group)) return;
    await delay(10);
  }
  signalGroup(group, 'SIGKILL');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await liveGroup(group)) return;
    await delay(10);
  }
  throw failure('vcr_backup_process_stop_unconfirmed');
}

export async function runVcrBackupProcess(command, args, { env = process.env, signal = null, timeout = 1800_000,
  stopGraceMs = 1000, maxBuffer = 65536 } = {}) {
  if (process.platform === 'win32') throw failure('vcr_backup_posix_required');
  if (signal?.aborted) throw failure('vcr_backup_canceled');
  let reason = null; let notifyStop;
  const stopped = new Promise(resolve => { notifyStop = resolve; });
  const requestStop = code => { reason ??= code; notifyStop(); };
  // detached creates a new session/group; no unrelated host process belongs
  // to it. Do not pass AbortSignal to spawn: its early rejection is not proof
  // that the foreground descendants are physically gone.
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let spawnedError = null; let exitCode = null;
  const output = (current, chunk) => {
    if (Buffer.byteLength(current) + chunk.length > maxBuffer) { requestStop('vcr_backup_process_output_limit'); return current; }
    return current + chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => { stdout = output(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = output(stderr, chunk); });
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnedError = error; resolve(); });
    child.once('exit', code => { exitCode = code; resolve(); });
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const abort = () => requestStop('vcr_backup_canceled');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => requestStop('vcr_backup_process_timeout'), timeout);
  try {
    await Promise.race([exited, stopped]);
    if (child.pid) await stopGroup(child.pid, stopGraceMs);
    await exited;
    // A descendant that unexpectedly escaped the group must not leave its
    // inherited pipes open while we claim completion.
    let closeTimer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(failure('vcr_backup_process_stop_unconfirmed')), 5000);
      })]);
    } finally { clearTimeout(closeTimer); }
    if (reason) throw failure(reason);
    if (spawnedError || exitCode !== 0) throw failure('vcr_backup_process_failed');
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
