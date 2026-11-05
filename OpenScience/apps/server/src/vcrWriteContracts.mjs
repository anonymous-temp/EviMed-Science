import { VCR_DATA_INTAKE_CONTRACT } from './vcrDataIntake.mjs';
import { VCR_POPULATION_KINDS, VCR_REQUIREMENT_CONTRACT, CLINICAL_FACT_CONTRACT, FACT_EVIDENCE_RULE, RUNTIME_SKILL_ROOTS, VCR_WRITE_WORDS } from '@evimed/domain';

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
    "effectRole",
    "fromPooling",
    "expertFrom",
    "sources"
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
    "pValue",
    "pRelation",
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
    "publication",
    "evidenceKind",
    "trialIdentity",
    "notReported"
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
    "comparatorId",
    "sources"
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
  "result_record": [
    "resultId"
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
    "dateQuote",
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

/**
 * The closed words of a write's fields with what each means: what a refusal prints for the field a word was refused in, here before
 * the first write so it is not guessed.
 * @param {string} table @returns {Record<string, Record<string, string>>}
 */
const wordsOf = (table) => Object.fromEntries(Object.entries(VCR_WRITE_WORDS[table] ?? {}).map(([field, entry]) => [field, { ...entry.meanings }]));

/**
 * One copyable example of each write that has cost a model rounds to guess: valid as it stands, to be changed to the research's own
 * numbers and words. `evidenceIds` of an assumption is the id the evidence write answered with; a criterion's text is the registry's.
 */
export const VCR_WRITE_EXAMPLES = Object.freeze({
  evidence_item: Object.freeze({
    publication: { pmid: '37676259' }, parameter: 'control_median_os', arm: 'sorafenib', armRole: 'control', value: 13.8, unit: 'months', ciLow: 12.3, ciHigh: 16.1,
    quote: '13.8 months (95% CI, 12.3–16.1) with sorafenib', endpointKey: 'os', evidenceKind: 'outcome', valueSource: 'extracted',
  }),
  assumption: Object.freeze({
    ownSetting: { key: 'hazard_ratio', name: '目标风险比', endpoint: 'os', unit: 'ratio', pointValue: 0.75, sourceKind: 'expert_set', valueSource: 'assumed',
      effectRole: 'realistic_expectation', note: '同类试验的风险比在 0.66 到 0.78 之间，取 0.75；出处写在这里' },
    fromEvidence: { key: 'control_median_os', name: '对照组中位 OS', parameter: 'control_median_os', endpoint: 'os', unit: 'months',
      sourceKind: 'external_evidence', evidenceIds: ['<the id vcr_write what=evidence_item answered with>'] },
    // The same card from the paper in one call: the platform writes the evidence item, holds the sentence against the paper and writes the card.
    fromPaper: { key: 'control_median_os', name: '对照组中位 OS', endpoint: 'os', unit: 'months', pointValue: 13.8,
      sources: [{ publication: 'PMID 37676259', quote: '13.8 months (95% CI, 12.3–16.1) with sorafenib' }] },
  }),
  trial_scenario: Object.freeze({
    label: 'A 固定 1:1', design: 'two_arm_fixed', endpointType: 'time_to_event',
    configuration: { design: { allocation: 0.5, nTreat: 415, nControl: 415 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.75, controlMedian: 13.5 },
      analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { duration: 24, followup: 12, dropoutAnnual: 0.05 }, timeUnit: 'months' },
  }),
  design_grid: Object.freeze({
    dimensions: { base: { endpoint: { type: 'time_to_event' }, truth: { controlMedian: 13.5 }, accrual: { duration: 24, followup: 12, dropoutAnnual: 0.05 }, timeUnit: 'months', performance: ['power', 'type_one_error'] },
      designs: [{ label: 'A 固定 1:1', kind: 'two_arm_fixed', nTreat: 415, nControl: 415 }, { label: 'C 固定 2:1', kind: 'two_arm_fixed', nTreat: 639, nControl: 320 }] },
    truthScenarios: [{ label: 'HR 0.75', hazardRatio: 0.75 }, { label: '零效应', hazardRatio: 1, null: true }],
    comparisonGoal: { text: '比较样本量、把握度和 I 类错误' },
  }),
  plan: Object.freeze({ analysis: { primary: '单侧 α 0.025 的 log-rank 检验' }, sensitivity: { cases: ['HR 0.80', '年脱落率 10%'] }, sealedFields: [] }),
  candidate_trial: Object.freeze({
    registry: 'clinicaltrials.gov', registryId: 'NCT06927986',
    criteria: [{ kind: 'inclusion', criterionType: 'biomarker', sourceText: 'Presence of at least one EGFR-sensitive mutation', requirement: { op: 'present', variable: 'egfr_exon19_deletion' } }],
  }),
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
    task_context: { fields: ['title'], required: [], title: 'optional, in data: a short name for the research question (at most 40 characters); never a person, and no identifier', creates: 'owned hidden conversation scope only' },
    patient_context: { fields: ['messageSeq', 'sourceId'], oneOf: ['authenticated human message sequence', 'owned uploaded source id'], automatedMessages: 'never admitted as human' },
    patient_set: { ...contracts.patient_set, anyOf: ['nonempty scenario', 'populationId', 'modelId'], scenario: 'when supplied, use vcr_simulate action=shape kind=generate_patients or supported variant gives exact keys' },
    decision: { ...contracts.decision, required: ['question', 'chosen', 'rationale'], chosen: 'nonempty structured choice', rationale: 'nonempty scientific basis; schema discovery uses contracts reads' },
    population: { ...contracts.population, kind: VCR_POPULATION_KINDS, real: 'snapshotId from freeze and definition rules, or fromProtocol=true with snapshotId' },
    protocol: { fields: ['title', 'sourceRef', 'usdm', 'criteria'], criteria: 'Read matching filter.kind=contract for exact criterion/applicability structure' },
    criteria: { fields: ['kind', 'criterionType', 'requirement', 'applicability', 'sourceText', 'sourceLocator', 'evidenceNeeded'], words: wordsOf('criterion'), requirement: VCR_REQUIREMENT_CONTRACT, applicability: 'Same grammar as requirement; do not infer eligibility when applicability is unknown', sourceLocator: 'optional object; never a string or invented quotation' },
    // The closed words of each field with what each means, and one copyable example. A spelling that has exactly one meaning here is read
    // as that word and the answer says so; any other word is refused with this list.
    evidence_item: { ...contracts.evidence_item, words: wordsOf('evidence_item'), example: VCR_WRITE_EXAMPLES.evidence_item,
      source: 'a trial registry record (registry + registryId: clinicaltrials.gov, chictr, ctis) or a paper (publication: { pmid } or { doi }); the quotation is held against the text the platform read of it, and a number it cannot check is kept as unchecked',
      parameterRule: 'a parameter that an assumption cites by sourceKind external_evidence is the card\'s own parameter' },
    assumption: { ...contracts.assumption, words: wordsOf('assumption'), example: VCR_WRITE_EXAMPLES.assumption,
      rule: 'expert_set and scenario: the number is yours (pointValue), valueSource is always assumed, the source goes in note. external_evidence: no pointValue; evidenceIds names the one evidence item (vcr_write what=evidence_item) whose number the card takes. A number you read in a paper: pointValue with sources [{ publication, quote }] (one entry) makes the card from the paper in one call (fromPaper)' },
    trial_scenario: { ...contracts.trial_scenario, example: VCR_WRITE_EXAMPLES.trial_scenario,
      rule: 'then vcr_simulate start kind=design_analytic|design_simulation|assurance with subjectId = the id and no scenario: the platform builds it from this object. A number of the configuration you read in a paper: sources [{ field: \'truth.controlMedian\', publication: \'PMID 37676259\', quote: \'<the sentence that prints it>\' }]' },
    design_grid: { ...contracts.design_grid, example: VCR_WRITE_EXAMPLES.design_grid, rule: 'labels are for the page; start kind=design_grid with subjectId = the id and no scenario' },
    plan: { ...contracts.plan, example: VCR_WRITE_EXAMPLES.plan, rule: 'analysis and sensitivity are objects; a list or a sentence is kept as it was written (under items or text)' },
    candidate_trial: { ...contracts.candidate_trial, words: wordsOf('criterion'), example: VCR_WRITE_EXAMPLES.candidate_trial },
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
