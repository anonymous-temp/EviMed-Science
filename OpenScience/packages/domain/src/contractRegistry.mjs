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

import { checkIdOf, clinicalEvidenceAdvisoryNotes, clinicalEvidenceCheckIds, clinicalEvidencePackageErrorCode, evaluateClinicalSafetyRules, reportSectionShares, validateClinicalEvidencePackage, citationIntegrityIssues, runtimeLeakageLine, verificationGateMetrics } from './clinicalEvidence.mjs'
import { CONTRACT_KINDS, isContractKind, isClinicalContractKind } from './contractKinds.mjs'
import { matchedClinicalTriggers } from './safetyRules.mjs'
import { workspaceLayout } from './workspaceLayout.mjs'

/**
 * Every check a gate verdict can attribute a finding to.
 *
 * The clinical delivery gate declares its ids at the rules themselves
 * (`clinicalEvidenceCheckIds`); the three added here belong to this file — the
 * capability manifest's required-output check, the JSON-parse guard that runs
 * before any content rule, and the coverage notice. One list, because the axis a
 * false-positive distribution is computed along should be enumerable without
 * reading two files.
 *
 * Contract kinds other than the clinical package do not name their checks yet.
 * Their findings carry no `check` and are counted as unattributed rather than
 * bucketed under a default that would read as coverage.
 * @type {readonly string[]}
 */
export const GATE_CHECK_IDS = Object.freeze([
  ...clinicalEvidenceCheckIds,
  'required-output',
  'deliverable-json-parse',
  'coverage-degraded',
])

/**
 * @typedef {object} GateIssue
 * @property {string} code
 * @property {string} message
 * @property {'required'|'advisory'|'optional'} severity
 * @property {number} [line]
 * @property {string} [path]
 * @property {string} [check] The id of the check that raised it, for the ledger.
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
 * @property {readonly string[] | null} [executedSearchQueries] null when the run
 *   executed no searches, which is what `validateClinicalEvidencePackage`
 *   defaults it to. Declared without the null for a long time, so the socket's
 *   own declaration of the same input — which does allow it — did not match, and
 *   nothing noticed because `packages/socket` was never typechecked in CI.
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
 * `check` is the identity of the rule that raised this finding, carried so the
 * gate ledger records which check spoke rather than only what it said. It is
 * absent where the raising code has not declared one — a hole that stays
 * visible instead of being filled with a default that would look like coverage.
 * @param {string} code @param {string} message
 * @param {{severity?: 'required'|'advisory'|'optional', line?: number, path?: string, check?: string | null}} [extra]
 * @returns {GateIssue}
 */
