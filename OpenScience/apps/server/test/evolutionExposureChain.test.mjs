import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateExposureAudit, priorDevelopmentRuns, worstExposureTier } from '../src/evolutionExposureChain.mjs';

test('a candidate is as exposed as the most exposed run its code passed through', async () => {
  assert.equal(worstExposureTier([]), 'unknown', 'no audited run is not evidence of absence');
  assert.equal(worstExposureTier(['unexposed', 'unexposed']), 'unexposed');
  assert.equal(worstExposureTier(['unexposed', 'unknown']), 'unknown');
  assert.equal(worstExposureTier(['unknown', 'exposed_uncited', 'unexposed']), 'exposed_uncited', 'observed exposure outranks an unknown trace');
  assert.equal(worstExposureTier(['exposed_uncited', 'cited']), 'cited');
  assert.equal(worstExposureTier(['unexposed', 'something-new']), 'unknown');
  // The reviewer's scenario: the transcript of attempt 3 named the target; attempt 4 carried its code forward.
  const tiers = { 'run-1': 'unexposed', 'run-2': 'unexposed', 'run-3': 'exposed_uncited', 'run-4': 'unexposed' }, audited = [];
  const audit = createCandidateExposureAudit({ auditRun: async ({ runId, projectId }, { policy }) => { audited.push([runId, projectId, policy.aliases[0]]); return { tier: tiers[runId] }; } });
  const lineage = { developmentRuns: ['run-1', 'run-2', 'run-3', 'run-4'], developmentRunProjects: { 'run-1': 'p1', 'run-2': 'p2', 'run-3': 'p3', 'run-4': 'p4' }, developmentProjectId: 'p4' };
  const result = await audit({ lineage }, { policy: { aliases: ['10.1/x'] } });
  assert.equal(result.tier, 'exposed_uncited');
  assert.deepEqual(audited, [['run-1', 'p1', '10.1/x'], ['run-2', 'p2', '10.1/x'], ['run-3', 'p3', '10.1/x'], ['run-4', 'p4', '10.1/x']]);
  // Auditing the last run only, as before, would have called this candidate unexposed.
  assert.equal((await audit({ lineage: { developmentRuns: ['run-4'], developmentProjectId: 'p4' } }, { policy: { aliases: ['10.1/x'] } })).tier, 'unexposed');
  assert.equal((await audit({ lineage: {} }, { policy: { aliases: [] } })).tier, 'unknown');
});

test('the chain is every earlier attempt of the same branch that left a run, whatever its status', async () => {
  const runs = { 'project-0': { id: 'run-a', dispatchId: 'dispatch-0', status: 'succeeded' }, 'project-2': { id: 'run-c', dispatchId: 'dispatch-2', status: 'failed' } }, asked = [];
  const chain = await priorDevelopmentRuns({ attempt: 3, identity: attempt => ({ projectId: `project-${attempt}`, dispatchId: `dispatch-${attempt}` }),
    find: async expected => { asked.push(expected.projectId); const run = runs[expected.projectId]; return run?.dispatchId === expected.dispatchId ? run : null; } });
  assert.deepEqual(asked, ['project-0', 'project-1', 'project-2']);
  assert.deepEqual(chain, [{ runId: 'run-a', projectId: 'project-0', attempt: 0 }, { runId: 'run-c', projectId: 'project-2', attempt: 2 }]);
  assert.deepEqual(await priorDevelopmentRuns({ attempt: 0, identity: () => { throw new Error('a first attempt has no earlier run'); }, find: async () => null }), []);
});

// Ruling of 2026-10-05: a reference the model names from its own memory is `recalled`, not an exposure.
test('a transcript is heard in two voices: the model\'s own reasoning and reply text, and everything it was handed or got back', async () => {
  const { transcriptVoices } = await import('../src/evolutionExposureChain.mjs');
  const transcript = { header: { completeness: 'complete' }, messages: [
    { role: 'user', parts: [{ type: 'text', text: 'the brief' }] },
    { role: 'assistant', parts: [{ type: 'reasoning', text: 'thinking of doi:10.1/x' }, { type: 'tool', tool: 'web_read', status: 'completed', input: { url: 'https://a.example' }, output: 'page text' }, { type: 'text', text: 'my reply' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 42 }, { type: 'note', text: 'an unknown kind of part' }] },
    { role: 'tool', parts: [{ type: 'text', text: 'a tool message' }] }] };
  const { served, own } = transcriptVoices(transcript);
  assert.deepEqual(own, [{ step: { message: 1, part: 0, voice: 'reasoning' }, text: 'thinking of doi:10.1/x' }, { step: { message: 1, part: 2, voice: 'reply' }, text: 'my reply' }]);
  // Everything that is not positively the model's own text stays on the served side, unknown shapes included.
  const rest = JSON.stringify(served);
  assert.doesNotMatch(rest, /thinking of|my reply/);
  for (const kept of ['the brief', 'https://a.example', 'page text', 'an unknown kind of part', 'a tool message', '42', 'complete']) assert.ok(rest.includes(kept), kept);
  assert.equal(JSON.stringify(transcript).includes('thinking of doi:10.1/x'), true, 'the transcript itself is not altered');
  assert.deepEqual(transcriptVoices(null), { served: null, own: [] });
});

