#!/usr/bin/env node
/** Label-free saved-native-result adapter. No provider, database, clinical judgment or scorer runs here. */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assertScope, contentDigest, metricInputFromResults, pairIdentity, profileIdentity, validateScope } from '../../packages/patient-matching-core/index.mjs';
import { array, check, digest, identifier, object, oneOf, text, unique } from '../../packages/patient-matching-core/src/validation.mjs';

const PROFILES = Object.freeze({ sigir: 'trialgpt-judged-pair-ranking', trec2021: 'trec-full-corpus', trec2022: 'trec-full-corpus', trec2023: 'trec-full-corpus' });
const STATES = ['complete', 'pending', 'failed', 'unsupported', 'stale', 'missing'];
const patientId = (value) => check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value), 'patientId', 'expected a safe benchmark topic id');
const registryId = (value) => check(typeof value === 'string' && /^NCT[0-9]{8}$/u.test(value), 'registryId', 'expected an exact NCT id');
const identity = (scope, resultId, revision) => profileIdentity({ scope, resultId, revision });
const countsOf = (rows) => Object.fromEntries(STATES.map((state) => [state, rows.filter((row) => row.state === state).length]));
const statusOf = (counts) => counts.complete === Object.values(counts).reduce((sum, count) => sum + count, 0) ? 'complete'
  : counts.complete > 0 ? 'partial' : ['pending', 'stale', 'failed', 'unsupported', 'missing'].find((state) => counts[state] > 0);

/** Freeze explicit ID mappings and the export policy; never infer IDs from labels or patient text. */
export function nativeMappingDigest(configuration) {
  return profileIdentity({ projectionPolicy: 'native-saved-order-v1', board: configuration.board, language: configuration.language,
    plugin: configuration.plugin, bindings: configuration.bindings });
}

function validateConfiguration(configuration, cases) {
  object(configuration, 'configuration', ['schemaVersion', 'board', 'language', 'casesDigest', 'plugin', 'bindings', 'metricProfile']);
  check(configuration.schemaVersion === '1', 'configuration.schemaVersion', 'unsupported export configuration');
  oneOf(configuration.board, Object.keys(PROFILES), 'configuration.board');
  check(configuration.language === 'en', 'configuration.language', 'this release accepts original English benchmark inputs only');
  digest(configuration.casesDigest, 'configuration.casesDigest');
  check(configuration.casesDigest === profileIdentity(cases), 'configuration.casesDigest', 'frozen cases differ');
  object(configuration.plugin, 'configuration.plugin', ['generation', 'artifactDigest', 'profileDigest']);
  identifier(configuration.plugin.generation, 'configuration.plugin.generation');
  digest(configuration.plugin.artifactDigest, 'configuration.plugin.artifactDigest');
  digest(configuration.plugin.profileDigest, 'configuration.plugin.profileDigest');
  array(configuration.bindings, 'configuration.bindings');
  unique(configuration.bindings, 'configuration.bindings', (binding) => binding.patientId);
  for (const binding of configuration.bindings) {
    object(binding, 'binding', ['patientId', 'scope', 'subjectKey', 'resultId', 'revision', 'pairs']);
    patientId(binding.patientId);
    validateScope(binding.scope);
    identifier(binding.subjectKey, 'binding.subjectKey');
    if (binding.resultId === null) check(binding.revision === null, 'binding.revision', 'a missing result has no revision');
    else { identifier(binding.resultId, 'binding.resultId'); text(binding.revision, 'binding.revision'); }
    array(binding.pairs, 'binding.pairs', (pair) => {
      object(pair, 'binding.pairs', ['trialId', 'armId', 'registryId']);
      registryId(pair.registryId);
      pairIdentity({ subjectKey: binding.subjectKey, ...pair });
    });
    unique(binding.pairs, 'binding.pairs', (pair) => pair.registryId);
    unique(binding.pairs, 'binding.pairs', (pair) => pairIdentity({ subjectKey: binding.subjectKey, ...pair }));
  }
}