function issue(code, message, extra = {}) {
  return { code, message, severity: extra.severity ?? 'required', ...(extra.line ? { line: extra.line } : {}), ...(extra.path ? { path: extra.path } : {}), ...(extra.check ? { check: extra.check } : {}) }
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
      if (output.required) issues.push(issue('required_output_missing', `${output.path} is missing.`, { path: output.path, check: 'required-output' }))
      continue
    }
    if (output.required && !body.trim()) {
      issues.push(issue('required_output_empty', `${output.path} is empty.`, { path: output.path, check: 'required-output' }))
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
      issues.push(issue('runtime_leakage', `${path} line ${leak.line} names the retrieval machinery: ${leak.text}`, { path, line: leak.line, check: checkIdOf(runtimeLeakageLine) }))
    }
    for (const citationIssue of citationIntegrityIssues(body)) {
      issues.push(issue('citation_integrity', `${path}: ${citationIssue}`, { path, check: checkIdOf(citationIntegrityIssues) }))
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
  // A syntax error is a syntax error, not two dozen content problems.
  //
  // `json()` returns `undefined` for a file that exists and does not parse, and
  // `validateJsonShaped` already reports that as its own issue. This contract
  // passed it straight through, so one unescaped quote inside a Chinese string
  // made the matrix `undefined` and the package came back with 24 blocking
  // issues of the form "CLM-001 does not resolve to the evidence matrix" —
  // twenty claim ids to chase and nothing anywhere saying the file had not
  // parsed. Observed on a real package: `"支撑"立即就医评估"的处置。"`, which
  // ends the JSON string early.
  //
  // Reported before the content rules run, because a repair loop has bounded
  // attempts and spending them on the symptom is how a fixable package dies.
  const parseIssues = [];
  for (const [file, parsed, provided] of [
    ["clinical-evidence-matrix.json", json(input, "clinical-evidence-matrix.json"), input.matrix],
    ["clinical-evidence-run.json", json(input, "clinical-evidence-run.json"), input.runReceipt],
  ]) {
    if (provided == null && parsed === undefined) {
      parseIssues.push(issue("deliverable_rejected", `${file} is not valid JSON. Fix the syntax first: a value containing a double quote must escape it (\\"), and every string must close before the next key.`, { check: "deliverable-json-parse" }));
    }
  }
  if (parseIssues.length) {
    return { ok: false, contractKind: input.contractKind, issues: parseIssues, metrics: {}, errorCode: "deliverable_rejected" };
  }
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
  // The manifest's own required-output check runs here too.
  //
  // It used to be left out, on the stated grounds that "the clinical validator
  // already has a message for every file it needs". Nothing tested that claim
  // and it was false for three of the eight: with `citation-ledger.csv`,
  // `references.bib` or `citation-audit.md` absent, this gate returned ok=true
  // with zero required issues, and the server's own check then failed the run
  // with `specialist_required_output_missing`. Two gates, one package, opposite
  // verdicts — exactly the drift the single-implementation rule exists to stop.
  //
  // It cost RQ-03 two full runs. Both spent all three repair attempts on
  // citation binding, were told nothing about the two files they had never
  // created, and died at the server boundary after the attempts were gone.
  //
  // Not a second implementation: `requiredOutputIssues` is the same function
  // every other contract kind calls, reading the same `expectedOutputs` the
  // capability manifest supplies and the server's `agent.outputs` mirrors. And
  // it cannot be stricter than the server, because it is the server's list.
  // Only the files this contract's own validator has nothing to say about.
  //
  // Adding the manifest check wholesale reported every absence twice -- once
  // as "X is missing." and once in the validator's own words -- which is the
  // opposite of the rule this contract kind is built on: one absent file is
  // one problem, not two. Three existing tests said so, and they were right.
  //
  // So the two are complementary, not stacked. The validator speaks for the
  // files it knows (report, matrix, run receipt, coverage ledger); the manifest
  // speaks for the rest, which is how citation-ledger.csv, references.bib and
  // citation-audit.md went unmentioned while the server failed the run for
  // them.
  // "Already spoken for" means the validator BLOCKS on that file's absence, not
  // merely that its name appears somewhere. Matching on the name alone let a
  // rule about `citation-ledger.csv`'s header column order — advisory, and
  // about a file that exists — suppress the report that the file is missing
  // entirely. The gate then passed a package the server would reject, which is
  // the exact drift this change was made to close.
  const blockedOn = new Set(result.blockingIssues ?? []);
  /** @param {string} relative @returns {boolean} */
  const namedByValidator = (relative) => [...blockedOn].some((message) => String(message).includes(relative));
  // Every required file the validator is not already blocking on, including
  // when the report itself is one of them.
  //
  // This withheld the whole list while the report was absent, reasoning that
  // the other absences were downstream of it. They are not: citation-ledger.csv,
  // references.bib and citation-audit.md are independent files, and a run told
  // about all of them writes all of them in one round. A run told only about
  // the report writes the report and spends another attempt discovering the
  // rest — which is the exact condition the manifest check was added to end,
  // reintroduced for the first submission of every run. RQ-03's rerun spent
  // gate 1 on the report and gate 2 on four more files, two of five attempts,
  // and never reached the quote checks at all.
  //
  // The nine complaints an absent report used to draw are handled where they
  // arise, in the validator's own early return. `namedByValidator` keeps the
  // report from being reported twice here.
  const manifestIssues = requiredOutputIssues(input)
    .filter((entry) => !namedByValidator(String(entry.path ?? "")));
  const issues = [
    ...manifestIssues,
    // `issueChecks` is `issues` with the raising check attached, in the same
    // order — read it rather than the strings, because recovering an id by
    // matching our own prose is regex over language to find out something the
    // code already knew, and that is the mistake this gate keeps paying for.
    ...(result.issueChecks ?? (result.issues ?? []).map((message) => ({ check: null, text: message })))
      .map((/** @type {{ check: string | null, text: string }} */ finding) => issue(
        blocking.has(finding.text) ? (errorCode ?? 'clinical_evidence_issue') : 'clinical_evidence_notice',
        String(finding.text),
        { severity: blocking.has(finding.text) ? 'required' : 'advisory', check: finding.check },
      )),
    ...(result.coverageDegradedNotice
      ? [issue('clinical_evidence_notice', String(result.coverageDegradedNotice), { severity: 'advisory', check: 'coverage-degraded' })]
      : []),
    // Findings that rest on a judgement no pattern can make. They reach the run
    // while it can still act, and can never withhold a package.
    ...clinicalEvidenceAdvisoryNotes(text(input, 'clinical-evidence-report.md'))
      .map((message) => issue('clinical_evidence_notice', message, { severity: 'advisory', check: checkIdOf(clinicalEvidenceAdvisoryNotes) })),
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
  // Everything markdown except the designated backstage file. Report prose is
  // held to a register the notes deliberately are not: the notes exist to say
  // what changed and why, in exactly the voice the report may not use. Scanning
  // them would make the outlet a trap, and an outlet that is a trap is one runs
  // learn to avoid by hiding backstage prose in the report instead.
  return [...input.files.keys()]
    .filter((path) => path.endsWith('.md') && path !== workspaceLayout.revisionNotesFile)
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
  'grant-proposal-package': validateGrantProposalPackage,
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
 * Reads the probe ledger: one JSON object per line, one line per probe call.
 *
 * Malformed lines are counted rather than thrown away. A ledger that half
 * parses is the shape this codebase keeps rediscovering — the run looks
 * complete and the count is quietly short — so the number of unreadable lines
 * is reported as its own finding instead of silently reducing the denominator.
 * @param {GateInput} input
 * @returns {{ rounds: any[], unreadable: number, present: boolean }}
 */
function probeLedger(input) {
  // input.files directly, not text(): that helper collapses a missing file and
  // an empty one to the same '', and those are the two facts this whole
  // function exists to keep apart.
  const raw = input.files.get('geo-probe-log.jsonl')
  if (raw == null) return { rounds: [], unreadable: 0, present: false }
  const rounds = []
  let unreadable = 0
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (isRecord(parsed)) rounds.push(parsed)
      else unreadable += 1
    } catch {
      unreadable += 1
    }
  }
  return { rounds, unreadable, present: true }
}

