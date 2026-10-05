import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { screenRetractions, validateRewrite } from '../../../evals/paper-gold/evaluator.mjs';
import { resolvePublicationIdentity } from './evolutionPublicationIdentity.mjs';
import { prospectiveNumericQuoteMatches, validProspectiveNumericReference } from './evolutionProspectiveScore.mjs';
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sourceHash = text => createHash('sha256').update(text).digest('hex');
const waiting = resourceCode => ({ ok: false, status: 'waiting_resource', resourceCode });
/** Control-only temporal QA. A primary paper can yield question-only gold; published prose
 * does not establish availability of same-version analysis inputs or full-study reproduction.
 * @param {any} dependencies */
export function createEvolutionTemporalGoldCuration({ config, write, review, fetchImpl = fetch, canonicalize = resolvePublicationIdentity }) {
  const root = path.join(config.evaluationDataDir || path.join(config.dataDir, 'evaluation-control'), 'paper-gold');
  async function get(url, signal, provenance) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const response = await fetchImpl(url, { signal: bounded, redirect: 'error', headers: { accept: 'application/json, application/xml', 'cache-control': 'no-cache' } });
    if (!response.ok) return null;
    const reader = response.body?.getReader?.();
    let bytes;
    if (reader) {
      const chunks = []; let size = 0;
      try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); return null; } chunks.push(Buffer.from(item.value)); } }
      finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks);
    } else { bytes = Buffer.from(await response.text()); if (bytes.length > 1024 * 1024) return null; }
    provenance?.push({ url: String(url), sha256: sourceHash(bytes.toString('utf8')) });
    return bytes.toString('utf8');
  }
  async function cached(directory, name, create) {
    const file = path.join(directory, `${name}.json`);
    try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await create();
    try { await writeFile(file, JSON.stringify(result), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; return JSON.parse(await readFile(file, 'utf8')); }
    return result;
  }
  async function prepare({ id, kind, record, tool = undefined, signal }) {
    if (!new RegExp(`^evolution-${kind === 'time-holdout' ? 'temporal' : 'prospective'}-[a-f0-9]{64}$`).test(id)) return waiting('temporal_identity_invalid');
    const destination = path.join(root, kind, `${id}.json`);
    const binding = { id, targetIdentity: record.targetIdentity ?? record.paperId, toolId: record.toolId, artifactDigest: record.artifactDigest,
      firstPublicAt: record.firstPublicAt, firstPublicEvidenceId: record.firstPublicEvidenceId, frozenAt: record.frozenAt ?? tool?.payload?.frozenAt, modelReleasedAt: record.modelReleasedAt ?? tool?.payload?.modelReleasedAt, modelReleaseEvidenceId: record.modelReleaseEvidenceId ?? tool?.payload?.modelReleaseEvidenceId, predictionHash: record.predictionHash ?? null };
    const publicAt = Date.parse(record.firstPublicAt ?? ''), frozenAt = Date.parse(record.frozenAt ?? tool?.payload?.frozenAt ?? ''), releasedAt = Date.parse(record.modelReleasedAt ?? tool?.payload?.modelReleasedAt ?? '');
    if (!binding.toolId || !binding.artifactDigest || !binding.modelReleaseEvidenceId || !binding.firstPublicEvidenceId || ![publicAt, frozenAt, releasedAt].every(Number.isFinite) || publicAt <= frozenAt || publicAt <= releasedAt) return waiting('temporal_chronology_incomplete');
    if (kind === 'prospective' && (record.registrationEligible !== true || record.actualPinnedToolUse !== true)) return waiting('prospective_registration_unverified');
    if (kind === 'time-holdout' && (tool?.id !== record.toolId || tool.payload?.status !== 'active' || tool.payload.artifactDigest !== record.artifactDigest)) return waiting('temporal_tool_pin_changed');
    try {
      const saved = JSON.parse(await readFile(destination, 'utf8'));
      const { hash, ...gold } = saved;
      if (hash !== digest(gold) || saved.bindingHash !== digest(binding)) throw new Error('Frozen temporal gold identity or bytes changed.');
      return { ok: true, status: 'prepared', goldPath: destination, goldHash: hash, access: 'evaluation-only' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let primary, aliases, title, publicationId;
    let dois = []; const sourceProvenance = []; let retractionScreens = [];
    if (kind === 'prospective') {
      const match = /^clinicaltrials\.gov:(NCT\d{8}):results$/.exec(record.targetIdentity ?? '');
      if (!match) return waiting('prospective_primary_type_unsupported');
      primary = await get(`https://clinicaltrials.gov/api/v2/studies/${match[1]}`, signal, sourceProvenance);
      if (!primary) return waiting('temporal_primary_unavailable');
      const study = JSON.parse(primary);
      const date = study.protocolSection?.statusModule?.resultsFirstPostDateStruct?.date;
      if (Date.parse(date ?? '') <= frozenAt || Date.parse(date ?? '') <= releasedAt) return waiting('temporal_earliest_public_chronology_unconfirmed');
      if (study.protocolSection?.identificationModule?.nctId !== match[1] || study.hasResults !== true || !study.resultsSection || !date || date !== record.firstPublicAt.slice(0, 10)) return waiting('prospective_official_results_unconfirmed');
      aliases = [record.targetIdentity, match[1]]; title = study.protocolSection?.identificationModule?.briefTitle ?? ''; publicationId = record.targetIdentity;
    } else {
      const identity = await canonicalize(record.paperId, { fetchImpl, signal });
      if (identity?.verified !== true) return waiting('temporal_publication_identity_unknown');
      sourceProvenance.push(...(identity.evidence ?? []));
      const raw = String(record.paperId).replace(/^doi:/i, '').replace(/^https?:\/\/doi.org\//i, '');
      const query = /^10\.\d{4,9}\//.test(raw) ? `DOI:"${raw}"` : /^PMC\d+$/i.test(raw) ? `PMCID:${raw.toUpperCase()}` : /^\d+$/.test(raw.replace(/^pmid:/i, '')) ? `EXT_ID:${raw.replace(/^pmid:/i, '')} AND SRC:MED` : null;
      if (!query) return waiting('temporal_publication_identity_unknown');
      const metadata = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${new URLSearchParams({ query, format: 'json', resultType: 'core', pageSize: '2' })}`, signal, sourceProvenance);
      const rows = metadata ? JSON.parse(metadata).resultList?.result ?? [] : [];
      const row = rows.find(item => identity.aliases.includes(`doi:${String(item.doi ?? '').toLowerCase()}`) || identity.aliases.includes(item.pmcid) || identity.aliases.includes(`pmid:${item.id}`));
      if (!row?.doi || !/^PMC\d+$/.test(row.pmcid ?? '') || row.firstPublicationDate !== record.firstPublicAt.slice(0, 10)) return waiting('temporal_earliest_public_unconfirmed');
      if (Date.parse(row.firstPublicationDate) <= frozenAt || Date.parse(row.firstPublicationDate) <= releasedAt) return waiting('temporal_earliest_public_chronology_unconfirmed');
      const screens = await screenRetractions([row.doi], fetchImpl);
      retractionScreens = screens; dois = [String(row.doi).toLowerCase()];
      if (!screens.length || !screens.every(item => item.admissible)) return waiting('temporal_retraction_status_unknown_or_changed');
      primary = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/${row.pmcid}/fullTextXML`, signal, sourceProvenance);
      if (!primary) return waiting('temporal_primary_unavailable');
      aliases = [...new Set([...identity.aliases, row.doi, row.pmcid])]; title = row.title ?? ''; publicationId = identity.canonicalId;
    }
    if (primary.length > 120000) return waiting('temporal_primary_exceeds_review_context');
    const hash = sourceHash(primary), directory = path.join(root, 'temporal-curation', id, digest({ sourceHash: hash, curatorVersion: 1, binding, reviewProvider: config.reviewProvider ?? null, reviewModel: config.reviewModel ?? null }));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await cached(directory, 'primary', async () => ({ source: primary, sourceHash: hash, binding, sourceProvenance, retractionScreens }));
    // The writer never sees the prediction, the previous score, or any runtime response.
    const proposal = await cached(directory, 'extraction', () => write({ kind, targetIdentity: publicationId, source: primary, sourceHash: hash, ...(kind === 'prospective' ? { question: record.question, preRegisteredProtocol: record.preRegisteredProtocol } : {}) }, { signal }));
    if (!proposal || typeof proposal.question !== 'string' || !proposal.question.trim() || !Array.isArray(proposal.variants) || proposal.variants.length !== 3 || new Set(proposal.variants).size !== 3 || proposal.variants.some(item => typeof item !== 'string' || !item.trim())) return waiting('temporal_question_extraction_incomplete');
    if (proposal.writerModelReported !== true || !/^deepseek/i.test(proposal.writerModel ?? '')) return waiting('temporal_writer_identity_unconfirmed');
    if (!Array.isArray(proposal.sourceQuotes) || !proposal.sourceQuotes.length || proposal.sourceQuotes.some(quote => typeof quote !== 'string' || !quote || !primary.includes(quote))) return waiting('temporal_primary_quote_bond_failed');
    const numeric = proposal.numeric ?? {};
    if (kind === 'prospective' && !Object.keys(numeric).length) return waiting('prospective_numeric_gold_unavailable');
    if (Object.keys(numeric).length > 3 || Object.entries(numeric).some(([key, ref]) => !/^[a-zA-Z][a-zA-Z0-9_.-]{0,120}$/.test(key) || !validProspectiveNumericReference(ref) || typeof ref.quote !== 'string' || !primary.includes(ref.quote) || !prospectiveNumericQuoteMatches(ref.quote, ref.value, primary))) return waiting('temporal_numeric_quote_bond_failed');
    const checked = await cached(directory, 'independent-review', () => review({ kind, targetIdentity: publicationId, source: primary, sourceHash: hash, proposed: proposal }, { signal }));
    if (checked?.passed !== true || checked.modelReported !== true || !/^qwen/i.test(checked.model ?? '') || checked.provider !== 'dashscope' || !Array.isArray(checked.evidenceIds) || !checked.evidenceIds.includes(hash) || checked.evidenceIds.some(item => item !== hash)) return waiting('temporal_independent_qa_unconfirmed');
    const limitations = 'No hash-verified same-version research input asset is supplied to this evaluation. Assess the resulting reproducibility limits without inventing inputs or claiming that data are globally unavailable.';
    const rewrite = { question: proposal.question, variants: kind === 'time-holdout' ? proposal.variants.map(variant => `${variant}\n${limitations}`) : proposal.variants, qaPassed: true, writer: proposal.writerModel, qaExecutor: checked.model };
    try { validateRewrite(rewrite, { identifiers: [...aliases, ...(title ? [title] : [])] }); }
    catch { return waiting('temporal_neutral_rewrite_invalid'); }
    const shared = { bindingHash: digest(binding), sourceProvenance, retractionScreens, sourceHash: hash, firstPublicAt: record.firstPublicAt, firstPublicEvidenceId: record.firstPublicEvidenceId,
      independent: true, retracted: false, qa: { model: checked.model, modelReported: true, evidenceIds: checked.evidenceIds },
      preservedEvidence: [{ id: publicationId, text: primary, sha256: hash, sourceHash: hash, quotes: proposal.sourceQuotes }] };
    let gold;
    if (kind === 'prospective') gold = { ...shared, registrationId: id, targetIdentity: record.targetIdentity, toolId: record.toolId, artifactDigest: record.artifactDigest, frozenAt: record.frozenAt, numeric,
      inputAvailable: false, benchmarkScope: 'numeric-prospective-prediction', reachableEvidenceIds: [], retractionScope: 'Exact official registry result availability; no assertion about publication retractions.' };
    else {
      const capabilityIds = tool.payload.capabilityIds ?? [];
      const capabilityId = capabilityIds.includes('statistical-analysis') ? 'statistical-analysis' : capabilityIds[0];
      if (!capabilityId) return waiting('temporal_capability_unknown');
      gold = { ...shared, observationId: id, paperId: record.paperId, toolId: record.toolId, artifactDigest: record.artifactDigest,
        definition: { cases: [{ id: `temporal-${digest(binding).slice(0, 24)}`, type: 'question', publicationId, capabilityId, dois, firstPublicAt: record.firstPublicAt, cutoff: null,
          rewrite,
          input: `${proposal.question}\nNo hash-verified same-version research input asset is supplied. Explain reproducibility limits without inventing inputs.`,
          policy: { aliases, titles: title ? [title] : [] },
          gold: { type: 'question', sourceHash: hash, inputAvailable: false, benchmarkScope: 'question-only', numeric: {}, applicableStages: ['question', 'method', 'certainty', 'writing'],
            stageChecks: { question: ['question_aligned'], method: ['method_supported'], certainty: ['certainty_supported'], writing: ['writing_sources_bound'] },
            preservedEvidence: shared.preservedEvidence, reachableEvidenceIds: [], unreachableEvidenceIds: [] } }] } };
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const frozen = { ...gold, hash: digest(gold) };
    if (Buffer.byteLength(JSON.stringify(frozen)) > 1024 * 1024) return waiting('temporal_gold_bound_exceeded');
    try { await writeFile(destination, JSON.stringify(frozen), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; const saved = JSON.parse(await readFile(destination, 'utf8')); if (saved.hash !== frozen.hash) throw new Error('Temporal gold is already frozen with another definition.'); }
    return { ok: true, status: 'prepared', goldPath: destination, goldHash: frozen.hash, access: 'evaluation-only' };
  }
  return {
    /** @param {any} input */
    prepareHoldout: ({ observation, tool, signal }) => prepare({ id: observation.id, kind: 'time-holdout', record: observation.payload, tool, signal }),
    /** @param {any} input */
    prepareProspective: ({ registration, signal }) => prepare({ id: registration.id, kind: 'prospective', record: registration.payload, signal }),
  };
}
