#!/usr/bin/env node
// LX: the learning-loop experiments L1 (every link lights), L10 (tool-chain routines), L5 (bad methods stopped, good ones not)
// and L2 (learning curve with hidden-rule simulated people) on the PRODUCT PATH: the real control plane in kernel mode, the real
// DSH kernel, DeepSeek through the model gateway, native memory, and the product's own LearningWorker. Development data only.
//
//   node evals/capsule-proving/lx/run_lx.mjs --exp l1|l10|l5|l2 --arm <arm> [--units id,id] [--out DIR] [--port 48852]
//        [--pg-port 55682] [--tree <OpenScience>] [--data /srv/evimed/data/memdata-data] [--timeout-min 15] [--summarize-only]
//
// Resumable: every finished step of a unit is written to units/<unit>/progress.json and a line to STATUS. A unit of L1/L10/L5
// interrupted inside a conversation restarts with a fresh account (its history would otherwise carry a half-run); an L2 unit
// resumes at the conversation it was in (marked `interrupted` in the record). Turns are ATTENDED (the loop refuses automated work);
// the worker runs only inside the runner's drains (EVAL_DEFER_LEARNING=1), with queued learning jobs brought forward.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Api, registerAccount } from '../../general-tasks/runner/cell.mjs';
import { ensurePostgres, ensureDatabase, startHarness, stopHarness } from '../../general-tasks/runner/run.mjs';
import { runConversation } from './conversation.mjs';
import { l1Ring, l10Family, l5Item, l2Summary, ruleResults, correctionFor, followUpOf, methodById, countsOf, mountOf, toolChainOf, nonZero } from './verdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(HERE, '../../..');
const SUITE = path.resolve(HERE, '../../general-tasks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const EXPERIMENTS = { l1: ['tc-off', 'tc-on'], l10: ['tc-off', 'tc-on'], l5: ['base'], l2: ['evolve', 'frozen', 'add-only'] };
const ACCEPTS = ['好的，可以。', '行，就这样。', '收到，没问题。'];
const PASSWORD = 'eval-pass-1';
export const SCORER = 'lx/1';

export function argsOf(argv) {
  const out = { port: 48852, pgPort: 55682, timeoutMin: 15, learningTimeoutMin: 45, data: '/srv/evimed/data/memdata-data' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['summarizeOnly'].includes(key)) out[key] = true; else out[key] = argv[++i];
  }
  for (const k of ['port', 'pgPort', 'timeoutMin', 'learningTimeoutMin']) out[k] = Number(out[k]);
  if (!EXPERIMENTS[out.exp]?.includes(out.arm)) throw new Error(`--exp ${out.exp} --arm ${out.arm}: expected one of ${JSON.stringify(EXPERIMENTS)}`);
  return out;
}
export function armEnv(exp, arm) {
  const read = file => Object.fromEntries(fsSync.readFileSync(`${HERE}/arms/${file}`, 'utf8').split('\n').filter(line => line && !line.startsWith('#'))
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const env = read('base.env');
  if (arm === 'tc-on') env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED = 'true';
  if (arm === 'add-only') env.EVAL_ADD_ONLY = '1';
  return env;
}
/** Development data only: a sealed directory is never opened. */
export function devDir(root, exp) {
  const dir = path.join(root, `${exp}-dev`);
  if (/sealed/i.test(dir)) throw new Error('sealed data refused');
  return dir;
}
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 1));
  await fs.rename(`${file}.tmp`, file);
}
const readJson = async (file, fallback = null) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } };
function ipc(h, action, args = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { h.child.off('message', reply); reject(new Error(`eval control timeout: ${action}`)); }, 300_000);
    const reply = message => {
      if (message.id !== id) return;
      clearTimeout(timer); h.child.off('message', reply);
      message.error ? reject(new Error(message.error)) : resolve(message.value);
    };
    h.child.on('message', reply);
    h.child.send({ evalControl: true, id, action, args });
  });
}
const kebab = (text, fallback) => (String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback);
export function skillOf({ name, whenToUse, body }) {
  const line = s => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/"/g, '\\"');
  return `---\nname: ${kebab(name, 'method')}\ndescription: "${line(whenToUse).slice(0, 300)}"\nwhenToUse: "${line(whenToUse).slice(0, 300)}"\n---\n${String(body).trim()}\n`;
}

