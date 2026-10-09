import { clinicalUnitToken, convertClinicalUnit } from './clinicalUnits.mjs';
/** Clinical extraction metadata. Values remain assertions grounded in a source, not diagnoses. */
export const CLINICAL_FACT_SCHEMA = 1;
export const CLINICAL_ASSERTIONS = Object.freeze(['affirmed', 'negated', 'possible', 'hypothetical', 'conditional', 'unknown']);
export const CLINICAL_EXPERIENCERS = Object.freeze(['patient', 'family', 'other', 'unknown']);
export const CLINICAL_RELATIONS = Object.freeze(['coreference', 'abbreviation', 'dose_of', 'route_of', 'frequency_of', 'result_of', 'specimen_of', 'indication_of', 'adverse_event_of', 'same_event', 'contradicts']);
/** Machine-readable extraction help, returned with the clinical tool data. */
export const CLINICAL_FACT_CONTRACT = Object.freeze({
  appliesTo: 'The optional clinical property inside one vcr_write fact item; never put schema/assertion/experiencer at the item root.',
  factRequired: ['subjectKey', 'documentId', 'variable', 'surface', 'quote'],
  factValue: 'value (number or text), unit and occurredAt belong at the fact item root, alongside variable and quote. Preserve every recorded measurement in value; surface and quote alone do not store a usable measurement.',
  factExample: {subjectKey:'<from tool>',documentId:'<from tool>',variable:'age',value:44,unit:'year',surface:'44',quote:'年龄44岁',
    clinical:{schema:1,assertion:'affirmed',experiencer:'patient'}},
  schema: CLINICAL_FACT_SCHEMA,
  required: ['schema', 'assertion', 'experiencer'],
  assertion: CLINICAL_ASSERTIONS, experiencer: CLINICAL_EXPERIENCERS,
  temporality: ['current', 'historical', 'planned', 'unknown'],
  medication: { state: ['prescribed', 'administered', 'stopped', 'planned', 'historical_list', 'unknown'],
    absenceScope: ['never', 'interval', 'current', 'unknown'],
    optionalText: ['ingredient', 'product', 'unit', 'route', 'frequency', 'line'], optionalNumber: ['dose'], optionalIsoDate: ['start', 'stop'] },
  laboratory: { optionalText: ['analyte', 'specimen', 'originalUnit', 'method'], optionalNumber: ['originalValue', 'referenceLow', 'referenceHigh'], optionalIsoDate: ['collectedAt'] },
  coding: { required: ['system', 'edition', 'method', 'basis', 'reference'], method: ['exact', 'alias', 'model', 'unresolved'],
    modelWriteBasis: 'model_inferred', optionalText: ['sourceCode', 'code', 'display'], optionalTextArray: ['alternatives'] },
  eventId: 'Use the same source-grounded event identifier for observations explicitly belonging to one event; omit if uncertain.',
  relation: { type: CLINICAL_RELATIONS, state: ['supported', 'unresolved'], quote: 'Exact source substring', targetFactId: 'Required for supported links: an existing fact of this subject' },
  example: { schema: 1, assertion: 'affirmed', experiencer: 'patient', temporality: 'current' },
  note: 'Omit optional fields unless grounded. Reuse the criterion variable verbatim. Numeric originals are numbers, not strings. Do not invent coding editions or source references. Locators are assigned from verified quotes by the platform.',
});
/** @param {any} value */
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
/** @param {any} value */
const short = (value, max = 300) => typeof value === 'string' && value.length <= max;
/** @param {any} value */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {any} value */
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** A locator describes only geometry the source actually supplies. @param {any} value @returns {string[]} */
export function clinicalLocatorIssues(value) {
  if (value == null) return [];
  const fields = ['kind', 'sourceHash', 'projectionHash', 'offsetUnit', 'start', 'end', 'page', 'sheet', 'cell', 'resourceType', 'resourceId', 'path', 'table', 'rowKey'];
  if (!object(value) || Object.keys(value).some(k => !fields.includes(k))) return ['locator_fields'];
  const issues = [];
  if (!['text', 'pdf', 'cell', 'fhir', 'omop'].includes(value.kind)) issues.push('locator_kind');
  for (const key of ['sourceHash', 'projectionHash']) if (value[key] != null && !/^[a-f0-9]{64}$/.test(value[key])) issues.push(`locator_${key}`);
  if (value.offsetUnit != null && value.offsetUnit !== 'utf16') issues.push('locator_offset_unit');
  if (value.start != null && (!Number.isInteger(value.start) || value.start < 0 || !Number.isInteger(value.end) || value.end <= value.start)) issues.push('locator_span');
  if (value.end != null && value.start == null) issues.push('locator_span');
  if (value.page != null && (!Number.isInteger(value.page) || value.page < 1)) issues.push('locator_page');
  for (const key of ['sheet', 'cell', 'resourceType', 'resourceId', 'path', 'table', 'rowKey']) if (value[key] != null && !short(value[key])) issues.push(`locator_${key}`);
  return issues;
}

