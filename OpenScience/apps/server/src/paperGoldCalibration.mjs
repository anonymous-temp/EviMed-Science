import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { callModelForControlPlane } from "./modelGateway.mjs";
import { callReviewModel } from "./reviewModel.mjs";
import { validateRewrite, freezeCycle, digest } from "../../../evals/paper-gold/evaluator.mjs";
import { curatedCaseNumeric, printedTokenIn, TOLERANCE_QUANTITIES } from "../../../evals/paper-gold/tolerance.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
/** Deterministic XML text derivative; original bytes remain authoritative. @param {string} xml */
export function calibrationTextView(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?(?:p|title|sec|abstract|table|tr|td|th|list-item|ref|caption|article-title)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[name]))
    .replace(/[ \t\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/**
 * A literature-search cut-off as a date the exclusion policy can compare with, or the reason it cannot be one.
 *
 * The cut-off used to be whatever string the extracting model returned, handed to `Date.parse`:
 * "December 13th, 2018" is NaN there and made its case undispatchable, "March 2025" became 1 March and
 * "2021" became 1 January, so the period the authors searched through was excluded. Now the string has to
 * be a verbatim substring of the source (its bond), it is read with a closed grammar of date forms, and a
 * month or a year is taken to its last instant: a search "through March 2025" includes March.
 * Day/month/year orders that cannot be told apart ("03/04/2021") are refused, not guessed.
 * @param {string} source @param {unknown} cutoff
 * @returns {{ok:boolean,iso?:string,printed?:string,precision?:"day"|"month"|"year",reason?:string}} `ok:false` carries the `reason`
 */
export function calibrationSearchCutoff(source, cutoff) {
  if (typeof cutoff !== "string" || !cutoff.trim()) return { ok: false, reason: "search_cutoff_absent" };
  if (!source.includes(cutoff)) return { ok: false, reason: "search_cutoff_unbonded" };
  const text = cutoff.trim().replace(/\s+/g, " ");
  const month = name => { const key = name.toLowerCase().replace(/\.$/, ""); const index = MONTHS.findIndex(full => full === key || (key.length >= 3 && key.length <= 4 && full.startsWith(key.slice(0, 3)) && (key.length === 3 || full.startsWith(key)))); return index < 0 ? null : index + 1; };
  let parts = null, match;
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text))) parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{4})-(\d{2})$/.exec(text))) parts = [Number(match[1]), Number(match[2]), null];
  else if ((match = /^(\d{4})$/.exec(text))) parts = [Number(match[1]), null, null];
  else if ((match = /^(\d{4})\u5e74(?:(\d{1,2})\u6708(?:(\d{1,2})\u65e5)?)?$/.exec(text))) parts = [Number(match[1]), match[2] ? Number(match[2]) : null, match[3] ? Number(match[3]) : null];
  else if ((match = /^([A-Za-z]{3,9}\.?) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) parts = [Number(match[3]), month(match[1]), Number(match[2])];
  else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([A-Za-z]{3,9}\.?),? (\d{4})$/.exec(text))) parts = [Number(match[3]), month(match[2]), Number(match[1])];
  else if ((match = /^([A-Za-z]{3,9}\.?),? (\d{4})$/.exec(text))) parts = [Number(match[2]), month(match[1]), null];
  if (!parts) return { ok: false, reason: "search_cutoff_unreadable" };
  const [year, monthNumber, day] = parts;
  if (year < 1950 || year > 2100 || monthNumber === null && /[A-Za-z]/.test(text) || (monthNumber !== null && (monthNumber < 1 || monthNumber > 12))) return { ok: false, reason: "search_cutoff_unreadable" };
  // The last instant of the stated period, in UTC.
  const end = day !== null ? new Date(Date.UTC(year, monthNumber - 1, day, 23, 59, 59, 999)) : monthNumber !== null ? new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59, 999)) : new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  if (day !== null && (end.getUTCMonth() !== monthNumber - 1 || end.getUTCDate() !== day)) return { ok: false, reason: "search_cutoff_unreadable" };
  return { ok: true, iso: end.toISOString(), printed: cutoff, precision: day !== null ? "day" : monthNumber !== null ? "month" : "year" };
}
/** Exact quote bond with numeric lexical equivalence, including exponent notation. A tolerance is not part of
 * the bond: it is derived in code from the printed number (`tolerance.mjs`), never taken from the draft.
 * @param {string} source @param {any} row */
