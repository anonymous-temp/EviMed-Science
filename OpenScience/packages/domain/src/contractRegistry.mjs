/**
 * The contract registry: contract kind → validator.
 *
 * Hidden knowledge: the whole delivery decision, expressed as a lookup. Two
 * things make it worth having as its own module. First, the run side and the
 * server side both call `runGate` — the same function, on the same package, with
 * the same rules, which is the invariant §8.5 exists to protect. Second, the
 * verdict is a value: `evimed_submit_deliverable` returns it, it does not throw
 * and it does not `deny`. A first submission failing is normal, not exceptional
 * (ch.10), and a normal outcome that arrives as an exception forces every caller
 * to write a `catch` that means "read the issues".
 */

import { clinicalEvidenceAdvisoryNotes, clinicalEvidencePackageErrorCode, reportSectionShares, validateClinicalEvidencePackage, citationIntegrityIssues, runtimeLeakageLine, verificationGateMetrics } from './clinicalEvidence.mjs'
import { CONTRACT_KINDS, isContractKind, isClinicalContractKind } from './contractKinds.mjs'
import { matchedClinicalTriggers } from './safetyRules.mjs'

/**
 * @typedef {object} GateIssue
 * @property {string} code
 * @property {string} message
 * @property {'required'|'advisory'|'optional'} severity
 * @property {number} [line]
 * @property {string} [path]
 */

/**
 * @typedef {object} GateVerdict
 * @property {boolean} ok
 * @property {string} contractKind
 * @property {GateIssue[]} issues
 * @property {Record<string, unknown>} metrics
 * @property {string | null} errorCode
 */

/**
 * @typedef {object} GateInput
 * @property {string} contractKind
 * @property {Map<string, string>} files          relative path inside the deliverable dir -> text
 * @property {readonly {path: string, required: boolean}[]} [expectedOutputs]
 * @property {string | null} [briefText]          the server's copy of the question
 * @property {string | null} [workspaceBriefText] the run's copy, compared not trusted
 * @property {any} [matrix]
 * @property {any} [runReceipt]
 * @property {Record<string, string>} [sourceArtifacts]
 * @property {readonly string[]} [executedSearchQueries]
 * @property {number} [staleEvidenceCount]
 * @property {string} [finalReplyText]
 */

/** @param {GateInput} input @param {string} path @returns {string} */
function text(input, path) {
  return input.files.get(path) ?? ''
}