/** The runner's side of a learning settlement: the product worker claims every queued learning job; nothing is written for it. */
async function drain(h, userId, { sleepKey = null, consolidate = true, timeoutMin = 45 } = {}, status = () => {}) {
  await ipc(h, 'start', { userId });
  const deadline = Date.now() + timeoutMin * 60_000;
  let quiet = 0, slept = false, last = null, timedOut = false, settled = false, applied = null;
  for (;;) {
    if (Date.now() > deadline) { timedOut = true; break; }
    await ipc(h, 'lxBring', { userId, kinds: consolidate ? ['distill', 'consolidate', 'learning-evidence'] : ['distill', 'learning-evidence'] });
    last = await ipc(h, 'status', { userId });
    const pending = last.jobs.filter(j => ['queued', 'running'].includes(j.status) && (consolidate || j.kind !== 'consolidate'));
    if (!pending.length && !last.worker.running) quiet++; else quiet = 0;
    if (quiet >= 3 && !settled) {
      // The consolidation-schedule pass's first step: reactions folded into the opened methods' counters (before any stop is decided).
      applied = await ipc(h, 'lxSettleApplied', { userId }).catch(error => ({ error: String(error?.message ?? error) }));
      settled = true; quiet = 0;
    } else if (quiet >= 3) {
      if (sleepKey && !slept && consolidate) { await ipc(h, 'sleep', { userId, key: sleepKey }); slept = true; quiet = 0; status(`    sleep queued (${sleepKey})`); }
      else break;
    }
    await sleep(5000);
  }
  await ipc(h, 'pause', { userId });
  const summary = { jobs: last?.jobs?.length ?? 0, byStatus: {}, slept, timedOut, applied };
  for (const j of last?.jobs ?? []) summary.byStatus[`${j.kind}:${j.status}`] = (summary.byStatus[`${j.kind}:${j.status}`] ?? 0) + 1;
  return summary;
}

class Unit {
  constructor(ctx, id, { restartable = true } = {}) {
    Object.assign(this, { ctx, id, restartable, dir: `${ctx.outDir}/units/${id}` });
  }
  async load() {
    this.p = await readJson(`${this.dir}/progress.json`, { attempt: 1, steps: {} });
    if (this.p.inFlight && this.restartable) {
      // A conversation or a drain was cut: its half is in the account. Start the unit again on a fresh account.
      const old = `${this.ctx.outDir}/units/${this.id}.attempt-${this.p.attempt}`;
      await fs.rm(old, { recursive: true, force: true }); await fs.rename(this.dir, old);
      this.ctx.status(`${this.id} restarts (attempt ${this.p.attempt} interrupted in ${this.p.inFlight}; kept as ${path.basename(old)})`);
      this.p = { attempt: this.p.attempt + 1, steps: {} };
    } else if (this.p.inFlight) { this.p.interrupted = [...(this.p.interrupted ?? []), this.p.inFlight]; delete this.p.inFlight; }
    await fs.mkdir(this.dir, { recursive: true });
    await this.save();
    return this;
  }
  async save() { await atomic(`${this.dir}/progress.json`, this.p); }
  /** Run a named step once; its result is kept. */
  async step(name, fn) {
    if (name in this.p.steps) return this.p.steps[name];
    this.p.inFlight = name; await this.save();
    this.ctx.status(`${this.id} ${name} start`);
    const value = await fn();
    this.p.steps[name] = value ?? true; delete this.p.inFlight; await this.save();
    this.ctx.status(`${this.id} ${name} done`);
    return this.p.steps[name];
  }
  async account() {
    const api = new Api(this.ctx.h.base);
    if (this.p.account) {
      const login = await api.call('POST', '/api/auth/login', { username: this.p.account.username, password: PASSWORD }, { project: null });
      if (login.status !== 200) throw new Error(`resume login ${this.p.account.username}: ${login.status}`);
      api.csrf = login.json?.data?.csrfToken ?? login.json?.data?.session?.csrfToken ?? '';
      if (!api.csrf) api.csrf = (await api.call('GET', '/api/me', undefined, { project: null })).json?.data?.csrfToken ?? '';
      return { api, ...this.p.account };
    }
    const username = `lx${this.ctx.exp}${createHash('sha1').update(`${this.ctx.arm}:${this.id}:${this.p.attempt}`).digest('hex').slice(0, 6)}${Date.now().toString(36).slice(-5)}`;
    this.p.account = await registerAccount(api, username);
    await this.save();
    return { api, ...this.p.account };
  }
  async conversation(name, { api, userId, projectId, projectName, first, next, maxTurns }) {
    return this.step(name, async () => {
      const sessionId = `s-${name}-${createHash('sha1').update(`${this.id}:${this.p.attempt}:${name}`).digest('hex').slice(0, 8)}`;
      const record = await runConversation({ api, userId, projectId, projectName, sessionId, first, next, maxTurns, dataDir: this.ctx.dataDir, outDir: `${this.dir}/${name}`,
        timeoutMs: this.ctx.args.timeoutMin * 60_000, log: this.ctx.status, observeMethods: identity => ipc(this.ctx.h, 'methods', identity), waitMemoryTools: true });
      await atomic(`${this.dir}/${name}.json`, record);
      return { file: `${name}.json`, runs: record.turns.map(t => t.runId), startedAt: record.startedAt, wallMs: record.wallMs };
    });
  }
  async drain(name, userId, options) {
    return this.step(name, async () => {
      const result = await drain(this.ctx.h, userId, { timeoutMin: this.ctx.args.learningTimeoutMin, ...options }, this.ctx.status);
      const state = await ipc(this.ctx.h, 'lxState', { userId });
      await atomic(`${this.dir}/state-${name}.json`, state);
      return { ...result, approved: state.methods.filter(m => m.payload?.status === 'approved').map(m => m.id),
        methods: state.methods.map(m => ({ id: m.id, name: m.payload?.frontmatter?.name, status: m.payload?.status })) };
    });
  }
  async record(name) { return readJson(`${this.dir}/${name}.json`); }
}

