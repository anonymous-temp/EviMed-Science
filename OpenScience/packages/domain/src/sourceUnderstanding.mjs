/** Source understanding has one data registry and one deterministic contract.
 * Semantic interpretation belongs to the capability; this module checks shape,
 * source identity and exact character bonds only. Offsets are UTF-16 code units. */
import { distillationCompleteness } from './analysis.mjs'

export const SOURCE_UNDERSTANDING_VERSION = 1
export const SOURCE_UNDERSTANDING_MAX_CHARS = 16 * 1024 * 1024
export const SOURCE_UNDERSTANDING_FILE = 'source-understanding.json'
export const SOURCE_UNDERSTANDING_INPUT_FILE = 'source-understanding-input.json'

const schemas = Object.freeze([
  { id: 'procedure', docTypes: ['research-protocol', 'grant-proposal'], slots: ['purpose', 'applicability', 'inputs', 'steps', 'checks', 'pitfalls'] },
  { id: 'paper', docTypes: ['published-paper', 'preprint-manuscript', 'review-guideline'], slots: ['doi', 'design', 'population', 'interventionExposure', 'outcomes', 'effectEstimates', 'limitations'] },
  { id: 'notes', docTypes: ['note-memo', 'message-export'], slots: ['topic', 'decisions', 'actions', 'openQuestions'] },
  { id: 'general', docTypes: [], slots: ['purpose', 'keyInformation', 'limitations'] },
].map(schema => Object.freeze({ ...schema, slots: Object.freeze(schema.slots), docTypes: Object.freeze(schema.docTypes) })))
export const SOURCE_UNDERSTANDING_SCHEMAS = schemas

/** @param {string} docType */
export function sourceUnderstandingSchema(docType) {
  return schemas.find(schema => schema.docTypes.includes(docType)) ?? schemas[schemas.length - 1]
}

/** @param {{sourceId:string,generation:number,docType:string,depth:string,text:string}} value */
export function normalizeSourceText(value) {
  if (typeof value.text !== 'string' || value.text.length > SOURCE_UNDERSTANDING_MAX_CHARS) throw new TypeError('Source text exceeds the supported complete-text limit.')
  const text = value.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const units = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 8000, text.length)
    // Keep valid surrogate pairs in one JSONB-storable chunk without changing
    // the global UTF-16 offsets used by exact source anchors.
    if (end < text.length && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF
      && text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF) end -= 1
    units.push({ id: `${value.sourceId}:g${value.generation}:u${units.length + 1}`, unitType: 'chunk', start, end, text: text.slice(start, end), status: 'indexed_only' })
    start = end
  }
  if (!units.length) units.push({ id: `${value.sourceId}:g${value.generation}:u1`, unitType: 'chunk', start: 0, end: 0, text: '', status: 'no_content' })
  // `auditSample` is a convenience for the run: it names the units the omission
  // audit must examine so the run never has to reproduce the hash in prose. It
  // is not authority — the contract recomputes the same plan from the immutable
  // capture, so an edited input file cannot move the sample. A run given no
  // `auditSample` reports `not_run`, which stays a deliverable answer.
  return { schemaVersion: SOURCE_UNDERSTANDING_VERSION, sourceId: value.sourceId, generation: value.generation, docType: value.docType, depth: value.depth,
    schema: sourceUnderstandingSchema(value.docType), text, units, auditSample: sourceUnderstandingAuditSample({ sourceId: value.sourceId, generation: value.generation, units }) }
}

/** The omission audit's status vocabulary.
 *
 * `not_run` stays valid on purpose. Coverage answers which units were parsed;
 * only the audit answers whether anything inside them went unrepresented, and a
 * deployment that does not sample must still be able to deliver rather than be
 * pushed into stating a rate it did not measure.
 */
export const SOURCE_UNDERSTANDING_AUDIT_STATUSES = Object.freeze(['not_run', 'audited'])
/** One unit in five, up to twelve. The cap keeps the audit inside the output's
 * byte budget; the fraction keeps a long source from being audited by a single
 * lucky chunk. `Math.ceil` already yields at least one unit for any non-empty
 * source, so there is no separate floor to state. */
export const SOURCE_UNDERSTANDING_AUDIT_SAMPLE_FRACTION = 0.2
export const SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES = 12
/** How much of a sample's note is kept. One sentence is what the note is for;
 * twelve samples at this bound is about 15 KB of Chinese, a seventh of the
 * output's 100,000-byte limit, so an audit can never be what pushes a package
 * over it. A longer note is dropped from the record rather than refused — the
 * bound is stated in SKILL.md so the run knows it before it writes. */
