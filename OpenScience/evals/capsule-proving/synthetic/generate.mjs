#!/usr/bin/env node
/**
 * Generate synthetic long-term users: skeleton (generator model) → schedule (code) → conversations (generator model, checked
 * by code) → runtime input, gold, planted errors. Every step writes its own file and is skipped when that file exists, so a
 * rerun continues where an interruption stopped; each finished step is appended to `<out>/STATUS`.
 *
 *   node synthetic/generate.mjs --out DIR --split dev --users U01,U02 [--sessions 200] [--kind auto|general|medical]
 *                               [--concurrency 3] [--seed capsule-synth-v1] [--reassemble]
 *
 * `--split sealed` prints counts only: a sealed user's questions are not shown to whoever writes the templates.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { GENERATOR, KIMI_MODEL, callKimi } from './kimi.mjs';
import { personaSeed, renderPrompt, repairPrompt, skeletonPrompt } from './prompts.mjs';
import { DEFAULT_SESSIONS, INPUT_SCHEMA, anchorWindows, batches, buildCorruptions, buildGold, renderProblems, rng, schedule, skeletonProblems } from './spec.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : a), []));
const out = args.out ?? (() => { throw new Error('--out required'); })();
const split = args.split ?? 'dev';
const sessionsArg = args.sessions ? Number(args.sessions) : null;
const seedBase = args.seed ?? 'capsule-synth-v1';
const concurrency = Number(args.concurrency ?? 3);
const users = String(args.users ?? 'U01').split(',');
const sealed = split === 'sealed';
const root = join(out, split);
mkdirSync(root, { recursive: true });

const sha = (t) => createHash('sha256').update(t).digest('hex');
const now = () => new Date().toISOString();
const status = (line) => appendFileSync(join(out, 'STATUS'), `${now()} ${split} ${line}\n`);
const say = (line) => { process.stdout.write(`${now()} ${line}\n`); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => { const t = `${JSON.stringify(v, null, 1)}\n`; writeFileSync(p, t); if (readFileSync(p, 'utf8').length !== t.length) throw new Error(`short write ${p}`); };

/** Every third user is medical-heavy unless told otherwise (≈30%); `M` users (M01…) are multi-patient carers or clinicians; `P` users carry one medical research project. */
const kindOf = (uid) => args.kind && args.kind !== 'auto' ? args.kind : uid.startsWith('M') ? 'multipatient' : uid.startsWith('P') ? 'medproject' : (Number(uid.replace(/\D/g, '')) % 3 === 0 ? 'medical' : 'general');

async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); } }));
  return results;
}

async function skeletonFor(uid, dir) {
  const file = join(dir, 'skeleton.json');
  if (existsSync(file)) return readJson(file);
  const kind = kindOf(uid);
  const seed = personaSeed(rng(`${seedBase}:${uid}:persona`), kind, Number(uid.replace(/\D/g, '')) - 1);
  let problems = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await callKimi(skeletonPrompt(seed, problems));
    if (!r.ok) { problems = [`output unusable: ${r.error}`]; say(`${uid} skeleton attempt ${attempt}: ${r.error}`); continue; }
    problems = skeletonProblems(r.value, kind);
    say(`${uid} skeleton attempt ${attempt}: ${problems.length} problems (${Math.round(r.ms / 1000)} s)`);
    if (!problems.length) {
      const doc = { schema: 'capsule-proving-synthetic-skeleton/1', userId: uid, kind, seed, generator: GENERATOR, ...r.value };
      writeJson(file, doc);
      status(`DONE ${uid} skeleton (${kind}, attempt ${attempt})`);
      return doc;
    }
  }
  writeJson(join(dir, 'skeleton.problems.json'), problems);
  throw new Error(`${uid}: skeleton still has ${problems.length} problems after 4 attempts`);
}

function scheduleFor(uid, dir, skel) {
  const file = join(dir, 'schedule.json');
  if (existsSync(file)) return readJson(file);
  const r = rng(`${seedBase}:${uid}:dates`);
  const month = 3 + Math.floor(r() * 3);
  const sessions = sessionsArg ?? DEFAULT_SESSIONS[skel.kind];
  const span = skel.kind === 'multipatient' ? 30 + Math.floor(r() * 30) : skel.kind === 'medproject' ? 60 + Math.floor(r() * 90) : 90 + Math.floor(r() * 90);
  const sched = schedule(skel, { seed: `${seedBase}:${uid}:schedule`, sessions, startDate: `2026-0${month}-0${1 + Math.floor(r() * 8)}`, spanDays: span });
  writeJson(file, sched);
  status(`DONE ${uid} schedule (${sessions} sessions, ${sched.checkpoints.length} checkpoints)`);
  return sched;
}

