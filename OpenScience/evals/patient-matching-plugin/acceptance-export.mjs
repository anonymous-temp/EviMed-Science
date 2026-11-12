/** Read-only saved-result projection. Run after the native host has stopped; scoring inputs never reach DSH. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { CRITERIA } from '../vcr-matching/n2c2/criteria.mjs';
import { projectAcceptance, incidentFindings } from './acceptance-inputs.mjs';
import { contentDigest } from '../../packages/patient-matching-core/index.mjs';
import { assertAcceptanceSavedIdentity, assertAcceptancePreparedProfile, verifyAcceptanceSources } from './acceptance-source.mjs';

const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const write = async (filename, value) => fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const lines = async (filename, values) => fs.writeFile(filename, values.map(value => JSON.stringify(value)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
export async function exportAcceptance({ configPath, out }) {
  const config = await read(configPath), root = path.dirname(configPath), scoring = path.join(root, 'scoring');
  assert.notEqual(config.executionStatus, 'user-skipped', 'The owner skipped evaluation; no judgments or pass metrics may be exported');
  const sourceIdentity = await verifyAcceptanceSources(config);
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const cTrials = await read(path.join(scoring, 'criterion-trials.json'));
  const expectations = await read(path.join(scoring, 'incident-expectations.json'));
  const mappings = [], incidents = [], producerExecutions = new Set(), profileDigests = new Set(), files = {};
  const coverage = {}, criteriaJudgments = [], n2c2Judgments = [];
  for (const [board, definition] of Object.entries(config.boards)) {
    const bytes = await fs.readFile(definition.cases); assert.equal(contentDigest(bytes), definition.casesDigest);
    const cases = bytes.toString().trim().split('\n').map(JSON.parse);
    coverage[board] = { requestedPatients: cases.length, requestedPairs: 0, currentPairs: 0, missingResults: 0, mappedClauses: 0, unmappedClauses: 0, ambiguousClauses: 0 };
    for (const one of cases) {
      coverage[board].requestedPairs += one.candidateCount;
      const statePath = path.join(config.out, 'topics', `${one.patientId}.json`);
      let state; try { state = await read(statePath); files[statePath] = contentDigest(await fs.readFile(statePath)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let projected = { patientId: one.patientId, status: 'none', ranking: [] };
      if (state?.result) {
        assertAcceptanceSavedIdentity({ state, one, config, definition, sourceIdentity });
        const profiles = new Map();
        for (let segment = 1; segment <= state.nativeSegments; segment++) {
          const filename = path.join(config.out, 'topics', `${one.patientId}-prepared-${segment}.json`);
          let prepared; try { prepared = await read(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
          files[filename] = contentDigest(await fs.readFile(filename));
          for (const profile of prepared.trialProfiles) {
            assertAcceptancePreparedProfile(profile, state.result);
            const old = profiles.get(profile.trialId); if (old) assert.deepEqual(profile, old);
            profiles.set(profile.trialId, profile);
          }
        }
        const requestedTrials = board === 'criterion' ? cTrials[one.patientId] : board === 'n2c2'
          ? [{ registryId: null, trialId: state.protocol.protocolVersionId, clauses: CRITERIA.map((item, index) => ({ annotationId: item.tag, number: index, kind: 'inclusion', text: item.sourceText })) }]
          : one.candidateIds.map(registryId => ({ registryId }));
        const result = projectAcceptance({ patientId: one.patientId, result: state.result, profiles: [...profiles.values()], requestedTrials });
        projected = result.judgment; mappings.push(...result.mappings);
        for (const row of result.mappings) coverage[board][row.state === 'literal' ? 'mappedClauses' : row.state === 'ambiguous' ? 'ambiguousClauses' : 'unmappedClauses']++;
        coverage[board].currentPairs += projected.ranking.filter(row => row.native.current).length;
        for (const row of projected.ranking) if (row.native.current && row.native.producer?.kind === 'model') { producerExecutions.add(row.native.producer.executionId); profileDigests.add(row.native.producer.modelProfileDigest); }
      } else coverage[board].missingResults++;
      if (board === 'criterion') criteriaJudgments.push(projected);
      if (board === 'n2c2') {
        const labels = {};
        for (const item of projected.ranking[0]?.criteria ?? []) labels[CRITERIA[item.number].tag] = { label: item.label, basis: item.basis, sentenceIds: [] };
        n2c2Judgments.push({ patientId: one.patientId, status: projected.status, labels });
      }
      if (board === 'incidents') {
        const expectation = expectations.find(row => `inc-${row.id}` === one.patientId); assert.ok(expectation);
        incidents.push({ id: expectation.id, findings: incidentFindings(expectation.expect, projected.ranking[0]) });
      }
    }
  }
  assert.ok(producerExecutions.size, 'No current native model-produced result exists; no judgments or pass metrics may be exported');
  await lines(path.join(out, 'criterion-judgments.jsonl'), criteriaJudgments);
  await lines(path.join(out, 'n2c2-judgments.jsonl'), n2c2Judgments);
  await write(path.join(out, 'annotation-mapping.json'), mappings);
  await write(path.join(out, 'incident-findings.json'), incidents);
  const receipt = { kind: 'native-non-trec-acceptance-export', coverage, originalSourceFiles: files, artifactSha256: config.artifactSha256,
    actualModelProducerExecutionCount: producerExecutions.size, modelProfileDigests: [...profileDigests],
    incidentCases: incidents.length, incidentPasses: incidents.filter(row => !row.findings.length).length,
    semantics: 'Only current native saved decisions are scored. Labels reflect inclusion/exclusion polarity. Missing/ambiguous annotation mappings stay missing; no gold-based mapping or scoring inference.',
    priorExposure: 'Previously inspected C/F patients. One new native workflow regression replay, not an untouched holdout.' };
  await write(path.join(out, 'receipt.json'), receipt);
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, out: { type: 'string' } } });
  const result = await exportAcceptance({ configPath: path.resolve(values.config), out: path.resolve(values.out) });
  console.log(JSON.stringify({ coverage: result.coverage, incidentPasses: result.incidentPasses, actualModelProducerExecutionCount: result.actualModelProducerExecutionCount }));
}
