import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { numericScore, screenRetractions } from '../../../evals/paper-gold/evaluator.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wait = reason => ({ ok: false, status: 'waiting_resource', resourceCode: reason });
/** Certify only the provider/model identity reported by the actual review response.
 * @param {any} config @param {any} result */
export function certifyEvolutionReferenceReview(config, result) {
  const independent = config.reviewProvider === 'dashscope' && result.modelReported === true && /^qwen/i.test(result.model ?? '');
  return { ...result.value, family: independent ? 'qwen' : 'unknown', independent, model: result.model ?? null };
}
/** A new method's references are built outside its development run. Only exact preserved
 * primary quotations, independent review and independently executed arithmetic can enter gold.
 * No runtime-selected URL is fetched; acquisition uses the fixed public Europe PMC service.
 * @param {any} deps */
export function createEvolutionReferenceCuration({ config, controller, write, review, fetchImpl = fetch }) {
  const root = path.join(config.evaluationDataDir || path.join(config.dataDir, 'evaluation-control'), 'paper-gold');
  const get = async (url, signal) => {
    const response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return null;
    return text;
  };
  return {
    /** @param {any} card @param {{signal?:AbortSignal}} [options] */
    async prepareCases(card, { signal } = {}) {
      const methodId = String(card.methodId ?? card.id);
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(methodId)) return wait('method_identity_invalid');
      const sources = [];
      for (const paper of (card.papers ?? card.sourcePapers ?? []).slice(0, 8)) {
        signal?.throwIfAborted();
        const doi = String(paper.doi ?? '').replace(/^https?:\/\/doi.org\//, '');
        const pmid = String(paper.pmid ?? '');
        const pmcid = String(paper.pmcid ?? '');
        const query = /^10\.\d{4,9}\/[^\s"]+$/.test(doi) ? `DOI:"${doi}"` : /^\d+$/.test(pmid) ? `EXT_ID:${pmid} AND SRC:MED` : /^PMC\d+$/.test(pmcid) ? `PMCID:${pmcid}` : null;
        if (!query) continue;
        const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
        url.search = new URLSearchParams({ query, format: 'json', pageSize: '2', resultType: 'core' }).toString();
        const response = await get(url, signal);
        const records = response ? JSON.parse(response).resultList?.result ?? [] : [];
        const record = records.find(row => /^PMC\d+$/.test(row.pmcid ?? '') && (doi ? String(row.doi).toLowerCase() === doi.toLowerCase() : pmid ? row.id === pmid : row.pmcid === pmcid));
        if (!record?.doi || sources.some(row => row.publicationId === record.doi)) continue;
        const screens = await screenRetractions([record.doi], fetchImpl);
        if (!screens.every(row => row.admissible)) continue;
        const source = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/${record.pmcid}/fullTextXML`, signal);
        if (!source) continue;
        sources.push({ id: record.pmcid, publicationId: record.doi, aliases: [record.doi, record.pmcid, `PMID:${record.id}`], title: record.title, sourceHash: createHash('sha256').update(source).digest('hex'), source });
        if (sources.length === 4) break;
      }
      if (sources.length < 2) return wait('two_reachable_primary_examples_required');
      const directory = path.join(root, 'reference-curation', methodId, sha(sources.map(row => row.sourceHash)));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, 'primary-sources.json'), JSON.stringify(sources), { mode: 0o600 });
      const modelSources = sources.map(source => {
        const tables = (source.source.match(/<table-wrap\b[\s\S]*?<\/table-wrap>/gi) ?? []).join('\n');
        const view = source.source.length <= 120000 ? source.source : `${source.source.slice(0, 24000)}\n${tables.slice(0, 96000)}`;
        return { ...source, source: view, coverage: source.source === view ? 'complete' : 'bounded-prefix-and-tables' };
      });
      const cached = async (name, create) => {
        const file = path.join(directory, `${name}.json`);
        try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const value = await create(); await writeFile(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); return value;
      };
      const proposed = await cached('extraction', () => write({ methodId, goal: card.goal, sources: modelSources }));
      if (!Array.isArray(proposed.cases) || proposed.cases.length < 2 || !proposed.callableContract || !Array.isArray(proposed.developmentCases) || proposed.developmentCases.length < 2) return wait('primary_example_extraction_incomplete');
      const cases = [];
      for (const item of proposed.cases.slice(0, 10)) {
        const source = sources.find(row => row.publicationId === item.publicationId);
        if (!source || !item.input || typeof item.input !== 'object' || !Object.keys(item.numeric ?? {}).length) return wait('primary_example_identity_invalid');
        for (const reference of Object.values(item.numeric)) {
          const ref = /** @type {any} */ (reference);
          if (!Number.isFinite(ref.value) || !Number.isFinite(ref.absoluteTolerance) || ref.absoluteTolerance < 0 || typeof ref.quote !== 'string' || !source.source.includes(ref.quote) || !ref.quote.includes(String(ref.value))) return wait('primary_numeric_quotation_bond_failed');
        }
        const inputs = [];
        const visit = (value, key = '') => { if (value && typeof value === 'object') for (const [name, entry] of Object.entries(value)) visit(entry, key ? `${key}.${name}` : name); else inputs.push({ key, value }); };
        visit(item.input);
        if (!inputs.length || inputs.some(leaf => !(item.inputEvidence ?? []).some(bond => bond.path === leaf.key && bond.value === leaf.value && typeof bond.quote === 'string' && source.source.includes(bond.quote) && bond.quote.includes(String(leaf.value))))) return wait('primary_input_quotation_bond_failed');
        cases.push({ id: `published-${sha([methodId, source.publicationId]).slice(0, 24)}`, hidden: true, kind: 'published', publicationId: source.publicationId,
          title: source.title, aliases: source.aliases, input: item.input, numeric: item.numeric, sourceHash: source.sourceHash });
      }
      if (new Set(cases.map(row => row.publicationId)).size < 2) return wait('distinct_primary_examples_required');
      const developmentText = JSON.stringify(proposed.developmentCases).toLowerCase();
      if (new Set(proposed.developmentCases.map(row => sha(row.input))).size < 2
        || proposed.developmentCases.some(row => cases.some(reference => sha(reference.input) === sha(row.input)))
        || sources.some(source => [...source.aliases, source.title].some(identity => identity && developmentText.includes(String(identity).toLowerCase())))) return wait('development_examples_expose_reference');
      const checked = await cached('independent-review', () => review({ methodId, sources: modelSources, proposed }));
      if (checked.passed !== true || checked.family !== 'qwen' || typeof checked.referenceCode !== 'string' || checked.referenceCode.length > 100000) return wait('independent_primary_review_failed');
      // The reviewer supplies an independent implementation; candidate code does not exist yet.
      for (const item of cases) {
        const executed = await controller.execVerify({ files: {}, code: checked.referenceCode, input: item.input }, { signal });
        if (!executed.ok || !executed.joined) return wait('independent_reference_execution_unavailable');
        let numeric;
        try { numeric = JSON.parse(String(executed.output).trim().split('\n').at(-1)).numeric; } catch { return wait('independent_reference_output_invalid'); }
        if (!numeric || !Object.entries(item.numeric).every(([key, reference]) => numericScore(numeric[key], reference).valid)) return wait('independent_reference_disagrees');
        Object.assign(item, { independentQa: { writer: 'deepseek', reviewer: 'qwen', passed: true }, independentImplementation: { implementationId: `qwen-reference-${sha(checked.referenceCode)}`, numeric } });
      }
      const definition = { methodId, frozen: true, publicInputCount: cases.length, cases, referenceCodeHash: sha(checked.referenceCode), curationHash: sha({ proposed, checked }) };
      const destination = path.join(root, 'candidate-cases', `${methodId}.json`);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, JSON.stringify(definition), { mode: 0o600, flag: 'wx' });
      // Synthetic development examples are explicitly separate from preserved published inputs.
      const publicContract = { methodId, callableContract: proposed.callableContract, basis: 'Synthetic development examples; no empirical evidence.', cases: proposed.developmentCases };
      await writeFile(path.join(directory, 'development.json'), JSON.stringify(publicContract), { mode: 0o600, flag: 'wx' });
      await writeFile(path.join(root, 'candidate-cases', `${methodId}.development.json`), JSON.stringify(publicContract), { mode: 0o600, flag: 'wx' });
      return { ok: true, caseIds: cases.map(row => row.id), publishedReferenceCount: new Set(cases.map(row => row.publicationId)).size, publicInputCount: cases.length,
        sourceHashes: cases.map(row => row.sourceHash), independentImplementation: true, access: 'evaluation-only', hash: sha(definition) };
    },
  };
}
