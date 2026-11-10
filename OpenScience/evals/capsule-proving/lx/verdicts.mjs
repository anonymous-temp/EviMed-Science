// Code verdicts for the LX learning-loop experiments, from the product's own records only: the learning-evidence rows
// (feedback_events), the learning jobs (distill / consolidate / learning-evidence), the method documents (status, counters,
// relations, provenance), the mounted-method selection each turn wrote and the product's read-only method observer.
// Pure: no I/O. Every link names the record that decided it.
import { checkReply } from '../synthetic/taskChecks.mjs';
import { learnedDirectory } from './conversation.mjs';

export const CORRECTION_CLASS = ['correction', 'preference', 'rejection'];
export const CLEAN_CLASS = ['accept', 'adopt'];
const RING_TRIGGER = { correction: 'correction', adopt: 'adopted', routine_file: 'routine', routine_toolchain: 'routine', script: 'script', sleep: 'adopted', replay: null };
export const L1_LINKS = ['delivered', 'verdict', 'evidence', 'lesson', 'distill', 'approved', 'mounted', 'opened', 'counted', 'consolidated', 'demoted'];

const clip = (value, n = 220) => { const s = typeof value === 'string' ? value : JSON.stringify(value); return s && s.length > n ? `${s.slice(0, n)}…` : s; };
const verdictMatches = (actual, expected) => actual === expected || (expected === 'correction' && CORRECTION_CLASS.includes(actual));
const time = value => Date.parse(String(value ?? '')) || 0;

/** The learning-evidence rows of one run. @param {any} state @param {string} runId */
export const evidenceOf = (state, runId) => (state?.events ?? []).filter(e => e.trigger_kind === 'learning-evidence' && e.run_id === runId);
/** The follow-up verdict recorded for one run, or null. */
export function followUpOf(state, runId) {
  const row = evidenceOf(state, runId).find(e => e.detail?.evidence === 'follow-up');
  return row ? { verdict: row.detail.verdict, rule: row.detail.rule ?? null, quote: row.detail.quote ?? null, shape: row.detail.shape ?? null, toolchain: row.detail.toolchain ?? null, id: row.id } : null;
}
export const settleJobOf = (state, runId) => (state?.jobs ?? []).find(j => j.kind === 'learning-evidence' && j.payload?.runId === runId) ?? null;
/** Distill jobs whose lesson came from one of these runs (the job's own run or its routine peers). */
export function distillJobsFor(state, runIds, trigger = null) {
  const ids = new Set(runIds);
  return (state?.jobs ?? []).filter(j => j.kind === 'distill' && (!trigger || j.payload?.trigger === trigger)
    && [j.payload?.runId, ...(j.payload?.sourceRunIds ?? []), ...(j.payload?.peers ?? []).map(p => p.runId)].some(id => ids.has(id)));
}
export const methodById = (state, id) => (state?.methods ?? []).find(m => m.id === id) ?? null;
export const countsOf = method => method?.payload?.learning?.counts ?? {};

/** Whether a method was put in front of a turn (selection file or the observer's loaded list) and whether the turn opened it. */
export function mountOf(turn, method) {
  const name = method?.payload?.frontmatter?.name;
  const dir = learnedDirectory(method?.id);
  const selected = (turn?.selection?.methods ?? []).some(m => m.directory === dir);
  const loaded = (turn?.methodObservation?.methodsLoaded ?? []).some(m => m.name === name);
  const opened = (turn?.methodObservation?.methodsInvoked ?? []).some(m => m.name === name);
  return { selected, loaded, opened, reason: (turn?.selection?.methods ?? []).find(m => m.directory === dir)?.reason ?? null };
}

/** The tool names of a turn in order, consecutive repeats folded. */
export const toolChainOf = turn => (turn?.tools ?? []).map(t => t.name).filter((name, i, all) => i === 0 || name !== all[i - 1]);