/** @param {GateInput} input @param {string} path @returns {any} */
function json(input, path) {
  const raw = input.files.get(path)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * @param {string} code @param {string} message
 * @param {{severity?: 'required'|'advisory'|'optional', line?: number, path?: string}} [extra]
 * @returns {GateIssue}
 */
function issue(code, message, extra = {}) {
  return { code, message, severity: extra.severity ?? 'required', ...(extra.line ? { line: extra.line } : {}), ...(extra.path ? { path: extra.path } : {}) }
}

/**
 * Checks the files the capability manifest promised are present and non-empty.
 * Every contract kind gets this; a kind's own validator adds what only it knows.
 * @param {GateInput} input @returns {GateIssue[]}
 */
function requiredOutputIssues(input) {
  /** @type {GateIssue[]} */
  const issues = []
  for (const output of input.expectedOutputs ?? []) {
    const body = input.files.get(output.path)
    if (body == null) {
      if (output.required) issues.push(issue('required_output_missing', `${output.path} is missing.`, { path: output.path }))
      continue
    }
    if (output.required && !body.trim()) {
      issues.push(issue('required_output_empty', `${output.path} is empty.`, { path: output.path }))
    }
  }
  return issues
}

/**
 * Report prose must not name the machinery that produced it, and must not carry
 * clinical content under a non-clinical contract without the safety rules
 * applying. Both are content triggers: they look at what was produced, never at
 * what was asked (§9.4).
 * @param {GateInput} input @param {readonly string[]} proseFiles @returns {GateIssue[]}
 */
function proseHygieneIssues(input, proseFiles) {
  /** @type {GateIssue[]} */
  const issues = []
  for (const path of proseFiles) {
    const body = text(input, path)
    if (!body) continue
    const leak = runtimeLeakageLine(body)
    if (leak) {
      issues.push(issue('runtime_leakage', `${path} line ${leak.line} names the retrieval machinery: ${leak.text}`, { path, line: leak.line }))
    }
    for (const citationIssue of citationIntegrityIssues(body)) {
      issues.push(issue('citation_integrity', `${path}: ${citationIssue}`, { path }))
    }
    if (!isClinicalContractKind(input.contractKind)) {
      const triggers = matchedClinicalTriggers(body)
      if (triggers.length) {
        issues.push(issue(
          'clinical_content_without_clinical_contract',
          `${path} discusses ${triggers.slice(0, 3).join('、')} but this deliverable is not under a clinical contract. Deliver it as a clinical contract kind, or remove the clinical content.`,
          { path },
        ))
      }
    }
  }
  return issues
}

/** @param {GateInput} input @returns {GateVerdict} */
function validateClinicalEvidenceReport(input) {
  const result = validateClinicalEvidencePackage({
    reportText: text(input, 'clinical-evidence-report.md'),
    matrix: input.matrix ?? json(input, 'clinical-evidence-matrix.json'),
    runReceipt: input.runReceipt ?? json(input, 'clinical-evidence-run.json'),
    sourceArtifacts: input.sourceArtifacts ?? {},
    executedSearchQueries: input.executedSearchQueries ?? null,
    searchLogText: text(input, 'clinical-evidence-search.json'),
    referencesText: text(input, 'references.bib'),
    citationLedgerText: text(input, 'citation-ledger.csv'),
    citationAuditText: text(input, 'citation-audit.md'),
    questionCoverageText: text(input, 'question-coverage.json'),
    briefText: input.briefText ?? null,
    workspaceBriefText: input.workspaceBriefText ?? null,
  })
  // The gate's own distinction between blocking and degradable is preserved,
  // not flattened. A degradable finding is one the run cannot repair and the
  // package should still be delivered with — flattening them to "required"
  // would send a finished package round the repair loop for something nobody
  // can fix, which is the failure the distinction was introduced to stop.
  const blocking = new Set(result.blockingIssues ?? result.issues ?? [])
  const errorCode = clinicalEvidencePackageErrorCode(result.blockingIssues ?? [])
  // No generic required-output check here. The clinical validator already has a
  // message for every file it needs, phrased so the run can act on it, and
  // adding the manifest's list on top would be a second implementation of the
  // same rule — the exact thing this contract kind exists to have only one of.
  // It would also be *stricter* than the server, which is the failure mode that
  // cost three finished packages: a run told it is not done for something the
  // server would have delivered.
  const issues = [
    ...(result.issues ?? []).map((message) => issue(
      blocking.has(message) ? (errorCode ?? 'clinical_evidence_issue') : 'clinical_evidence_notice',
      String(message),
      { severity: blocking.has(message) ? 'required' : 'advisory' },
    )),
    ...(result.coverageDegradedNotice
      ? [issue('clinical_evidence_notice', String(result.coverageDegradedNotice), { severity: 'advisory' })]
      : []),
    // Findings that rest on a judgement no pattern can make. They reach the run
    // while it can still act, and can never withhold a package.
    ...clinicalEvidenceAdvisoryNotes(text(input, 'clinical-evidence-report.md'))
      .map((message) => issue('clinical_evidence_notice', message, { severity: 'advisory' })),
  ]
  const required = issues.filter((entry) => entry.severity === 'required')
  return {
    ok: required.length === 0,
    contractKind: input.contractKind,
    issues,
    metrics: {
      ...verificationGateMetrics({
        matrix: input.matrix ?? json(input, 'clinical-evidence-matrix.json'),
        citationLedgerText: text(input, 'citation-ledger.csv'),
        staleEvidenceCount: input.staleEvidenceCount ?? 0,
      }),
      // A measurement, not a rule: which section serves which question is not
      // decidable here, so the run is handed the shares and applies the rule.
      sectionShares: reportSectionShares(text(input, 'clinical-evidence-report.md')),
    },
    errorCode: required.length ? (errorCode ?? 'deliverable_rejected') : null,
  }
}

/**
 * The default validator: declared files exist, prose is clean, citations
 * resolve. It is what every report-shaped kind gets until it earns rules of its
 * own — deliberately shallow, so a kind is never blocked by a rule nobody wrote.
 * @param {GateInput} input @param {readonly string[]} proseFiles @returns {GateVerdict}
 */
function validateReportShaped(input, proseFiles) {
  const issues = [...requiredOutputIssues(input), ...proseHygieneIssues(input, proseFiles)]
  return {
    ok: issues.every((item) => item.severity !== 'required'),
    contractKind: input.contractKind,
    issues,
    metrics: verificationGateMetrics({
      matrix: input.matrix ?? json(input, 'evidence-matrix.json'),
      citationLedgerText: text(input, 'citation-ledger.csv'),
      staleEvidenceCount: input.staleEvidenceCount ?? 0,
    }),
    errorCode: issues.some((item) => item.severity === 'required') ? 'deliverable_rejected' : null,
  }
}

/** Markdown files inside a deliverable, which is what "prose" means here.
 *  @param {{ files: Map<string, any> }} input @returns {string[]} */
function proseFilesOf(input) {
  return [...input.files.keys()].filter((path) => path.endsWith('.md'))
}

/**
 * @param {GateInput} input
 * @param {{ file: string, check: (value: any) => string[] }} spec
 * @returns {GateVerdict}
 */
function validateJsonShaped(input, spec) {
  const issues = requiredOutputIssues(input)
  const value = json(input, spec.file)
  if (value === undefined) {
    issues.push(issue('deliverable_rejected', `${spec.file} is not valid JSON.`, { path: spec.file }))
  } else if (value === null) {
    issues.push(issue('required_output_missing', `${spec.file} is missing.`, { path: spec.file }))
  } else {
    for (const message of spec.check(value)) issues.push(issue('deliverable_rejected', `${spec.file}: ${message}`, { path: spec.file }))
  }
  return {
    ok: issues.length === 0,
    contractKind: input.contractKind,
    issues,
    metrics: {},
    errorCode: issues.length ? 'deliverable_rejected' : null,
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The registry. Static on purpose: a runtime-registerable table is a mutable
 * global that lets a plugin decide how it is graded.
 * @type {Readonly<Record<string, (input: GateInput) => GateVerdict>>}
 */
const VALIDATORS = Object.freeze({
  'clinical-evidence-report': validateClinicalEvidenceReport,
  'drug-evaluation-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'drug-selection-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'off-label-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'meta-analysis-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'mendelian-randomization-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'bibliometric-analysis-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'peer-review-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'adr-analysis-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'research-topic-report': (input) => validateReportShaped(input, proseFilesOf(input)),
  'dataset-scoping-package': (input) => validateReportShaped(input, proseFilesOf(input)),
  'research-brief': (input) => validateReportShaped(input, proseFilesOf(input)),
  'appraisal-table': (input) => validateReportShaped(input, proseFilesOf(input)),
  'manuscript-section': (input) => validateReportShaped(input, proseFilesOf(input)),
  'geo-content-pack': validateGeoContentPack,
  'clinical-decision-brief': (input) => validateReportShaped(input, proseFilesOf(input)),
  'episode-plan': (input) => validateJsonShaped(input, { file: 'episode-plan.json', check: checkEpisodePlan }),
  'agenda-delta': (input) => validateJsonShaped(input, { file: 'agenda-delta.json', check: checkAgendaDelta }),
  'analysis-plan': (input) => validateJsonShaped(input, { file: 'analysis-plan.json', check: checkAnalysisPlan }),
  'reproducibility-pack': (input) => validateJsonShaped(input, { file: 'reproducibility-pack.json', check: checkReproducibilityPack }),
  'surveillance-diff': (input) => validateJsonShaped(input, { file: 'surveillance-diff.json', check: checkSurveillanceDiff }),
  'hypothesis-set': (input) => validateJsonShaped(input, { file: 'hypothesis-set.json', check: checkHypothesisSet }),
})

/** Every kind must have a validator; the test that walks CONTRACT_KINDS holds that line. */
export const CONTRACT_VALIDATOR_KINDS = Object.freeze(Object.keys(VALIDATORS))

/**
 * @param {GateInput} input
 * @returns {GateVerdict}
 */
export function runGate(input) {
  const contractKind = String(input?.contractKind ?? '')
  if (!isContractKind(contractKind)) {
    return {
      ok: false,
      contractKind,
      issues: [issue('contract_kind_unknown', `unknown contract kind "${contractKind}"; known kinds: ${CONTRACT_KINDS.join(', ')}.`)],
      metrics: {},
      errorCode: 'contract_kind_unknown',
    }
  }
  const validator = VALIDATORS[contractKind]
  const files = input.files instanceof Map ? input.files : new Map(Object.entries(input.files ?? {}))
  return validator({ ...input, contractKind, files })
}

/** @param {any} value @returns {string[]} */
function checkEpisodePlan(value) {
  const errors = []
  if (!isRecord(value)) return ['must be an object.']
  const tasks = Array.isArray(value.tasks) ? value.tasks : null
  if (!tasks || !tasks.length) errors.push('tasks[] must be a non-empty array.')
  for (const task of tasks ?? []) {
    if (!isRecord(task)) { errors.push('each task must be an object.'); continue }
    if (!task.type) errors.push('each task needs a type.')
    if (!task.costClass) errors.push('each task needs a costClass.')
    if (!Array.isArray(task.inputs)) errors.push('each task needs inputs[].')
  }
  return errors
}

/** @param {any} value @returns {string[]} */
function checkAgendaDelta(value) {
  const errors = []
  if (!isRecord(value)) return ['must be an object.']
  const claims = Array.isArray(value.claims) ? value.claims : []
  for (const claim of claims) {
    if (!isRecord(claim)) { errors.push('each claim must be an object.'); continue }
    if (!claim.statement) errors.push('each claim needs a statement.')
    if (!['direct', 'synthesized', 'derived'].includes(String(claim.type))) errors.push(`claim type "${claim.type}" must be direct / synthesized / derived.`)
    if (claim.tier !== 'unverified') errors.push('a new claim must enter as tier "unverified"; only a verification episode raises it.')
    if (!Array.isArray(claim.sources) || !claim.sources.length) errors.push('each claim needs sources[].')
    if (!isRecord(claim.provenance)) errors.push('each claim needs provenance.')
    if (claim.type !== 'direct' && !claim.what_would_change) errors.push('a synthesized or derived claim must say what would change it.')
  }
  for (const hypothesis of Array.isArray(value.hypotheses) ? value.hypotheses : []) {
    if (!isRecord(hypothesis)) { errors.push('each hypothesis must be an object.'); continue }
    if (!hypothesis.statement) errors.push('each hypothesis needs a statement.')
    if (!Array.isArray(hypothesis.evidence_for) || !Array.isArray(hypothesis.evidence_against)) {
      errors.push('each hypothesis needs evidence_for[] and evidence_against[].')
    }
  }
  if (!claims.length && !Array.isArray(value.hypotheses)) errors.push('a delta must carry claims[] or hypotheses[], even when empty.')
  return errors
}

/** @param {any} value @returns {string[]} */
function checkAnalysisPlan(value) {
  const errors = []
  if (!isRecord(value)) return ['must be an object.']
  if (!value.hypothesis_id) errors.push('needs hypothesis_id.')
  if (!Array.isArray(value.variables) || !value.variables.length) errors.push('needs variables[].')
  if (!value.model) errors.push('needs a model.')
  if (!value.multiplicity) errors.push('needs a multiplicity correction.')
  if (!value.stopping) errors.push('needs a stopping rule.')
  if (!value.primary_endpoint) errors.push('needs exactly one primary_endpoint.')
  return errors
}

/** @param {any} value @returns {string[]} */
function checkReproducibilityPack(value) {
  const errors = []
  if (!isRecord(value)) return ['must be an object.']
  for (const field of ['code_path', 'image_digest', 'dataset_partition_id', 'random_seed', 'run_id']) {
    if (!value[field]) errors.push(`needs ${field}.`)
  }
  if (!Array.isArray(value.results) || !value.results.length) errors.push('needs results[].')
  return errors
}

/** @param {any} value @returns {string[]} */
function checkSurveillanceDiff(value) {
  const errors = []
  if (!isRecord(value)) return ['must be an object.']
  if (!isRecord(value.strategy)) errors.push('needs the strategy it ran.')
  if (!Array.isArray(value.new_records)) errors.push('needs new_records[].')
  if (!Array.isArray(value.retractions)) errors.push('needs retractions[], even when empty.')
  return errors
}

/** @param {any} value @returns {string[]} */
function checkHypothesisSet(value) {
  const errors = []
  if (!isRecord(value)) return ['must be an object.']
  const items = Array.isArray(value.hypotheses) ? value.hypotheses : []
  if (!items.length) errors.push('needs hypotheses[].')
  for (const item of items) {
    if (!isRecord(item)) { errors.push('each hypothesis must be an object.'); continue }
    if (!item.statement) errors.push('each hypothesis needs a statement.')
    if (!isRecord(item.novelty)) errors.push('each hypothesis needs a novelty check.')
    else if (!Array.isArray(item.novelty.nearest) || !item.novelty.nearest.length) {
      errors.push('a novelty check must cite the nearest literature it compared against, not just score it.')
    }
    if (!Array.isArray(item.tests) || !item.tests.length) errors.push('each hypothesis needs tests[] — what would settle it.')
  }
  return errors
}

/**
 * GEO content blocks are mechanically checkable, so they block (§9.11).
 * @param {GateInput} input @returns {GateVerdict}
 */
function validateGeoContentPack(input) {
  const issues = [...requiredOutputIssues(input), ...proseHygieneIssues(input, proseFilesOf(input))]
  const pack = json(input, 'geo-content-pack.json')
  if (pack === undefined) {
    issues.push(issue('deliverable_rejected', 'geo-content-pack.json is not valid JSON.', { path: 'geo-content-pack.json' }))
  } else if (!isRecord(pack)) {
    issues.push(issue('required_output_missing', 'geo-content-pack.json is missing.', { path: 'geo-content-pack.json' }))
  } else {
    const blocks = Array.isArray(pack.blocks) ? pack.blocks : []
    if (!blocks.length) issues.push(issue('deliverable_rejected', 'the pack contains no content blocks.'))
    blocks.forEach((block, index) => {
      const where = `blocks[${index}]`
      if (!isRecord(block)) { issues.push(issue('deliverable_rejected', `${where} must be an object.`)); return }
      for (const field of ['conclusion', 'basis', 'conditions']) {
        if (!String(block[field] ?? '').trim()) issues.push(issue('deliverable_rejected', `${where} is missing its ${field} paragraph.`))
      }
      const citations = Array.isArray(block.citations) ? block.citations : []
      if (citations.length < 2) issues.push(issue('deliverable_rejected', `${where} needs at least two resolvable citations.`))
      if (!block.jsonLd) issues.push(issue('deliverable_rejected', `${where} is missing its schema.org JSON-LD.`))
      if (!block.author || !block.updatedAt) issues.push(issue('deliverable_rejected', `${where} needs an author credential and an update date.`))
    })
    if (!String(pack.llmsTxt ?? '').trim()) issues.push(issue('deliverable_rejected', 'the pack is missing its llms.txt fragment.'))
    if (!Array.isArray(pack.faq) || !pack.faq.length) issues.push(issue('deliverable_rejected', 'the pack is missing its FAQ block.'))
  }
  return {
    ok: issues.length === 0,
    contractKind: input.contractKind,
    issues,
    metrics: {},
    errorCode: issues.length ? 'deliverable_rejected' : null,
  }
}

/**
 * Splits a verdict's issues into the three layers a repair instruction uses
 * (§8.1): must fix, should fix, may fix.
 * @param {readonly GateIssue[]} issues
 * @returns {{ required: GateIssue[], advisory: GateIssue[], optional: GateIssue[] }}
 */
export function layeredIssues(issues) {
  return {
    required: issues.filter((item) => item.severity === 'required'),
    advisory: issues.filter((item) => item.severity === 'advisory'),
    optional: issues.filter((item) => item.severity === 'optional'),
  }
}
