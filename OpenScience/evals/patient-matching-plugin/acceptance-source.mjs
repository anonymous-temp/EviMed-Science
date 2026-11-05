/** The same frozen source/model/harness identity is verified by preparation, execution and export. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { contentDigest, profileIdentity, validateMatchingResult, validateTrialProfile } from '../../packages/patient-matching-core/index.mjs';
import { patientMatchingConfiguration } from '../../apps/server/src/patientMatchingConfiguration.mjs';
import { verifyCampaignSources } from './campaign-host.mjs';

export const acceptanceModelProfile = () => patientMatchingConfiguration({}, {});
export const acceptanceReasoningProfileDigest = () => {
  const modelProfile = acceptanceModelProfile(), reasoning = { provider: 'deepseek', model: modelProfile.reasoningModel, reasoningEffort: 'high', maxTokens: 16000 };
  return profileIdentity({ modelProfile, reasoning });
};
export const acceptanceSourceIdentity = ({ artifactSha256, definition, sourceIdentity, harnessSourcesDigest }) =>
  contentDigest(JSON.stringify({ artifactSha256, definition, sourceIdentity, harnessSourcesDigest, modelProfile: acceptanceModelProfile() }));
export const acceptanceScope = sessionId => ({ tenantId: 'matching-campaign-owner', actorId: 'matching-campaign-owner', projectId: 'matching-campaign-project', conversationId: sessionId });
export function assertAcceptanceSavedIdentity({ state, one, config, definition, sourceIdentity }) {
  validateMatchingResult(state.result);
  assert.equal(state.inputDigest, contentDigest(JSON.stringify(one)));
  assert.equal(state.artifactSha256, config.artifactSha256, 'Saved state belongs to another installed bundle');
  assert.equal(state.result.pluginGeneration, `campaign-${config.artifactSha256}`, 'Saved result belongs to another native generation');
  assert.equal(state.sourceModelIdentity, acceptanceSourceIdentity({ artifactSha256: config.artifactSha256, definition, sourceIdentity, harnessSourcesDigest: config.harnessSourcesDigest }));
  assert.equal(state.sessionId, `campaign-${config.sessionNamespace}-${one.patientId.toLowerCase()}`);
  assert.deepEqual(state.result.scope, acceptanceScope(state.sessionId));
  assert.equal(state.result.profileDigest, acceptanceReasoningProfileDigest());
  assert.equal(state.result.taskId, (state.protocol ?? state.context).taskId);
  assert.ok(state.result.rows.every(row => row.subjectKey === state.context.subjectKey));
  const selected = state.protocol ? [state.protocol.protocolVersionId] : one.candidateIds;
  assert.equal(state.result.rows.length, one.candidateCount, 'Saved result does not retain every requested pair');
  assert.deepEqual(state.result.rows.map(row => row.trialId).sort(), [...selected].sort(), 'Saved result contains a different trial selection');
}
export function assertAcceptancePreparedProfile(profile, result) {
  validateTrialProfile(profile); assert.deepEqual(profile.scope, result.scope);
  assert.equal(contentDigest(profile.preservedText), profile.source.digest);
  for (const clause of profile.criteria) assert.equal(profile.preservedText.slice(clause.span.start, clause.span.end), clause.text);
  // Pending placeholders have no clinical decision and intentionally carry no sourceRefs.
  for (const row of result.rows.filter(candidate => candidate.current && candidate.trialId === profile.trialId)) {
    assert.deepEqual(row.sourceRefs.find(source => source.sourceId === profile.source.sourceId), profile.source, 'Saved row has another trial source');
  }
}
export async function verifyAcceptanceSources(config) {
  const sourceIdentity = await verifyCampaignSources(config);
  const harnessBytes = await fs.readFile(config.harnessSources);
  assert.equal(contentDigest(harnessBytes), config.harnessSourcesDigest, 'Acceptance harness receipt changed');
  for (const [filename, digest] of Object.entries(JSON.parse(harnessBytes))) assert.equal(contentDigest(await fs.readFile(filename)), digest, 'Acceptance harness source changed');
  for (const [board, definition] of Object.entries(config.boards)) {
    assert.ok(['incidents', 'criterion', 'n2c2'].includes(board));
    assert.equal(contentDigest(await fs.readFile(definition.cases)), definition.casesDigest, 'Frozen runtime cases changed');
    const collection = await fs.readFile(definition.collection);
    assert.equal(contentDigest(collection), definition.collectionDigest, 'Frozen collection manifest changed');
    const parsed = JSON.parse(collection), databasePath = path.resolve(path.dirname(definition.collection), parsed.databasePath);
    assert.equal(contentDigest(await fs.readFile(databasePath)), `sha256:${parsed.databaseSha256}`, 'Frozen source collection changed');
    if (definition.protocolPath) assert.equal(contentDigest(await fs.readFile(definition.protocolPath)), definition.protocolDigest, 'Original guide protocol changed');
  }
  return sourceIdentity;
}
