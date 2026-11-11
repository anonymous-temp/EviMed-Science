import { Readable } from 'node:stream';
import { createLearningRoutes } from '../src/learningRoutes.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMethodSkill } from '@evimed/domain';
import { LearningService, methodPersonCorrection, legacyCorrectionRecoverable } from '../src/learningService.mjs';
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
  const learning = new LearningService({ documents, correctionPrecedence: true, now: () => new Date('2026-11-11T00:00:00Z') });
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

import { createHash } from 'node:crypto';
import { methodContentDigest } from '@evimed/domain';
import { correctionSources, correctionCovered } from '../src/methodCorrectionJudge.mjs';
import { correctionImpact, readCorrectionSnapshot } from '../../../scripts/ops/correction-precedence-report.mjs';

const at = day => `2026-11-${day}T00:00:00.000Z`;
const proofFor = (method, time, body = method.payload.body) => ({ source: 'judged', at: time, eventId: `event-${time}`,
  digest: methodContentDigest({ frontmatter: method.payload.frontmatter, body, files: method.payload.files }, text => createHash('sha256').update(text).digest('hex')) });
const corrected = async (h, method, time) => h.amend(method, { body: method.payload.body, correctionProof: proofFor(method, time) });
const judgeYes = { read: async ({ runText }) => JSON.stringify({ covers: true, methodQuote: 'Keep the requested reply form.', correctionQuote: runText }) };
const eventJob = { ...job, payload: { ...job.payload, feedback: [{ id: 'fe_1', occurredAt: at('10'), trigger: 'learning-evidence',
  detail: { quote: 'Keep my reply form.', verdict: 'correction' } }] } };

test('B1: directly written and edited methods outrank a later distilled correction', async () => {
  const h = harness();
  const manual = await h.make('manual', { provenance: { origin: 'explicit' } });
  const lesson = await h.make('lesson');
  await corrected(h, lesson, at('12'));
  await h.conflict(manual, lesson);
  assert.equal((await h.learning.getMethod('u1', manual.id)).payload.status, 'approved');
  assert.equal((await h.learning.getMethod('u1', lesson.id)).payload.status, 'candidate');
  assert.equal(manual.payload.personCorrection.source, 'direct');
  const edit = await h.amend(manual, { directEdit: true });
  assert.equal(edit.payload.personCorrection.source, 'direct');
  assert.equal(edit.payload.personCorrection.at, at('11'));
  assert.doesNotMatch((await h.learning.getMethod('u1', lesson.id)).payload.statusReason, /你较新纠正/);
});

test('B1: existing hand-written first bodies rank as direct, but system rewrites do not inherit it', async () => {
  const h = harness();
  const method = await h.make('legacy-hand', { provenance: { origin: 'explicit' } });
  const payload = { ...method.payload, personCorrection: null };
  assert.equal(methodPersonCorrection(payload, true).source, 'direct');
  const rewritten = await h.amend(method);
  assert.equal(methodPersonCorrection(rewritten.payload, true), null);
});

test('B2: an older lesson finishing later yields, ordered by human event time', async () => {
  const h = harness();
  const newer = await h.make('newer');
  const older = await h.make('older');
  await corrected(h, newer, at('10'));
  await corrected(h, older, at('09'));
  await h.conflict(newer, older);
  assert.equal((await h.learning.getMethod('u1', newer.id)).payload.status, 'approved');
  assert.equal((await h.learning.getMethod('u1', older.id)).payload.status, 'candidate');
  await assert.rejects(corrected(h, newer, at('08')), { code: 'method_correction_superseded' });
});

test('B2: missing event time grants nothing; feedback time survives retries and timestamp offsets', () => {
  assert.deepEqual(correctionSources({ feedback: [{ detail: { quote: 'instruction', verdict: 'correction' } }] }), []);
  const sources = correctionSources({ feedback: [
    { occurredAt: '2026-11-10T10:00:00+08:00', detail: { quote: 'older', verdict: 'correction' } },
    { occurredAt: '2026-11-10T03:00:00Z', detail: { quote: 'newer', verdict: 'correction' } },
  ] });
  assert.equal(sources[0].text, 'newer');
});