/** The turns of conversation records, labelled, with their conversation's start time. */
function labelledTurns(records) {
  return records.flatMap(({ label, record, roles }) => (record?.turns ?? []).map((t, i) => ({ ...t, label: `${label}.t${i}`, role: roles?.[i] ?? 'request', conversationStartedAt: record.startedAt })));
}

// ---------- L1 ----------
async function l1Unit(ctx, script, gold, { seededSleep = false } = {}) {
  const id = seededSleep ? `${script.id}-seeded` : script.id;
  const u = await new Unit(ctx, id).load();
  if (fsSync.existsSync(`${u.dir}/verdict.json`)) return readJson(`${u.dir}/verdict.json`);
  const { api, userId } = await u.account();
  const projectId = `lx-${kebab(id, 'ring')}-${u.p.attempt}`;
  const seeded = [];
  if (script.ring === 'replay') {
    const seed = await u.step('seed', async () => {
      const r = await api.call('POST', '/api/methods', { skill: skillOf({ name: 'project-weekly-report', whenToUse: '用户给出本周项目进展的零散记录，要求整理成可直接发到项目群的周报时。', body: script.method.before }) });
      if (r.status !== 201) throw new Error(`seed method: ${r.status} ${r.raw.slice(0, 200)}`);
      return { id: r.json.data.id, status: r.json.data.status, digest: r.json.data.contentDigest };
    });
    seeded.push(seed);
  }
  if (seededSleep) {
    const seeds = await u.step('seed', async () => {
      const out = [];
      for (const [i, m] of script.methods.entries()) {
        const r = await api.call('POST', '/api/methods', { skill: skillOf({ name: `meeting-notes-summary-${i + 1}`, whenToUse: m.whenToUse, body: m.body }) });
        if (r.status !== 201) throw new Error(`seed method: ${r.status} ${r.raw.slice(0, 200)}`);
        out.push({ id: r.json.data.id, status: r.json.data.status });
      }
      return out;
    });
    seeded.push(...seeds);
    const sleepKey = `lx-${id}-${u.p.attempt}-sleep`;
    await u.drain('sleep', userId, { sleepKey });
    const state = await ipc(ctx.h, 'lxState', { userId });
    await atomic(`${u.dir}/state-final.json`, state);
    const sleepJob = state.jobs.find(j => j.kind === 'consolidate' && j.payload?.action === 'sleep');
    const merged = state.methods.filter(m => m.payload?.provenance?.consolidatedBy);
    const relations = state.methods.flatMap(m => (m.payload?.learning?.relations ?? []).map(r => ({ from: m.payload?.frontmatter?.name, type: r.type, target: r.target })));
    const verdict = { ring: 'sleep(seeded)', id, seeded, usage: await ipc(ctx.h, 'usage', { userId }), consolidated: merged.length > 0 || relations.some(r => ['supersedes', 'duplicate', 'merge'].includes(r.type)),
      sleepJob: sleepJob ? { status: sleepJob.status, result: sleepJob.result, error: sleepJob.error } : null, merged: merged.map(m => ({ id: m.id, name: m.payload?.frontmatter?.name, status: m.payload?.status })),
      relations, statuses: state.methods.map(m => ({ name: m.payload?.frontmatter?.name, status: m.payload?.status, reason: m.payload?.statusReason ?? null })), noop: nonZero(state.counters?.consolidateNoop) };
    await atomic(`${u.dir}/verdict.json`, verdict);
    return verdict;
  }
  // Conversations as the script groups them; each run's follow-up is the next user turn of the same conversation.
  const groups = [];
  for (const [k, run] of script.runs.entries()) {
    const last = groups.at(-1);
    if (last && last.conversationId === run.conversationId) last.ks.push(k); else groups.push({ conversationId: run.conversationId, ks: [k] });
  }
  const records = [];
  for (const [g, group] of groups.entries()) {
    const texts = group.ks.flatMap(k => [script.runs[k].request, script.runs[k].followUp]);
    const name = `conv-${group.conversationId}`;
    await u.conversation(name, { api, userId, projectId, first: texts[0], next: (_t, i) => texts[i + 1] ?? null, maxTurns: texts.length });
    records.push({ label: group.conversationId, record: await u.record(name), roles: texts.map((_, i) => (i % 2 ? 'followUp' : 'request')), ks: group.ks });
    await u.drain(`drain-${group.conversationId}`, userId, {});
  }
  if (script.ring === 'sleep') await u.drain('sleep', userId, { sleepKey: `lx-${id}-${u.p.attempt}-sleep` });
  let amend = null;
  if (script.ring === 'replay') {
    amend = await u.step('amend', () => ipc(ctx.h, 'lxAmend', { userId, methodId: seeded[0].id, body: script.method.after }));
    await u.drain('drain-amend', userId, {});
  }
  // One more same-kind conversation: is the learnt method mounted, opened and counted? (the scripted runs alone end where it is born)
  const probeTexts = [script.runs[0].request, ACCEPTS[0]];
  await u.conversation('conv-probe', { api, userId, projectId, first: probeTexts[0], next: (_t, i) => probeTexts[i + 1] ?? null, maxTurns: 2 });
  records.push({ label: 'probe', record: await u.record('conv-probe'), roles: ['request', 'followUp'] });
  await u.drain('drain-probe', userId, {});
  const state = await ipc(ctx.h, 'lxState', { userId });
  await atomic(`${u.dir}/state-final.json`, state);
  const usage = await ipc(ctx.h, 'usage', { userId });
  const runs = [];
  for (const r of records.filter(r => r.ks)) r.ks.forEach((k, j) => { const t = r.record.turns[2 * j]; runs.push({ k, runId: t?.runId ?? null, status: t?.run?.status ?? (t?.error ? 'dispatch_error' : 'missing'), followUpRunId: r.record.turns[2 * j + 1]?.runId ?? null }); });
  runs.sort((a, b) => a.k - b.k);
  const approvedSeen = new Set(Object.values(u.p.steps).flatMap(s => s?.approved ?? []));
  const verdict = { id, ring: script.ring, ...l1Ring({ ring: script.ring, gold, runs, turns: labelledTurns(records), state, seeded, amend, approvedSeen, sleepJobKey: script.ring === 'sleep' ? `consolidate:sleep:eval:lx-${id}-${u.p.attempt}-sleep` : null }),
    runs, attempt: u.p.attempt, interrupted: u.p.interrupted ?? [], counters: nonZero(state.counters), usage };
  await atomic(`${u.dir}/verdict.json`, verdict);
  return verdict;
}