export const SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS = 400

/** FNV-1a over UTF-16 code units: a pure function of the string, so the sample
 * is the same on every host, in every process and after every restart.
 * @param {string} value */
function stableHash(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Which units this source's omission audit examines.
 *
 * Deterministic and reproducible from the source identity alone: two runs over
 * the same `(sourceId, generation)` audit the same units, so a rerun is a
 * comparison rather than a new sample, and the measurement never depends on the
 * units a run happens to have quoted. Empty units are excluded — a chunk with no
 * characters has nothing that could have been omitted.
 *
 * Returned in document order.
 *
 * @param {{sourceId:string,generation:number,units:readonly any[]}} input
 * @returns {string[]} unit ids, in document order
 */
export function sourceUnderstandingAuditSample(input) {
  const units = (Array.isArray(input?.units) ? input.units : []).filter((/** @type {any} */ unit) =>
    record(unit) && typeof unit.id === 'string' && Number.isSafeInteger(unit.start) && Number.isSafeInteger(unit.end) && unit.end > unit.start)
  if (!units.length) return []
  const size = Math.min(SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES, Math.ceil(units.length * SOURCE_UNDERSTANDING_AUDIT_SAMPLE_FRACTION))
  const seed = `${input.sourceId}:g${input.generation}`
  return units
    .map((/** @type {any} */ unit) => ({ unit, rank: stableHash(`${seed}:${unit.id}`) }))
    // Rank ties break on the unit id, so the order never depends on the input array's order.
    .sort((left, right) => left.rank - right.rank || (left.unit.id < right.unit.id ? -1 : left.unit.id > right.unit.id ? 1 : 0))
    .slice(0, size)
    .map((/** @type {any} */ entry) => entry.unit)
    .sort((/** @type {any} */ left, /** @type {any} */ right) => left.start - right.start)
    .map((/** @type {any} */ unit) => unit.id)
}

/** Whether an anchor is an exact character bond into the immutable capture.
 *
 * One predicate, used both to report an unusable anchor and to decide which
 * units the output reaches, so the contract and the omission notice cannot
 * drift apart about what "represented" means.
 * @param {any} anchor @param {Map<string, any>} units @param {any} input */
function exactAnchor(anchor, units, input) {
  const unit = units.get(anchor?.unitId)
  return Boolean(record(anchor) && unit && anchor.sourceId === input.sourceId && anchor.generation === input.generation
    && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end)
    && anchor.start >= unit.start && anchor.end <= unit.end && anchor.end > anchor.start
    && nonempty(anchor.quote, 2000) && input.text.slice(anchor.start, anchor.end) === anchor.quote)
}

/** The units this output actually reaches, read off the output's own anchors.
 *
 * This is the control plane's own reading and it is what the omission audit is
 * measured from. It never consults `omissionAudit`, so how a run describes its
 * audit cannot move the measurement.
 * @param {any} output @param {any} input @returns {Set<string>} */
function citedUnitsOf(output, input) {
  /** @type {Set<string>} */
  const cited = new Set()
  if (typeof input?.text !== 'string' || !Array.isArray(input.units)) return cited
  const units = new Map(input.units.filter((/** @type {any} */ unit) => record(unit)).map((/** @type {any} */ unit) => [unit.id, unit]))
  /** @param {any} evidence */
  const take = evidence => {
    for (const anchor of Array.isArray(evidence) ? evidence : []) if (exactAnchor(anchor, units, input)) cited.add(anchor.unitId)
  }
  for (const raw of Object.values(record(output?.slots) ? output.slots : {})) {
    const slot = /** @type {any} */ (raw)
    if (slot?.state === 'known') take(slot.evidence)
  }
  for (const key of ['claims', 'methods']) for (const item of Array.isArray(output?.[key]) ? output[key] : []) take(item?.evidence)
  return cited
}

