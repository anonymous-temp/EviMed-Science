import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMethodSkill } from '@evimed/domain';
import { LearningService, methodPersonCorrection } from '../src/learningService.mjs';
import { methodView } from '../src/learningRoutes.mjs';
import { selectLearnedMethods } from '../src/learnedMethodMount.mjs';
import { MethodConsolidation } from '../src/methodConsolidation.mjs';
import { MethodDistillationRuns } from '../src/methodDistillationRuns.mjs';
import { MethodReplay } from '../src/methodReplay.mjs';
import { productDocumentsDouble } from './helpers/productDocumentsDouble.mjs';

const BODY = ['## Purpose', 'Keep the requested reply form.', '## When to Use', 'When writing a reply.',
  '## Inputs', 'The person’s instruction.', '## Workflow', '1. Use the requested form.',
  '## Verification', 'The form matches the instruction.', '## Constraints', 'Preserve quoted dates.', '## Output', 'A reply.'].join('\n\n');
const frontmatter = name => ({ name, description: 'Keep the requested date format in every reply.', whenToUse: 'When writing a reply.',
  metadata: { role: 'functional', applies_when: 'A reply is needed.', not_when: 'Writing a file.', derived_from: 'run:run_1', evimed_schema: 'method-skill/1' } });
const job = { id: 'correction', userId: 'u1', projectId: 'p1', payload: { trigger: 'correction', feedbackEventIds: ['fe_1'],
  feedback: [{ trigger: 'learning-evidence', detail: { quote: 'Keep my reply form.', verdict: 'correction' } }] } };

function harness() {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, now: () => new Date('2026-11-11T00:00:00Z') });
  const make = (name, input = {}) => learning.createCandidate('u1', { frontmatter: frontmatter(name), body: BODY,
    provenance: { origin: 'inferred', runId: 'run_1', sourceProjectId: 'p1' }, ...input });
  const amend = async (method, input = {}) => {
    const current = await learning.getMethod('u1', method.id);
    return learning.amendMethod('u1', method.id, { expectedRevision: current.revision, frontmatter: current.payload.frontmatter,
      body: `${BODY}\n\nKeep the date on the first line and the reply short.`, ...input });
  };
  const conflict = async (a, b) => {
    for (const [source, target] of [[a, b], [b, a]]) await learning.recordRelations('u1', source.id,
      [{ type: 'conflicts_with', target: target.id, evidence: 'The two forms differ.', proposedBy: 'test' }]);
  };
  const distillation = new MethodDistillationRuns({ learning, jobs: { enqueue: async () => ({}) },
    dispatch: async () => { throw new Error('No dispatch'); }, readResult: async () => { throw new Error('No read'); } });
  return { learning, documents, make, amend, conflict, distillation };
}

test('L2 sequence: a correction keeps the amended method approved and mounted; the older conflict yields with a readable reason', async () => {
  const h = harness();
  const older = await h.make('keep-date-format-consistent');
  const corrected = await h.make('dated-terse-replies');
  await h.conflict(older, corrected);
  assert.equal((await h.learning.approvedMethods('u1')).length, 2);
  const changed = await h.amend(corrected, { personCorrection: true, provenance: { trigger: 'correction' } });
  assert.equal(changed.payload.status, 'approved');
  assert.ok(methodPersonCorrection(changed.payload));
  const yielded = await h.learning.getMethod('u1', older.id);
  assert.equal(yielded.payload.status, 'candidate');
  assert.equal(yielded.payload.conflictHold.methodId, corrected.id);
  assert.ok(yielded.payload.statusReason.includes('dated-terse-replies'));
  assert.equal(methodView(yielded).statusReason, yielded.payload.statusReason);
  const mounted = await selectLearnedMethods(h.learning, { userId: 'u1', projectId: 'p1' });
  assert.deepEqual(mounted.map(method => method.name), ['dated-terse-replies']);
  await assert.rejects(h.learning.approve('u1', yielded.id, { expectedRevision: yielded.revision }), { code: 'method_not_promotable' });
});