/** No field silently supplies an assertion or an experiencer for a new-format fact.
 * @param {any} value @returns {string[]} */
export function clinicalFactIssues(value) {
  if (value == null) return [];
  const fields = ['schema', 'assertion', 'experiencer', 'temporality', 'eventId', 'encounterId', 'occurredInterval', 'section', 'coding',
    'relations', 'medication', 'laboratory', 'specialty', 'locator', 'copiedFrom', 'correctionOf', 'correctionReason'];
  if (!object(value) || Object.keys(value).some(k => !fields.includes(k))) return ['clinical_fields'];
  const issues = [];
  if (value.schema !== CLINICAL_FACT_SCHEMA) issues.push('clinical_schema');
  if (!CLINICAL_ASSERTIONS.includes(value.assertion)) issues.push('clinical_assertion');
  if (!CLINICAL_EXPERIENCERS.includes(value.experiencer)) issues.push('clinical_experiencer');
  if (value.temporality != null && !['current', 'historical', 'planned', 'unknown'].includes(value.temporality)) issues.push('clinical_temporality');
  for (const key of ['eventId', 'encounterId', 'copiedFrom', 'correctionOf']) if (value[key] != null && !id(value[key])) issues.push(`clinical_${key}`);
  if (value.correctionOf && (!short(value.correctionReason) || !value.correctionReason.trim())) issues.push('clinical_correction_reason');
  if (value.occurredInterval != null && (!object(value.occurredInterval) || Object.keys(value.occurredInterval).some(k => !['start', 'end'].includes(k))
    || !instant(value.occurredInterval.start) || !instant(value.occurredInterval.end)
    || Date.parse(value.occurredInterval.start) > Date.parse(value.occurredInterval.end))) issues.push('clinical_interval');
  if (value.section != null && (!object(value.section) || Object.keys(value.section).some(k => !['name', 'start', 'end', 'documentType'].includes(k))
    || !short(value.section.name) || !Number.isInteger(value.section.start) || !Number.isInteger(value.section.end)
    || value.section.start < 0 || value.section.end <= value.section.start || value.section.documentType != null && !short(value.section.documentType))) issues.push('clinical_section');
  if (value.coding != null) {
    if (!Array.isArray(value.coding) || value.coding.length > 10) issues.push('clinical_coding');
    else for (const code of value.coding) {
      if (!object(code) || Object.keys(code).some(k => !['system', 'edition', 'sourceCode', 'code', 'display', 'method', 'basis', 'alternatives', 'reference'].includes(k))
        || !['exact', 'alias', 'model', 'unresolved'].includes(code.method) || !['researcher_confirmed', 'dictionary_stated', 'model_inferred'].includes(code.basis)
        || !short(code.system) || !short(code.edition) || !short(code.reference, 500)
        || ['code', 'sourceCode', 'display'].some(k => code[k] != null && !short(code[k]))
        || code.alternatives != null && (!Array.isArray(code.alternatives) || code.alternatives.length > 10 || code.alternatives.some((/** @type {any} */ v) => !short(v)))) issues.push('clinical_coding');
    }
  }
  if (value.relations != null) {
    if (!Array.isArray(value.relations) || value.relations.length > 20) issues.push('clinical_relations');
    else for (const relation of value.relations) if (!object(relation) || Object.keys(relation).some(k => !['type', 'targetFactId', 'state', 'quote'].includes(k))
      || !CLINICAL_RELATIONS.includes(relation.type) || !['supported', 'unresolved'].includes(relation.state)
      || relation.state === 'supported' && !id(relation.targetFactId) || !short(relation.quote, 3000)) issues.push('clinical_relation');
  }
  if (value.medication != null) {
    const med = value.medication;
    if (!object(med) || Object.keys(med).some(k => !['ingredient', 'product', 'dose', 'unit', 'route', 'frequency', 'state', 'start', 'stop', 'line', 'absenceScope'].includes(k))
      || !['prescribed', 'administered', 'stopped', 'planned', 'historical_list', 'unknown'].includes(med.state)
      || med.absenceScope != null && !['never', 'interval', 'current', 'unknown'].includes(med.absenceScope)
      || ['ingredient', 'product', 'unit', 'route', 'frequency', 'line'].some(k => med[k] != null && !short(med[k]))
      || med.dose != null && (!Number.isFinite(med.dose) || med.dose < 0)
      || ['start', 'stop'].some(k => med[k] != null && !instant(med[k]))
      || med.start && med.stop && Date.parse(med.start) > Date.parse(med.stop)) issues.push('clinical_medication');
  }
  if (value.laboratory != null) {
    const lab = value.laboratory;
    if (!object(lab) || Object.keys(lab).some(k => !['analyte', 'specimen', 'collectedAt', 'originalValue', 'originalUnit', 'referenceLow', 'referenceHigh', 'method'].includes(k))
      || ['analyte', 'specimen', 'originalUnit', 'method'].some(k => lab[k] != null && !short(lab[k]))
      || ['originalValue', 'referenceLow', 'referenceHigh'].some(k => lab[k] != null && !Number.isFinite(lab[k]))
      || lab.collectedAt != null && !instant(lab.collectedAt)) issues.push('clinical_laboratory');
  }
  if (value.specialty != null) {
    if (!object(value.specialty) || Object.keys(value.specialty).some(k => !['stage', 'edition', 'histology', 'marker', 'testMethod', 'specimen', 'scoreName', 'score', 'laterality', 'hgvs', 'rads'].includes(k))
      || Object.values(value.specialty).some(v => v != null && !short(v))) issues.push('clinical_specialty');
  }
  return [...new Set([...issues, ...clinicalLocatorIssues(value.locator)])];
}