test('B3: exact no_change text and amend wrong target are refused without independent coverage', async () => {
  const h = harness();
  const a = await h.make('a');
  const b = await h.make('b');
  await h.conflict(a, b);
  const before = await h.learning.getMethod('u1', b.id);
  h.distillation.correctionJudge = { read: async () => JSON.stringify({ covers: false }) };
  for (const operation of ['no_change', 'amend']) {
    const result = await h.distillation.applyCandidate(eventJob, { id: 'run_2' }, { candidate: { operation, targetMethodId: b.id,
      baseDigest: before.payload.contentDigest, personCorrection: true }, skill: renderMethodSkill(b.payload.frontmatter, b.payload.body) });
    assert.equal(result.skipped, 'correction_unverified');
    assert.equal((await h.learning.getMethod('u1', b.id)).revision, before.revision);
  }
});

test('B3: independent grounded coverage grants exact body authority at the event time', async () => {
  const h = harness();
  h.distillation.correctionJudge = judgeYes;
  const b = await h.make('b');
  await h.distillation.applyCandidate(eventJob, { id: 'run_2' }, { candidate: { operation: 'amend', targetMethodId: b.id },
    skill: renderMethodSkill(b.payload.frontmatter, b.payload.body) });
  const saved = await h.learning.getMethod('u1', b.id);
  assert.equal(saved.payload.personCorrection.source, 'judged');
  assert.equal(saved.payload.personCorrection.at, at('10'));
  assert.equal(saved.payload.personCorrection.digest, saved.payload.contentDigest);
  assert.equal(correctionCovered('{"covers":true,"methodQuote":"invented","correctionQuote":"keep"}', 'other text', 'keep'), false);
});

test('B3: bare distiller boolean cannot stamp, and failed judge preserves the current method', async () => {
  const h = harness();
  const method = await h.make('a', { personCorrection: true });
  assert.equal(methodPersonCorrection(method.payload, true), null);
  h.distillation.correctionJudge = { read: async () => { throw new Error('offline'); } };
  const result = await h.distillation.applyCandidate(eventJob, { id: 'run_2' }, { candidate: { operation: 'amend', targetMethodId: method.id },
    skill: renderMethodSkill(method.payload.frontmatter, method.payload.body) });
  assert.equal(result.skipped, 'correction_unverified');
  assert.equal((await h.learning.getMethod('u1', method.id)).revision, method.revision);
});

test('B3: a subsequent attributed correction to the same body revokes replay exemption and queues replay', async () => {
  const h = harness();
  const method = await corrected(h, await h.make('a'), at('09'));
  const queued = [];
  h.learning.jobs = { enqueue: async (...args) => queued.push(args) };
  await h.learning.recordApplied('u1', method.id, { runId: 'use-1', outcome: 'corrected', at: at('10') }, method.payload.contentDigest);
  const current = await h.learning.getMethod('u1', method.id);
  assert.equal(methodPersonCorrection(current.payload, true), null);
  assert.equal(queued.length, 1);
  let reads = 0;
  const replay = new MethodReplay({ learning: h.learning, feedback: { cleanSettledRuns: async () => { reads++; return []; } },
    readTrajectory: async () => null, judge: { available: true } });
  const result = await replay.run({ job: { ...job, payload: { methodId: method.id, digest: method.payload.contentDigest } } });
  assert.equal(result.outcome, 'no_runs');
  assert.equal(reads, 1);
});

async function legacy(h, name, historyStop = false) {
  const method = await h.make(name);
  if (historyStop) await h.learning.retire('u1', method.id, { expectedRevision: method.revision });
  const current = await h.learning.getMethod('u1', method.id);
  const payload = { ...current.payload, status: 'candidate', provenance: { trigger: 'correction', signal: 'researcher', feedbackEventIds: ['fe_1'] },
    learning: { ...current.payload.learning, rewrites: { count: 1, dates: [at('09')] } } };
  delete payload.personCorrection;
  delete payload.correctionRecoveryStopped;
  await h.documents.put('u1', 'method', method.id, payload, { expectedRevision: current.revision });
  return h.learning.getMethod('u1', method.id);
}