test('a new conflict after a correction gives precedence to the corrected body, including a one-sided relation', async () => {
  const h = harness();
  const corrected = await h.make('corrected', { personCorrection: true });
  const older = await h.make('older');
  await h.learning.recordRelations('u1', older.id, [{ type: 'conflicts_with', target: corrected.id, evidence: 'Opposite prescriptions.', proposedBy: 'test' }]);
  assert.equal((await h.learning.getMethod('u1', corrected.id)).payload.status, 'approved');
  assert.equal((await h.learning.getMethod('u1', older.id)).payload.status, 'candidate');
});

test('a new correction merged into an unchanged held method restores it and reverses precedence, even within the same millisecond', async () => {
  const h = harness();
  const older = await h.make('old');
  const newer = await h.make('new');
  await h.conflict(older, newer);
  await h.amend(newer, { personCorrection: true });
  const restored = await h.amend(older, { personCorrection: true, body: older.payload.body });
  assert.equal(restored.payload.status, 'approved');
  assert.equal(restored.payload.conflictHold, undefined);
  assert.equal((await h.learning.getMethod('u1', newer.id)).payload.status, 'candidate');
});

test('the existing rollback route can restore the same body of a held method and the other method then yields', async () => {
  const h = harness();
  const older = await h.make('old');
  const newer = await h.make('new');
  await h.conflict(older, newer);
  await h.amend(newer, { personCorrection: true });
  const held = await h.learning.getMethod('u1', older.id);
  const restored = await h.learning.rollback('u1', older.id, { expectedRevision: held.revision, targetRevision: older.revision });
  assert.equal(restored.payload.status, 'approved');
  assert.equal(restored.payload.contentDigest, older.payload.contentDigest);
  assert.equal((await h.learning.getMethod('u1', newer.id)).payload.status, 'candidate');
});

test('system rewrites retain conflict checks and a stored reason even when they copy correction provenance', async () => {
  const h = harness();
  const a = await h.make('a');
  const b = await h.make('b');
  await h.conflict(a, b);
  const changed = await h.amend(b, { provenance: { trigger: 'correction', signal: 'researcher', feedbackEventIds: ['fe_1'], consolidatedBy: 'consolidate:1' } });
  assert.equal(changed.payload.status, 'candidate');
  assert.ok(changed.payload.statusReason);
  assert.equal(methodPersonCorrection(changed.payload), null);
  assert.equal((await h.learning.getMethod('u1', a.id)).payload.status, 'approved');
});

test('retirements and harmful-method stops remain stopped when another correction changes their text', async () => {
  const h = harness();
  const a = await h.make('harmful');
  await h.learning.retire('u1', a.id, { expectedRevision: a.revision, reason: 'Observed harm.' });
  const changed = await h.amend(a, { personCorrection: true });
  assert.equal(changed.payload.status, 'retired');
  assert.equal(changed.payload.statusReason, 'Observed harm.');
});

test('a pinned no_change that names a withdrawn method restores coverage instead of discarding the correction', async () => {
  const h = harness();
  const older = await h.make('older');
  const changed = await h.make('changed');
  await h.conflict(older, changed);
  const withdrawn = await h.amend(changed);
  assert.equal(withdrawn.payload.status, 'candidate');
  const skill = renderMethodSkill(withdrawn.payload.frontmatter, withdrawn.payload.body);
  const result = await h.distillation.applyCandidate(job, { id: 'run_2' }, { candidate: { operation: 'no_change',
    targetMethodId: changed.id, baseDigest: withdrawn.payload.contentDigest }, skill });
  assert.equal(result.operation, 'amend');
  assert.equal((await h.learning.getMethod('u1', changed.id)).payload.status, 'approved');
  assert.equal((await h.learning.getMethod('u1', older.id)).payload.status, 'candidate');
});

test('no_change cannot restore stale text and a model cannot grant itself correction authority', async () => {
  const h = harness();
  const older = await h.make('older');
  const changed = await h.make('changed');
  await h.conflict(older, changed);
  const withdrawn = await h.amend(changed);
  await assert.rejects(h.distillation.applyCandidate(job, { id: 'run_2' }, { candidate: { operation: 'no_change',
    targetMethodId: changed.id, baseDigest: 'sha256:stale' }, skill: renderMethodSkill(withdrawn.payload.frontmatter, withdrawn.payload.body) }), { code: 'method_candidate_stale' });
  await h.distillation.applyCandidate({ ...job, payload: {} }, { id: 'run_3' }, { candidate: { operation: 'amend',
    personCorrection: true, targetMethodId: changed.id }, skill: renderMethodSkill(withdrawn.payload.frontmatter, `${BODY}\n\nSystem text.`) });
  assert.equal((await h.learning.getMethod('u1', changed.id)).payload.status, 'candidate');
});