/** Legacy four-way polarity stays readable; new facts keep context orthogonal.
 * @param {any} fact */
export function clinicalFactPolarity(fact) {
  if (!fact.clinical) return fact.polarity ?? 'affirmed';
  if (fact.clinical.experiencer !== 'patient') return 'family';
  if (fact.clinical.temporality === 'planned') return 'hypothetical';
  return ['affirmed', 'negated'].includes(fact.clinical.assertion) ? fact.clinical.assertion : 'hypothetical';
}

/** Metadata shared with dataset semantics: no subject, values or quotations.
 * @param {any[]} facts */
export function clinicalSemanticFields(facts) {
  const fields = new Map();
  for (const fact of facts) {
    const previous = fields.get(fact.variable) ?? { field: fact.variable, units: new Set(), systems: new Set(), sourceVersions: new Set(), factSchema: CLINICAL_FACT_SCHEMA, basis: 'model_inferred' };
    if (fact.unit) previous.units.add(fact.unit);
    const sourceHash = fact.source?.sourceHash ?? fact.clinical?.locator?.sourceHash;
    if (typeof sourceHash === 'string' && /^[a-f0-9]{64}$/.test(sourceHash)) previous.sourceVersions.add(sourceHash);
    for (const coding of fact.clinical?.coding ?? []) previous.systems.add(`${coding.system}@${coding.edition}`);
    fields.set(fact.variable, previous);
  }
  return [...fields.values()].map(v => ({ ...v, units: [...v.units], systems: [...v.systems], sourceVersions: [...v.sourceVersions] }));
}

/** Select existing pack definitions by exact criterion variable, not by prose.
 * This enriches an existing disease pack without introducing another vocabulary.
 * @param {any} pack @param {any[]} criteria */
