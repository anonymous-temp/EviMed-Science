import { VCR_DATA_INTAKE_CONTRACT } from './vcrDataIntake.mjs';
import { VCR_POPULATION_KINDS, VCR_CRITERION_TYPES, VCR_REQUIREMENT_CONTRACT, CLINICAL_FACT_CONTRACT, FACT_EVIDENCE_RULE, RUNTIME_SKILL_ROOTS } from '@evimed/domain';

/** Closed top-level fields shared by mutation validation and read-only discovery. */
export const VCR_WRITE_FIELDS = Object.freeze({
  "definition": [
    "pico",
    "estimand",
    "endpointType",
    "intendedUse",
    "fieldSources",
    "title",
    "question"
  ],
  "assumption": [
    "key",
    "name",
    "endpoint",
    "unit",
    "pointValue",
    "distribution",
    "sensitivity",
    "sourceKind",
    "valueSource",
    "evidenceIds",
    "applicability",
    "note",
    "parameter",
    "fromPooling",
    "expertFrom"
  ],
  "precedent": [
    "registry",
    "registryId",
    "endpointKeys",
    "armRoles",
    "line",
    "biomarker"
  ],
  "candidate_trial": [
    "registry",
    "registryId",
    "criteria",
    "subjectKeys"
  ],
  "evidence_item": [
    "registry",
    "registryId",
    "parameter",
    "arm",
    "armRole",
    "value",
    "valueText",
    "unit",
    "ciLow",
    "ciHigh",
    "sampleSize",
    "events",
    "valueSource",
    "quote",
    "locator",
    "endpointKey",
    "enrollmentKind",
    "historicalBaseline",
    "line",
    "biomarker",
    "outcome",
    "note",
    "source",
    "candidateFrom",
    "timepoint",
    "literatureSource",
    "evidenceKind",
    "trialIdentity"
  ],
  "pack": [
    "use",
    "schema",
    "id",
    "version",
    "status",
    "updated",
    "disease",
    "sources",
    "terms",
    "phenotypes",
    "endpoints",
    "criteria",
    "mappings",
    "background"
  ],
  "population": [
    "kind",
    "name",
    "definition",
    "snapshotId",
    "allowedUses",
    "fromLibrary",
    "fromProtocol"
  ],
  "patient_set": [
    "populationId",
    "name",
    "modelId",
    "modelVersion",
    "scenario"
  ],
  "comparator": [
    "route",
    "estimand",
    "targetTrial",
    "configuration"
  ],
  "trial_scenario": [
    "label",
    "design",
    "endpointType",
    "configuration",
    "assumptionIds",
    "comparatorId"
  ],
  "design_grid": [
    "dimensions",
    "truthScenarios",
    "comparisonGoal"
  ],
  "soa": [
    "visit",
    "day",
    "windowDays",
    "note",
    "procedures",
    "remove"
  ],
  "regulatory_contact": [
    "date",
    "agency",
    "type",
    "summary",
    "outcome",
    "attachments"
  ],
  "decision": [
    "question",
    "chosen",
    "alternatives",
    "rationale"
  ],
  "forecast": [
    "kind",
    "resultId"
  ],
  "model": [
    "name",
    "version",
    "endpointType",
    "risk",
    "card",
    "sources"
  ],
  "model_assessment": [
    "key",
    "modelName",
    "modelVersion",
    "questionOfInterest",
    "contextOfUse",
    "influence",
    "influenceJustification",
    "consequence",
    "consequenceJustification",
    "riskJustification",
    "impact",
    "impactJustification",
    "technicalCriteria",
    "appropriateness",
    "evaluation",
    "outcome"
  ],
  "step": [
    "step",
    "requested",
    "note"
  ],
  "plan": [
    "analysis",
    "sensitivity",
    "sealedFields"
  ],
  "field_map": [
    "sourceId",
    "columns",
    "reason"
  ],
  "fact": [
    "subjectKey",
    "variable",
    "value",
    "unit",
    "polarity",
    "occurredAt",
    "recordedAt",
    "visibleAt",
    "surface",
    "dateSurface",
    "documentId",
    "start",
    "end",
    "quote",
    "vocabularyVersion",
    "clinical"
  ],
  "language_judgment": [
    "subjectKey",
    "criterionKey",
    "protocolVersionId",
    "candidateTrialId",
    "state",
    "evidence"
  ],
  "report": [
    "kind",
    "section",
    "template",
    "text"
  ],
  "history": [
    "snapshotId",
    "asOf",
    "mappings",
    "split",
    "priorHistoryId",
    "includeClinicalFacts",
    "perturbation"
  ],
  "trial_benchmark": [
    "model",
    "comparisons",
    "split",
    "trainingOverlap",
    "sourceFile"
  ],
  "forecast_design": [
    "predictionId",
    "controlPredictionId",
    "horizonDays",
    "allocation",
    "alpha",
    "power",
    "prognosticEvaluationId",
    "randomizationAt",
    "lambda",
    "gamma"
  ]
});