export function calibrationNumericBond(source, row) {
  if (typeof row.quote !== "string" || !source.includes(row.quote) || !Number.isFinite(row.value)) return false;
  return [...row.quote.matchAll(/(?:[-+]|\u2212[ \t]*)?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE](?:[-+]|\u2212[ \t]*)?\d+)?/g)]
    .some(match => Number(match[0].replaceAll("\u2212", "-").replace(/[ \t]/g, "").replaceAll(",", "")) === row.value);
}
/** Corpus curation commissions only withheld-input units; availability is a control-plane fact, never a model assertion. @param {any} input */
export function constrainCalibrationInputs(input) {
  return { ...structuredClone(input), inputAvailable: false, inputAvailabilityBasis: "evaluation_withheld_no_bound_verified_input",
    inputLimitations: [...new Set([...(Array.isArray(input.inputLimitations) ? input.inputLimitations : []), "This evaluation unit does not provide a hash-verified same-version analysis input asset. Published data may exist elsewhere; no global unavailability is asserted. Exact numerical reproduction cannot be claimed for this withheld-input unit."])] };
}
/** Structural failures are repair instructions, never an independent QA verdict. @param {any} draft */
export function calibrationDraftContractIssues(draft) {
  const issues = [];
  if (!Array.isArray(draft?.variants) || draft.variants.length !== 3 || new Set(draft.variants).size !== 3) issues.push("Return exactly THREE distinct variant strings, with no fourth variant; each must preserve the same full PICO and neutral report intent.");
  for (const [key, reference] of Object.entries(draft?.numeric ?? {})) {
    const row = /** @type {any} */ (reference);
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(key) || !Number.isFinite(row?.value) || typeof row.quote !== "string") issues.push(`Numeric output path ${key} requires one finite scalar value and an exact string quote; never nested objects or placeholders.`);
  }
  return issues;
}
/** Repair formatting only by an exact, unique non-whitespace character match; never approximate text or alter facts. @param {string} source @param {any} input */
export function repairCalibrationDraft(source, input) {
  const draft = structuredClone(input);
  const repairs = [];
  const offsets = [];
  let compact = "";
  for (let i = 0; i < source.length; i++) if (!/\s/u.test(source[i])) { compact += source[i]; offsets.push(i); }
  for (const [key, row] of Object.entries(draft.numeric ?? {})) {
    const reference = /** @type {any} */ (row);
    if (typeof reference.value === "string" && /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(reference.value) && Number.isFinite(Number(reference.value))) { reference.value = Number(reference.value); repairs.push({ key, kind: "numeric_json_type" }); }
    if (typeof reference.absoluteTolerance === "string" && Number.isFinite(Number(reference.absoluteTolerance)) && Number(reference.absoluteTolerance) >= 0) { reference.absoluteTolerance = Number(reference.absoluteTolerance); repairs.push({ key, kind: "tolerance_json_type" }); }
    if (typeof reference.quote !== "string" || source.includes(reference.quote)) continue;
    const normalized = calibrationTextView(reference.quote).replace(/\s/gu, "");
    const start = compact.indexOf(normalized);
    if (!normalized || start < 0 || compact.indexOf(normalized, start + 1) !== -1) continue;
    const quote = source.slice(offsets[start], offsets[start + normalized.length - 1] + 1);
    if (calibrationNumericBond(source, { ...reference, quote })) { repairs.push({ key, kind: "exact_unique_nonwhitespace_character_match", originalQuoteHash: hash(reference.quote), exactSourceQuoteHash: hash(quote) }); reference.quote = quote; }
  }
  return { draft, repairs };
}
/** Replacement is explicit and preserves the original manifest; admission still requires fresh QA. @param {any} manifest @param {any} replacementManifest @param {string|null} track @param {string|null} replacementId */
export function selectCalibrationCandidates(manifest, replacementManifest, track, replacementId) {
  if (replacementId === null) return { records: manifest.cases, replacement: null };
  const replacement = replacementManifest?.cases.find(row => row.id === replacementId && row.track === track);
  if (!replacement || !manifest.cases.some(row => row.id === replacement.replacesId && row.track === track)) throw new Error("Unknown same-track replacement candidate.");
  return { records: [...manifest.cases.filter(row => row.id !== replacement.replacesId), replacement], replacement };
}
/** Trusted primary-paper extraction and independent QA; no gold ever enters a research runtime.
 * Fifteen primary papers are candidates, not silently pre-approved benchmark results.
 * @param {any} dependencies */
