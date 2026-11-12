/** Export all requested native campaign topics through the unchanged saved-result adapter. No labels are read. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { contentDigest, profileIdentity } from '../../packages/patient-matching-core/index.mjs';
import { patientMatchingConfiguration } from '../../apps/server/src/patientMatchingConfiguration.mjs';
import { exportNativeResults, nativeMappingDigest } from '../vcr-matching-boards/native_projection.mjs';
import { campaignSourceModelIdentity, verifyCampaignSources } from './campaign-host.mjs';
const lines = bytes => bytes.toString().split('\n').filter(line => line.trim()).map(JSON.parse);
const json = async (filename, value) => fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const jsonl = async (filename, values) => fs.writeFile(filename, values.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
export async function exportCampaign(configPath, out) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const sourceIdentity = await verifyCampaignSources(config);
  await fs.mkdir(out, { mode: 0o700 });
  const summary = { schemaVersion: '1', source: 'saved-native-postgres-result-projection', boards: {}, originalSigirQueries: 59, requestedSigirJudgedTopics: 58,
    omittedSigirZeroCandidateTopic: 'sigir-201428', sourceIdentity, noEligibilityRescore: true, noLabelInput: true };
  summary.sourceRepairs = [];
  const seenRepairs = new Set(); let repair = config.sourceRepair;
  while (repair) {
    if (seenRepairs.has(repair.digest)) throw new Error('Cyclic source repair history'); seenRepairs.add(repair.digest);
    const repairBytes = await fs.readFile(repair.receipt);
    if (contentDigest(repairBytes) !== repair.digest) throw new Error('Source repair receipt changed');
    const file = `source-repair-receipt-${summary.sourceRepairs.length + 1}.json`;
    await fs.writeFile(path.join(out, file), repairBytes, { mode: 0o600, flag: 'wx' });
    summary.sourceRepairs.push({ issue: repair.issue, file, digest: repair.digest }); repair = JSON.parse(repairBytes).previousRepair;
  }
  const stages = { lexical: [], dense: [], fused: [], rerank: [], 'clinical-input': [], clinical: [] };
  summary.depths = Object.fromEntries(Object.entries(config.boards).map(([board, definition]) => [board, { mainRanking: board === 'sigir' ? 'all-supplied-pairs' : 100, fullClinical: definition.clinicalDepth ?? 'all-supplied-pairs' }]));
  let historicalSplit = null;
  if (Object.keys(config.boards).some(board => board !== 'sigir')) {
    const splitBytes = await fs.readFile(new URL('../vcr-matching-boards/split_e.json', import.meta.url)); historicalSplit = JSON.parse(splitBytes);
    summary.historicalSplitDigest = contentDigest(splitBytes);
  }
  for (const [board, definition] of Object.entries(config.boards)) {
    const collectionBytes = await fs.readFile(definition.collection);
    if (contentDigest(collectionBytes) !== definition.collectionDigest) throw new Error('Frozen collection changed');
    const indexDigest = definition.indexManifest ? contentDigest(await fs.readFile(definition.indexManifest)) : null;
    if (definition.indexManifest && indexDigest !== definition.indexManifestDigest) throw new Error('Frozen index changed');
    const modelProfile = patientMatchingConfiguration({}, {}), reasoning = { provider: 'deepseek', model: modelProfile.reasoningModel, reasoningEffort: 'high', maxTokens: 16000 };
    const expectedIdentity = campaignSourceModelIdentity({ artifactSha256: config.artifactSha256, definition, indexDigest, sourceIdentity, modelProfile });
    const originalBytes = await fs.readFile(definition.cases);
    if (contentDigest(originalBytes) !== definition.casesDigest) throw new Error('Frozen requested topics changed');
    const original = lines(originalBytes), states = [];
    for (const row of original) {
      try {
        const state = JSON.parse(await fs.readFile(path.join(config.out, 'topics', `${row.patientId}.json`), 'utf8'));
        if (state.inputDigest !== contentDigest(JSON.stringify(row)) || state.sourceModelIdentity !== expectedIdentity) throw new Error('Frozen topic/source/model identity differs');
        if (definition.clinicalDepth && state.discovery) {
          const fullIds = state.discovery.candidates.map(item => item.registryId), selected = fullIds.slice(0, definition.clinicalDepth);
          if (profileIdentity(state.case.candidateIds) !== profileIdentity(selected) || profileIdentity(state.clinicalSelection?.registryIds) !== profileIdentity(selected)
            || profileIdentity(state.case.retrievedCandidateIds) !== profileIdentity(fullIds) || state.clinicalSelection.parentSearchId !== state.discovery.searchId) throw new Error('Frozen clinical subset differs from its full parent relevance order');
        }
        states.push(state);
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; states.push({ case: row, sessionId: `campaign-${config.sessionNamespace}-${row.patientId.toLowerCase()}` }); }
    }
    const cases = states.map(state => state.case), results = states.filter(state => state.result).map(state => state.result);
    const directory = path.join(out, board); await fs.mkdir(directory);
    const scorer = path.join(config.out, 'TrialGPT2-pinned/scripts/eval_trialgpt_rankings_qrels.py');
    // Resolve the repository scorer relative to this module, independent of the private campaign's location.
    const scorerBytes = board === 'sigir' ? await fs.readFile(scorer) : await fs.readFile(new URL('../vcr-matching-boards/score_e.py', import.meta.url));
    const collection = JSON.parse(collectionBytes);
    const configuration = { schemaVersion: '1', board, language: 'en', casesDigest: profileIdentity(cases),
      plugin: { generation: `campaign-${config.artifactSha256}`, artifactDigest: `sha256:${config.artifactSha256}`, profileDigest: results[0]?.profileDigest ?? profileIdentity({ modelProfile, reasoning }) },
      metricProfile: { id: board === 'sigir' ? 'trialgpt-judged-pair-ranking' : 'trec-full-corpus', revision: 'native-full-campaign-20261105-v1',
        scorer: { id: board === 'sigir' ? 'trialgpt-official' : 'trec-official-profile', version: board === 'sigir' ? '1c5f9ebc3b98d1f780ceea68043efdaa2daba880' : 'score-e-v1', digest: contentDigest(scorerBytes) },
        inputManifestDigest: profileIdentity({ definition, sourceIdentity, sourceRepairs: summary.sourceRepairs, depth: summary.depths[board] }), corpusDigest: `sha256:${collection.databaseSha256}`, aggregation: board === 'sigir' ? 'official-profile' : 'per-year-official-profile', mappingPolicyDigest: `sha256:${'0'.repeat(64)}` },
      bindings: states.map(state => ({ patientId: state.case.patientId,
        scope: state.result?.scope ?? { tenantId: 'matching-campaign-owner', actorId: 'matching-campaign-owner', projectId: 'matching-campaign-project', conversationId: state.sessionId },
        subjectKey: state.context?.subjectKey ?? `unread:${state.case.patientId}`, resultId: state.result?.resultId ?? null, revision: state.result?.revision ?? null,
        pairs: state.case.candidateIds.map(registryId => ({ trialId: registryId, registryId })) })) };
    configuration.metricProfile.mappingPolicyDigest = nativeMappingDigest(configuration);
    const projection = exportNativeResults({ cases, results, configuration });
    projection.receipt.sourceIdentity = sourceIdentity;
    projection.receipt.sourceRepairs = summary.sourceRepairs;
    projection.receipt.depth = summary.depths[board];
    await jsonl(path.join(directory, 'cases.jsonl'), cases); await jsonl(path.join(directory, 'saved-results.jsonl'), results); await json(path.join(directory, 'profile.json'), configuration);
    await jsonl(path.join(directory, 'judgments.jsonl'), projection.records); await json(path.join(directory, 'receipt.json'), projection.receipt);
    if (board !== 'sigir') {
      const year = Number(board.slice(4)), cohort = `trec_${year}`, test = new Set(historicalSplit.test[cohort]);
      await jsonl(path.join(directory, 'historical-test-judgments.jsonl'), projection.records.filter(row => test.has(row.patientId)));
      for (const [index, state] of states.entries()) {
        const topic = state.case.patientId;
        const orders = { lexical: state.discovery?.retrieval?.retrievedIds ?? [], dense: (state.denseRetrieval?.data?.candidates ?? []).map(row => row.registryId),
          fused: state.discovery?.rerank?.incomingOrder ?? [], rerank: state.discovery?.rerank?.finalOrder ?? [], 'clinical-input': state.case.candidateIds, clinical: projection.records[index].ranking.map(row => row.registryId) };
        for (const [stage, order] of Object.entries(orders)) stages[stage].push({ topic, year, retrieved: order, status: state.status ?? 'missing',
          stageState: stage === 'dense' ? state.denseRetrieval?.status ?? 'not-run' : stage === 'rerank' ? state.discovery?.rerank?.state ?? 'not-run' : undefined });
      }
    }
    summary.boards[board] = projection.receipt.counts;
  }
  for (const [stage, rows] of Object.entries(stages)) {
    if (!rows.length) continue;
    await jsonl(path.join(out, `trec-${stage}.jsonl`), rows);
    await jsonl(path.join(out, `trec-${stage}-historical-test.jsonl`), rows.filter(row => new Set(historicalSplit.test[`trec_${row.year}`]).has(row.topic)));
  }
  await json(path.join(out, 'receipt.json'), summary); return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, out: { type: 'string' } } });
  if (!values.config || !values.out) throw new Error('--config and fresh --out are required');
  process.stdout.write(JSON.stringify(await exportCampaign(values.config, values.out)) + '\n');
}