test('a fresh non-conflict judgement resolves the old conflict on both ends and sleep restores the held method', async () => {
  const h = harness();
  const a = await h.make('a');
  const b = await h.make('b');
  await h.conflict(a, b);
  await h.amend(b, { personCorrection: true });
  const members = (await h.learning.listMethods('u1')).items;
  const consolidation = new MethodConsolidation({ learning: h.learning, dispatch: async () => ({}), readResult: async () => ({}) });
  await consolidation.applyRelations(job, members, { assignments: [{ ASSIGNMENT: 'A1', SKILLS: [a.id, b.id],
    RELATION_TYPE: 'subset', WIDER: b.id, REASON: 'The amended text makes one a subprocedure of the other.' }] });
  for (const id of [a.id, b.id]) assert.ok((await h.learning.getMethod('u1', id)).payload.learning.relations.find(r => r.type === 'conflicts_with').resolved);
  const promoted = await consolidation.approveCandidates(job, (await h.learning.listMethods('u1')).items, { strict: true });
  assert.deepEqual(promoted, [a.id]);
  assert.equal((await h.learning.getMethod('u1', a.id)).payload.conflictHold, undefined);
});

test('a stale consolidation decision cannot withdraw or resolve the newly amended body', async () => {
  const h = harness();
  const a = await h.make('a');
  const b = await h.make('b');
  const members = [a, b];
  await h.amend(b, { personCorrection: true });
  const consolidation = new MethodConsolidation({ learning: h.learning, dispatch: async () => ({}), readResult: async () => ({}) });
  await consolidation.applyRelations(job, members, { assignments: [{ ASSIGNMENT: 'A1', SKILLS: [a.id, b.id], RELATION_TYPE: 'conflicts_with', REASON: 'Old text.' }] });
  assert.equal((await h.learning.getMethod('u1', a.id)).payload.status, 'approved');
  assert.equal((await h.learning.getMethod('u1', b.id)).payload.status, 'approved');
});

test('correction replay needs no accepted runs, while a subsequent system rewrite is still replayed', async () => {
  const h = harness();
  const a = await h.make('a');
  const corrected = await h.amend(a, { personCorrection: true });
  let acceptedReads = 0;
  const replay = new MethodReplay({ learning: h.learning, feedback: { cleanSettledRuns: async () => { acceptedReads++; return []; } },
    readTrajectory: async () => null, judge: { available: true, read: async () => { throw new Error('No judge'); } } });
  const replayJob = method => ({ job: { ...job, payload: { methodId: method.id, digest: method.payload.contentDigest } } });
  assert.equal((await replay.run(replayJob(corrected))).outcome, 'person_correction');
  assert.equal(acceptedReads, 0);
  const system = await h.amend(corrected, { body: `${BODY}\n\nSystem rewrite.` });
  assert.equal(methodPersonCorrection(system.payload), null);
  assert.equal((await replay.run(replayJob(system))).outcome, 'no_runs');
  assert.equal(acceptedReads, 1);
});

test('a legacy withdrawn correction exits no_runs through approval without waiting for a build or replay proof', async () => {
  const h = harness();
  const older = await h.make('old');
  const newer = await h.make('new');
  await h.conflict(older, newer);
  const legacy = await h.amend(newer, { provenance: { trigger: 'correction', signal: 'researcher', feedbackEventIds: ['fe_1'] } });
  const payload = { ...legacy.payload };
  delete payload.personCorrection;
  await h.documents.put('u1', 'method', legacy.id, payload, { expectedRevision: legacy.revision });
  const current = await h.learning.getMethod('u1', legacy.id);
  assert.ok(methodPersonCorrection(current.payload));
  await h.learning.approve('u1', legacy.id, { expectedRevision: current.revision });
  assert.equal((await h.learning.getMethod('u1', newer.id)).payload.status, 'approved');
  assert.equal((await h.learning.getMethod('u1', older.id)).payload.status, 'candidate');
});
