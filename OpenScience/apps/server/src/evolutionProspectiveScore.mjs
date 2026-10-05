import { canonicalJson } from '@evimed/domain';
import { saveEvolutionEvaluation, publishEvaluationGaps } from './evolutionEvaluationGaps.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { numericScore } from '../../../evals/paper-gold/evaluator.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Literal tokens in the original text, fully contained in the quote; fragments cannot bind.
 * @param {string} quote @param {number} value @param {string} [original] */
export function prospectiveNumericQuoteMatches(quote, value, original = quote) {
  if (typeof quote !== 'string' || !quote || typeof original !== 'string' || !Number.isFinite(value)) return false;
  const tokens = original.replace(/\u2212/g, '-').matchAll(/(?<![\p{L}\p{N}_.,])[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?(?![\p{L}\p{N}_]|[.,]\d)/gu);
  let next = original.indexOf(quote), latest = -1;
  for (const token of tokens) {
    if (Number(token[0].replaceAll(',', '')) !== value) continue;
    while (next >= 0 && next <= token.index) { latest = next; next = original.indexOf(quote, next + 1); }
    if (latest >= 0 && latest + quote.length >= token.index + token[0].length) return true;
  }
  return false;
}
/** Never let malformed, inverted or overflowing control tolerances turn any result into a pass. @param {any} reference */
export function validProspectiveNumericReference(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return false;
  if (reference.value !== undefined && !Number.isFinite(reference.value)) return false;
  const interval = reference.interval ?? [reference.value, reference.value];
  if (!Array.isArray(interval) || interval.length !== 2 || !interval.every(Number.isFinite) || interval[0] > interval[1]) return false;
  const absolute = reference.absoluteTolerance ?? 0, relative = reference.relativeTolerance ?? 0;
  if (!Number.isFinite(absolute) || absolute < 0 || !Number.isFinite(relative) || relative < 0 || relative > 0 && !Number.isFinite(reference.value)) return false;
  const tolerance = Math.max(absolute, Math.abs(reference.value ?? 0) * relative);
  return Number.isFinite(tolerance) && Number.isFinite(interval[0] - tolerance) && Number.isFinite(interval[1] + tolerance);
}

/** Only the official registry result has an absence claim; this does not assert absence of papers.
 * @param {any} input @param {any} [dependencies] */
export async function verifyOfficialProspectiveTarget({ targetIdentity, signal }, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const match = /^clinicaltrials\.gov:(NCT\d{8}):results$/.exec(targetIdentity ?? '');
  if (!match) return { unpublished: null, targetIdentity, reason: 'No independent target-specific availability verifier is configured.' };
  const response = await fetchImpl(`https://clinicaltrials.gov/api/v2/studies/${match[1]}`, { signal: signal ?? AbortSignal.timeout(30000), redirect: 'error', headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  if (!response.ok) return { unpublished: null, targetIdentity, reason: 'Official registry record is unavailable.' };
  const text = await response.text(); if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Registry response exceeds its bound.');
  const study = JSON.parse(text);
  if (study.protocolSection?.identificationModule?.nctId !== match[1]) throw new Error('Registry identity differs.');
  const firstPublicAt = study.protocolSection?.statusModule?.resultsFirstPostDateStruct?.date ?? null;
  return { targetIdentity, unpublished: study.hasResults === false && !study.resultsSection ? true : study.hasResults === true && study.resultsSection ? false : null,
    firstPublicAt, evidenceId: sha([targetIdentity, text]), checkedAt: now().toISOString(), scope: 'Only publicly posted results in this exact official registry record; no claim about all publications.', sourceUrl: `https://clinicaltrials.gov/api/v2/studies/${match[1]}` };
}

/** Score the immutable frozen prediction. Gold never enters a dispatch or extraction prompt.
 * Control-only gold path: prospective/<registrationId>.json containing {registrationId,targetIdentity,
 * firstPublicAt,firstPublicEvidenceId,independent:true,retracted:false,numeric:{key:{value,tolerance}},sha256?}.
 * @param {any} dependencies */
export function createEvolutionProspectiveScore({ service, config = {}, extractPrediction, verifyPinnedRun, assessStages, prepareGold }) {
  return { /** @param {{registrationId:string,signal?:AbortSignal}} input */
    async score({ registrationId, signal }) {
      if (!/^evolution-prospective-[a-f0-9]{64}$/.test(registrationId)) throw new Error('Invalid prospective registration identity.');
      const row = await service.get(registrationId);
      if (!row || row.payload.registrationEligible !== true) return { status: 'waiting', reason: 'Verified prepublication registration is required.' };
      const record = row.payload;
      let gold;
      try { const bytes = await readFile(path.join(config.evaluationDataDir || path.join(config.dataDir, 'evaluation-control'), 'paper-gold', 'prospective', `${registrationId}.json`)); if (bytes.length > 1024 * 1024) throw new Error('Prospective gold exceeds its bound.'); gold = JSON.parse(bytes.toString('utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!prepareGold) return { status: 'waiting', reason: 'Independent control-only gold is not yet preserved.' };
        const original = verifyPinnedRun ? await verifyPinnedRun(record) : null;
        if (original?.ok !== true || original.predictionHash !== record.predictionHash || original.transcriptHash !== record.transcriptHash || original.toolId !== record.toolId || original.digest !== record.artifactDigest) return { status: 'waiting', reason: 'Original pinned provenance is required before independent gold preparation.' };
        const prepared = await prepareGold({ registration: row, signal });
        if (!prepared?.ok) return { status: 'waiting', reason: prepared?.resourceCode ?? 'Independent control-only gold is not yet preserved.' };
        const bytes = await readFile(path.join(config.evaluationDataDir || path.join(config.dataDir, 'evaluation-control'), 'paper-gold', 'prospective', `${registrationId}.json`));
        if (bytes.length > 1024 * 1024) throw new Error('Prospective gold exceeds its bound.');
        gold = JSON.parse(bytes.toString('utf8'));
      }
      if (gold.hash !== undefined) {
        const { hash, ...frozen } = gold;
        if (hash !== createHash('sha256').update(canonicalJson(frozen)).digest('hex')) throw new Error('Frozen prospective gold bytes changed.');
      }
      const firstPublicAt = Date.parse(gold.firstPublicAt ?? '');
      const eligible = gold.registrationId === row.id && gold.targetIdentity === record.targetIdentity && gold.independent === true && gold.retracted === false && gold.firstPublicEvidenceId
        && (gold.toolId === undefined || gold.toolId === record.toolId) && (gold.artifactDigest === undefined || gold.artifactDigest === record.artifactDigest) && (gold.frozenAt === undefined || gold.frozenAt === record.frozenAt)
        && Number.isFinite(firstPublicAt) && firstPublicAt > Date.parse(record.frozenAt) && firstPublicAt > Date.parse(record.modelReleasedAt ?? '')
        && record.predictionHash === sha(record.prediction) && record.actualPinnedToolUse === true;
      const references = Object.entries(gold.numeric ?? {});
      if (!eligible || !references.length || !extractPrediction || !verifyPinnedRun) return { status: 'waiting', reason: 'Independent gold, frozen prediction, publication chronology, or pinned run evidence is incomplete.' };
      if (!references.every(([, reference]) => validProspectiveNumericReference(reference))) return { status: 'waiting', reason: 'Independent numeric gold contains an invalid finite reference, interval, or tolerance.' };
      const pinned = await verifyPinnedRun(record);
      if (pinned?.status === 'waiting-provenance') return { status: 'waiting', reason: 'The original model or execution provenance is incomplete.' };
      if (!pinned || pinned.ok !== true || pinned.predictionHash !== record.predictionHash || pinned.transcriptHash !== record.transcriptHash || pinned.toolId !== record.toolId || pinned.digest !== record.artifactDigest) throw new Error('The original pinned prediction run evidence changed.');
      if (record.score?.status === 'scored' && record.score.goldHash === sha(gold)) {
        const evaluation = await service.get(`prospective-score-${sha([row.id, record.score.goldHash])}`);
        if (evaluation) await publishEvaluationGaps(service, evaluation);
        return record.score;
      }
      const extraction = await extractPrediction({ text: record.prediction, fields: references.map(([key]) => key), producerRunId: record.producerRunId, signal });
      if (extraction.independent !== true || extraction.modelFamily === pinned.modelFamily || !extraction.modelFamily || !pinned.modelFamily) return { status: 'waiting', reason: 'Extraction must use a documented different model family.' };
      const numeric = {};
      const scored = references.map(([key, reference]) => {
        const extracted = extraction.numeric?.[key];
        const anchored = typeof extracted?.quote === 'string' && prospectiveNumericQuoteMatches(extracted.quote, extracted.value, record.prediction);
        numeric[key] = anchored ? extracted.value : null;
        return { key, ...numericScore(numeric[key], reference), quoteHash: anchored ? sha(extracted.quote) : null };
      });
      const research = assessStages ? await assessStages({ record, gold, numeric, pinned, signal }) : null;
      const result = { status: 'scored', passed: scored.every(item => item.valid), numeric: scored, caseGroup: 'prospective', exposed: false, retracted: false, independent: true,
        goldHash: sha(gold), predictionHash: record.predictionHash, extractorModelFamily: extraction.modelFamily, research, scoredAt: service.now().toISOString() };
      await saveEvolutionEvaluation(service, `prospective-score-${sha([row.id, result.goldHash])}`, { at: result.scoredAt, units: [{ ...(research ?? {}), id: row.id, type: 'question', track: record.track ?? 'E', group: 'prospective', numericEvaluationPassed: result.passed,
        eligibleForMainMetric: research?.eligibleForMainMetric === true, allStagesValid: research?.eligibleForMainMetric === true && research.allStagesValid === true,
        fullResearchReproductionValid: false, benchmarkScope: research?.eligibleForMainMetric ? 'prospective-full-research' : 'numeric-prospective-prediction',
        observedStages: research?.stages ? Object.entries(research.stages).filter(([, stage]) => stage.observed).map(([stage]) => stage) : ['calculation'], exposureTier: 'unexposed' }], prospectiveRegistrationId: row.id, score: result });
      await service.save('prospective', row.id, { ...record, status: 'scored', score: result }, row);
      return result;
    },
  };
}