// ---------- L10 ----------
async function l10Unit(ctx, family) {
  const u = await new Unit(ctx, family.id).load();
  if (fsSync.existsSync(`${u.dir}/verdict.json`)) return readJson(`${u.dir}/verdict.json`);
  const { api, userId } = await u.account();
  const projectId = `lx-${family.id.toLowerCase()}-${u.p.attempt}`;
  const plan = [...family.requests.map((text, index) => ({ kind: 'same', index, text })), ...family.lookalikes.map((text, index) => ({ kind: 'lookalike', index, text })),
    { kind: 'probe', index: 0, text: family.requests[0] }];
  const runs = [];
  for (const [n, item] of plan.entries()) {
    const name = `conv-${item.kind}${item.index + 1}`;
    const texts = [item.text, ACCEPTS[n % ACCEPTS.length]];
    await u.conversation(name, { api, userId, projectId, first: texts[0], next: (_t, i) => texts[i + 1] ?? null, maxTurns: 2 });
    await u.drain(`drain-${item.kind}${item.index + 1}`, userId, {});
    const record = await u.record(name);
    const t = record.turns[0];
    runs.push({ ...item, runId: t?.runId, status: t?.run?.status, chain: toolChainOf(t), turn: t });
  }
  const state = await ipc(ctx.h, 'lxState', { userId });
  await atomic(`${u.dir}/state-final.json`, state);
  const usage = await ipc(ctx.h, 'usage', { userId });
  for (const r of runs) r.verdict = followUpOf(state, r.runId)?.verdict ?? null;
  const routineMethods = state.jobs.filter(j => j.kind === 'distill' && j.payload?.trigger === 'routine' && j.result?.methodId).map(j => methodById(state, j.result.methodId)).filter(Boolean);
  const probe = runs.find(r => r.kind === 'probe');
  const probeMount = routineMethods.map(m => ({ name: m.payload?.frontmatter?.name, ...mountOf(probe?.turn, m), counts: countsOf(m) }));
  const verdict = { ...l10Family({ family, runs: runs.map(({ turn, ...r }) => r), state, toolchainOn: ctx.arm === 'tc-on', probeMount }),
    statuses: runs.map(r => `${r.kind}${r.index + 1}:${r.status}`), attempt: u.p.attempt, counters: nonZero(state.counters), usage };
  await atomic(`${u.dir}/verdict.json`, verdict);
  return verdict;
}