export function clinicalTerminologyContext(pack, criteria) {
  if (!pack) return null;
  const variables = new Set();
  const visit = (/** @type {any} */ value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.variable === 'string') variables.add(value.variable);
    for (const nested of Object.values(value)) visit(nested);
  };
  for (const criterion of criteria) {visit(criterion.requirement);visit(criterion.applicability);}
  /** @type {any[]} */
  const terms = (pack.terms ?? []).filter((/** @type {any} */ term) => variables.has(term.concept));
  /** @type {any[]} */
  const mappings = (pack.mappings ?? []).filter((/** @type {any} */ mapping) => variables.has(mapping.concept));
  const references = new Set([...terms,...mappings].flatMap(row=>row.sources??[]));
  return { packId: pack.id, version: pack.version, terms, mappings,
    sources: (pack.sources ?? []).filter((/** @type {any} */ source)=>references.has(source.id)),
    unmappedVariables: [...variables].filter(variable=>![...terms,...mappings].some(row=>row.concept===variable)),
    basis:'dictionary_stated', note:'These are selected pack definitions, not patient diagnoses. A model-applied interpretation remains model_inferred.' };
}

/** A correction supersedes a fact only in a view that could already see that correction.
 * Distinct episodes are not merged; explicit contradictions and same-episode disagreements stay visible.
 * @param {any[]} facts @param {string|number|Date} asOf */
export function clinicalFactView(facts, asOf) {
  const at = new Date(asOf).getTime();
  const visible = facts.filter(f => !f.createdAt || new Date(f.createdAt).getTime() <= at);
  const byId = new Map(visible.map(f => [f.id, f]));
  const replaced = new Set();
  for (const fact of visible) {
    const original = byId.get(fact.clinical?.correctionOf);
    if (original && original.subjectKey === fact.subjectKey && original.variable === fact.variable) replaced.add(original.id);
  }
  const active = visible.filter(f => !replaced.has(f.id));
  const conflicts = new Map();
  for (const fact of active) {
    const related = (fact.clinical?.relations ?? []).filter((/** @type {any} */ r) => r.type === 'contradicts' && r.state === 'supported')
      .map((/** @type {any} */ r) => r.targetFactId).filter((/** @type {any} */ target) => byId.has(target) && byId.get(target).subjectKey === fact.subjectKey && !replaced.has(target));
    if (related.length) {
      conflicts.set(fact.id, related);
      for (const target of related) conflicts.set(target, [...(conflicts.get(target) ?? []), fact.id]);
    }
  }
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const fact of active) {
    const event = fact.clinical?.correctionOf ? `correction:${fact.clinical.correctionOf}`
      : fact.clinical?.eventId ?? (fact.clinical?.encounterId && fact.occurredAt ? `${fact.clinical.encounterId}:${fact.occurredAt}` : null);
    if (!event || clinicalFactPolarity(fact) === 'hypothetical' || clinicalFactPolarity(fact) === 'family') continue;
    const key = JSON.stringify([fact.subjectKey, fact.variable, event]);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const members of groups.values()) {
    const anchor = members[0];
    const equivalent = (/** @type {any} */ fact) => {
      if (clinicalFactPolarity(fact) !== clinicalFactPolarity(anchor)) return false;
      if (clinicalUnitToken(fact.unit) === clinicalUnitToken(anchor.unit)) return fact.value === anchor.value;
      if (typeof fact.value !== 'number' || typeof anchor.value !== 'number') return false;
      const converted = convertClinicalUnit(fact.value, fact.unit, anchor.unit, fact.variable);
      return converted !== null && Math.abs(converted.value-anchor.value) <= Math.max(1,Math.abs(anchor.value))*1e-9;
    };
    if (!members.every(equivalent)) {
      for (const fact of members) conflicts.set(fact.id, members.filter(f => f.id !== fact.id).map(f => f.id));
    }
  }
  return { facts: active.map(f => ({ ...f, polarity: clinicalFactPolarity(f), ...(conflicts.has(f.id) ? { conflicts: conflicts.get(f.id) } : {}) })),
    superseded: [...replaced], conflicts: [...conflicts].map(([factId, withFacts]) => ({ factId, withFacts })) };
}
