import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { numericScore, screenRetractions } from '../../../evals/paper-gold/evaluator.mjs';
import { curatedCaseNumeric, printedTokenIn, withholdNumbers, TOLERANCE_QUANTITIES, TOLERANCE_LIMITS } from '../../../evals/paper-gold/tolerance.mjs';
import { genericFreshInput, seededRandom, referenceOutputsDiffer, BEHAVIOUR_LIMITS } from '../../../evals/paper-gold/behavioural.mjs';
import { PYTHON_NUMERIC_LITERALS, specificValue } from './evolutionCandidateEvaluator.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wait = (reason, detail = {}) => ({ ok: false, status: 'waiting_resource', resourceCode: reason, ...detail });
/** Certify only the provider/model identity reported by the actual review response.
 * @param {any} config @param {any} result */
export function certifyEvolutionReferenceReview(config, result) {
  const independent = config.reviewProvider === 'dashscope' && result.modelReported === true && /^qwen/i.test(result.model ?? '');
  return { ...result.value, family: independent ? 'qwen' : 'unknown', independent, model: result.model ?? null };
}
/** `a.b.c` keys of a flat numeric map as the nested object a callable returns. @param {Record<string, number>} flat */
function nested(flat) {
  const result = {};
  for (const [key, value] of Object.entries(flat)) key.split('.').reduce((node, part, index, parts) => (node[part] ??= index === parts.length - 1 ? value : {}), result);
  return result;
}
/**
 * A new method's references are built outside its development run, from preserved primary papers.
 *
 * Who decides what, since a model proposes most of this and a model's proposal is not a measurement:
 *  - which numbers a paper prints: the model proposes a value with a quotation, and code checks that the
 *    quotation is verbatim in the source and prints that number as a token (not as a substring: "5" does
 *    not bond to "0.52");
 *  - how close a result must be: code, from the printed precision (`tolerance.mjs`). A tolerance the model
 *    writes is discarded, and a case whose numbers cannot tell a real answer from the trivial one is refused;
 *  - the independent implementation: a reviewer of another model family writes it without the answers.
 *    The request it receives carries the method, the inputs and the source text with every printed
 *    occurrence of an expected value withheld. The code it returns is then tested here: it must contain
 *    no expected value as a literal, it must change its output when its input changes, and only then is
 *    it run on the published inputs and compared with the published numbers. It used to be shown the
 *    numbers it was "independently" reproducing, and was tested only on them;
 *  - the public development examples: the model proposes inputs only. Their expected values are
 *    computed by executing the independent implementation, and their ids are assigned here (a
 *    development contract without ids is refused downstream, so this path used to dead-end).
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
  /** The reference's numbers on one input: null when it refuses the input, a throw when it could not be run at all. */
  const runReference = async (code, input, signal) => {
    const executed = await controller.execVerify({ files: {}, code, input }, { signal });
    if (executed.joined !== true) throw Object.assign(new Error('Reference execution did not complete.'), { code: 'independent_reference_execution_unavailable' });
    if (executed.ok !== true) return null;
    let numeric;
    try { numeric = JSON.parse(String(executed.output).trim().split('\n').at(-1)).numeric; } catch { return null; }
    const values = Object.values(numeric ?? {});
    return values.length > 0 && values.every(Number.isFinite) ? numeric : null;
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
      /** @type {any[]} */
      const cases = [];
      for (const [index, item] of proposed.cases.slice(0, 10).entries()) {
        const source = sources.find(row => row.publicationId === item.publicationId);
        if (!source || !item.input || typeof item.input !== 'object' || !Object.keys(item.numeric ?? {}).length) return wait('primary_example_identity_invalid');
        const numeric = {};
        for (const [key, reference] of Object.entries(item.numeric)) {
          const ref = /** @type {any} */ (reference);
          // The quotation is verbatim in the source, and one of its number tokens is this value.
          const printed = Number.isFinite(ref?.value) && typeof ref.quote === 'string' && source.source.includes(ref.quote) ? printedTokenIn(ref.quote, ref.value) : null;
          if (!printed) return wait('primary_numeric_quotation_bond_failed');
          // What kind of number it is comes from the model as a label and only selects which trivial answers are
          // checked; an unknown label is read as the most cautious kind. A tolerance from the model is not read at all.
          numeric[key] = { value: ref.value, printed, quote: ref.quote, ...(TOLERANCE_QUANTITIES.includes(ref.quantity) ? { quantity: ref.quantity } : {}) };
        }
        const curated = curatedCaseNumeric(numeric);
        if (!curated.ok) return wait(curated.code === 'case_accepts_trivial_answer' ? 'primary_example_cannot_discriminate_trivial_answer' : 'primary_numeric_quotation_bond_failed', { detail: curated.code });
        const inputs = [];
        const visit = (value, key = '') => { if (value && typeof value === 'object') for (const [name, entry] of Object.entries(value)) visit(entry, key ? `${key}.${name}` : name); else inputs.push({ key, value }); };
        visit(item.input);
        const bonded = leaf => (item.inputEvidence ?? []).some(bond => bond.path === leaf.key && bond.value === leaf.value && typeof bond.quote === 'string' && source.source.includes(bond.quote)
          && (typeof leaf.value === 'number' ? printedTokenIn(bond.quote, leaf.value) !== null : bond.quote.includes(String(leaf.value))));
        if (!inputs.length || !inputs.every(bonded)) return wait('primary_input_quotation_bond_failed');
        cases.push({ id: `published-${sha([methodId, source.publicationId, index]).slice(0, 24)}`, hidden: true, kind: 'published', publicationId: source.publicationId,
          title: source.title, aliases: source.aliases, input: item.input, numeric: curated.numeric, sourceHash: source.sourceHash });
      }
      const publications = [...new Set(cases.map(row => row.publicationId))];
      if (publications.length < 2) return wait('distinct_primary_examples_required');
      // Two publications score every evaluation. Any further publication is held in reserve: no ordinary
      // evaluation runs it, so no repair round learns from it, and the sudden-perfect review has a case to use.
      const scoring = new Set([...publications].sort((left, right) => sha([methodId, left]).localeCompare(sha([methodId, right]))).slice(0, 2));
      for (const row of cases) if (!scoring.has(row.publicationId)) row.reserve = true;
      const developmentInputs = proposed.developmentCases.map(row => row?.input).filter(input => input && typeof input === 'object');
      const developmentText = JSON.stringify(developmentInputs).toLowerCase();
      if (developmentInputs.length < 2 || new Set(developmentInputs.map(sha)).size < 2
        || developmentInputs.some(input => cases.some(reference => sha(reference.input) === sha(input)))
        || sources.some(source => [...source.aliases, source.title].some(identity => identity && developmentText.includes(String(identity).toLowerCase())))) return wait('development_examples_expose_reference');
      // The reviewer writes the implementation blind: the method, the inputs and the papers' text with every
      // printed occurrence of an expected value withheld. No expected number, quotation or tolerance is sent.
      const expected = cases.flatMap(row => Object.values(row.numeric).map(reference => reference.value));
      const blind = { methodId, callableContract: proposed.callableContract, outputFields: [...new Set(cases.flatMap(row => Object.keys(row.numeric)))],
        inputs: cases.map(row => row.input), developmentInputs, sources: modelSources.map(source => ({ id: source.id, coverage: source.coverage, source: withholdNumbers(source.source, expected) })) };
      const checked = await cached('independent-review', () => review(blind));
      if (checked.passed !== true || checked.family !== 'qwen' || typeof checked.referenceCode !== 'string' || !checked.referenceCode || checked.referenceCode.length > 100000) return wait('independent_primary_review_failed');
      const code = checked.referenceCode;
      try {
        // 1. It may not contain an answer. A value match on the code's own numeric constants, read with Python's parser.
        const scanned = await controller.execVerify({ files: { 'reference.py': code }, code: PYTHON_NUMERIC_LITERALS, input: {} }, { signal });
        if (scanned.ok !== true || scanned.joined !== true) return wait('independent_reference_execution_unavailable');
        const literals = new Set(Object.values(JSON.parse(String(scanned.output).trim().split('\n').at(-1)).literals ?? {}).flat().map(Math.abs));
        if (expected.some(value => specificValue(value) && literals.has(Math.abs(value)))) return wait('independent_reference_recites_published_values');
        for (const item of cases) {
          signal?.throwIfAborted();
          // 2. It reproduces the published numbers from the published inputs.
          const numeric = await runReference(code, item.input, signal);
          if (!numeric || !Object.entries(item.numeric).every(([key, reference]) => numericScore(numeric[key], reference).valid)) return wait('independent_reference_disagrees');
          // 3. It is a function of its input: on perturbed inputs it still answers, and answers differently.
          const random = seededRandom(sha([methodId, item.id, 'reference-generalises']));
          let moved = 0;
          for (let attempt = 0; attempt < BEHAVIOUR_LIMITS.freshAttempts && moved < BEHAVIOUR_LIMITS.freshPerCase; attempt++) {
            const other = await runReference(code, genericFreshInput(item.input, random), signal);
            if (other && referenceOutputsDiffer(other, numeric)) moved++;
          }
          if (moved < BEHAVIOUR_LIMITS.freshPerCase) return wait('independent_reference_not_a_function_of_its_input');
          Object.assign(item, { independentQa: { writer: 'deepseek', reviewer: 'qwen', passed: true, basis: 'blind-reference-implementation-reproduces-published-numbers' },
            independentImplementation: { implementationId: `qwen-reference-${sha(code)}`, numeric } });
        }
        // The public examples: inputs from the model, expected values from executing the reference.
        const developmentCases = [];
        for (const input of developmentInputs) {
          const numeric = await runReference(code, input, signal);
          if (numeric) developmentCases.push({ id: `development-${developmentCases.length + 1}`, kind: 'synthetic-development', input, expected: nested(numeric), expectedSubset: true,
            absoluteTolerance: TOLERANCE_LIMITS.zeroAbsolute, relativeTolerance: TOLERANCE_LIMITS.computedRelative });
        }
        if (developmentCases.length < 2) return wait('development_examples_not_computable');
        const implementationId = `qwen-reference-${sha(code)}`;
        const definition = { methodId, frozen: true, publicInputCount: cases.length, cases, referenceCodeHash: sha(code), curationHash: sha({ proposed, checked }),
          // Kept with the cases, in control storage only: the evaluator derives fresh cases from it for every candidate.
          referenceImplementation: { implementationId, language: 'python', code } };
        const destination = path.join(root, 'candidate-cases', `${methodId}.json`);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, JSON.stringify(definition), { mode: 0o600, flag: 'wx' });
        // Synthetic development examples are explicitly separate from preserved published inputs.
        const publicContract = { methodId, callableContract: proposed.callableContract, basis: 'Synthetic development examples; no empirical evidence. Expected values were computed by an independent implementation, not typed.', cases: developmentCases };
        await writeFile(path.join(directory, 'development.json'), JSON.stringify(publicContract), { mode: 0o600, flag: 'wx' });
        await writeFile(path.join(root, 'candidate-cases', `${methodId}.development.json`), JSON.stringify(publicContract), { mode: 0o600, flag: 'wx' });
        return { ok: true, caseIds: cases.map(row => row.id), publishedReferenceCount: publications.length, reservedCaseCount: cases.filter(row => row.reserve).length, publicInputCount: cases.length,
          sourceHashes: cases.map(row => row.sourceHash), independentImplementation: true, access: 'evaluation-only', hash: sha(definition) };
      } catch (error) {
        if (error?.code === 'independent_reference_execution_unavailable') return wait(error.code);
        throw error;
      }
    },
  };
}