// ---------- L5 ----------
async function l5Unit(ctx, item, gold) {
  const u = await new Unit(ctx, item.id).load();
  if (fsSync.existsSync(`${u.dir}/verdict.json`)) return readJson(`${u.dir}/verdict.json`);
  const { api, userId } = await u.account();
  const projectId = `lx-${kebab(item.id, 'item')}-${u.p.attempt}`;
  const seed = await u.step('seed', async () => {
    const r = await api.call('POST', '/api/methods', { skill: skillOf(item.method) });
    if (r.status !== 201) throw new Error(`seed method: ${r.status} ${r.raw.slice(0, 200)}`);
    return { id: r.json.data.id, status: r.json.data.status, name: r.json.data.name };
  });
  const snapshots = [], verdicts = [], mounts = [];
  for (const [t, task] of item.tasks.entries()) {
    const name = `conv-task${t + 1}`;
    const texts = [task, item.followUp];
    await u.conversation(name, { api, userId, projectId, first: texts[0], next: (_t, i) => texts[i + 1] ?? null, maxTurns: 2 });
    const d = await u.drain(`drain-task${t + 1}`, userId, { sleepKey: `lx-${item.id}-${u.p.attempt}-t${t + 1}` });
    const state = await readJson(`${u.dir}/state-drain-task${t + 1}.json`);
    const m = methodById(state, seed.id);
    snapshots.push({ afterTask: t + 1, status: m?.payload?.status ?? 'missing', statusReason: m?.payload?.statusReason ?? null, counts: countsOf(m), jobs: d.byStatus });
    const record = await u.record(name);
    verdicts.push(followUpOf(state, record.turns[0]?.runId)?.verdict ?? null);
    mounts.push({ task: t + 1, status: record.turns[0]?.run?.status, route: record.turns[0]?.run?.effectiveAgentId, ...mountOf(record.turns[0], m) });
  }
  const state = await ipc(ctx.h, 'lxState', { userId });
  await atomic(`${u.dir}/state-final.json`, state);
  const usage = await ipc(ctx.h, 'usage', { userId });
  const verdict = { ...l5Item({ item, gold, snapshots, verdicts, mounts, state, methodId: seed.id }), attempt: u.p.attempt, counters: nonZero(state.counters), usage,
    attribution: 'Today\'s rule only (a correction counts against a method the judge names in `concerns`, else unattributed); the TARA-style per-turn rule is not built.' };
  await atomic(`${u.dir}/verdict.json`, verdict);
  return verdict;
}

// ---------- L2 ----------
async function l2Unit(ctx, person, gold) {
  const u = await new Unit(ctx, person.id, { restartable: false }).load();
  if (fsSync.existsSync(`${u.dir}/verdict.json`)) return readJson(`${u.dir}/verdict.json`);
  const { api, userId } = await u.account();
  const projectA = `lx-${person.id.toLowerCase()}-a`, projectB = `lx-${person.id.toLowerCase()}-b`;
  const arm = ctx.arm;
  const sessions = [];
  const prior = [];
  for (const [i, request] of person.sessions.entries()) {
    const checks = gold.sessions[i].checks;
    const name = `conv-s${String(i + 1).padStart(2, '0')}`;
    const sent = [];
    const step = await u.conversation(name, { api, userId, projectId: projectA, projectName: person.projectA.title, first: request, maxTurns: 4,
      next: turn => {
        const c = correctionFor(person, checks, turn.reply, [...prior, ...sent]);
        if (!c) return null;
        sent.push(c.ruleId);
        return c.line;
      } });
    const record = await u.record(name);
    // Re-derive the corrections from the record (the decision is code over the stored replies, so a resume reads the same).
    const corrections = [], perTurn = [];
    const seen = [...prior];
    for (const [k, t] of record.turns.entries()) {
      perTurn.push(ruleResults(checks, t.reply));
      if (k + 1 < record.turns.length) { const c = correctionFor(person, checks, t.reply, seen); if (c) { corrections.push(c); seen.push(c.ruleId); } }
    }
    prior.splice(0, prior.length, ...seen);
    sessions.push({ index: i, first: perTurn[0] ?? [], final: perTurn.at(-1) ?? [], corrections, turns: record.turns.length, runs: step.runs });
    const learning = arm === 'frozen' && i >= 6 ? null : arm;
    if (learning) await u.drain(`drain-s${String(i + 1).padStart(2, '0')}`, userId, { consolidate: arm !== 'add-only', sleepKey: arm !== 'add-only' ? `lx-${person.id}-${arm}-s${i + 1}` : null });
  }
  const frozen = [];
  for (const [i, request] of person.frozen.entries()) {
    const name = `conv-f${i + 1}`;
    await u.conversation(name, { api, userId, projectId: projectA, projectName: person.projectA.title, first: request, next: () => null, maxTurns: 1 });
    const record = await u.record(name);
    frozen.push({ index: i, results: ruleResults(gold.frozen[i].checks, record.turns[0]?.reply), status: record.turns[0]?.run?.status });
  }
  const probes = [];
  for (const [i, request] of person.probes.entries()) {
    const name = `conv-p${i + 1}`;
    await u.conversation(name, { api, userId, projectId: projectB, projectName: person.projectB.title, first: request, next: () => null, maxTurns: 1 });
    const record = await u.record(name);
    probes.push({ index: i, status: record.turns[0]?.run?.status, results: gold.probes[i].leakChecks.map(c => ({ ruleId: c.ruleId, kind: c.check.kind, unnatural: c.unnatural, pass: ruleResults([c], record.turns[0]?.reply)[0].pass })) });
  }
  const state = await ipc(ctx.h, 'lxState', { userId });
  await atomic(`${u.dir}/state-final.json`, state);
  const verdict = { id: person.id, arm, ...l2Summary({ sessions, frozen, probes }), sessionsDetail: sessions, frozen, probes, interrupted: u.p.interrupted ?? [],
    methods: state.methods.map(m => ({ name: m.payload?.frontmatter?.name, status: m.payload?.status, counts: countsOf(m), trigger: m.payload?.provenance?.trigger ?? null })),
    lessons: state.jobs.filter(j => j.kind === 'distill').map(j => ({ trigger: j.payload?.trigger, status: j.status, operation: j.result?.operation ?? null })),
    verdictsRecorded: state.events.filter(e => e.detail?.evidence === 'follow-up').map(e => e.detail.verdict), counters: nonZero(state.counters),
    usage: await ipc(ctx.h, 'usage', { userId }) };
  await atomic(`${u.dir}/verdict.json`, verdict);
  return verdict;
}