test('a recalled run does not raise its branch\'s tier, and the candidate carries where the reference was named', async () => {
  const { referenceRecallNotices } = await import('../src/evolutionExposureChain.mjs');
  assert.equal(worstExposureTier(['unexposed', 'recalled']), 'unexposed');
  assert.equal(worstExposureTier(['recalled']), 'unexposed');
  assert.equal(worstExposureTier(['recalled', 'unknown']), 'unknown');
  assert.equal(worstExposureTier(['recalled', 'exposed_uncited']), 'exposed_uncited', 'a served exposure elsewhere in the chain still stands');
  assert.equal(worstExposureTier(['recalled', 'cited']), 'cited');
  const step = { message: 20, part: 0, voice: 'reasoning' };
  const audit = createCandidateExposureAudit({ auditRun: async ({ runId }) => runId === 'run-1' ? { tier: 'recalled', recalledAt: step } : { tier: 'unexposed' } });
  const result = await audit({ lineage: { developmentRuns: ['run-1', 'run-2'], developmentProjectId: 'p' } }, { policy: { aliases: ['10.1/x'] } });
  assert.equal(result.tier, 'unexposed');
  assert.deepEqual(result.runs.map(run => run.tier), ['recalled', 'unexposed']);
  assert.deepEqual(result.recalled, [{ runId: 'run-1', step }]);
  assert.deepEqual(referenceRecallNotices(result.recalled), [{ code: 'reference_named_from_memory', runId: 'run-1', step, message: 'The builder named the reference paper from memory, at message 20 (reasoning).' }]);
  assert.deepEqual(referenceRecallNotices([{ runId: 'run-9', step: null }])[0].message, 'The builder named the reference paper from memory, at an unrecorded step.');
  assert.deepEqual((await audit({ lineage: { developmentRuns: ['run-2'], developmentProjectId: 'p' } }, { policy: { aliases: [] } })).recalled, []);
});