/**
 * Measurement honesty, as notices.
 *
 * Everything else in this file grades a document. These grade a number, and a
 * number has a failure the document does not: a visibility rate computed over
 * rounds that never happened is wrong in a way that is invisible on the page.
 * "The vendor answered and did not mention us", "the vendor errored" and "the
 * vendor was never logged in" are three different facts that produce one
 * identical-looking absence, and collapsing them inflates the finding.
 *
 * These are advisory on purpose. The system blocks in six places; a seventh
 * needs an observed distribution first, and this capability has produced no
 * real runs yet. The metrics beside them are how that distribution gets
 * collected. When the shape of real failures is known, the ones that earn it
 * can be promoted — and the argument will be made from data rather than from
 * how bad the failure sounds.
 * @param {GateInput} input @returns {{ issues: GateIssue[], metrics: Record<string, unknown> }}
 */
function geoMeasurementNotices(input) {
  /** @type {GateIssue[]} */
  const issues = []
  /** @param {string} code @param {string} message */
  const notice = (code, message) => issues.push(issue(code, message, { severity: 'advisory', path: 'geo-probe-log.jsonl' }))
  const { rounds, unreadable, present } = probeLedger(input)
  const measured = rounds.filter((row) => row.inDenominator === true)
  const failed = rounds.filter((row) => row.inDenominator !== true)

  if (!present) {
    notice('geo_measurement_absent', 'geo-probe-log.jsonl is not in the deliverable, so no number in this pack can be recomputed from what was actually asked.')
  } else if (!measured.length) {
    notice(
      'geo_measurement_absent',
      rounds.length
        ? `all ${rounds.length} probe round(s) failed, so nothing was measured. A pack built on zero measurements states what the engines were not observed to say.`
        : 'the probe ledger is empty, so nothing was measured.',
    )
  }
  if (unreadable) {
    notice('geo_probe_log_unreadable', `${unreadable} line(s) of geo-probe-log.jsonl could not be parsed; every rate computed from it is short by an unknown amount.`)
  }

  // A round that failed and was counted anyway. The two fields disagree, and
  // whichever is right the rate is wrong.
  const countedFailures = rounds.filter((row) => row.inDenominator === true && String(row.status ?? 'ok') !== 'ok')
  if (countedFailures.length) {
    notice('geo_failed_round_counted', `${countedFailures.length} probe round(s) are marked as counting toward the denominator while their status is not ok. A failed probe is not a measurement.`)
  }

  // The surface is part of the finding: the same question in deep mode from a
  // fresh session is a different claim about the vendor than one from a warm
  // session, and a client reproducing it on a phone sees a contradiction.
  const surfaceless = measured.filter((row) => {
    const surface = isRecord(row.surface) ? row.surface : {}
    return !String(surface.mode ?? '').trim() || !String(surface.session ?? '').trim()
  })
  if (surfaceless.length) {
    notice('geo_surface_undeclared', `${surfaceless.length} measured round(s) do not record both a mode and a session. Without the surface the measurement cannot be reproduced or compared with the next one.`)
  }

  // The declared denominator against the one the ledger supports. Compared as
  // numbers from a JSON field rather than read out of prose: a denominator
  // typed into a sentence is a number nobody can re-derive.
  const pack = json(input, 'geo-content-pack.json')
  const declared = isRecord(pack) && isRecord(pack.measurement) ? pack.measurement : null
  if (declared && Number.isFinite(Number(declared.measured)) && Number(declared.measured) > measured.length) {
    notice(
      'geo_denominator_overstated',
      `the pack declares ${Number(declared.measured)} measured round(s) but the ledger contains ${measured.length}. A denominator that includes rounds which did not happen overstates every rate built on it.`,
    )
  }

  // The probe host, leaked into client-facing prose. The shared leakage rule
  // already covers tool names, gateway words and retrieval narration — it is
  // derived from toolNames.mjs, so geo_visibility_probe came under it the
  // moment the tool was registered. A bare address is the one shape it does not
  // match, and it is specific to this capability because no other deliverable
  // has an infrastructure host anywhere near it.
  for (const path of proseFilesOf(input)) {
    const found = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/.exec(text(input, path))
    if (found) {
      issues.push(issue('geo_probe_host_in_prose', `${path} contains what looks like a probe host (${found[0]}). The reader needs the finding, not the machine it came from.`, { severity: 'advisory', path }))
    }
  }

  const platforms = [...new Set(measured.map((row) => String(row.provider ?? '').trim()).filter(Boolean))].sort()
  return {
    issues,
    metrics: {
      geoProbeRounds: rounds.length,
      geoMeasuredRounds: measured.length,
      geoFailedRounds: failed.length,
      geoUnreadableLedgerLines: unreadable,
      geoPlatformsMeasured: platforms,
      geoQuestionsMeasured: new Set(measured.map((row) => String(row.question ?? ''))).size,
    },
  }
}

