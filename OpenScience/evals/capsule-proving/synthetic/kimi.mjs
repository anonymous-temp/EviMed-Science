/**
 * One call to the generator model through the Kimi Code CLI in prompt mode. Returns the parsed JSON object of the last
 * assistant message, or an error; never a partial object.
 * @module capsule-proving/synthetic/kimi
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The owner's model for swarm Kimi work (2026-11-09); its CLI default effort is high. */
export const KIMI_MODEL = process.env.SYNTH_KIMI_MODEL || 'kimi-code/k3.1-pro';

/**
 * Which outside model writes the content. Kimi by default; `SYNTH_GENERATOR=codex` sends the same prompts to the Codex CLI
 * (GPT, `SYNTH_CODEX_MODEL`, default gpt-6.1-sol) — owner 2026-11-09, when Kimi's usage window ran out. Either one is
 * outside every judged role (not the template author, not the DeepSeek extractor or answerer, not the Qwen judge), and every
 * file records which one wrote it (`GENERATOR`), so a result can be split by generator.
 */
export const GENERATOR_BACKEND = process.env.SYNTH_GENERATOR === 'codex' ? 'codex' : 'kimi';
const CODEX_MODEL = process.env.SYNTH_CODEX_MODEL || 'gpt-6.1-sol';
const CODEX_EFFORT = process.env.SYNTH_CODEX_EFFORT || 'medium';
export const GENERATOR = GENERATOR_BACKEND === 'codex' ? `codex-cli:${CODEX_MODEL}` : `kimi-code-cli:${KIMI_MODEL}`;

/**
 * A Kimi process holds about 350 MB on this box and the box is shared with other sessions; with `SYNTH_MIN_FREE_MB` set, a
 * call waits until the kernel reports at least that much available memory before it spawns (no limit when unset).
 */
const MIN_FREE_MB = Number(process.env.SYNTH_MIN_FREE_MB || 0);
const availableMb = () => {
  try { return Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024; } catch { return Infinity; }
};
async function memoryGate() {
  if (!MIN_FREE_MB) return;
  while (availableMb() < MIN_FREE_MB) await new Promise((r) => setTimeout(r, 5000 + Math.random() * 5000));
}

/**
 * The plan's usage window runs out (「You've reached your 5-hour usage limit」, measured 2026-11-09 after ~5 h of 8–12
 * parallel calls). A call that meets it is not a failed attempt: it waits and asks again, so a long run sleeps through the
 * window instead of spending every retry and marking its users failed. `SYNTH_KIMI_QUOTA_WAIT_MIN` (default 10) is the pause,
 * `SYNTH_KIMI_QUOTA_MAX_HOURS` (default 8) the most it waits in all; 0 turns waiting off.
 */
export const QUOTA_EXHAUSTED = /usage limit|quota will reset/i;
const QUOTA_WAIT_MS = Number(process.env.SYNTH_KIMI_QUOTA_WAIT_MIN ?? 10) * 60_000;
const QUOTA_MAX_MS = Number(process.env.SYNTH_KIMI_QUOTA_MAX_HOURS ?? 8) * 3_600_000;

/** @param {string} prompt @param {{ timeoutMs?: number, cwd?: string, model?: string }} [o] @returns {Promise<{ ok: true, value: any, ms: number } | { ok: false, error: string, ms: number, raw?: string }>} */
export async function callKimi(prompt, o = {}) {
  const began = Date.now();
  for (;;) {
    const r = await callOnce(prompt, o);
    if (r.ok || GENERATOR_BACKEND !== 'kimi' || !QUOTA_WAIT_MS || !QUOTA_EXHAUSTED.test(r.error) || Date.now() - began > QUOTA_MAX_MS) return r;
    process.stderr.write(`${new Date().toISOString()} kimi usage window exhausted; waiting ${QUOTA_WAIT_MS / 60_000} min\n`);
    await new Promise((res) => setTimeout(res, QUOTA_WAIT_MS + Math.random() * 30_000));
  }
}

/** One spawn of the CLI. */
async function callOnce(prompt, o = {}) {
  await memoryGate();
  return GENERATOR_BACKEND === 'codex' ? callCodex(prompt, o) : callKimiCli(prompt, o);
}

/** The JSON object a reply holds, or why it holds none. */
function parseReply(last, code, err, ms) {
  if (last == null) return { ok: false, error: `no assistant reply (exit ${code}): ${err.slice(-300)}`, ms };
  const body = last.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, error: 'reply holds no JSON object', ms, raw: last.slice(0, 2000) };
  try { return { ok: true, value: JSON.parse(body.slice(start, end + 1)), ms }; }
  catch (e) { return { ok: false, error: `JSON parse: ${e.message}`, ms, raw: last.slice(0, 2000) }; }
}

function callKimiCli(prompt, { timeoutMs = 15 * 60_000, cwd, model = KIMI_MODEL } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('kimi', ['-m', model, '-p', prompt, '--output-format', 'stream-json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let last = null;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try { const d = JSON.parse(line); if (d.role === 'assistant' && typeof d.content === 'string') last = d.content; } catch { /* not a frame */ }
      }
      resolve(parseReply(last, code, err, Date.now() - started));
    });
  });
}

/**
 * The Codex CLI in exec mode: the prompt on stdin, a read-only sandbox in an empty directory of its own, no user config
 * (so no MCP server or hook starts for a text-only call), the last message written to a file.
 */
function callCodex(prompt, { timeoutMs = 15 * 60_000 } = {}) {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'synth-codex-'));
  const lastFile = join(dir, 'last.txt');
  return new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', dir,
      '-m', CODEX_MODEL, '-c', `model_reasoning_effort="${CODEX_EFFORT}"`, '-o', lastFile, '-'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end(prompt);
    child.on('close', (code) => {
      clearTimeout(timer);
      let last = null;
      try { last = existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : null; } catch { /* unreadable */ }
      if (last != null && !last.trim()) last = null;
      rmSync(dir, { recursive: true, force: true });
      resolve(parseReply(last, code, err, Date.now() - started));
    });
  });
}