/** Detailed nested matching shapes use the existing matching contract; numerical shapes use action=shape. */
export function vcrWriteContracts(kind = null) {
  const contracts = Object.fromEntries(Object.entries(VCR_WRITE_FIELDS).map(([what, fields]) => [what, { fields, additionalProperties: false }]));
  Object.assign(contracts, {
    fact: { ...contracts.fact, rule: FACT_EVIDENCE_RULE },
    // One typed action object in `data`, never `items`: the fields are the union of the actions' own, which are the intake adapter's
    // (`VCR_DATA_INTAKE_CONTRACT.actions`) and so cannot drift from what it accepts.
    data_intake: { fields: [...new Set(Object.values(VCR_DATA_INTAKE_CONTRACT.actions).flat())], actions: VCR_DATA_INTAKE_CONTRACT.actions,
      envelope: 'data is one object whose action names its fields; items is refused', additionalProperties: false,
      detail: 'dataIntake in this read gives each action\'s required fields and the sequence' },
    task_context: { fields: [], required: [], creates: 'owned hidden conversation scope only' },
    patient_context: { fields: ['messageSeq', 'sourceId'], oneOf: ['authenticated human message sequence', 'owned uploaded source id'], automatedMessages: 'never admitted as human' },
    patient_set: { ...contracts.patient_set, anyOf: ['nonempty scenario', 'populationId', 'modelId'], scenario: 'when supplied, use vcr_simulate action=shape kind=generate_patients or supported variant gives exact keys' },
    decision: { ...contracts.decision, required: ['question', 'chosen', 'rationale'], chosen: 'nonempty structured choice', rationale: 'nonempty scientific basis; schema discovery uses contracts reads' },
    population: { ...contracts.population, kind: VCR_POPULATION_KINDS, real: 'snapshotId from freeze and definition rules, or fromProtocol=true with snapshotId' },
    protocol: { fields: ['title', 'sourceRef', 'usdm', 'criteria'], criteria: 'Read matching filter.kind=contract for exact criterion/applicability structure' },
    criteria: { fields: ['kind', 'criterionType', 'requirement', 'applicability', 'sourceText', 'sourceLocator', 'evidenceNeeded'], criterionType: VCR_CRITERION_TYPES, requirement: VCR_REQUIREMENT_CONTRACT, applicability: 'Same grammar as requirement; do not infer eligibility when applicability is unknown', sourceLocator: 'optional object; never a string or invented quotation' },
  });
  return kind ? { [kind]: Object.hasOwn(contracts, kind) ? contracts[kind] : null } : contracts;
}

/**
 * Where the VCR methods are, for a conversation whose skill catalogue does not list them. They are capability skill bodies, which a
 * planned capability's run is handed; a plain conversation in a study calls the same tools and loads nothing unless the tools point it
 * at the files. The root is the image's declared one (`RUNTIME_SKILL_ROOTS`), the methods the five VCR capabilities'.
 */
export const VCR_METHOD_SKILLS = Object.freeze(['vcr-matching', 'vcr-protocol', 'vcr-evidence', 'vcr-analysis', 'vcr-package']);
const capabilityRoot = RUNTIME_SKILL_ROOTS.find(root => root.family === 'capability-skills')?.path ?? '/opt/evimed/capability-skills';
export const VCR_METHODS = Object.freeze({
  note: 'These methods are not in the skill catalogue: read the SKILL.md at the path before the work it governs. vcr-matching governs facts, criteria, candidate trials and eligibility verdicts.',
  files: Object.freeze(Object.fromEntries(VCR_METHOD_SKILLS.map(name => [name, `${capabilityRoot}/${name}/SKILL.md`]))),
});

/** Schema literals only. This entry never reads a store or adopts arbitrary package output. */
export function vcrContractsRead(kind = null) {
  return { what: 'contracts', schemaOnly: true, available: true,
    writes: vcrWriteContracts(kind), dataIntake: VCR_DATA_INTAKE_CONTRACT, methods: VCR_METHODS,
    requirementGrammar: VCR_REQUIREMENT_CONTRACT, factContract: CLINICAL_FACT_CONTRACT,
    writeEnvelope: { single: { what: '<kind>', data: '<one object>' }, batch: { what: '<kind>', items: ['<object>'] },
      rule: 'items is top level, never nested inside data. Read these schemas rather than issuing probe writes.' },
    matchingRead: { what: 'matching', filter: { kind: 'contract' } },
    numericalRead: { tool: 'vcr_simulate', action: 'shape', kind: '<job kind>' } };
}