/**
 * A grant package, graded on the two things a reviewer cannot recover for
 * themselves.
 *
 * The skill's own rules name what goes wrong: "do not invent a funding rule or
 * reuse a requirement from another call", and do not fabricate institutional
 * resources or preliminary results. Neither is decidable from prose. What is
 * decidable is whether every requirement the run says the call imposes carries a
 * quote from the call it was read out of — a fabricated rule has no quote to
 * give — and whether the audit actually covers each of them rather than the
 * three that were easy.
 *
 * Blocking stays at what the skill already declared: the four files, and a
 * milestones table that parses. The two above are notices, because they are new
 * and the budget is six.
 * @param {GateInput} input @returns {GateVerdict}
 */
function validateGrantProposalPackage(input) {
  const issues = [...requiredOutputIssues(input), ...proseHygieneIssues(input, proseFilesOf(input))]

  // Milestones are a table, so they are checked as one. A milestone with no date
  // is a plan item; a milestone with no measurable outcome is a wish.
  const milestones = text(input, 'milestones.csv')
  if (milestones.trim()) {
    const [header = '', ...rows] = milestones.trim().split('\n')
    const columns = header.split(',').map((name) => name.trim().toLowerCase())
    for (const required of ['milestone', 'date', 'outcome']) {
      if (!columns.includes(required)) {
        issues.push(issue('deliverable_rejected', `milestones.csv has no "${required}" column; it has: ${columns.join(', ')}.`, { path: 'milestones.csv' }))
      }
    }
    const dateAt = columns.indexOf('date')
    const undated = rows.filter((row) => row.trim() && !String(row.split(',')[dateAt] ?? '').trim()).length
    if (dateAt >= 0 && undated) {
      issues.push(issue('deliverable_rejected', `${undated} milestone(s) have no date. A milestone without one is a plan item.`, { path: 'milestones.csv' }))
    }
  }

  const requirements = json(input, 'call-requirements.json')
  const entries = isRecord(requirements) && Array.isArray(requirements.requirements) ? requirements.requirements : []
  if (entries.length) {
    // A rule invented or carried over from another call has no quote to give.
    const unquoted = entries.filter((entry) => !isRecord(entry) || !String(entry.sourceQuote ?? '').trim())
    if (unquoted.length) {
      issues.push(issue(
        'grant_requirement_unquoted',
        `${unquoted.length} of ${entries.length} stated call requirement(s) carry no quote from the call. A requirement nobody can trace to the instructions is one the reviewer will not find either.`,
        { severity: 'advisory', path: 'call-requirements.json' },
      ))
    }
    // Coverage by id, not by reading the prose: the audit names each id or it
    // does not.
    const audit = text(input, 'grant-audit.md')
    const uncovered = entries
      .map((entry) => String(isRecord(entry) ? entry.id ?? '' : '').trim())
      .filter((id) => id && !audit.includes(id))
    if (uncovered.length) {
      issues.push(issue(
        'grant_requirement_unaudited',
        `${uncovered.length} requirement(s) are absent from grant-audit.md: ${uncovered.slice(0, 5).join(', ')}. The audit exists to map every criterion to a location.`,
        { severity: 'advisory', path: 'grant-audit.md' },
      ))
    }
  }

  return {
    ok: issues.every((item) => item.severity !== 'required'),
    contractKind: input.contractKind,
    issues,
    metrics: {
      grantRequirements: entries.length,
      grantMilestones: milestones.trim() ? milestones.trim().split('\n').length - 1 : 0,
    },
    errorCode: issues.some((item) => item.severity === 'required') ? 'deliverable_rejected' : null,
  }
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
  // The clinical half of the contract. A content block is written to be quoted
  // by a machine that will not add the caveat back, so the same rules that
  // govern a clinical report's practical advice govern it — the pack's prose is
  // both the report and the practical section, and there is no originating
  // question, which is exactly why `entity_requires_question_mention` does not
  // fire: it asks whether a medicine was dragged into an answer that was not
  // about it, and a brand's own content block is about that brand.
  //
  // Called, not reimplemented. A "GEO version" of these rules is how the pair
  // that drifted three times got started.
  // The blocks themselves, not only the rendered Markdown. The content lives in
  // geo-content-pack.json and `proseFilesOf` yields .md files, so a pack whose
  // Markdown is a stub — "三段见 JSON" — would have had its every block go
  // unexamined while the check reported clean. Found by writing a test whose
  // assertion could not fail and then asking what it should have asserted.
  const blockProse = /** @type {any[]} */ (Array.isArray(pack?.blocks) ? pack.blocks : [])
    .flatMap((/** @type {any} */ block) => (isRecord(block) ? [block.conclusion, block.basis, block.conditions] : []))
    .map((/** @type {any} */ value) => String(value ?? ''))
  const packProse = [...proseFilesOf(input).map((path) => text(input, path)), ...blockProse].join('\n')
  for (const message of evaluateClinicalSafetyRules({ reportText: packProse, practical: packProse })) {
    issues.push(issue('clinical_safety_rule', message, { check: checkIdOf(evaluateClinicalSafetyRules) }))
  }

  const measurement = geoMeasurementNotices(input)
  issues.push(...measurement.issues)
  return {
    // By severity, not by count. Written as `issues.length === 0` this validator
    // would have turned its own first notice into a rejection, which is exactly
    // how "ships as a notice first" quietly becomes a seventh blocking point.
    ok: issues.every((item) => item.severity !== 'required'),
    contractKind: input.contractKind,
    issues,
    metrics: measurement.metrics,
    errorCode: issues.some((item) => item.severity === 'required') ? 'deliverable_rejected' : null,
  }
}

