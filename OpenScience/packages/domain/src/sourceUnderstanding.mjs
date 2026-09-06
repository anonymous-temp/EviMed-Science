/** Source understanding has one data registry and one deterministic contract.
 * Semantic interpretation belongs to the capability; this module checks shape,
 * source identity and exact character bonds only. Offsets are UTF-16 code units. */
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
  return { schemaVersion: SOURCE_UNDERSTANDING_VERSION, sourceId: value.sourceId, generation: value.generation, docType: value.docType, depth: value.depth,
    schema: sourceUnderstandingSchema(value.docType), text, units }
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
  const citedUnits = new Set()
  let anchors = 0
  /** @param {any} evidence @param {string} where */
  const checkEvidence = (evidence, where) => {
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8) { issues.push(`${where} needs 1 to 8 source anchors.`); return }
    for (const anchor of evidence) {
      anchors += 1
      const unit = units.get(anchor?.unitId)
      if (!record(anchor) || anchor.sourceId !== input.sourceId || anchor.generation !== input.generation || !unit
        || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end)
        || anchor.start < unit.start || anchor.end > unit.end || anchor.end <= anchor.start
        || !nonempty(anchor.quote, 2000) || input.text.slice(anchor.start, anchor.end) !== anchor.quote) {
        issues.push(`${where} needs an exact quote within its source generation and unit range.`)
      } else citedUnits.add(anchor.unitId)
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
  if (output.omissionAudit?.status !== 'not_run' || output.omissionAudit?.omissionRate !== null || !nonempty(output.omissionAudit?.reason, 2000)) {
    issues.push('Question-based omission audit has not run; omissionRate must be null with a reason.')
  }
  // Leave space within ProductDocuments' 256 KiB limit for immutable record
  // identity, source-unit metadata and the actual run/usage receipt.
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 100_000) issues.push('Understanding exceeds the 100000 UTF-8 byte output limit.')
  return issues
}

/** Discard undeclared fields before public projection or storage.
 * @param {any} value */
export function projectSourceUnderstandingOutput(value) {
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
    omissionAudit: { status: 'not_run', reason: value.omissionAudit.reason, omissionRate: null },
  }
}