// The whole path, with the real exclusion layer, the real chain audit, the real evaluator and the real builder: what
// the two live branches of 2026-10-05 would have been under the ruling, and what still parks a branch.
test('a branch whose only finding is a recalled reference validates and publishes with the label; a served one still waits', async t => {
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const { createEvaluationIsolation } = await import('../src/evaluationIsolation.mjs');
  const { createEvolutionCandidateEvaluator } = await import('../src/evolutionCandidateEvaluator.mjs');
  const { createEvolutionBuilder } = await import('../src/evolutionBuild.mjs');
  const { auditDevelopmentTranscript, referenceRecallLabel } = await import('../src/evolutionExposureChain.mjs');
  const { pythonExecVerify } = await import('./helpers/pythonExecVerify.mjs');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-chain-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, 'paper-gold/candidate-cases'), { recursive: true });
  // Two published hidden cases; their publication ids are what the candidate's policy excludes.
  const definition = { methodId: 'method', frozen: true, referenceImplementation: { implementationId: 'fixture-reference', language: 'python', code: "import json,sys\nprint(json.dumps({'numeric':{'value':json.load(sys.stdin)['x']}}))\n" },
    cases: [3, 5].map(id => ({ id: `opaque-${id}`, hidden: true, kind: 'published', publicationId: `10.1136/paper.${id}`, independentQa: { passed: true }, sourceHash: 'a'.repeat(64), input: { x: id }, numeric: { value: { value: id, absoluteTolerance: 0 } } })) };
  await fs.writeFile(path.join(dataDir, 'paper-gold/candidate-cases/method.json'), JSON.stringify(definition));
  const brief = { role: 'user', parts: [{ type: 'text', text: 'Implement the method from the card.' }] };
  const transcripts = {
    // The live shape: the model thinks of the method paper's DOI while drafting a reference; nothing handed it over.
    'run-recalled': { header: { completeness: 'complete' }, messages: [brief, { role: 'assistant', parts: [{ type: 'reasoning', text: 'Background reference, from memory: doi:10.1136/paper.3. Let me not over-cite.' }, { type: 'text', text: 'Submitted.' }] }] },
    'run-clean': { header: { completeness: 'complete' }, messages: [brief, { role: 'assistant', parts: [{ type: 'reasoning', text: 'A plain implementation.' }, { type: 'text', text: 'Submitted.' }] }] },
    'run-served': { header: { completeness: 'complete' }, messages: [brief, { role: 'assistant', parts: [{ type: 'tool', tool: 'mcp__evimed__web_read', status: 'completed', output: '{"status":"ok","data":{"doi":"10.1136/paper.3"}}' }, { type: 'text', text: 'Submitted.' }] }] } };
  const isolation = createEvaluationIsolation({ dataDir });
  const auditCandidateExposure = createCandidateExposureAudit({ auditRun: ({ runId, projectId }, { policy }) => auditDevelopmentTranscript({ isolation, identity: { userId: 'operator', projectId, runId }, policy, transcript: transcripts[runId] }) });
  // The retraction screen asks Crossref about DOI-shaped publications; here it is answered locally, with a clean record.
  const screened = [], fetchImpl = async url => { screened.push(String(url)); return { ok: true, json: async () => ({ message: {} }) }; };
  const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir, evaluationDataDir: dataDir }, auditCandidateExposure, fetchImpl, controller: { execVerify: pythonExecVerify({}) } });
  const build = async (id, developmentRuns) => {
    const published = [];
    const builder = createEvolutionBuilder({ verification: { verify: async () => ({ ok: true }) }, evaluator: { evaluate: (candidate, options) => evaluator.evaluate(candidate, { ...options, card: { methodId: 'method' } }) },
      dispatch: async () => ({ id, publicationKind: 'isolated-tool', entrypoint: 'scripts/estimate.py:estimate', files: { 'SKILL.md': `Public instructions for ${id}`, 'scripts/estimate.py': "def estimate(x): return {'value':x}" }, lineage: { developmentRuns, developmentProjectId: `eval-paper-build-${id}` } }),
      publisher: { publish: async (candidate, { evaluation }) => { published.push({ candidate, evaluation }); return { id: `publication-${id}` }; } } });
    return { built: await builder.build({ id: 'dossier', methodId: 'method' }), published };
  };
  // One branch, two attempts: the first run recalled the reference, the second did not. Before the ruling the chain's
  // worst tier was `exposed_uncited` and this candidate waited for ever.
  const recalled = await build('recalled-branch', ['run-recalled', 'run-clean']);
  assert.equal(recalled.built.status, 'published', JSON.stringify(recalled.built.feedback));
  assert.ok(screened.length >= 2 && screened.every(url => url.startsWith('https://api.crossref.org/works/')), 'the screen was answered by the stub, not the network');
  const verdict = recalled.published[0].evaluation;
  assert.deepEqual([verdict.ok, verdict.verificationLevel, verdict.exposureTier], [true, 'V2', 'unexposed']);
  const step = { message: 1, part: 0, voice: 'reasoning' };
  assert.deepEqual(referenceRecallLabel(verdict), { referenceRecall: [{ code: 'reference_named_from_memory', runId: 'run-recalled', step, message: 'The builder named the reference paper from memory, at message 1 (reasoning).' }] });
  assert.equal((await isolation.audit('run-recalled')).tier, 'recalled'); assert.equal((await isolation.audit('run-clean')).tier, 'unexposed');
  assert.equal(isolation.counters.recalled, 1);
  // The evaluation's receipt records it too.
  const receipt = JSON.parse(await fs.readFile(path.join(dataDir, 'paper-gold/candidate-evaluations', `${verdict.evaluationReceiptHash}.json`), 'utf8'));
  assert.deepEqual(receipt.notices.map(row => [row.code, row.runId]), [['reference_named_from_memory', 'run-recalled']]); assert.equal(receipt.exposureTier, 'unexposed');
  // A branch that was served the paper still waits, and says why; a clean branch publishes with no label.
  const served = await build('served-branch', ['run-served', 'run-clean']);
  assert.deepEqual([served.built.status, served.published.length], ['repair', 0]);
  assert.equal((await isolation.audit('run-served')).tier, 'exposed_uncited');
  const clean = await build('clean-branch', ['run-clean']);
  assert.equal(clean.built.status, 'published'); assert.deepEqual(referenceRecallLabel(clean.published[0].evaluation), {});
  assert.equal(isolation.counters.recalled, 1);
  // The published tool's record takes the label from the same verdict.
  const composition = await fs.readFile(new URL('../src/evolutionComposition.mjs', import.meta.url), 'utf8');
  assert.ok(composition.includes('...referenceRecallLabel(verdict) });') && composition.includes('await auditDevelopmentTranscript({ isolation: evaluationIsolation,'));
});