export function createPaperGoldCalibration({ config, usageLedger, fetchImpl = fetch }) {
  const dataDir = config.evaluationDataDir || path.join(config.dataDir, "evaluation-control");
  return {
    /** @param {any} request */
    async prepare({ userId, cycleId, signal, track = null, reuseFromCycleId = null, targetedRepair = false, replacementId = null }) {
      if (config.reviewProvider === "deepseek") throw new Error("Calibration QA requires a different model family.");
      const manifest = JSON.parse(await readFile(new URL("../../../evals/paper-gold/calibration-manifest.json", import.meta.url), "utf8"));
      if (track && !["meta", "pharmacovigilance", "mr"].includes(track)) throw new Error("Invalid calibration track.");
      const replacementManifest = replacementId === null ? null : JSON.parse(await readFile(new URL("../../../evals/paper-gold/calibration-replacements.json", import.meta.url), "utf8"));
      const { records, replacement } = selectCalibrationCandidates(manifest, replacementManifest, track, replacementId);
      const cases = [], unavailable = [], replacedCandidates = [];
      if (reuseFromCycleId) {
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(reuseFromCycleId)) throw new Error("Invalid source calibration cycle.");
        const prior = JSON.parse(await readFile(path.join(dataDir, "paper-gold", "cycles", reuseFromCycleId, "definition.json"), "utf8"));
        if (prior.hash !== digest({ definition: prior.definition, evaluatorCodeHash: prior.evaluatorCodeHash }) || prior.definition.track !== track || prior.definition.sourceManifestHash !== hash(JSON.stringify(manifest))) throw new Error("Calibration reuse must preserve immutable hash, track and source manifest.");
        if (replacement && prior.definition.cases.some(row => row.id === replacement.replacesId)) throw new Error("An admitted case cannot be silently replaced.");
        if (replacement) replacedCandidates.push({ id: replacement.replacesId, replacementId: replacement.id, priorCycleId: reuseFromCycleId, priorCycleHash: prior.hash, priorFailure: prior.definition.unavailable.find(row => row.id === replacement.replacesId) ?? null });
        cases.push(...prior.definition.cases);
      }
      for (const record of records.filter(row => !track || row.track === track)) {
        if (cases.some(row => row.id === record.id)) continue;
        let preserved, primaryBytes;
        try { primaryBytes = await readFile(path.join(dataDir, "paper-gold", "calibration", `${record.id}.json`), "utf8"); preserved = JSON.parse(primaryBytes); }
        catch (error) { if (error.code !== "ENOENT") throw error; unavailable.push({ id: record.id, reason: "preserved_primary_unavailable" }); continue; }
        if (hash(primaryBytes) !== record.hiddenHash) { unavailable.push({ id: record.id, reason: "preserved_primary_integrity_changed" }); continue; }
        const source = typeof preserved.fullText === "string" ? calibrationTextView(preserved.fullText) : "";
        if (!source || source.length > 300000) { unavailable.push({ id: record.id, reason: source ? "primary_requires_bounded_chunk_curation" : "full_text_unavailable" }); continue; }
        const projectId = `eval-paper-${hash(`${cycleId}:curation`).slice(0, 40)}`;
        const responseDirectory = path.join(dataDir, "paper-gold", "curation", cycleId);
        await mkdir(responseDirectory, { recursive: true, mode: 0o700 });
        const responseFile = path.join(responseDirectory, `${record.id}.json`);
        let cache;
        try { cache = JSON.parse(await readFile(responseFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        let repairDraft;
        if (!cache && reuseFromCycleId) {
          try {
            const previous = JSON.parse(await readFile(path.join(dataDir, "paper-gold", "curation", reuseFromCycleId, `${record.id}.json`), "utf8"));
            if (previous.sourceViewHash === hash(source)) {
              repairDraft = { proposed: previous.draft, issues: [...(previous.qa?.value?.issues ?? []), ...(previous.questionQa?.value?.issues ?? []), ...calibrationDraftContractIssues(previous.draft)], failure: previous.failure, previousResponseHash: hash(JSON.stringify(previous)) };
              cache = targetedRepair ? { sourceViewHash: previous.sourceViewHash, originalEvidenceHash: repairDraft.previousResponseHash, originalEvidence: previous } : { ...previous, qa: previous.qa?.value?.passed === true ? previous.qa : undefined, failure: undefined, targetedQaFrom: repairDraft.previousResponseHash };
            }
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (cache && cache.sourceViewHash !== hash(source)) throw new Error("Preserved curation view changed.");
        const extraction = cache?.extraction ?? await callModelForControlPlane({ config, usageLedger, fetchImpl }, {
          userId, projectId, purpose: "evolution", signal, limits: { daily: config.evolutionDailyBudgetCny, weekly: 0 },
          body: { model: "deepseek-flash", thinking: { type: "disabled" }, response_format: { type: "json_object" }, max_tokens: 8192, messages: [
            { role: "system", content: 'Curate a published-paper research reproduction benchmark from this preserved deterministic primary text view. Return JSON {question,variants:[3 distinct neutral questions],numeric:{receipt_path:{value,quote,quantity}},inputAvailable:boolean,inputLimitations:[string],methodSpecification:string,cutoff:string|null,reachableEvidenceIds:[eligible included-study DOI/PMID/PMCID],unreachableEvidenceIds:[IDs],dataVersion:string|null}. Preserve population, intervention/exposure and outcome; remove direction, author, journal and target identifiers. Include explicit report intent. Select only 1 to 3 central published analysis estimates; copy exact contiguous text-view substrings as quotes, with unchanged whitespace. Each numeric map entry MUST be one flat named output path (for example analysis.ror), with a finite JSON number value, a string quote, and quantity as one of ratio, difference, probability, p-value, count, other. Do not supply tolerances: they are derived from the printed precision. Never nest drug objects, use placeholder strings, nulls, arrays, or object-valued estimates. If no justified scalar is available return numeric:{}; do not manufacture one. Preserve the quoted numeric scale and units, including percentages, without implicit conversion. Numeric values must occur verbatim in exact source quotes and refer to named outcomes in the methods; never invent values or data. Numeric paths should match the deterministic analysis receipt the evaluator can compare. Mark inputAvailable false when exact same-version inputs are absent, and explicitly include a withheld-input request variant whose correct answer is inability to reproduce. Do not equate preserved full text with accessible study-level data. For cutoff give the literature-search end date exactly as the methods print it (an exact substring holding only the date, such as "December 13th, 2018" or "March 2025"), or null when no search date is stated. No self-reported scores.' },
            { role: "user", content: repairDraft ? JSON.stringify({ source, targetedRepair: repairDraft, instruction: "Repair only the identified failures. Retain the same paper and PICO. Preserve named interventions/exposures; hide article identifiers, authors and title. Select exact contiguous source substrings for 1-3 numeric quotes. Do not alter an estimate or its outcome to obtain a pass. If unavailable, explicitly say so." }) : source },
          ] },
        });
        cache = { ...cache, sourceHash: hash(preserved.fullText), sourceViewHash: hash(source), extraction, ...(repairDraft ? { targetedRepairFrom: repairDraft.previousResponseHash } : {}) };
        await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 });
        let draft;
        try { draft = cache.draft ?? JSON.parse(extraction.choices?.[0]?.message?.content ?? "{}"); }
        catch { cache.failure = "primary_extraction_response_invalid"; await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 }); unavailable.push({ id: record.id, reason: cache.failure }); continue; }
        const originalDraftHash = hash(JSON.stringify(draft));
        const repaired = repairCalibrationDraft(source, draft);
        draft = constrainCalibrationInputs(repaired.draft);
        if (cache.draft && digest(cache.draft) !== digest(draft)) cache = { ...cache, qa: undefined, questionQa: undefined };
        if (repaired.repairs.length) { cache = { ...cache, qa: undefined, originalDraftHash, repairs: repaired.repairs }; }
        const qa = cache.qa ?? await callReviewModel({ config, usageLedger, fetchImpl }, {
          userId, projectId, purpose: "evolution", limits: { daily: config.evolutionDailyBudgetCny, weekly: 0 }, signal, schemaName: "paper_gold_primary_qa", maxTokens: 2048,
          schema: { type: "object", additionalProperties: false, required: ["passed", "issues"], properties: { passed: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } } },
          messages: [{ role: "system", content: "Independently check the proposed benchmark against the exact primary source. Count the variant array elements explicitly: anything other than exactly three distinct strings fails. Verify every numerical value, exact quote, outcome label, inputs and data version against this deterministic text view; numerical formatting 1.30 equals 1.3 and comma-separated thousands are allowed, but quote strings must match exactly; distinguish primary trial effects from pooled results and observational effects from MR. Neutral wording must preserve PICO INCLUDING the named intervention/exposure/comparator/outcome; forbidden target identifiers mean article DOI/PMID/PMCID, article title, authors and journal, not the PICO intervention names. Commission a report and include exactly three distinct variants. Correctly declared missing exact inputs are an honest question-response benchmark; do not reject it solely because full reproduction is unavailable. Do not require trial-level effects when a clearly named pooled meta-analysis estimate is the stated outcome. Confirm cutoff and reachable-source IDs. Reject unsupported gold or inputs. A commission asking to calculate a numerical estimate or confidence interval is permitted; it does not disclose the published answer. Reject actual answer values or directional conclusions embedded in the neutral question. Return passed and specific issues." }, { role: "user", content: JSON.stringify({ source, proposed: draft, enforcedEvaluationInputConstraint: "No hash-verified same-version input asset is provided to this evaluation unit. Treat inputAvailable:false as an intentionally withheld-input protocol, not a claim that public source data cannot exist." }) }],
        });
        cache = { ...cache, draft, qa };
        await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 });
        const aliases = [record.doi, record.pmid ? `PMID:${record.pmid}` : null, record.pmcid].filter(Boolean);
        const rewrite = { writer: "deepseek-flash", qaExecutor: "qwen-primary-qa", qaPassed: qa.value.passed === true, question: draft.question, variants: draft.variants };
        const admitQuestion = async reason => {
          try { validateRewrite({ ...rewrite, qaPassed: true }, { identifiers: aliases }); }
          catch { return false; }
          const proposed = { question: draft.question, methodSpecification: draft.methodSpecification, variants: draft.variants };
          const questionDraftHash = hash(JSON.stringify(proposed));
          const questionQa = cache.questionDraftHash === questionDraftHash ? cache.questionQa : undefined;
          const review = questionQa ?? await callReviewModel({ config, usageLedger, fetchImpl }, {
            userId, projectId, purpose: "evolution", limits: { daily: config.evolutionDailyBudgetCny, weekly: 0 }, signal,
            schemaName: "paper_gold_question_only_qa", maxTokens: 2048,
            schema: { type: "object", additionalProperties: false, required: ["passed", "issues"], properties: { passed: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } } },
            messages: [{ role: "system", content: "Independently verify ONLY this question benchmark against the preserved primary text: accurate PICO including named exposures/interventions, comparators, outcomes, and methods; a neutral commission for a report; exactly three distinct faithful variants; no article identifiers, title, author or journal, and no answer direction or published numerical result. The words reported, numerical, estimates, and confidence intervals are not literal answer values. Asking to estimate or independently reproduce an effect, ROR or confidence interval is permitted and is NOT disclosure of an actual published numerical answer. When exact inputs are explicitly unavailable, a conditional request to assess reproducibility must not be read as assuming those inputs exist; reject literal published answer values or answer direction in the question, not a request to calculate. This ruler does not test numerical reproduction: No hash-verified same-version research input asset is provided to this evaluation unit; published data may exist elsewhere. Never invent inputs or infer global unavailability. Reject unsupported question/method facts. Return passed and issues." }, { role: "user", content: JSON.stringify({ source, proposed }) }],
          });
          cache = { ...cache, questionDraftHash, questionQa: review, failure: reason };
          await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 });
          if (review.value.passed !== true) return false;
          cases.push({ id: record.id, publicationId: record.doi ?? record.pmcid ?? record.pmid ?? null, sourceHash: hash(source), engineId: record.track, track: record.track, type: "question",
            capabilityId: { meta: "meta-analysis", pharmacovigilance: "adr-analysis", mr: "mendelian-randomization" }[record.track],
            rewrite: { ...rewrite, qaPassed: true, qaExecutor: "qwen-question-only-primary-qa" },
            input: `${draft.question}\nMethod specification: ${draft.methodSpecification}\nNo hash-verified same-version analysis input asset is provided to this evaluation unit. Published data may exist elsewhere. State the resulting limitations without inventing data or claiming exact reproduction.`,
            policy: { aliases, titles: [preserved.record.title] }, dois: record.doi ? [record.doi] : [],
            unsupportedRulers: [{ type: "method", reason }, { type: "research", reason: "same_version_inputs_unavailable" }],
            gold: { numeric: {}, inputAvailable: false, benchmarkScope: "question-only", applicableStages: ["question", "method", "certainty", "writing"], sourceHash: hash(source), inputLimitations: draft.inputLimitations,
              preservedEvidence: [{ id: record.id, sourceHash: hash(source) }], reachableEvidenceIds: [], unreachableEvidenceIds: [],
              stageChecks: { question: ["question_aligned"], method: ["method_supported"], certainty: ["certainty_supported"], writing: ["writing_sources_bound"] } } });
          return true;
        };
        const bonded = {};
        let numericBondValid = true;
        for (const [key, reference] of Object.entries(draft.numeric ?? {})) {
          const row = /** @type {any} */ (reference);
          const printed = calibrationNumericBond(source, row) ? printedTokenIn(row.quote, row.value) : null;
          if (!printed) { numericBondValid = false; break; }
          bonded[key] = { value: row.value, printed, quote: row.quote, ...(TOLERANCE_QUANTITIES.includes(row.quantity) ? { quantity: row.quantity } : {}) };
        }
        // The tolerance of every number is the printed precision, by rule; and a case none of whose numbers can tell
        // a real answer from the trivial one is not a numeric reference.
        const curated = numericBondValid && Object.keys(bonded).length ? curatedCaseNumeric(bonded) : null;
        const numeric = curated?.ok ? curated.numeric : {};
        if (!curated?.ok) { cache.failure = curated?.code === "case_accepts_trivial_answer" ? "primary_numeric_cannot_discriminate_trivial_answer" : "primary_numeric_quotation_bond_failed"; await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 }); if (!await admitQuestion(cache.failure)) unavailable.push({ id: record.id, reason: cache.failure }); continue; }
        // A stated search cut-off that cannot be bonded and read is not replaced by a guess or silently dropped.
        const searchCutoff = draft.cutoff == null ? null : calibrationSearchCutoff(source, draft.cutoff);
        if (searchCutoff && !searchCutoff.ok) { cache.failure = searchCutoff.reason; await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 }); if (!await admitQuestion(cache.failure)) unavailable.push({ id: record.id, reason: cache.failure }); continue; }
        if (qa.value.passed !== true) { cache.failure = "independent_primary_qa_failed"; await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 }); if (!await admitQuestion(cache.failure)) unavailable.push({ id: record.id, reason: cache.failure, issues: qa.value.issues }); continue; }
        try { validateRewrite(rewrite, { identifiers: aliases }); }
        catch { cache.failure = "neutral_rewrite_validation_failed"; await writeFile(responseFile, JSON.stringify(cache), { mode: 0o600 }); unavailable.push({ id: record.id, reason: cache.failure }); continue; }
        const reachable = [], unreachable = [...(draft.unreachableEvidenceIds ?? [])];
        for (const identifier of (draft.reachableEvidenceIds ?? []).slice(0, 64)) {
          const normalized = String(identifier);
          const query = /^10\.\d{4,9}\//.test(normalized) ? `DOI:"${normalized}"` : /^PMID:?\d+$/.test(normalized) ? `EXT_ID:${normalized.replace(/^PMID:?/, "")} AND SRC:MED` : /^PMC\d+$/.test(normalized) ? `PMCID:${normalized}` : null;
          if (!query) { unreachable.push(normalized); continue; }
          const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
          url.search = new URLSearchParams({ query, format: "json", pageSize: "1" }).toString();
          try {
            const response = await fetchImpl(url, { signal: signal ?? AbortSignal.timeout(30000), redirect: "error" });
            const payload = response.ok ? /** @type {any} */ (await response.json()) : null;
            if (payload?.hitCount > 0) reachable.push(normalized); else unreachable.push(normalized);
          } catch (error) { signal?.throwIfAborted(); unreachable.push(normalized); }
        }
        unreachable.push(...(draft.reachableEvidenceIds ?? []).slice(64));
        const type = "research";
        cases.push({ id: record.id, publicationId: record.doi ?? record.pmcid ?? record.pmid ?? null, engineId: record.track, sourceHash: hash(source), track: record.track, type, capabilityId: { meta: "meta-analysis", pharmacovigilance: "adr-analysis", mr: "mendelian-randomization" }[record.track], rewrite,
          input: `${draft.question}\nMethod specification: ${draft.methodSpecification}\n${draft.inputAvailable ? "Reproduce the stated methods using verified same-version inputs." : "The exact same-version analysis inputs are withheld. State what cannot be reproduced; do not manufacture inputs or claim exact reproduction."}`,
          policy: { aliases, titles: [preserved.record.title], ...(searchCutoff ? { cutoff: searchCutoff.iso } : {}) }, dois: record.doi ? [record.doi] : [],
          ...(searchCutoff ? { searchCutoff: { printed: searchCutoff.printed, iso: searchCutoff.iso, precision: searchCutoff.precision } } : {}),
          gold: { numeric: draft.inputAvailable === true ? numeric : {}, baselineNumeric: numeric, ...(draft.inputAvailable === true ? {} : { applicableStages: ["question", "method", "certainty", "writing"] }), inputAvailable: draft.inputAvailable === true, inputAvailabilityBasis: draft.inputAvailabilityBasis, inputLimitations: draft.inputLimitations, dataVersion: draft.dataVersion, sourceHash: hash(source), preservedEvidence: [{ id: record.id, sourceHash: hash(source), numericQuotes: Object.values(numeric).map(row => row.quote) }], reachableEvidenceIds: reachable, unreachableEvidenceIds: [...new Set(unreachable)], stageChecks: { question: ["question_aligned"], method: ["method_supported"], recall: ["reachable_sources_recalled"], extraction: ["input_data_preserved"], calculation: ["deterministic_receipts"], certainty: ["certainty_supported"], writing: ["writing_sources_bound"] } },
        });
      }
      const definition = { schemaVersion: 1, assessmentConfiguration: { reviewProvider: config.reviewProvider, reviewModel: config.reviewModel, baselineModel: "deepseek-flash" }, replicates: 2, track, cases, unavailable, status: "independently_curated_not_live_scored", sourceManifestHash: hash(JSON.stringify(manifest)), ...(replacement ? { replacementManifestHash: hash(JSON.stringify(replacementManifest)), replacementId: replacement.id, replacedCandidates } : {}) };
      const frozen = await freezeCycle(dataDir, cycleId, definition);
      await mkdir(frozen.directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(frozen.directory, "calibration-readiness.json"), JSON.stringify({ caseIds: cases.map(row => row.id), unavailable, definitionHash: frozen.hash }), { mode: 0o600 });
      return { definition, definitionHash: frozen.hash, caseIds: cases.map(row => row.id), unavailable };
    },
  };
}