/** Project a frozen requested denominator from validated core results; all saved rows retain their exact relative order. */
export function exportNativeResults({ cases, results, configuration }) {
  array(cases, 'cases');
  check(cases.length > 0, 'cases', 'at least one frozen requested topic is required');
  unique(cases, 'cases', (row) => row.patientId);
  for (const row of cases) {
    object(row, 'case'); patientId(row.patientId);
    check(row.language === undefined || row.language === 'en', 'case.language', 'translated benchmark cases are retired for this release');
    check(row.translatedFrom === undefined, 'case.translatedFrom', 'translated benchmark cases are retired for this release');
    array(row.candidateIds, 'case.candidateIds', registryId);
    unique(row.candidateIds, 'case.candidateIds');
    if (row.candidateCount !== undefined) check(row.candidateCount === row.candidateIds.length, 'case.candidateCount', 'candidate count differs');
  }
  validateConfiguration(configuration, cases);
  // The core validates every saved invariant and the full metric profile, without reranking.
  const metricInput = metricInputFromResults(results, configuration.metricProfile);
  check(metricInput.profile.id === PROFILES[configuration.board], 'metricProfile.id', 'metric profile differs from benchmark protocol');
  check(metricInput.profile.mappingPolicyDigest === nativeMappingDigest(configuration), 'metricProfile.mappingPolicyDigest', 'frozen mapping policy differs');
  const expectedCohort = configuration.board === 'sigir' ? 'sigir' : `trec_${configuration.board.slice(4)}`;
  for (const row of cases) {
    if (row.cohort !== undefined) check(row.cohort === expectedCohort, 'case.cohort', 'case belongs to a different benchmark');
    if (configuration.board === 'sigir') check(row.patientId.startsWith('sigir-'), 'case.patientId', 'expected original SIGIR topic id');
    else {
      const year = configuration.board.slice(4);
      const topicPattern = new RegExp(year === '2023' ? '^trec-2023-[1-9][0-9]*$' : `^trec-${year}[1-9][0-9]*$`, 'u');
      check(topicPattern.test(row.patientId), 'case.patientId', 'topic differs from the configured TREC year');
    }
  }
  check(configuration.bindings.length === cases.length, 'bindings', 'every requested topic requires one explicit binding');
  const bindings = new Map(configuration.bindings.map((binding) => [binding.patientId, binding]));
  const byResult = new Map(), consumed = new Map();
  for (const result of results) {
    const key = identity(result.scope, result.resultId, result.revision);
    check(!byResult.has(key), 'results', 'duplicate saved result identity');
    check(result.pluginGeneration === configuration.plugin.generation, 'result.pluginGeneration', 'saved plugin generation differs');
    check(result.profileDigest === configuration.plugin.profileDigest, 'result.profileDigest', 'saved source/model profile differs');
    byResult.set(key, result); consumed.set(key, new Set());
  }
  const counts = { patientsRequested: cases.length, patientsWithResult: 0, patientsComplete: 0, pairsRequested: 0, pairsSaved: 0, pairsCurrent: 0,
    stateCounts: Object.fromEntries(STATES.map((state) => [state, 0])) };
  const topics = [];
  const records = cases.map((row) => {
    const binding = bindings.get(row.patientId);
    check(binding, 'bindings', 'requested topic lacks a binding');
    const candidates = new Set(row.candidateIds);
    check(binding.pairs.length === candidates.size && binding.pairs.every((pair) => candidates.has(pair.registryId)), 'binding.pairs', 'mapping differs from the entire requested candidate set');
    const key = binding.resultId === null ? null : identity(binding.scope, binding.resultId, binding.revision);
    const result = key === null ? null : byResult.get(key);
    check(key === null || result, 'binding.resultId', 'the exact bound saved result was not supplied');
    const mapping = new Map(binding.pairs.map((pair) => [pairIdentity({ subjectKey: binding.subjectKey, ...pair }), pair.registryId]));
    const rows = result ? result.rows.filter((item) => item.subjectKey === binding.subjectKey) : [];
    if (result) {
      assertScope(binding.scope, result.scope);
      check(rows.length === mapping.size && rows.every((item) => mapping.has(pairIdentity(item))), 'binding.pairs', 'saved subject/pair scope differs from frozen mapping');
      for (const item of rows) {
        const id = pairIdentity(item);
        check(!consumed.get(key).has(id), 'bindings', 'one saved pair cannot become two benchmark topics');
        consumed.get(key).add(id);
      }
    }
    const states = result ? countsOf(rows) : { ...countsOf([]), missing: candidates.size };
    const status = result ? statusOf(states) : 'missing';
    counts.patientsWithResult += result ? 1 : 0;
    counts.patientsComplete += status === 'complete' ? 1 : 0;
    counts.pairsRequested += candidates.size; counts.pairsSaved += rows.length; counts.pairsCurrent += states.complete;
    for (const state of STATES) counts.stateCounts[state] += states[state];
    const ranking = rows.map((item, index) => ({ registryId: mapping.get(pairIdentity(item)), rank: index + 1,
      fit: item.current ? item.recommendation.priority : null, confidence: null, verdict: item.current ? item.clinicalEligibility : null,
      native: { pairIdentity: pairIdentity(item), state: item.state, current: item.current, clinicalEligibility: item.clinicalEligibility,
        decisionId: item.decisionId, decisionRevision: item.decisionRevision, staleReasons: item.staleReasons } }));
    const failed = result ? rows.filter((item) => !item.current).map((item) => ({ registryId: mapping.get(pairIdentity(item)), code: `native_${item.state}` }))
      : row.candidateIds.map((id) => ({ registryId: id, code: 'native_missing_result' }));
    topics.push({ patientId: row.patientId, scope: binding.scope, subjectKey: binding.subjectKey, resultId: binding.resultId, revision: binding.revision,
      state: status, requested: candidates.size, saved: rows.length, current: states.complete, stateCounts: states, finalOrder: rows.map(pairIdentity) });
    return { patientId: row.patientId, status, ranking, failed };
  });
  for (const [key, result] of byResult) check(consumed.get(key).size === result.rows.length, 'results', 'saved artifact contains unmapped pairs');
  return structuredClone({ records, receipt: { schemaVersion: '1', projectionPolicy: 'native-saved-order-v1', board: configuration.board, language: configuration.language,
    metricProfile: metricInput.profile, plugin: configuration.plugin, casesDigest: configuration.casesDigest, counts, topics,
    results: results.map((result) => ({ resultId: result.resultId, revision: result.revision, projectionVersion: result.projectionVersion, taskId: result.taskId, scope: result.scope,
      pluginGeneration: result.pluginGeneration, profileDigest: result.profileDigest, artifactDigest: profileIdentity(result),
      currentSources: result.currentSources, frozenSources: result.frozenSources, finalOrder: result.finalOrder, stageOrders: result.stageOrders, counts: result.counts, state: result.state })),
    limitations: ['No score or new clinical execution is produced.', 'Legacy completion fields describe ranking entries or non-null priority, not native clinical completion; use this receipt.',
      'SIGIR missing results use the existing converter input-order fallback; TREC missing results remain empty rankings.'] } });
}