/** The omission audit's shape, and deliberately nothing beyond it.
 *
 * The audit is a self-report. Everything it asserts — which units belong to the
 * sample, whether each one is represented, the rate that follows — the control
 * plane derives for itself from the frozen input and the output's own anchors
 * (`sourceUnderstandingOmissionNotice`, which the projection stores). So the
 * run's arithmetic carries no information the control plane lacks, and there is
 * nothing in it worth refusing a finished package over: an issue returned here
 * becomes `source_understanding_invalid`, which the source worker treats as
 * terminal, so a check placed here is an ingestion lost with no repair loop.
 * Blocking points are budgeted at six system-wide and this is not one of them;
 * a disagreement is reported as a notice instead.
 *
 * What remains are the three properties a stored record is unusable without: a
 * status from the vocabulary, a reason, and a rate that does not silently turn
 * an audit nobody ran into a clean one.
 *
 * @param {any} audit @returns {string[]}
 */
function omissionAuditIssues(audit) {
  /** @type {string[]} */
  const issues = []
  if (!record(audit) || !SOURCE_UNDERSTANDING_AUDIT_STATUSES.includes(audit.status)) {
    return [`omissionAudit.status must be one of: ${SOURCE_UNDERSTANDING_AUDIT_STATUSES.join(', ')}.`]
  }
  if (!nonempty(audit.reason, 2000)) issues.push('omissionAudit needs a reason.')
  if (audit.status === 'not_run') {
    // Absent is not zero. An audit that did not run reports no rate at all.
    if (audit.omissionRate !== null) issues.push('omissionAudit has not run; omissionRate must be null, because an absent audit is not a zero omission rate.')
  } else if (audit.omissionRate !== null && audit.omissionRate !== undefined
    && !(typeof audit.omissionRate === 'number' && Number.isFinite(audit.omissionRate) && audit.omissionRate >= 0 && audit.omissionRate <= 1)) {
    issues.push('omissionAudit.omissionRate must be null or a fraction between 0 and 1.')
  }
  return issues
}

/** Where the run's account of its own audit differs from the control plane's.
 *
 * Every line is an observation, never an error. This is the distribution that
 * would have to exist, and be looked at, before any of it could be considered
 * for blocking — which is a separate, budgeted decision, not an edit here.
 *
 * @param {string} status @param {readonly string[]} plan
 * @param {readonly {unitId:string,represented:boolean}[]} samples
 * @param {Map<string, any>} reported
 * @param {number|null} reportedRate @param {number|null} derivedRate
 * @returns {string[]}
 */
function auditDisagreements(status, plan, samples, reported, reportedRate, derivedRate) {
  /** @type {string[]} */
  const lines = []
  if (status !== 'audited') {
    if (reported.size) lines.push(`The audit reports ${status} yet attaches ${reported.size} sample(s).`)
    return lines
  }
  const missing = plan.filter(unitId => !reported.has(unitId))
  const extra = [...reported.keys()].filter(unitId => !plan.includes(unitId))
  if (missing.length) lines.push(`The audit did not report on ${missing.length} of this source's ${plan.length} sampled unit(s): ${missing.join(', ')}.`)
  if (extra.length) lines.push(`The audit reported on ${extra.length} unit(s) outside this source's sample: ${extra.join(', ')}.`)
  for (const sample of samples) {
    const claimed = reported.get(sample.unitId)?.represented
    if (typeof claimed === 'boolean' && claimed !== sample.represented) {
      lines.push(`The audit calls ${sample.unitId} ${claimed ? 'represented' : 'unrepresented'}; the anchors this output carries say ${sample.represented ? 'represented' : 'unrepresented'}.`)
    }
  }
  if (reportedRate !== null && derivedRate !== null && reportedRate !== derivedRate) {
    lines.push(`The audit reports an omission rate of ${reportedRate}; the anchors this output carries imply ${derivedRate}.`)
  }
  return lines
}