/** Codes that mean the gate could not read the package, not that the work is wrong. */
const UNREADABLE_CODES = Object.freeze(['required_output_missing', 'required_output_empty'])

/** Text that means the same for the clinical validator, which reports in prose. */
const UNREADABLE_MARKERS = Object.freeze([
  'uses a different claim shape',
  'is not in the deliverable, or is empty',
])

/**
 * Whether a rejection is about the package being unreadable rather than wrong.
 *
 * The late avalanche: two runs spent seven submissions each on the trajectory
 * 8 → 13 → 1 → **83** → 7 → 13 → 2. The 83 arrived the moment the matrix schema
 * was finally right — every content rule ran for the first time and reported at
 * once. Nothing was wrong with that report; what was wrong is that the four
 * submissions before it, which the gate could not evaluate at all, had already
 * spent more than half the budget.
 *
 * A submission the gate could not read teaches the run the contract, not the
 * work. It is still counted, against a small separate allowance, so a run
 * cannot loop on malformed packages forever — but it does not consume the
 * attempts reserved for repairing content.
 *
 * Takes anything carrying `issues`, because that is all it reads: a caller
 * holding a partial verdict — or a test naming the one field the rule depends
 * on — should not have to build a whole one to ask.
 *
 * @param {{ issues?: readonly GateIssue[] } | null | undefined} verdict
 * @returns {boolean}
 */
export function unreadableSubmission(verdict) {
  const required = (verdict?.issues ?? []).filter((entry) => entry?.severity === 'required')
  if (!required.length) return false
  return required.every((entry) => (
    UNREADABLE_CODES.includes(String(entry.code))
    || UNREADABLE_MARKERS.some((marker) => String(entry.message ?? '').includes(marker))
  ))
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