test('B4: legacy recovery requires independent proof; retired history and harm-stopped candidates cannot recover', async () => {
  const h = harness();
  const eligible = await legacy(h, 'eligible');
  await assert.rejects(h.learning.approve('u1', eligible.id, { expectedRevision: eligible.revision }), { code: 'method_not_promotable' });
  h.learning.verifyLegacyCorrection = async (_user, method) => proofFor(method, at('09'));
  assert.equal((await h.learning.approve('u1', eligible.id, { expectedRevision: eligible.revision })).payload.status, 'approved');
  const stopped = await legacy(h, 'stopped', true);
  await assert.rejects(h.learning.approve('u1', stopped.id, { expectedRevision: stopped.revision }), { code: 'method_not_promotable' });
  const harmful = await legacy(h, 'harmful');
  const payload = { ...harmful.payload, learning: { ...harmful.payload.learning, harmCarried: { runs: 30, bad: 30, crossed: { runs: 30, bad: 30 } } } };
  assert.equal(legacyCorrectionRecoverable(payload), false);
  await h.documents.put('u1', 'method', harmful.id, payload, { expectedRevision: harmful.revision });
  await assert.rejects(h.learning.approve('u1', harmful.id, { expectedRevision: harmful.revision + 1 }), { code: 'method_not_promotable' });
});

test('B4: retired methods never move; an explicit restore gets a new direct timestamp', async () => {
  const h = harness();
  const method = await corrected(h, await h.make('retired'), at('09'));
  const stopped = await h.learning.retire('u1', method.id, { expectedRevision: method.revision });
  await assert.rejects(h.learning.approve('u1', stopped.id, { expectedRevision: stopped.revision }), { code: 'method_not_promotable' });
  const restored = await h.learning.rollback('u1', stopped.id, { expectedRevision: stopped.revision, targetRevision: method.revision });
  assert.equal(restored.payload.personCorrection.source, 'direct');
  assert.equal(restored.payload.correctionRecoveryStopped, undefined);
});

test('B5: relation settlement reads only conflict partners regardless of library size', async () => {
  const h = harness();
  const a = await corrected(h, await h.make('a'), at('10'));
  const b = await h.make('b');
  for (let index = 0; index < 240; index++) await h.documents.put('u1', 'method', `unrelated-${index}`, { ...b.payload,
    frontmatter: { ...b.payload.frontmatter, name: `unrelated-${index}` } }, { expectedRevision: 0 });
  let reads = 0, lists = 0;
  const get = h.documents.get.bind(h.documents), list = h.documents.list.bind(h.documents);
  h.documents.get = async (...args) => { reads++; assert.ok(!String(args[2]).startsWith('unrelated')); return get(...args); };
  h.documents.list = async (...args) => { lists++; assert.ok(args[2].filter.learning?.relations); return list(...args); };
  await h.learning.recordRelations('u1', b.id, [{ type: 'conflicts_with', target: a.id, evidence: 'Opposite forms.', proposedBy: 'test' }]);
  assert.ok(reads <= 8, `reads=${reads}`);
  assert.equal(lists, 1);
  assert.equal((await h.learning.getMethod('u1', b.id)).payload.status, 'candidate');
});

test('B4 report lists only account/row identities and titles; read transaction never mutates', async () => {
  const h = harness();
  const method = await legacy(h, 'legacy');
  const rows = [{ ...method, userId: 'u1' }];
  const jobs = [{ userId: 'u1', id: 'replay-1', status: 'queued', payload: { action: 'replay', methodId: method.id, digest: method.payload.contentDigest } }];
  const report = correctionImpact(rows, jobs);
  assert.equal(report[0].switchOff.counts.legacyRecovery, 1);
  assert.equal(report[0].switchOff.counts.replayUnjudged, 1);
  assert.equal(report[0].switchOn.counts.replayUnjudged, 0);
  assert.ok(!JSON.stringify(report).includes('Keep the requested reply form'));
  const queries = [];
  await readCorrectionSnapshot({ query: async sql => { queries.push(sql); return { rows: [] }; } });
  assert.match(queries[0], /READ ONLY$/);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.ok(queries.slice(1, -1).every(sql => sql.startsWith('SELECT')));
});


