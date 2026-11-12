import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentDigest, profileIdentity, projectMatchingResult } from '../../packages/patient-matching-core/index.mjs';
import { patientMatchingConfiguration } from '../../apps/server/src/patientMatchingConfiguration.mjs';
import { campaignSourceModelIdentity } from './campaign-host.mjs';
import { repairCampaign } from './campaign-repair.mjs';
test('contract repair preserves session, task, search and valid result; acknowledges only the failed boundary and releases its lock', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-repair-'));
  try {
    const artifact = path.join(directory, 'artifact'), module = path.join(directory, 'host.mjs'), oldFiles = path.join(directory, 'old-source.json'), newFiles = path.join(directory, 'new-source.json'), archive = path.join(directory, 'archive');
    await fs.writeFile(artifact, 'same bundle'); await fs.writeFile(module, 'old contract');
    const oldBytes = JSON.stringify({ [module]: contentDigest('old contract') }); await fs.writeFile(oldFiles, oldBytes);
    const archived = path.join(archive, 'external', module.slice(1)); await fs.mkdir(path.dirname(archived), { recursive: true }); await fs.writeFile(archived, 'old contract');
    await fs.writeFile(module, 'fixed contract'); const newBytes = JSON.stringify({ [module]: contentDigest('fixed contract') }); await fs.writeFile(newFiles, newBytes);
    const row = { patientId: 'sigir-1', note: 'Original public input', candidateIds: ['NCT00000001', 'NCT00000002'] }, caseBytes = JSON.stringify(row) + '\n';
    const cases = path.join(directory, 'cases.jsonl'), collection = path.join(directory, 'collection.json'); await fs.writeFile(cases, caseBytes); await fs.writeFile(collection, '{}');
    const definition = { cases, casesDigest: contentDigest(caseBytes), collection, collectionDigest: contentDigest('{}') };
    const modelProfile = patientMatchingConfiguration({}, {}), reasoning = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 16000 }, profileDigest = profileIdentity({ modelProfile, reasoning });
    const scope = { tenantId: 'matching-campaign-owner', actorId: 'matching-campaign-owner', projectId: 'matching-campaign-project', conversationId: 'campaign-test-sigir-1' }, source = { sourceId: 'patient-source', revision: '1', digest: contentDigest('source'), kind: 'patient' };
    const pair = { subjectKey: 'subject-preserved', trialId: row.candidateIds[0] }, task = { schemaVersion: '1', taskId: 'task-preserved', direction: 'patient-to-trials', objective: 'Frozen task', scope, pluginGeneration: 'same-generation', sources: [source], selectedPairs: [pair, { ...pair, trialId: row.candidateIds[1] }], budgets: { maxPairs: 2, maxEvidenceReads: 1, maxModelCalls: 1 } };
    const decision = { schemaVersion: '1', decisionId: 'decision-preserved', revision: '1', scope, ...pair, state: 'complete', clinicalEligibility: 'eligible', recommendation: { priority: 0.75, rationale: 'Source-backed fixture' }, criteria: [{ criterionId: 'c1', kind: 'inclusion', verdict: 'satisfied', basis: 'stated', evidenceIds: ['e1'], assumptions: [], reason: 'Original model decision' }], sourceRefs: [source], profileDigest, producer: { kind: 'model', modelProfileDigest: profileDigest, executionId: 'old-execution' }, evidenceBundleId: 'bundle', unresolvedFacts: [], assumptions: [] };
    const result = projectMatchingResult({ task, resultId: 'result-preserved', revision: '1', decisions: [decision], profileDigest });
    const configPath = path.join(directory, 'config.json'), config = { out: directory, artifact, artifactSha256: contentDigest('same bundle').slice(7), sourceFiles: oldFiles, sourceFilesDigest: contentDigest(oldBytes), sessionNamespace: 'test', boards: { sigir: definition } };
    const state = { board: 'sigir', case: row, sessionId: scope.conversationId, inputDigest: contentDigest(JSON.stringify(row)), sourceModelIdentity: campaignSourceModelIdentity({ artifactSha256: config.artifactSha256, definition, indexDigest: null, sourceIdentity: config.sourceFilesDigest, modelProfile }),
      context: { taskId: task.taskId, subjectKey: pair.subjectKey }, discovery: { searchId: 'search-preserved', rerank: { state: 'complete', finalOrder: row.candidateIds } }, result, nativeSegments: 2, lastSavedSegment: 1, ended: true, status: 'partial', stopReason: 'native_root_tool_failed' };
    await fs.mkdir(path.join(directory, 'topics')); const stateFile = path.join(directory, 'topics/sigir-1.json'); await fs.writeFile(stateFile, JSON.stringify(state)); await fs.writeFile(configPath, JSON.stringify(config));
    const options = { configPath, newSourceFiles: newFiles, previousSourceDigest: config.sourceFilesDigest, previousArchive: archive, issue: 'output-contract-repair', receiptPath: path.join(directory, 'repair.json') }, receipt = await repairCampaign(options), after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(after.sessionId, state.sessionId); assert.deepEqual(after.context, state.context); assert.deepEqual(after.discovery, state.discovery); assert.deepEqual(after.result, result);
    assert.equal(after.nativeSegments, 2); assert.equal(after.lastSavedSegment, 1); assert.equal(after.sourceRepair.acceptedFailureThroughSegment, 2);
    assert.equal(receipt.currentDecisionsPreserved, 1); assert.equal(receipt.cachedRankingsPreserved, 1); assert.equal(receipt.providerCalls, 0); assert.equal(receipt.budgetReset, false);
    await assert.rejects(fs.access(path.join(directory, 'run.lock')), error => error.code === 'ENOENT');
    await assert.rejects(repairCampaign(options), /exact previous source phase/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