/**
 * L1: the conversion of one ring. `runs[k]` = { runId, followUpRunId, status, conversation, startedAt } for scripted run k;
 * `later` = turns of conversations that started after a method existed (with their start time); `seeded` / `amend` for the
 * replay ring; `state` is the final product state.
 */
export function l1Ring({ ring, gold, runs, turns, state, seeded = [], amend = null, sleepJobKey = null, approvedSeen = new Set() }) {
  const links = Object.fromEntries(L1_LINKS.map(name => [name, { expected: false, reached: null, evidence: '' }]));
  const set = (name, expected, reached, evidence) => { links[name] = { expected, reached, evidence: clip(evidence, 400) }; };
  const trigger = RING_TRIGGER[ring];
  const scripted = runs.map(r => r.runId).filter(Boolean);
  // 0. Every scripted run delivered (the follow-up judge reads only a run that succeeded).
  const bad = runs.filter(r => r.status !== 'succeeded');
  set('delivered', true, bad.length === 0, bad.length ? `runs not succeeded: ${bad.map(r => `#${r.k + 1}=${r.status}`).join(', ')}` : `${runs.length}/${runs.length} succeeded`);
  // 1. The follow-up verdict of every scripted run, against the code-assigned class.
  const verdicts = runs.map((r, k) => ({ k, expected: gold.verdicts[k], actual: followUpOf(state, r.runId)?.verdict ?? null }));
  const wrong = verdicts.filter(v => !verdictMatches(v.actual, v.expected));
  set('verdict', true, wrong.length === 0, verdicts.map(v => `#${v.k + 1} ${v.expected}->${v.actual ?? 'none'}`).join('; '));
  // 2. The evidence a lesson rests on: a learning-evidence row for every scripted run; routines also need the work's shape.
  const rows = runs.map(r => evidenceOf(state, r.runId));
  const missingRows = runs.filter((r, k) => !rows[k].length).map(r => r.k + 1);
  let evidenceOk = missingRows.length === 0;
  let evidenceNote = missingRows.length ? `no evidence row for runs ${missingRows.join(',')}` : `rows: ${rows.map(rs => rs.map(e => e.detail?.evidence).join('+')).join(' | ')}`;
  if (ring === 'routine_file' || ring === 'routine_toolchain') {
    const key = ring === 'routine_file' ? 'shape' : 'toolchain';
    const shaped = rows.map(rs => rs.find(e => Array.isArray(e.detail?.[key]) ? e.detail[key].length : e.detail?.[key]));
    evidenceOk = evidenceOk && shaped.every(Boolean);
    evidenceNote += `; ${key} on runs: ${shaped.map((e, k) => `#${k + 1}=${e ? clip(e.detail[key], 120) : 'none'}`).join(' ')}`;
    const settles = runs.map(r => settleJobOf(state, r.runId));
    evidenceNote += `; settle jobs: ${settles.map((j, k) => `#${k + 1}=${j ? `${j.status}:${clip(j.result, 120)}` : 'none'}`).join(' ')}`;
  }
  if (ring === 'script') evidenceNote += `; script counters: ${clip(state?.counters?.scripts)}`;
  set('evidence', true, evidenceOk, evidenceNote);
  // 3–5. The lesson (a distill job with the ring's trigger), what the distillation did, and the method's status.
  let methodIds = [];
  if (trigger) {
    const lessons = distillJobsFor(state, scripted, trigger);
    const others = distillJobsFor(state, scripted).filter(j => !lessons.includes(j));
    set('lesson', true, lessons.length > 0, lessons.length ? lessons.map(j => `${j.payload.trigger} from ${j.payload.runId} (${j.status})`).join('; ')
      : `no distill job with trigger ${trigger}${others.length ? `; other lessons: ${others.map(j => j.payload.trigger).join(',')}` : ''}; refusals=${clip(nonZero(state?.counters?.triggerRefused))}; evidenceFailed=${clip(nonZero(state?.counters?.evidenceFailed))}`);
    const done = lessons.filter(j => j.status === 'succeeded' && ['create', 'amend', 'merge'].includes(j.result?.operation) && j.result?.methodId);
    set('distill', true, done.length > 0, lessons.map(j => `${j.status} op=${j.result?.operation ?? '-'}${j.result?.skipped ? ` skipped=${j.result.skipped}` : ''}${j.error ? ` error=${clip(j.error, 160)}` : ''}`).join('; ') || 'no lesson');
    methodIds = [...new Set(done.map(j => j.result.methodId))];
  } else {
    set('lesson', false, null, 'ring seeds its method (no lesson expected)'); set('distill', false, null, 'n/a');
    methodIds = seeded.map(m => m.id);
  }
  if (ring === 'sleep') methodIds = [...new Set([...methodIds, ...(state?.methods ?? []).filter(m => m.payload?.provenance?.consolidatedBy).map(m => m.id)])];
  const methods = methodIds.map(id => methodById(state, id)).filter(Boolean);
  set('approved', true, methods.some(m => m.payload?.status === 'approved' || approvedSeen.has(m.id)),
    methods.length ? methods.map(m => `${m.payload?.frontmatter?.name}=${m.payload?.status}${approvedSeen.has(m.id) ? ' (approved at a snapshot)' : ''}${m.payload?.statusReason ? ` (${clip(m.payload.statusReason, 100)})` : ''}`).join('; ') : 'no method');
  // 6–8. Mounted in a later conversation, opened there, counted on the method record.
  const mountRows = [];
  for (const m of methods) {
    const born = ring === 'replay' ? 0 : time(m.created_at);
    for (const t of turns) if (time(t.conversationStartedAt) >= born && t.role === 'request') mountRows.push({ m, t, ...mountOf(t, m) });
  }
  const laterTurns = turns.filter(t => t.role === 'request' && methods.some(m => time(t.conversationStartedAt) >= (ring === 'replay' ? 0 : time(m.created_at))));
  set('mounted', methods.length > 0, mountRows.some(r => r.selected || r.loaded),
    !methods.length ? 'no method' : !laterTurns.length ? 'no conversation after the method existed' : mountRows.map(r => `${r.t.label}:${r.selected ? `selected(${r.reason})` : r.loaded ? 'loaded' : 'absent'}`).join(' '));
  set('opened', methods.length > 0, mountRows.some(r => r.opened), mountRows.length ? mountRows.map(r => `${r.t.label}:${r.opened ? 'opened' : '-'}`).join(' ') : 'not mounted');
  const counts = methods.map(m => ({ name: m.payload?.frontmatter?.name, ...countsOf(m) }));
  set('counted', methods.length > 0, counts.some(c => (c.loaded ?? 0) > 0 && (c.invoked ?? 0) > 0 && ((c.appliedClean ?? 0) + (c.appliedCorrected ?? 0)) > 0),
    counts.length ? counts.map(c => `${c.name}: loaded=${c.loaded ?? 0} invoked=${c.invoked ?? 0} clean=${c.appliedClean ?? 0} corrected=${c.appliedCorrected ?? 0} read=${c.read ?? 0} carried=${c.carried ?? 0}`).join('; ') : 'no method');
  // 9. Sleep ring: the two learnt methods consolidated into one (merge), by the sleep pass.
  if (ring === 'sleep') {
    const sleepJob = (state?.jobs ?? []).find(j => j.kind === 'consolidate' && j.payload?.action === 'sleep' && (!sleepJobKey || j.idempotency_key === sleepJobKey));
    const merged = (state?.methods ?? []).filter(m => m.payload?.provenance?.consolidatedBy);
    const superseded = (state?.methods ?? []).filter(m => (m.payload?.learning?.relations ?? []).some(r => r.type === 'supersedes'));
    const relations = (state?.methods ?? []).flatMap(m => (m.payload?.learning?.relations ?? []).map(r => `${m.payload?.frontmatter?.name}-${r.type}->${r.target}`));
    set('consolidated', true, merged.length > 0 || superseded.length > 0,
      `sleep job ${sleepJob ? `${sleepJob.status} result=${clip(sleepJob.result, 200)}` : 'none'}; merged=${merged.length}; superseded=${superseded.length}; relations=${relations.join(', ') || 'none'}; noop=${clip(nonZero(state?.counters?.consolidateNoop))}`);
  }
  // 10. Replay ring: the scripted amendment regresses what the person accepted and is rolled back.
  if (ring === 'replay') {
    const job = (state?.jobs ?? []).find(j => j.kind === 'consolidate' && j.payload?.action === 'replay' && j.payload?.digest === amend?.digest);
    const method = methods[0];
    const back = Boolean(method && amend && (method.payload?.contentDigest === amend.previousDigest || method.payload?.status === 'retired'));
    set('demoted', gold.expectRollback === true, back, `${amend ? `amended ${clip(amend.previousDigest, 20)}->${clip(amend.digest, 20)}` : 'no amendment'}; replay job ${job ? `${job.status} result=${clip(job.result, 220)}${job.error ? ` error=${clip(job.error, 120)}` : ''}` : 'none'}; now digest=${clip(method?.payload?.contentDigest, 20)} status=${method?.payload?.status}; replay counters=${clip(nonZero(state?.counters?.replayOutcomes))}/${clip(nonZero(state?.counters?.replayVerdicts))}`);
  }
  const firstBroken = L1_LINKS.find(name => links[name].expected && links[name].reached === false) ?? null;
  return { ring, links, firstBroken, verdicts, methods: methods.map(m => ({ id: m.id, name: m.payload?.frontmatter?.name, status: m.payload?.status, counts: countsOf(m) })) };
}

/** A counter map with its zero entries dropped. */
export function nonZero(map) {
  if (!map || typeof map !== 'object') return map ?? null;
  return Object.fromEntries(Object.entries(map).filter(([, v]) => (typeof v === 'number' ? v !== 0 : v && typeof v === 'object' ? Object.keys(nonZero(v)).length : false)).map(([k, v]) => [k, typeof v === 'object' ? nonZero(v) : v]));
}

/** L10: one family. `runs` = [{ kind: 'same'|'lookalike'|'probe', index, runId, status, chain, verdict }]. */
export function l10Family({ family, runs, state, toolchainOn, probeMount = null }) {
  const byRun = new Map(runs.map(r => [r.runId, r]));
  const routines = (state?.jobs ?? []).filter(j => j.kind === 'distill' && j.payload?.trigger === 'routine');
  const rows = routines.map(j => {
    const members = [j.payload?.runId, ...(j.payload?.peers ?? []).map(p => p.runId)].map(id => byRun.get(id)).filter(Boolean);
    return { job: j.id, status: j.status, operation: j.result?.operation ?? null, methodId: j.result?.methodId ?? null, members: members.map(m => `${m.kind}${m.index + 1}`),
      lookalike: members.some(m => m.kind === 'lookalike'), skipped: j.result?.skipped ?? null };
  });
  const learned = rows.filter(r => r.status === 'succeeded' && ['create', 'amend', 'merge'].includes(r.operation));
  const expected = toolchainOn ? 1 : 0;
  const before = runs.find(r => r.kind === 'same' && r.index === 0);
  const probe = runs.find(r => r.kind === 'probe');
  return { family: family.id, expectedRoutines: expected, lessons: rows.length, routinesLearned: learned.length, exact: learned.length === expected && rows.filter(r => r.lookalike).length === 0,
    falseRoutine: rows.some(r => r.lookalike), rows,
    fingerprints: runs.map(r => ({ run: `${r.kind}${r.index + 1}`, verdict: r.verdict, toolchain: (evidenceOf(state, r.runId).find(e => e.detail?.toolchain)?.detail?.toolchain?.tools ?? null), chain: r.chain })),
    chainChanged: before && probe ? JSON.stringify(before.chain) !== JSON.stringify(probe.chain) : null, chainBefore: before?.chain ?? null, chainAfter: probe?.chain ?? null, probeMount };
}

/** L5: one item. `snapshots` = [{ afterTask, status, counts }]. */
export function l5Item({ item, gold, snapshots, verdicts, mounts, state, methodId }) {
  const stopAt = snapshots.find(s => s.status !== 'approved');
  const method = methodById(state, methodId);
  const distills = (state?.jobs ?? []).filter(j => j.kind === 'distill');
  return { id: item.id, class: gold.class, shouldStop: gold.shouldStop, stopped: Boolean(stopAt), stoppedAfterTask: stopAt?.afterTask ?? null,
    finalStatus: method?.payload?.status ?? null, statusReason: method?.payload?.statusReason ?? null, links: method?.payload?.links ?? [],
    correct: Boolean(stopAt) === gold.shouldStop, falseStop: !gold.shouldStop && Boolean(stopAt), missedStop: gold.shouldStop && !stopAt,
    counts: countsOf(method), verdicts, mounts,
    lessons: distills.map(j => ({ trigger: j.payload?.trigger, status: j.status, operation: j.result?.operation ?? null, methodId: j.result?.methodId ?? null, amendedSeed: j.result?.methodId === methodId })),
    amendedSeedApproved: distills.some(j => j.result?.methodId === methodId && j.result?.operation === 'amend') && method?.payload?.status === 'approved',
    snapshots };
}

/** L2: rule checks of one reply. @param {{ruleId: string, check: any}[]} checks */
export const ruleResults = (checks, reply) => checks.map(c => ({ ruleId: c.ruleId, pass: checkReply(c.check, reply) }));
/** The simulated person's next line: the first applicable rule the reply breaks, hinted the first time it is corrected, clear after. */
export function correctionFor(person, checks, reply, priorCorrections) {
  for (const c of checks) {
    if (checkReply(c.check, reply) !== false) continue;
    const rule = person.rules.find(r => r.id === c.ruleId);
    const level = priorCorrections.includes(c.ruleId) ? 'clear' : 'first';
    return { line: level === 'clear' ? rule.correctionClear : rule.correctionFirst, ruleId: c.ruleId, level };
  }
  return null;
}
const POSITIVE_FORMS = ['pattern', 'startsWith', 'endsWith', 'table'];
/** L2 summary of one person-arm. */
export function l2Summary({ sessions, frozen, probes }) {
  const corrections = sessions.map(s => s.corrections.length);
  const firstRight = sessions.filter(s => s.first.every(r => r.pass !== false)).length;
  const frozenChecks = frozen.flatMap(f => f.results);
  const leaks = probes.flatMap(p => p.results.filter(r => r.unnatural && POSITIVE_FORMS.includes(r.kind) && r.pass === true).map(r => ({ probe: p.index, ruleId: r.ruleId, kind: r.kind })));
  const positive = probes.flatMap(p => p.results.filter(r => r.unnatural && POSITIVE_FORMS.includes(r.kind)));
  return { sessions: sessions.length, correctionsPerSession: corrections, totalCorrections: corrections.reduce((a, b) => a + b, 0),
    firstTimeRight: sessions.length ? firstRight / sessions.length : null, firstTimeRightCount: firstRight,
    firstHalfCorrections: corrections.slice(0, 6).reduce((a, b) => a + b, 0), secondHalfCorrections: corrections.slice(6).reduce((a, b) => a + b, 0),
    frozenCompliance: frozenChecks.length ? frozenChecks.filter(r => r.pass === true).length / frozenChecks.length : null, frozenChecks: frozenChecks.length,
    probeLeaks: leaks, probePositiveChecks: positive.length, probeLeakRate: positive.length ? leaks.length / positive.length : null };
}