// ---------- summary and ledger ----------
export function summarizeExp(exp, arm, verdicts) {
  if (exp === 'l1') {
    const rings = verdicts.filter(v => v.links);
    const links = rings.flatMap(v => Object.values(v.links).filter(l => l.expected));
    const reached = links.filter(l => l.reached === true).length;
    return { exp, arm, rings: rings.length, fullyLit: rings.filter(v => !v.firstBroken).length, expectedLinks: links.length, reachedLinks: reached,
      table: rings.map(v => ({ ring: v.ring, firstBroken: v.firstBroken, links: Object.fromEntries(Object.entries(v.links).map(([k, l]) => [k, l.expected ? (l.reached ? 'Y' : 'N') : '-'])) })),
      seededSleep: verdicts.filter(v => v.ring === 'sleep(seeded)').map(v => ({ consolidated: v.consolidated, sleepJob: v.sleepJob?.status, relations: v.relations })) };
  }
  if (exp === 'l10') return { exp, arm, families: verdicts.length, exact: verdicts.filter(v => v.exact).length, routinesLearned: verdicts.reduce((n, v) => n + v.routinesLearned, 0),
    falseRoutines: verdicts.filter(v => v.falseRoutine).length, chainChanged: verdicts.filter(v => v.chainChanged).length,
    table: verdicts.map(v => ({ family: v.family, lessons: v.lessons, learned: v.routinesLearned, expected: v.expectedRoutines, falseRoutine: v.falseRoutine, chainBefore: v.chainBefore, chainAfter: v.chainAfter })) };
  if (exp === 'l5') {
    const bad = verdicts.filter(v => v.shouldStop), good = verdicts.filter(v => !v.shouldStop);
    return { exp, arm, items: verdicts.length, badStopped: bad.filter(v => v.stopped).length, bad: bad.length, goodFalseStops: good.filter(v => v.falseStop).length, good: good.length,
      table: verdicts.map(v => ({ id: v.id, class: v.class, shouldStop: v.shouldStop, stopped: v.stopped, after: v.stoppedAfterTask, final: v.finalStatus, verdicts: v.verdicts.join(','), counts: `clean=${v.counts.appliedClean ?? 0} corrected=${v.counts.appliedCorrected ?? 0} invoked=${v.counts.invoked ?? 0}` })) };
  }
  return { exp, arm, people: verdicts.length, table: verdicts.map(v => ({ id: v.id, corrections: v.correctionsPerSession, firstTimeRight: v.firstTimeRight, frozenCompliance: v.frozenCompliance, probeLeaks: v.probeLeaks.length, probePositiveChecks: v.probePositiveChecks })) };
}

