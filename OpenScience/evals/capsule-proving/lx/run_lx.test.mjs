import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillFrontmatter } from '../../../packages/domain/src/methodSkill.mjs';
import { armEnv, argsOf, devDir, skillOf, summarizeExp, ledgerRows } from './run_lx.mjs';
import { l1Ring, l10Family, l2Summary, correctionFor, toolChainOf } from './verdicts.mjs';
import { learnedDirectory } from './conversation.mjs';

const gold = { verdicts: ['correction', 'accept', 'accept'] };
const ev = (run, verdict, extra = {}) => ({ trigger_kind: 'learning-evidence', run_id: run, detail: { evidence: 'follow-up', verdict, ...extra } });

test('arms: tool chain and add-only differ from the production base only by their switch', () => {
  assert.equal(armEnv('l1', 'tc-off').OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED, 'false');
  assert.equal(armEnv('l1', 'tc-on').OPEN_SCIENCE_LEARNING_TOOLCHAIN_ROUTINE_ENABLED, 'true');
  assert.equal(armEnv('l2', 'add-only').EVAL_ADD_ONLY, '1');
  assert.equal(armEnv('l2', 'evolve').OPEN_SCIENCE_LEARNING_ENABLED, 'true');
  assert.throws(() => argsOf(['--exp', 'l1', '--arm', 'evolve']));
  assert.throws(() => devDir('/srv/x-sealed', 'l1'));
});

test('a seeded SKILL.md parses with the product parser', () => {
  const parsed = parseSkillFrontmatter(skillOf({ name: 'Verify Number "Sources"', whenToUse: '写含数字的内容前，核对"来源"。', body: '- 先找原始依据' }));
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.frontmatter.name, 'verify-number-sources');
  assert.match(parsed.frontmatter.whenToUse, /核对/);
});