async function renderFor(uid, dir, skel, sched) {
  const rdir = join(dir, 'render');
  mkdirSync(rdir, { recursive: true });
  const windows = anchorWindows(skel, sched.events);
  const groups = batches(sched.sessions, 8);
  const failed = [];
  await pool(groups, concurrency, async (group, k) => {
    const name = `b${String(k).padStart(3, '0')}`;
    const file = join(rdir, `${name}.json`);
    const partial = join(rdir, `${name}.partial.json`);
    if (existsSync(file)) return;
    // The last attempt's text survives a restart, so a rerun repairs it instead of starting the batch over.
    let last = existsSync(partial) ? readJson(partial).sessions : null;
    let problems = last ? renderProblems(group, { sessions: last }, { firstSessionOf: windows }) : {};
    for (let attempt = 1; attempt <= 6; attempt++) {
      const bad = Object.keys(problems);
      // A few failing sessions are edited in place; many, or nothing usable yet, re-render the batch with the problems named.
      const repair = last && bad.length > 0 && bad.length <= 3;
      const targets = repair ? group.filter((s) => bad.includes(s.id)) : group;
      const r = await callKimi(repair ? repairPrompt(skel, targets, last, problems) : renderPrompt(skel, group, problems));
      if (!r.ok) { say(`${uid} b${k} attempt ${attempt}${repair ? ' (repair)' : ''}: ${r.error}`); continue; }
      const got = new Map((r.value?.sessions ?? []).map((x) => [x?.id, x]));
      const prev = new Map((last ?? []).map((x) => [x?.id, x]));
      const merged = repair ? group.map((s) => got.get(s.id) ?? prev.get(s.id)).filter(Boolean) : r.value?.sessions;
      if (!Array.isArray(merged)) { say(`${uid} b${k} attempt ${attempt}: no sessions array`); continue; }
      problems = renderProblems(group, { sessions: merged }, { firstSessionOf: windows });
      const n = Object.keys(problems).length;
      say(`${uid} b${k} attempt ${attempt}${repair ? ` (repair ${targets.length})` : ''}: ${n} sessions with problems (${Math.round(r.ms / 1000)} s)`);
      if (!n) {
        writeJson(file, { batch: k, attempt, repaired: Boolean(repair), generator: GENERATOR, sessions: merged });
        for (const stale of [partial, join(rdir, `${name}.problems.json`)]) rmSync(stale, { force: true });
        status(`DONE ${uid} render b${k}`);
        return;
      }
      last = merged;
      writeJson(partial, { batch: k, attempt, sessions: merged });
    }
    failed.push({ batch: k, problems });
    writeJson(join(rdir, `${name}.problems.json`), problems);
  });
  if (failed.length) throw new Error(`${uid}: ${failed.length} batches still failing`);
}

function assemble(uid, dir, skel, sched) {
  const rendered = new Map();
  for (const [k] of batches(sched.sessions, 8).entries()) for (const s of readJson(join(dir, 'render', `b${String(k).padStart(3, '0')}.json`)).sessions) rendered.set(s.id, s);
  const gold = buildGold(uid, skel, sched);
  const input = {
    schema: INPUT_SCHEMA, benchmark: 'synthetic-users', userId: uid, split, kind: skel.kind,
    // Runtime input: conversations in order, and each question with the checkpoint after which it is asked. No answer, plant id or category.
    sessions: sched.sessions.map((s) => ({ sourceSessionId: s.id, at: s.at, messages: rendered.get(s.id).messages.map((m) => ({ role: m.role, text: m.text })) })),
    questions: gold.questions.map((q) => ({ qid: q.qid, afterSession: q.checkpoint, asOf: q.asOf, text: q.question })),
  };
  const corruptions = buildCorruptions(uid, skel, sched, { seed: seedBase });
  writeJson(join(dir, 'input.json'), input);
  writeJson(join(dir, 'gold.json'), gold);
  writeJson(join(dir, 'corruptions.json'), { schema: 'capsule-proving-synthetic-corruptions/1', userId: uid, corruptions });
  const files = ['skeleton.json', 'schedule.json', 'input.json', 'gold.json', 'corruptions.json'];
  // Batches written before the generator was recorded are Kimi's (the only generator until 2026-11-09 08:43Z).
  const generators = [...new Set([skel.generator ?? 'kimi-code-cli:kimi-code/k3.1-pro', ...batches(sched.sessions, 8).map((_, k) => readJson(join(dir, 'render', `b${String(k).padStart(3, '0')}.json`)).generator ?? 'kimi-code-cli:kimi-code/k3.1-pro')])];
  const manifest = { userId: uid, split, kind: skel.kind, generators, sessions: input.sessions.length, messages: input.sessions.reduce((n, s) => n + s.messages.length, 0),
    chars: input.sessions.reduce((n, s) => n + s.messages.reduce((m, x) => m + x.text.length, 0), 0), questions: gold.questions.length,
    codeDecidable: gold.questions.filter((q) => !q.expect.judge).length, storeChecks: gold.store.length, corruptions: corruptions.length,
    sha256: Object.fromEntries(files.map((f) => [f, sha(readFileSync(join(dir, f)))])) };
  writeJson(join(dir, 'manifest.json'), manifest);
  status(`DONE ${uid} assemble (${manifest.questions} questions, ${manifest.corruptions} corruptions)`);
  return manifest;
}

for (const uid of users) {
  const dir = join(root, uid);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'manifest.json'))) {
    // `--reassemble` rebuilds gold, corruptions and the manifest of a finished user from its skeleton, schedule and rendered
    // batches (no generator call), after a change to how gold is derived.
    if (args.reassemble === 'true') { const skel = readJson(join(dir, 'skeleton.json')); assemble(uid, dir, skel, readJson(join(dir, 'schedule.json'))); say(`${uid} reassembled`); }
    else say(`${uid} already assembled`);
    continue;
  }
  try {
    const skel = await skeletonFor(uid, dir);
    const sched = scheduleFor(uid, dir, skel);
    await renderFor(uid, dir, skel, sched);
    const m = assemble(uid, dir, skel, sched);
    say(sealed ? `${uid} sealed: ${m.sessions} sessions, ${m.questions} questions, ${m.corruptions} corruptions` : `${uid} ${JSON.stringify({ ...m, sha256: undefined })}`);
  } catch (e) {
    status(`FAIL ${uid} ${e.message}`);
    say(`${uid} FAILED: ${e.message}`);
    process.exitCode = 1;
  }
}