export function ledgerRows(sum, { runId, commit, flags, rawPath, wallSeconds, tokens }) {
  const base = { runId, commit, engine: { version: 'ovlab-pp', templatesDigest: 'ovlab-pp-same-as-ovlab' }, arm: sum.arm, flags, set: sum.exp, split: 'dev', scorer: SCORER, rawPath,
    tokens: { prompt: tokens.prompt, completion: tokens.completion, cached: tokens.cached, extractionPrompt: 0, extractionCompletion: 0 }, costCny: tokens.costCny ?? null, wallSeconds, ci95: null };
  const row = (metric, n, value, notes) => ({ ...base, metric, n, value, judged: { code: n, judge: 0, unknown: 0, error: 0 }, notes, at: new Date().toISOString() });
  if (sum.exp === 'l1') return [row('rings_fully_lit', sum.rings, sum.rings ? sum.fullyLit / sum.rings : 0, 'rings with no expected link broken (product records)'),
    row('link_conversion', sum.expectedLinks, sum.expectedLinks ? sum.reachedLinks / sum.expectedLinks : 0, 'expected loop links reached / expected')];
  if (sum.exp === 'l10') return [row('families_exact_routines', sum.families, sum.families ? sum.exact / sum.families : 0, 'exactly the expected routines (1 on, 0 off) and no look-alike folded in'),
    row('false_routines', sum.families, sum.falseRoutines, 'families where a look-alike run was part of a routine lesson')];
  if (sum.exp === 'l5') return [row('bad_methods_stopped', sum.bad, sum.bad ? sum.badStopped / sum.bad : 0, 'harmful/outdated/safety-conflict methods not approved after the 4 tasks'),
    row('good_methods_false_stopped', sum.good, sum.good ? sum.goodFalseStops / sum.good : 0, 'good methods stopped')];
  return sum.table.flatMap(p => [row('first_time_right', 12, p.firstTimeRight ?? 0, `person ${p.id}`), row('corrections_total', 12, p.corrections.reduce((a, b) => a + b, 0), `person ${p.id}; per session ${p.corrections.join(',')}`),
    row('frozen_compliance', 9, p.frozenCompliance ?? 0, `person ${p.id}; 3 frozen tasks x 3 rules`), row('probe_leaks', p.probePositiveChecks, p.probeLeaks, `person ${p.id}; positive-form rule satisfied where unnatural (project B)`)]);
}