test('L1: the first broken link is the first expected link not reached, with its record', () => {
  const runs = [{ k: 0, runId: 'r1', status: 'succeeded' }, { k: 1, runId: 'r2', status: 'succeeded' }, { k: 2, runId: 'r3', status: 'succeeded' }];
  const state = { events: [ev('r1', 'accept'), ev('r2', 'accept'), ev('r3', 'accept')], jobs: [], methods: [], counters: { triggerRefused: { paused: 0 } } };
  const v = l1Ring({ ring: 'correction', gold, runs, turns: [], state });
  assert.equal(v.firstBroken, 'verdict');
  assert.match(v.links.verdict.evidence, /#1 correction->accept/);
  const state2 = { ...state, events: [ev('r1', 'preference'), ev('r2', 'accept'), ev('r3', 'accept')],
    jobs: [{ kind: 'distill', status: 'succeeded', payload: { trigger: 'correction', runId: 'r1' }, result: { operation: 'create', methodId: 'm1' } }],
    methods: [{ id: 'm1', created_at: '2026-11-10T10:00:00Z', payload: { status: 'approved', frontmatter: { name: 'shopping-list' }, learning: { counts: { loaded: 1, invoked: 1, appliedClean: 1 } } } }] };
  const turn = { role: 'request', label: 'c2.t0', conversationStartedAt: '2026-11-10T10:05:00Z', selection: { methods: [{ directory: learnedDirectory('m1'), reason: 'similarity' }] },
    methodObservation: { methodsLoaded: [{ name: 'shopping-list' }], methodsInvoked: [{ name: 'shopping-list' }] } };
  const lit = l1Ring({ ring: 'correction', gold, runs, turns: [turn], state: state2 });
  assert.equal(lit.firstBroken, null);
  assert.equal(lit.links.mounted.reached, true);
  assert.equal(lit.links.lesson.reached, true);
  const unrun = l1Ring({ ring: 'correction', gold, runs: [{ ...runs[0], status: 'unverified' }, runs[1], runs[2]], turns: [turn], state: state2 });
  assert.equal(unrun.firstBroken, 'delivered');
});

test('L1 routine ring needs the shape on its evidence; replay ring seeds and expects the rollback', () => {
  const runs = ['a', 'b', 'c'].map((runId, k) => ({ k, runId, status: 'succeeded' }));
  const state = { events: runs.map(r => ev(r.runId, 'accept')), jobs: [], methods: [] };
  const v = l1Ring({ ring: 'routine_toolchain', gold: { verdicts: ['accept', 'accept', 'accept'] }, runs, turns: [], state });
  assert.equal(v.firstBroken, 'evidence');
  const rs = { events: runs.map(r => ev(r.runId, 'accept')), jobs: [{ kind: 'consolidate', payload: { action: 'replay', digest: 'd2' }, status: 'succeeded', result: { outcome: 'clean' } }],
    methods: [{ id: 's1', payload: { status: 'approved', contentDigest: 'd2', frontmatter: { name: 'w' }, learning: { counts: {} } } }] };
  const replay = l1Ring({ ring: 'replay', gold: { verdicts: ['accept', 'accept', 'accept'], expectRollback: true }, runs, turns: [], state: rs, seeded: [{ id: 's1' }], amend: { previousDigest: 'd1', digest: 'd2' } });
  assert.equal(replay.links.lesson.expected, false);
  assert.equal(replay.links.demoted.reached, false);
});

test('L10: a routine lesson that folds in a look-alike is a false routine', () => {
  const runs = [{ kind: 'same', index: 0, runId: 's1', chain: ['web_search', 'calc'] }, { kind: 'lookalike', index: 0, runId: 'l1', chain: ['kb_search'] }, { kind: 'probe', index: 0, runId: 'p', chain: ['web_search'] }];
  const state = { events: [], methods: [], jobs: [{ id: 'j', kind: 'distill', status: 'succeeded', payload: { trigger: 'routine', runId: 'l1', peers: [{ runId: 's1' }] }, result: { operation: 'create', methodId: 'm' } }] };
  const v = l10Family({ family: { id: 'F' }, runs, state, toolchainOn: true });
  assert.equal(v.falseRoutine, true);
  assert.equal(v.exact, false);
  assert.equal(v.chainChanged, true);
  assert.deepEqual(toolChainOf({ tools: [{ name: 'a' }, { name: 'a' }, { name: 'b' }] }), ['a', 'b']);
});

test('L2: the simulated person hints first and is clear after; leaks count only positive forms where unnatural', () => {
  const person = { rules: [{ id: 'r1', correctionFirst: 'hint', correctionClear: 'clear rule' }, { id: 'r2', correctionFirst: 'h2', correctionClear: 'c2' }] };
  const checks = [{ ruleId: 'r1', check: { kind: 'startsWith', value: '结论：' } }, { ruleId: 'r2', check: { kind: 'maxChars', value: 20 } }];
  assert.deepEqual(correctionFor(person, checks, '结论：好', []), null);
  assert.equal(correctionFor(person, checks, '你好', []).line, 'hint');
  assert.equal(correctionFor(person, checks, '你好', ['r1']).level, 'clear');
  const s = l2Summary({ sessions: [{ first: [{ pass: true }], corrections: [] }, { first: [{ pass: false }], corrections: [{}] }],
    frozen: [{ results: [{ pass: true }, { pass: false }] }],
    probes: [{ index: 0, results: [{ ruleId: 'r1', kind: 'startsWith', unnatural: true, pass: true }, { ruleId: 'r2', kind: 'maxChars', unnatural: true, pass: true }] }] });
  assert.equal(s.firstTimeRight, 0.5);
  assert.equal(s.frozenCompliance, 0.5);
  assert.equal(s.probeLeaks.length, 1);
  const rows = ledgerRows(summarizeExp('l2', 'evolve', [{ id: 'D01', correctionsPerSession: [1, 0], firstTimeRight: 0.5, frozenCompliance: 0.5, probeLeaks: [{}], probePositiveChecks: 1 }]),
    { runId: 'lx', commit: 'c', flags: {}, rawPath: '/x', wallSeconds: 1, tokens: { prompt: 1, completion: 1, cached: 0, costCny: 0 } });
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.set === 'l2' && r.split === 'dev' && Number.isInteger(r.n)));
});