// HAND-OFF TO apps/server (the control plane) AND apps/web, 2026-09-07.
//
// This contract used to mandate that the omission audit had never run: any
// output whose status was not `not_run` was rejected. It now accepts a
// delivered result, refuses nothing about its arithmetic, and derives the
// authoritative numbers itself. Six properties have to hold outside this
// package for that to be worth anything. Each is stated as a property and
// anchored on a symbol rather than a line number, because these files are being
// edited in parallel and a line number is stale the day it is written: grep the
// named symbol to check one. A property already satisfied is to be preserved,
// not redone. None of them is optional.
//
//   1. The publish path in `sourceService.mjs` keeps what the run delivered:
//      `omissionAudit: output?.omissionAudit ?? {...UNAUDITED_OMISSION}`. The
//      pre-understanding record starting at `{...UNAUDITED_OMISSION}` is right;
//      only a path that overwrites a delivered `audited` verdict with it is
//      wrong.
//   2. Every `projectSourceUnderstandingOutput` call that holds the immutable
//      input passes it as the second argument — the publish path in
//      `sourceService.mjs` and the run-result path in
//      `sourceUnderstandingRuns.mjs`. (Re-projecting an already stored record
//      for read has no input and correctly passes none.) Without the input the
//      stored audit is the run's self-report; with it the stored audit is the
//      control plane's own reading of the same output, which is the whole
//      reason this contract can afford not to refuse a run whose arithmetic is
//      off.
//   3. `coverage.omissionRate` carries the projected
//      `omissionAudit.omissionRate` when the delivered audit is `audited`. Both
//      places that build a coverage object hard-coded that field to null, which
//      left the one measured number permanently absent from the source row.
//   4. `sourceUnderstandingOmissionNotice(output, input)` is a NOTICE. Display
//      or meter `withinTarget`, `target` and `disagreements`; none of them may
//      ever fail a delivery, and none of them appears in the issue list
//      `validateSourceUnderstanding` returns. Both names are exported from
//      `@evimed/domain` (`packages/domain/index.mjs`), so the import is
//      `import { sourceUnderstandingOmissionNotice } from "@evimed/domain"`.
//   5. `normalizeSourceText` puts the sample plan in the input as `auditSample`,
//      which is what tells a run which units to audit. The fresh-parse path gets
//      it for free; `sourceService.loadCapture` rebuilds the input object field
//      by field and must add `auditSample: sourceUnderstandingAuditSample({
//      sourceId, generation, units })` (also exported). Without it every retry
//      and restart of a source whose first attempt could audit delivers
//      `not_run` — degraded, not broken.
//   6. Web: `SourcesPage.tsx` branches on the audit status. Two surfaces still
//      do not. `SourceUnderstandingPanel.tsx` renders 「遗漏尚未审计」 for every
//      record, audited or not, and `sourceClient.ts` types `omissionAudit` as
//      `{status:"not_run"; reason:string; omissionRate:null}` only. Both need
//      the audited shape `{status; reason; omissionRate:number|null;
//      samples:{unitId;represented;note?}[]}`.
//
// The run side needs nothing beyond its SKILL.md.

/** The distillation-completeness verdict for a delivered understanding, and
 * every disagreement between what the run reported and what its output shows.
 *
 * NOTICE ONLY, AND DELIBERATELY SO, in two senses.
 *
 * `withinTarget` compares the measured omission rate against
 * `distillationCompleteness`'s 5%/15% targets, and those targets have never
 * been checked against an observed distribution of real sources. `disagreements`
 * records where the run's self-report and the control plane's reading differ,
 * and that distribution has never been observed either. Per the development
 * principles a new check ships as a notice or a metric first, so neither is
 * called by `validateSourceUnderstanding` and neither can appear in its issue
 * list: an over-target or self-contradictory audit is a delivered package with
 * a measured shortfall recorded against it, not a refused one. If a real-world
 * distribution ever justifies blocking, that is a separate, budgeted decision —
 * not an edit to this function.
 *
 * `samples`, `omissionRate` and `audited` are derived here, from the frozen
 * input and the output's own anchors, and are what the projection stores. The
 * run's `omissionRate` is carried through untouched as `reportedRate` so the
 * two can be compared rather than confused.
 *
 * @param {any} output @param {any} input
 * @returns {{status:string, omissionRate:number|null, target:number, withinTarget:boolean, audited:number,
 *   plan:string[], samples:{unitId:string,represented:boolean,note?:string}[], reportedRate:number|null,
 *   disagreements:string[], blocking:false}}
 */