function markdown(sum) {
  const lines = [`# LX ${sum.exp} ${sum.arm}`, '', '```', JSON.stringify(sum, null, 1), '```'];
  return lines.join('\n');
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const env = armEnv(args.exp, args.arm);
  Object.assign(process.env, env, { EVAL_CONTROL_EXTRA: path.join(HERE, 'lx-control.mjs') });
  const outDir = path.resolve(args.out ?? `/srv/evimed/runs/lx-${args.exp}-${args.arm}-1`);
  await fs.mkdir(outDir, { recursive: true });
  const status = message => {
    const line = `${new Date().toISOString()} LX ${args.exp} ${args.arm} ${message}\n`;
    process.stdout.write(line); fsSync.appendFileSync(`${outDir}/STATUS`, line);
    if (process.env.LX_STATUS_FILE) fsSync.appendFileSync(process.env.LX_STATUS_FILE, line);
  };
  const data = devDir(args.data, args.exp);
  const treeOs = path.resolve(args.tree ?? OS);
  const commit = process.env.EVAL_TREE_COMMIT || spawnSync('git', ['-C', treeOs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown';
  // The data, as the generators wrote it (inputs = what a run sees; gold / persons = what code checks against).
  let units;
  if (args.exp === 'l1') {
    const inputs = JSON.parse(await fs.readFile(`${data}/inputs.json`, 'utf8')).scripts;
    const gold = JSON.parse(await fs.readFile(`${data}/gold.json`, 'utf8')).scripts;
    const order = ['correction', 'adopt', 'routine_file', 'routine_toolchain', 'script', 'replay', 'sleep'];
    units = inputs.sort((a, b) => order.indexOf(a.ring) - order.indexOf(b.ring)).map(s => ({ id: s.id, run: ctx => l1Unit(ctx, s, gold.find(g => g.id === s.id)) }));
    const sleepScript = inputs.find(s => s.ring === 'sleep');
    if (sleepScript) units.push({ id: `${sleepScript.id}-seeded`, run: ctx => l1Unit(ctx, sleepScript, gold.find(g => g.id === sleepScript.id), { seededSleep: true }) });
  } else if (args.exp === 'l10') {
    units = JSON.parse(await fs.readFile(`${data}/inputs.json`, 'utf8')).families.map(f => ({ id: f.id, run: ctx => l10Unit(ctx, f) }));
  } else if (args.exp === 'l5') {
    const items = JSON.parse(await fs.readFile(`${data}/inputs.json`, 'utf8')).items;
    const gold = JSON.parse(await fs.readFile(`${data}/gold.json`, 'utf8')).items;
    units = items.map(item => ({ id: item.id, run: ctx => l5Unit(ctx, item, gold.find(g => g.id === item.id)) }));
  } else {
    const persons = JSON.parse(await fs.readFile(`${data}/persons.json`, 'utf8')).persons;
    const gold = JSON.parse(await fs.readFile(`${data}/gold.json`, 'utf8')).people;
    units = persons.map(p => ({ id: p.id, run: ctx => l2Unit(ctx, p, gold.find(g => g.id === p.id)) }));
  }
  // A unit list for a whole experiment can be set without restarting a running plan: <runs>/lx-units-<exp>.txt (comma-separated ids).
  const unitsFile = path.join(path.dirname(outDir), `lx-units-${args.exp}.txt`);
  if (!args.units && fsSync.existsSync(unitsFile)) args.units = fsSync.readFileSync(unitsFile, 'utf8').trim();
  if (args.units) { const want = args.units.split(','); units = units.filter(u => want.includes(u.id)); }
  const finish = async () => {
    const verdicts = [];
    for (const u of units) { const v = await readJson(`${outDir}/units/${u.id}/verdict.json`); if (v) verdicts.push(v); }
    const sum = summarizeExp(args.exp, args.arm, verdicts);
    await atomic(`${outDir}/summary.json`, { ...sum, complete: verdicts.length === units.length, units: units.length });
    await fs.writeFile(`${outDir}/summary.md`, markdown(sum));
    return { sum, done: verdicts.length === units.length };
  };
  if (args.summarizeOnly) { await finish(); return; }
  const dbName = `evimed_test_${path.basename(outDir).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);
  await ensurePostgres(args.pgPort); await ensureDatabase(args.pgPort, dbName);
  const live = process.env.EVAL_LIVE_DIR ?? '/tmp/eval/live';
  const seed = spawnSync('bash', [`${SUITE}/runner/seed.sh`], { encoding: 'utf8', env: { ...process.env, OS: treeOs, L: live, SEED_FROM: args.seedFrom ?? '/srv/evimed/pp/seed/dsh-seed' }, maxBuffer: 16 * 1024 * 1024 });
  process.stderr.write(seed.stderr ?? '');
  if (seed.status !== 0) throw new Error('seed failed');
  const treeDir = seed.stdout.trim().split('\n').pop();
  const dataDir = path.resolve(args.dataDir ?? `/srv/evimed/pp/data/${path.basename(outDir)}`);
  const prior = await readJson(`${outDir}/run.json`, {});
  await atomic(`${outDir}/run.json`, { attempts: [...(prior.attempts ?? []), { at: new Date().toISOString(), commit, args }], exp: args.exp, arm: args.arm, tree: { path: treeOs, commit }, env, data,
    scorer: SCORER, followUpsForAccept: ACCEPTS, notes: ['attended turns (never automated)', 'worker runs only in drains; queued learning jobs brought forward (no wall-clock wait)', 'harness IPC writes: lxAmend (L1 replay ring only), sleep jobs through ProductJobs'] });
  let h;
  const shutdown = async () => { if (h) { const old = h; h = null; await stopHarness(old); } };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await shutdown(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); });
  const t0 = Date.now();
  try {
    h = await startHarness({ args, treeOs, treeDir, dataDir, profile: 'normal', arm: 'B', dbUrl: `postgresql://coder@127.0.0.1:${args.pgPort}/${dbName}` });
    const facts = await ipc(h, 'facts');
    await atomic(`${outDir}/engine-facts.json`, facts);
    if (process.env.OPEN_SCIENCE_OPENVIKING_URL && !facts.nativeMemory?.ok) throw new Error(`Native memory engine is unavailable: ${JSON.stringify(facts.nativeMemory)}`);
    status(`harness ready pid=${h.pid} port=${args.port} db=${dbName} units=${units.map(u => u.id).join(',')}`);
    const ctx = { args, exp: args.exp, arm: args.arm, outDir, dataDir, status, h };
    for (const unit of units) {
      const v = await unit.run(ctx);
      status(`${unit.id} verdict ${JSON.stringify(v.firstBroken !== undefined ? { firstBroken: v.firstBroken } : v.exact !== undefined ? { learned: v.routinesLearned, falseRoutine: v.falseRoutine } : v.stopped !== undefined ? { stopped: v.stopped, after: v.stoppedAfterTask } : { firstTimeRight: v.firstTimeRight, corrections: v.totalCorrections })}`);
    }
    const { sum, done } = await finish();
    if (done) {
      const tokens = { prompt: 0, completion: 0, cached: 0, costCny: 0 };
      for (const u of units) {
        const a = (await readJson(`${outDir}/units/${u.id}/verdict.json`))?.usage?.account;
        if (!a) continue;
        tokens.prompt += (a.cacheHitTokens ?? 0) + (a.cacheMissTokens ?? 0); tokens.cached += a.cacheHitTokens ?? 0; tokens.completion += a.outputTokens ?? 0; tokens.costCny += a.actualCost ?? 0;
      }
      const rows = ledgerRows(sum, { runId: `lx-${args.exp}-${args.arm}-1`, commit, flags: { lane: 'LX', exp: args.exp, arm: args.arm, toolchain: env.OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED === 'true', addOnly: env.EVAL_ADD_ONLY === '1', automated: false },
        rawPath: outDir, wallSeconds: (Date.now() - t0) / 1000, tokens });
      await atomic(`${outDir}/ledger-rows.json`, rows);
      status(`complete; ledger rows in ${outDir}/ledger-rows.json`);
    }
  } finally { await shutdown(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exit(1); });
