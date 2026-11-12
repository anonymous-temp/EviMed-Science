/** Explicit, audited source-contract repair. No provider calls, new patient facts, reranking or decision rewriting. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { contentDigest, profileIdentity, validateMatchingResult } from '../../packages/patient-matching-core/index.mjs';
import { patientMatchingConfiguration } from '../../apps/server/src/patientMatchingConfiguration.mjs';
import { campaignSourceModelIdentity, verifyCampaignSources } from './campaign-host.mjs';
const atomic = async (filename, value) => { const temporary = `${filename}.${randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, filename); };

export async function repairCampaign({ configPath, newSourceFiles, previousSourceDigest, previousArchive, issue, receiptPath }) {
  assert.match(issue, /^[a-z0-9-]{8,100}$/);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const lock = path.join(config.out, 'run.lock');
  await fs.mkdir(lock, { mode: 0o700 });
  try {
  await atomic(path.join(lock, 'owner.json'), { kind: 'source-repair', pid: process.pid, issue, at: new Date().toISOString() });
  assert.equal(config.sourceFilesDigest, previousSourceDigest, 'The repair must name the exact previous source phase');
  const oldBytes = await fs.readFile(config.sourceFiles); assert.equal(contentDigest(oldBytes), previousSourceDigest);
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const [filename, digest] of Object.entries(JSON.parse(oldBytes))) {
    const relative = filename.startsWith(repository + '/') ? filename.slice(repository.length + 1) : `external/${filename.slice(1)}`;
    assert.equal(contentDigest(await fs.readFile(path.join(previousArchive, relative))), digest, 'Previous execution source bytes were not preserved');
  }
  const sourceBytes = await fs.readFile(newSourceFiles), newDigest = contentDigest(sourceBytes);
  assert.notEqual(newDigest, previousSourceDigest, 'A repair needs a reviewed source change');
  const nextConfig = { ...config, sourceFiles: path.resolve(newSourceFiles), sourceFilesDigest: newDigest };
  await verifyCampaignSources(nextConfig);
  const modelProfile = patientMatchingConfiguration({}, {}), reasoning = { provider: 'deepseek', model: modelProfile.reasoningModel, reasoningEffort: 'high', maxTokens: 16000 };
  const profileDigest = profileIdentity({ modelProfile, reasoning });
  if (config.sourceRepair) assert.equal(contentDigest(await fs.readFile(config.sourceRepair.receipt)), config.sourceRepair.digest, 'Previous repair receipt changed');
  const planned = [], receipt = { schemaVersion: 1, issue, previousSourceDigest, newSourceDigest: newDigest, previousArchive: path.resolve(previousArchive),
    previousRepair: config.sourceRepair ?? null, at: new Date().toISOString(), providerCalls: 0, budgetReset: false, unchangedModelProfileDigest: profileDigest,
    depths: Object.fromEntries(Object.entries(config.boards).map(([board, definition]) => [board, { mainRanking: board === 'sigir' ? 'all-supplied-pairs' : 100, fullClinical: definition.clinicalDepth ?? 'all-supplied-pairs' }])), topics: [] };
  for (const [board, definition] of Object.entries(config.boards)) {
    const casesBytes = await fs.readFile(definition.cases); assert.equal(contentDigest(casesBytes), definition.casesDigest);
    assert.equal(contentDigest(await fs.readFile(definition.collection)), definition.collectionDigest);
    const indexDigest = definition.indexManifest ? contentDigest(await fs.readFile(definition.indexManifest)) : null;
    if (definition.indexManifest) assert.equal(indexDigest, definition.indexManifestDigest);
    const oldIdentity = campaignSourceModelIdentity({ artifactSha256: config.artifactSha256, definition, indexDigest, sourceIdentity: previousSourceDigest, modelProfile });
    const nextIdentity = campaignSourceModelIdentity({ artifactSha256: config.artifactSha256, definition, indexDigest, sourceIdentity: newDigest, modelProfile });
    for (const row of casesBytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse)) {
      const filename = path.join(config.out, 'topics', `${row.patientId}.json`); let state;
      try { state = JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      assert.equal(state.inputDigest, contentDigest(JSON.stringify(row)));
      assert.equal(state.sessionId, `campaign-${config.sessionNamespace}-${row.patientId.toLowerCase()}`);
      assert.ok(state.sourceModelIdentity === oldIdentity || state.sourceModelIdentity === nextIdentity && state.sourceRepair?.issue === issue);
      assert.notEqual(state.status, 'complete', 'Completed topics must not be replayed');
      if (state.result) { validateMatchingResult(state.result); assert.equal(state.result.profileDigest, profileDigest, 'A changed clinical profile needs a separate protocol'); }
      const identities = { sessionId: state.sessionId, taskId: state.context?.taskId ?? null, searchId: state.discovery?.searchId ?? null,
        contextDigest: profileIdentity(state.context ?? null), rankingDigest: profileIdentity(state.discovery ?? null), resultDigest: profileIdentity(state.result ?? null),
        resultId: state.result?.resultId ?? null, revision: state.result?.revision ?? null, currentDecisions: state.result?.rows.filter(value => value.current).map(value => value.decisionId) ?? [] };
      state.sourceRepair = { issue, previousSourceModelIdentity: oldIdentity, newSourceModelIdentity: nextIdentity, previous: state.sourceRepair ?? null,
        acceptedFailureThroughSegment: state.nativeSegments, priorStopReason: state.stopReason ?? null, at: receipt.at };
      state.sourceModelIdentity = nextIdentity; state.status = 'pending'; state.ended = false; delete state.endedAt; delete state.stopReason;
      planned.push({ filename, state }); receipt.topics.push({ board, patientId: row.patientId, ...identities, ...state.sourceRepair });
    }
  }
  receipt.currentDecisionsPreserved = receipt.topics.reduce((sum, row) => sum + row.currentDecisions.length, 0);
  receipt.cachedRankingsPreserved = receipt.topics.filter(row => row.searchId).length;
  // A crash mid-publication leaves source identities mismatched, so normal launch fails closed until this explicit repair is completed.
  await atomic(receiptPath, receipt);
  for (const item of planned) await atomic(item.filename, item.state);
  nextConfig.sourceRepair = { issue, receipt: path.resolve(receiptPath), digest: contentDigest(await fs.readFile(receiptPath)) };
  await atomic(configPath, nextConfig);
  return receipt;
  } finally { await fs.rm(lock, { recursive: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['config', 'new-source-files', 'previous-source-digest', 'previous-archive', 'issue', 'receipt'].map(name => [name, { type: 'string' }])) });
  for (const name of ['config', 'new-source-files', 'previous-source-digest', 'previous-archive', 'issue', 'receipt']) if (!values[name]) throw new Error(`--${name} is required`);
  const result = await repairCampaign({ configPath: values.config, newSourceFiles: values['new-source-files'], previousSourceDigest: values['previous-source-digest'], previousArchive: values['previous-archive'], issue: values.issue, receiptPath: values.receipt });
  process.stdout.write(JSON.stringify({ topics: result.topics.length, currentDecisionsPreserved: result.currentDecisionsPreserved, cachedRankingsPreserved: result.cachedRankingsPreserved, newSourceDigest: result.newSourceDigest }) + '\n');
}