export function sourceUnderstandingOmissionNotice(output, input) {
  const audit = record(output?.omissionAudit) ? output.omissionAudit : {}
  const status = SOURCE_UNDERSTANDING_AUDIT_STATUSES.includes(audit.status) ? audit.status : 'unknown'
  const plan = sourceUnderstandingAuditSample(input)
  const cited = citedUnitsOf(output, input)
  /** @type {Map<string, any>} */
  const reported = new Map()
  for (const sample of Array.isArray(audit.samples) ? audit.samples : []) {
    // First mention of a unit wins, so a repeated unit cannot make the reading order-dependent.
    if (record(sample) && nonempty(sample.unitId, 200) && !reported.has(sample.unitId)) reported.set(sample.unitId, sample)
  }
  /** @type {{unitId:string,represented:boolean,note?:string}[]} */
  const samples = []
  if (status === 'audited') {
    for (const unitId of plan) {
      const represented = cited.has(unitId)
      const note = reported.get(unitId)?.note
      // The run's note is the one thing only the run can supply: what the unit
      // holds that nothing in the output reaches. Representation is not.
      samples.push(nonempty(note, SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS) ? { unitId, represented, note } : { unitId, represented })
    }
  }
  const verdict = distillationCompleteness(samples.map(sample => ({ unitId: sample.unitId, answered: sample.represented })), input?.depth)
  const omissionRate = samples.length ? verdict.omissionRate : null
  const reportedRate = typeof audit.omissionRate === 'number' && Number.isFinite(audit.omissionRate) ? audit.omissionRate : null
  return {
    status, omissionRate, target: verdict.target, withinTarget: verdict.withinTarget, audited: verdict.audited,
    plan, samples, reportedRate, disagreements: auditDisagreements(status, plan, samples, reported, reportedRate, omissionRate), blocking: false,
  }
}

/** @param {any} value @param {number} max */
function nonempty(value, max = 8000) { return typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !value.includes('\0') }
/** @param {any} value */
function record(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

/** This validator is also called against the control plane's immutable capture.
 * A run-side input copy is useful feedback, never canonical source authority.
 * @param {any} output @param {any} input @returns {string[]} */
export function validateSourceUnderstanding(output, input) {
  /** @type {string[]} */
  const issues = []
  if (!record(output) || !record(input)) return ['Understanding and immutable input must be objects.']
  for (const key of ['schemaVersion', 'sourceId', 'generation', 'docType', 'depth']) {
    if (output[key] !== input[key]) issues.push(`${key} must equal the immutable source input.`)
  }
  if (input.schemaVersion !== 1 || !nonempty(input.sourceId, 160) || !Number.isSafeInteger(input.generation) || input.generation < 1
    || typeof input.text !== 'string' || !Array.isArray(input.units)) return [...issues, 'Immutable source input is invalid.']
  if (!['structured', 'deep'].includes(input.depth)) issues.push('Understanding is only valid for structured or deep depth.')
  if (!nonempty(output.summary, 8000)) issues.push('summary is required and bounded.')
  const units = new Map(input.units.map((/** @type {any} */ unit) => [unit.id, unit]))
  // One shared predicate decides both which anchors are unusable and which units
  // the output reaches, so the contract and the omission notice cannot drift.
  const citedUnits = citedUnitsOf(output, input)
  let anchors = 0
  /** @param {any} evidence @param {string} where */
  const checkEvidence = (evidence, where) => {
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8) { issues.push(`${where} needs 1 to 8 source anchors.`); return }
    for (const anchor of evidence) {
      anchors += 1
      if (!exactAnchor(anchor, units, input)) issues.push(`${where} needs an exact quote within its source generation and unit range.`)
    }
  }
  const schema = sourceUnderstandingSchema(input.docType)
  if (!record(output.slots)) issues.push('slots must be an object.')
  else {
    for (const key of Object.keys(output.slots)) if (!schema.slots.includes(key)) issues.push(`Unknown slot: ${key}.`)
    for (const key of schema.slots) {
      const slot = output.slots[key]
      if (slot?.state === 'known') {
        if (!nonempty(slot.value)) issues.push(`slots.${key} needs a known value.`)
        checkEvidence(slot.evidence, `slots.${key}`)
      } else if (slot?.state !== 'unknown' || !nonempty(slot.reason, 2000)) issues.push(`slots.${key} must be known with evidence or unknown with a reason.`)
    }
  }
  const ids = new Set()
  for (const key of ['claims', 'methods']) {
    const items = output[key]
    if (!Array.isArray(items) || items.length > (key === 'claims' ? 40 : 6)) { issues.push(`${key} must be a bounded array.`); continue }
    if (key === 'methods' && input.depth !== 'deep' && items.length) issues.push('Method drafts require deep depth.')
    for (const item of items) {
      if (!record(item) || !nonempty(item.id, 80) || ids.has(item.id)) { issues.push(`${key} entries need unique ids.`); continue }
      ids.add(item.id)
      if (key === 'claims' && !nonempty(item.statement, 4000)) issues.push('Each claim needs a statement.')
      if (key === 'methods') {
        for (const field of ['title', 'description', 'whenToUse']) if (!nonempty(item[field], 2000)) issues.push(`Method ${field} is required.`)
        for (const field of ['steps', 'checks', 'pitfalls']) {
          if (!Array.isArray(item[field]) || item[field].length > 30 || item[field].some((/** @type {any} */ part) => !nonempty(part, 2000))
            || (field === 'steps' && !item[field].length)) issues.push(`Method ${field} must be a bounded list.`)
        }
        if (item.status !== 'draft') issues.push('Methods must remain drafts.')
      }
      checkEvidence(item.evidence, `${key}.${item.id}`)
    }
  }
  if (anchors > 100 || citedUnits.size > 32) issues.push('Understanding exceeds the bounded anchor or cited-unit limit.')
  // The audit's shape is checked; its arithmetic is not. See `omissionAuditIssues`.
  issues.push(...omissionAuditIssues(output.omissionAudit))
  // Leave space within ProductDocuments' 256 KiB limit for immutable record
  // identity, source-unit metadata and the actual run/usage receipt.
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 100_000) issues.push('Understanding exceeds the 100000 UTF-8 byte output limit.')
  return issues
}