const HELP = 'Export actual saved core matching results without reranking.\nnode native_projection.mjs --cases cases.jsonl --results saved.jsonl --profile frozen-profile.json --out NEW_DIRECTORY\nOriginal English SIGIR or full-corpus TREC only. No labels, provider calls or legacy matching jobs are accepted.';
const read = (file) => { const bytes = fs.readFileSync(file); return { bytes, file: path.basename(file), digest: contentDigest(bytes) }; };
const jsonl = (bytes) => bytes.toString('utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));

export async function main(argv = process.argv.slice(2), { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { cases: { type: 'string' }, results: { type: 'string' }, profile: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: false });
    if (values.help) { log(HELP); return 0; }
    for (const name of ['cases', 'results', 'profile', 'out']) check(values[name], `--${name}`, 'required option');
    const cases = read(values.cases), results = read(values.results), profile = read(values.profile);
    const projected = exportNativeResults({ cases: jsonl(cases.bytes), results: jsonl(results.bytes), configuration: JSON.parse(profile.bytes.toString('utf8')) });
    const serialized = projected.records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    projected.receipt.inputs = Object.fromEntries(Object.entries({ cases, results, profile }).map(([name, input]) => [name, { file: input.file, digest: input.digest }]));
    projected.receipt.output = { file: 'judgments.jsonl', digest: contentDigest(serialized) };
    // A fresh directory keeps a frozen campaign export from being overwritten on rerun.
    fs.mkdirSync(values.out);
    fs.writeFileSync(path.join(values.out, 'judgments.jsonl'), serialized, { flag: 'wx' });
    fs.writeFileSync(path.join(values.out, 'receipt.json'), JSON.stringify(projected.receipt, null, 2) + '\n', { flag: 'wx' });
    log(JSON.stringify({ board: projected.receipt.board, ...projected.receipt.counts }));
    return 0;
  } catch (error) {
    log(`native_projection: ${error?.code ?? 'error'}: ${String(error?.message ?? error).slice(0, 300)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