test('B1: authenticated method create/edit routes grant direct authority and reject caller-supplied proof', async () => {
  const h = harness();
  let csrf = 0;
  const routes = createLearningRoutes({ service: h.learning, maxJsonBytes: 30_000,
    store: { ensureSessionUser: async () => ({ user: { id: 'u1' } }), assertCsrf: async () => { csrf++; } } });
  const request = async (method, url, body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, url, headers: { 'content-type': 'application/json' } });
    let result;
    await routes(req, { writeHead() {}, end(text) { result = JSON.parse(text); } });
    return result.data;
  };
  const made = await request('POST', '/api/methods', { skill: renderMethodSkill(frontmatter('manual-page'), BODY) });
  let stored = await h.learning.getMethod('u1', made.id);
  assert.equal(stored.payload.personCorrection.source, 'direct');
  await request('PATCH', `/api/methods/${encodeURIComponent(made.id)}`, { expectedRevision: made.revision,
    skill: renderMethodSkill(frontmatter('manual-page'), `${BODY}\n\nUse ISO dates.`) });
  stored = await h.learning.getMethod('u1', made.id);
  assert.equal(stored.payload.personCorrection.source, 'direct');
  assert.equal(stored.payload.personCorrection.digest, stored.payload.contentDigest);
  await assert.rejects(request('PATCH', `/api/methods/${encodeURIComponent(made.id)}`, { expectedRevision: stored.revision,
    skill: renderMethodSkill(frontmatter('manual-page'), BODY), correctionProof: { source: 'judged' } }), { status: 400 });
  assert.equal(csrf, 3);
});

test('official read-only records are never moved by learned conflict precedence', async () => {
  const h = harness();
  const direct = await h.make('direct', { provenance: { origin: 'explicit' } });
  const officialId = 'method:official:read-only';
  await h.documents.put('u1', 'method', officialId, { ...direct.payload, recordType: 'official-method', readOnly: true }, { expectedRevision: 0 });
  await h.learning.recordRelations('u1', direct.id, [{ type: 'conflicts_with', target: officialId, evidence: 'Opposite text.', proposedBy: 'test' }]);
  const official = await h.documents.get('u1', 'method', officialId);
  assert.equal(official.payload.status, 'approved');
  assert.equal(official.revision, 1);
});

test('B2: delayed distillation completion cannot replace a newer event on the same method', async () => {
  const h = harness();
  const method = await h.make('shared-target');
  let release;
  let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  h.distillation.correctionJudge = { read: async ({ runText }) => {
    if (runText === 'Older correction.') { started(); await waiting; }
    return JSON.stringify({ covers: true, methodQuote: 'Keep the requested reply form.', correctionQuote: runText });
  } };
  const apply = (text, time) => h.distillation.applyCandidate({ ...eventJob, payload: { ...eventJob.payload,
    feedback: [{ id: text, occurredAt: time, detail: { verdict: 'correction', quote: text } }] } }, { id: 'run_2' },
  { candidate: { operation: 'amend', targetMethodId: method.id }, skill: renderMethodSkill(method.payload.frontmatter, `${BODY}

${text}`) });
  const older = apply('Older correction.', at('08'));
  await entered;
  await apply('Newer correction.', at('10'));
  release();
  await assert.rejects(older, { code: 'method_correction_superseded' });
  assert.match((await h.learning.getMethod('u1', method.id)).payload.body, /Newer correction/);
});

test('B3: corrections to a different body or predating the proof cannot revoke it', async () => {
  const h = harness();
  const method = await corrected(h, await h.make('dated-proof'), at('10'));
  await h.learning.recordApplied('u1', method.id, { runId: 'old-use', outcome: 'corrected', at: at('09') }, method.payload.contentDigest);
  await h.learning.recordApplied('u1', method.id, { runId: 'different-body', outcome: 'corrected', at: at('11') }, 'sha256:other');
  assert.ok(methodPersonCorrection((await h.learning.getMethod('u1', method.id)).payload, true));
});

test('B4: retirement while legacy coverage is judged prevents the later recovery commit', async () => {
  const h = harness();
  const method = await legacy(h, 'retired-during-judgement');
  h.learning.verifyLegacyCorrection = async (_owner, row) => {
    await h.learning.retire('u1', row.id, { expectedRevision: row.revision });
    return proofFor(row, at('09'));
  };
  await assert.rejects(h.learning.approve('u1', method.id, { expectedRevision: method.revision }), { code: 'product_revision_conflict' });
  assert.equal((await h.learning.getMethod('u1', method.id)).payload.status, 'retired');
});