/** Discard undeclared fields before public projection or storage.
 *
 * Pass the immutable input whenever the caller holds it. The omission audit is
 * then recorded as the control plane read the output, not as the run described
 * it — which is exactly what lets the contract accept a run whose own
 * arithmetic is off instead of destroying the ingestion over it. Without an
 * input (a stored record being projected again) the recorded audit is carried
 * through, normalized.
 * @param {any} value @param {any} [input] */
export function projectSourceUnderstandingOutput(value, input) {
  /** @param {any[]} evidence */
  const anchors = evidence => evidence.map(({ sourceId, generation, unitId, start, end, quote }) => ({ sourceId, generation, unitId, start, end, quote }))
  return {
    schemaVersion: value.schemaVersion, sourceId: value.sourceId, generation: value.generation, docType: value.docType, depth: value.depth, summary: value.summary,
    slots: Object.fromEntries(Object.entries(value.slots).map(([key, raw]) => {
      const slot = /** @type {any} */ (raw)
      return [key, slot.state === 'known' ? { state: 'known', value: slot.value, evidence: anchors(slot.evidence) } : { state: 'unknown', reason: slot.reason }]
    })),
    claims: value.claims.map((/** @type {any} */ item) => ({ id: item.id, statement: item.statement, evidence: anchors(item.evidence) })),
    methods: value.methods.map((/** @type {any} */ item) => ({ id: item.id, title: item.title, description: item.description, whenToUse: item.whenToUse,
      steps: [...item.steps], checks: [...item.checks], pitfalls: [...item.pitfalls], evidence: anchors(item.evidence), status: 'draft' })),
    omissionAudit: projectOmissionAudit(value, input),
  }
}

/** An audit that did not run projects as one, whatever else was attached to it.
 *
 * A sample records `{unitId, represented}` and, when the run supplied one, a
 * note. It deliberately does not copy the anchor: the anchor is already in the
 * output that this same record carries, so duplicating up to twelve quotes of
 * 2,000 characters would spend the output's byte budget to say nothing new.
 *
 * This also runs on read paths over records written before the audit existed,
 * so it degrades rather than throws: anything that is not `status: 'audited'`
 * projects as `not_run`, and a malformed sample is dropped instead of turning a
 * stored row into a 500.
 * @param {any} value @param {any} [input] */
function projectOmissionAudit(value, input) {
  const audit = record(value?.omissionAudit) ? value.omissionAudit : {}
  if (audit.status !== 'audited') return { status: 'not_run', reason: audit.reason, omissionRate: null }
  if (record(input)) {
    const notice = sourceUnderstandingOmissionNotice(value, input)
    return { status: 'audited', reason: audit.reason, omissionRate: notice.omissionRate, samples: notice.samples }
  }
  /** @type {{unitId:string,represented:boolean,note?:string}[]} */
  const samples = []
  for (const sample of Array.isArray(audit.samples) ? audit.samples : []) {
    if (!record(sample) || !nonempty(sample.unitId, 200)) continue
    const represented = sample.represented === true
    samples.push(nonempty(sample.note, SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS)
      ? { unitId: sample.unitId, represented, note: sample.note } : { unitId: sample.unitId, represented })
  }
  return { status: 'audited', reason: audit.reason, omissionRate: typeof audit.omissionRate === 'number' ? audit.omissionRate : null, samples }
}
