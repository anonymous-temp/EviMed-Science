/**
 * The selected research package: what a recipient is handed to check a result and to reuse the way it was made (plan
 * 2026-10-02 §5.6, §11.3 N16).
 *
 * The package is the existing selected-version ZIP (`apps/server/src/resultExport.mjs`): one result version and the
 * versions it recorded as its inputs, code and environment, each with its size and digest. This module is the part
 * that is pure: the vocabulary a package names its omissions and exclusions in, the check that keeps a credential out
 * of its bytes, and the records the exporter adds beside the files — what produced the result (`execution.json`), what
 * has been checked about it (`verification.json`) and how a supported calculation is reconstructed
 * (`reproduction.json`). The exporter reads the ledger and writes the bytes; nothing here does I/O.
 *
 * Hidden knowledge:
 *
 * - **Every dependency is accounted for, one way or the other.** A version names inputs, code and an environment. In
 *   the package each one is either a file (its bytes, with size and digest) or an entry of `omissions` naming why its
 *   bytes are not there. A recipient's verifier checks exactly that, so a reference cannot disappear without a trace.
 * - **Unknown is a value.** An engine's code and environment are identified by digest and are not distributed; a source
 *   that was only cited has no bytes. Those are omissions with a reason, never an absent field. A record that was not
 *   produced says so (`none_recorded`): a check that was not run never reads as a check that passed.
 * - **A credential never rides in.** The projection of a version is a closed schema with no field for an environment
 *   variable, a command line or a token; the bytes of a captured script or table are the one place a credential can
 *   still sit, so text-shaped bytes are read for the formats credentials come in (`credentialShapedText`) and a hit
 *   leaves the file out as a named omission. It is a format check, not a reading of language; it never echoes a match.
 * - **Patient rows are not here because nothing here can read them.** The export reads the project's preserved result
 *   versions and nothing else; the 虚拟临床研究 data plane is not reachable from it.
 * - **A package is read, never run.** Nothing in a package is executed, imported or restored by the platform or by
 *   the verifier it ships with: scripts are bytes, a recipe is data, and an identity in the manifest grants no access
 *   to the project it came from.
 *
 * Pure, browser-safe, no I/O.
 * @module @evimed/domain/resultPackage
 */

import { isCodePath } from './producerSnapshot.mjs'
import { RESULT_LINEAGE_LIMITS } from './resultIdentity.mjs'

/** The package's format name and the version of its manifest. Version 1 had files, versions and omissions only. */
export const RESULT_PACKAGE_FORMAT = 'evimed-research-result'
export const RESULT_PACKAGE_VERSION = 2

/** The records a package carries beside its files, by the name each is stored under. */
export const RESULT_PACKAGE_RECORD_FILES = Object.freeze({
  execution: 'execution.json',
  verification: 'verification.json',
  reproduction: 'reproduction.json',
})

/** What a file in the package is. */
export const RESULT_PACKAGE_FILE_ROLES = Object.freeze(['result', 'dependency', 'record', 'verifier', 'readme'])

/**
 * Why a dependency's bytes are not in the package. Closed; the verifier warns on a reason it does not know, the
 * recipient reads the reason, and none of them withholds the package.
 *
 * - `bytes_not_captured`: the platform holds an identity (a DOI, an engine's code or environment digest) and no
 *   preserved bytes.
 * - `input_unavailable`: the preserved version exists and the exporting researcher may not read it now (access was
 *   withdrawn, or the project no longer holds it for them).
 * - `input_deleted`: the version's record is gone.
 * - `preserved_bytes_unreadable`: the version is recorded and its stored bytes could not be read back as recorded.
 * - `over_package_limit`: including the bytes would pass the package's size or file allowance.
 * - `credential_shaped_text`: the bytes contain text in the shape of a credential and were left out.
 */
export const RESULT_PACKAGE_OMISSION_REASONS = Object.freeze([
  'bytes_not_captured',
  'input_unavailable',
  'input_deleted',
  'preserved_bytes_unreadable',
  'over_package_limit',
  'credential_shaped_text',
])

/** What no package contains, by design, and why. Declared in every manifest so an absence is a statement. */
export const RESULT_PACKAGE_EXCLUSIONS = Object.freeze([
  Object.freeze({ kind: 'credentials', reason: 'never_collected' }),
  Object.freeze({ kind: 'patient_level_data', reason: 'data_plane_never_read' }),
  Object.freeze({ kind: 'workspace_files', reason: 'only_the_selected_version_and_its_recorded_dependencies' }),
  Object.freeze({ kind: 'conversation', reason: 'prompts_and_transcripts_are_not_part_of_a_result' }),
  Object.freeze({ kind: 'researcher_instructions', reason: 'a_correction_keeps_the_digest_of_the_words' }),
  Object.freeze({ kind: 'engine_code', reason: 'identified_by_digest_not_distributed' }),
])

/** The bytes of one object a credential check reads, at most. A larger text is declared `too_large` and not read. */
export const RESULT_PACKAGE_SCAN_LIMIT_BYTES = 8 * 1024 * 1024

/** The methods whose engine is the R service; every other admitted method is the Python adapter's. */
const R_ENGINE_METHODS = Object.freeze(['design.analytic', 'comparator.evalue'])

/**
 * The variable the Python adapter reads each method's engine root from (`METHODS` in
 * `deploy/specialist-adapter/evimed_specialist_adapter/deterministic_replay.py`), so the steps can name it. A test reads
 * the adapter's own table and holds the two equal.
 */
const PYTHON_ENGINE_ROOTS = Object.freeze({
  'meta.dl': 'EVIMED_REPLAY_META_ROOT',
  'faers.signals': 'EVIMED_REPLAY_SAFETY_ROOT',
  'bibliometric.network': 'EVIMED_REPLAY_BIBLIOMETRIC_ROOT',
})
const PYTHON_ENGINE_SOURCE = 'deploy/specialist-adapter/evimed_specialist_adapter/deterministic_replay.py'
const R_ENGINE_SOURCE = '项目代码/vcr-engine/README.md'

/** Bounds on the records, so a record always fits its allowance beside the files. */
const RECORD_LIMITS = Object.freeze({ replays: 10, replayValues: 500, findings: 200, corrections: 10, message: 600 })

// ---------------------------------------------------------------------------------------------------------------
// The credential check

const PLACEHOLDER = /(?:example|fake|placeholder|redacted|replace|test-only|your[-_ ]?(?:key|token)|xxxx|\*{4})/i
/** Formats a credential has regardless of the name it is assigned to. Linear patterns, no nested repetition. */
const CREDENTIAL_FORMATS = Object.freeze([
  /\b(?:sk|tvly|rk|pk)-[A-Za-z0-9_-]{20,}/,
  /\b(?:LTAI|AKIA|ASIA)[A-Za-z0-9]{12,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
])
/** A URL that carries a user and a password. */
const URL_PASSWORD = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|https?|ftp):\/\/[^\s:/@]+:([^\s@/]{3,})@/gi
/** A secret-named key assigned a quoted literal. A value read from the environment is not a literal and does not match. */
const NAMED_SECRET = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|token)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi

/**
 * Whether a text contains something in the shape of a credential: a provider key, a cloud access key, a token of a
 * known family, a private-key block, a JSON web token, a URL with an embedded password, or a secret-named key assigned
 * a literal that is not a placeholder. Never returns or logs what it matched.
 *
 * A format check, so it belongs in code (principle 5): it does not read language, and it is deliberately narrower than
 * `hasSensitiveText`, which over-matches ordinary words and would withhold most scripts.
 * @param {string} text
 * @returns {boolean}
 */
export function credentialShapedText(text) {
  const source = String(text ?? '')
  for (const format of CREDENTIAL_FORMATS) if (format.test(source)) return true
  for (const pattern of [URL_PASSWORD, NAMED_SECRET]) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) if (!PLACEHOLDER.test(match[1]) && !match[1].includes('${')) return true
  }
  return false
}

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|x-ndjson|x-yaml|yaml|javascript|x-sh|sql|toml)\b|[a-z]+\/[a-z0-9.+-]*\+(?:json|xml)$)/
const TEXT_EXTENSIONS = new Set([
  '.csv', '.tsv', '.txt', '.md', '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.xml', '.toml', '.ini', '.cfg', '.conf',
  '.env', '.html', '.htm', '.svg', '.tex', '.bib', '.log', '.rmd', '.qmd',
])

/** Whether a version's bytes are read for credentials as text, by its type and file extension. @param {string} path @param {string} mimeType */
function readsAsText(path, mimeType) {
  if (TEXT_MIME.test(String(mimeType ?? ''))) return true
  const dot = path.lastIndexOf('.')
  return isCodePath(path) || (dot > 0 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase()))
}

/**
 * What the credential check found in one object's bytes: `clean` (read, nothing in a credential's shape),
 * `credential_shaped` (read, and the object is left out), `not_text` (a binary type, not read) or `too_large` (text
 * past the scan limit, not read). Only `clean` is a statement that something was checked.
 * @param {{ path: string, mimeType: string, bytes: Uint8Array }} object
 * @returns {'clean' | 'credential_shaped' | 'not_text' | 'too_large'}
 */
export function packageCredentialScan({ path, mimeType, bytes }) {
  if (!readsAsText(path, mimeType)) return 'not_text'
  if (bytes.length > RESULT_PACKAGE_SCAN_LIMIT_BYTES) return 'too_large'
  return credentialShapedText(new TextDecoder('utf-8').decode(bytes)) ? 'credential_shaped' : 'clean'
}

// ---------------------------------------------------------------------------------------------------------------
// Omissions and completeness

/**
 * The reason a dependency's bytes are not in the package, from what the ledger said about it.
 * @param {{ availability?: string | null, status?: number | null, code?: string | null }} what
 *   `availability`: the reference's own state; `status`/`code`: how reading the preserved version failed, when it did.
 * @returns {string}
 */
export function omissionReason({ availability = null, status = null, code = null } = {}) {
  if (availability === 'deleted') return 'input_deleted'
  if (availability === 'restricted' || status === 403 || code === 'result_input_restricted') return 'input_unavailable'
  if (status === 404 && code !== 'result_snapshot_unavailable') return 'input_unavailable'
  if (code === 'result_snapshot_unavailable' || code === 'result_snapshot_changed' || code === 'result_snapshot_invalid') return 'preserved_bytes_unreadable'
  return 'bytes_not_captured'
}

/**
 * The completeness a manifest declares: `captured` only when nothing was left out and the selected version has no
 * coverage gap. The verifier derives it the same way and flags a manifest that says otherwise.
 * @param {{ omissions: readonly unknown[], gaps: readonly unknown[] }} input
 * @returns {'captured' | 'partial'}
 */
export function packageCompleteness({ omissions, gaps }) {
  return omissions.length || gaps.length ? 'partial' : 'captured'
}

// ---------------------------------------------------------------------------------------------------------------
// The three records

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** @param {unknown} value @param {number} max */
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)

/**
 * How one reference of a version stands in the package, as its accounting says.
 * @typedef {{ archivePathFor: (versionId: string) => string | null, reasonFor: (requiredBy: string, role: string, reference: any) => string | null }} Accounting
 */

/** @param {any} reference @param {string} role @param {string} requiredBy @param {Accounting} accounting */
function accountedReference(reference, role, requiredBy, accounting) {
  const archivePath = reference.versionId ? accounting.archivePathFor(reference.versionId) : null
  return {
    role, kind: reference.kind, id: reference.id, digest: reference.digest ?? null, versionId: reference.versionId ?? null,
    state: archivePath ? 'included' : 'referenced', archivePath,
    reason: archivePath ? null : accounting.reasonFor(requiredBy, role, reference) ?? 'bytes_not_captured',
  }
}

/**
 * What produced a version and what it ran on, from its recorded snapshot: the method, the script and its digest, the
 * environment facts as reported, each input and whether its bytes are in the package, and the closed list of what the
 * platform did not observe. Read from the projected version, which is a closed schema, so a command line, an
 * environment variable or a path outside the workspace has no field here.
 * @param {any} version @param {Accounting} accounting
 */
export function executionRecord(version, accounting) {
  const snapshot = version.snapshot ?? {}
  const script = isRecord(snapshot.script) ? snapshot.script : null
  const code = isRecord(version.code) ? version.code : null
  const environment = isRecord(snapshot.environment) ? snapshot.environment : { status: 'unknown', digest: null, facts: null }
  const requiredBy = version.versionId
  return {
    versionId: version.versionId,
    digest: version.digest,
    bytes: version.size,
    path: version.path,
    producerKind: version.producer?.kind ?? 'workspace',
    snapshot: { kind: snapshot.kind ?? 'unobserved', origin: snapshot.origin ?? 'unknown', reproduction: snapshot.reproduction ?? 'not_applicable',
      unknown: Array.isArray(snapshot.unknown) ? snapshot.unknown : [], recorded: snapshot.recorded !== false },
    // The method record (id, version, digest, seeding) the calculation ran, and the method identity the snapshot read.
    method: version.method ?? null,
    methodIdentity: isRecord(snapshot.method) ? snapshot.method : null,
    script: script ? {
      path: script.path ?? null, digest: script.digest ?? null, bytes: script.bytes ?? null, executed: script.executed === true, verified: script.verified === true,
      files: Array.isArray(script.files) ? script.files : null,
      file: code?.versionId ? accountedReference(code, 'code', requiredBy, accounting) : null,
    } : null,
    code: code ? accountedReference(code, 'code', requiredBy, accounting) : null,
    environment: {
      status: environment.status ?? 'unknown', digest: environment.digest ?? null, facts: environment.facts ?? null,
      ...(environment.truncated ? { truncated: true } : {}),
      reference: isRecord(version.environment) ? accountedReference(version.environment, 'environment', requiredBy, accounting) : null,
    },
    inputs: (Array.isArray(version.inputs) ? version.inputs : []).map((/** @type {any} */ input) => accountedReference(input, 'input', requiredBy, accounting)),
    transformations: Array.isArray(snapshot.transformations) ? snapshot.transformations : [],
    process: snapshot.process ?? null,
  }
}

/** @param {any} value */
const versionSide = (value) => ({ versionId: value?.versionId ?? null, digest: value?.digest ?? null, path: value?.path ?? null })

/**
 * One recorded correction as a package carries it: the pair of immutable versions, what differs between them (a closed
 * reading of their bytes) and who said what. The researcher's words and the selected text stay out: the digest of the
 * words is kept, so two instructions can still be told apart.
 * @param {any} item one element of the correction read (`ResultCorrectionService.read`)
 */
export function packageCorrection(item) {
  const record = item?.correction ?? {}
  return {
    role: item?.role ?? null, occurredAt: item?.occurredAt ?? null,
    original: versionSide(record.original), successor: versionSide(record.successor),
    kind: record.kind ?? 'unknown', effects: record.effects ?? null,
    anchor: { kind: record.anchor?.kind ?? null, elementId: record.anchor?.elementId ?? null },
    instructionDigest: record.instructionDigest ?? null,
    instructionOrigin: record.instructionOrigin ?? 'researcher', successorOrigin: record.successorOrigin ?? 'system_generated', adoption: record.adoption ?? 'not_recorded',
    outcome: item?.outcome ? { status: item.outcome.status ?? null, successorVersionId: item.outcome.successorVersionId ?? null } : null,
  }
}

/**
 * One re-run of a calculation as a package carries it: what it compared (bytes, numbers under the original's declared
 * tolerances, the environment it ran on) and how it ended. A re-run is not a verdict on the science.
 * @param {any} replay a replay status (`ResultReplayService.listFor`)
 */
export function packageReplay(replay) {
  const comparison = replay?.comparison ?? null
  const values = Array.isArray(comparison?.numbers?.values) ? comparison.numbers.values : []
  return {
    id: replay?.id ?? null, state: replay?.state ?? 'unknown', createdAt: replay?.createdAt ?? null,
    outputVersionId: replay?.outputVersionId ?? null, outputDigest: replay?.outputDigest ?? null,
    partial: replay?.partial === true, cleanup: replay?.cleanup ?? null, errorCode: replay?.error?.code ?? null,
    comparison: comparison ? {
      bytes: comparison.bytes ?? null,
      numbers: { status: comparison.numbers?.status ?? 'not-assessed', values: values.slice(0, RECORD_LIMITS.replayValues),
        ...(values.length > RECORD_LIMITS.replayValues ? { truncated: values.length - RECORD_LIMITS.replayValues } : {}) },
      environment: comparison.environment ?? null,
      scientificApplicability: 'not_assessed',
    } : null,
  }
}

/**
 * What has been checked about one version, and what has not. Findings keep their message and status but not their
 * source references (the version in the manifest carries those); the replays and corrections are the records of this
 * version's re-runs and revisions. A part that was not read is `unavailable` with its reason, and a part that has no
 * record is `none_recorded`: neither reads as clean.
 * @param {any} version
 * @param {{ replays?: { status: string, items?: any[], reason?: string } | null, corrections?: { status: string, items?: any[], reason?: string } | null }} read
 */
export function verificationRecord(version, { replays = null, corrections = null } = {}) {
  const findings = (Array.isArray(version.findings) ? version.findings : []).slice(0, RECORD_LIMITS.findings)
  const review = version.review ?? { status: 'unknown' }
  const bindings = version.bindings ?? null
  /** @param {{ status: string, items?: any[], reason?: string } | null} read @param {(item: any) => any} project @param {number} limit */
  const part = (read, project, limit) => {
    if (!read) return { status: 'unavailable', reason: 'not_read', items: [] }
    if (read.status !== 'recorded') return { status: 'unavailable', reason: read.reason ?? 'not_read', items: [] }
    const all = read.items ?? []
    const items = all.slice(0, limit).map(project)
    return { status: items.length ? 'recorded' : 'none_recorded', items, ...(all.length > limit ? { truncated: all.length - limit } : {}) }
  }
  return {
    versionId: version.versionId,
    digest: version.digest,
    coverage: version.coverage ?? null,
    findings: findings.map((/** @type {any} */ finding) => ({ id: finding.id ?? null, kind: finding.kind ?? null, status: finding.status ?? null,
      message: clip(finding.message, RECORD_LIMITS.message), elementId: finding.elementId ?? null })),
    review: { status: review.status ?? 'unknown', matrixVersionId: review.matrixVersionId ?? null, matrixDigest: review.matrixDigest ?? null,
      claims: review.verification?.counts ?? null },
    bindings: bindings ? { status: bindings.status ?? 'not_checked', counts: bindings.counts ?? null } : { status: 'not_checked', counts: null },
    replays: part(replays, packageReplay, RECORD_LIMITS.replays),
    corrections: part(corrections, packageCorrection, RECORD_LIMITS.corrections),
    scientificApplicability: 'not_assessed',
  }
}

/** The steps by basis. Prose a researcher follows; nothing the platform or the verifier runs. */
const REPRODUCTION_STEPS = Object.freeze({
  engine_recipe: Object.freeze([
    'Obtain the engine named under `engine` from the EviMed source repository (`engineSource`) at the code whose file digests are listed under `executionFiles` (paths are relative to the engine root, which the Python adapter reads from `engineRootVariable`; `adapter/deterministic_replay.py` is the adapter itself), and install the packages listed under `environment.packages` at those versions.',
    'Write `recipe` unchanged to recipe.json (its digest covers `recipe.input.path`) and the file named under `inputs` (its sha256 is recorded; verify.py has checked it) to any path, then run `invocation` with that path. The R engine is a service: its own README describes how a job is submitted.',
    'The engine refuses a recipe whose code or environment digest is not its own (replay_code_changed, replay_environment_incompatible). That refusal is the answer: the environment is not the recorded one, and the numbers it would give are not a reproduction.',
    'Take the machine values the engine wrote (a list of {key, value, unit}) to a file and run `python3 verify.py --compare <file>`. It compares each key under the tolerance the original declared, never one taken from your run.',
  ]),
  script_rerun: Object.freeze([
    'Recreate the interpreter and the packages listed under `environment` (`requirements` holds the Python ones as a pip listing). The image the script ran on, when recorded, is `environment.imageId`.',
    'Place each file under `inputs` at its recorded path and the script at its recorded path. The arguments the script was run with were not recorded, and anything it read that no record lists is unknown: both are named under `reasons`.',
    'Run the script yourself, in an environment you control; nothing in this package runs it. Take the numbers it writes to a file and run `python3 verify.py --compare <file>`.',
    'The original declared no tolerance for a script result, so only equal numbers count as the same; a difference is reported as a difference.',
  ]),
})

/** @param {any} snapshot @param {string | null} methodId */
function pythonEnvironment(snapshot, methodId) {
  const facts = snapshot?.environment?.facts
  return methodId === 'python' || /^Python\b/.test(String(facts?.interpreter ?? ''))
}

/**
 * How a supported calculation is reconstructed and checked, or `null` for a version that is not a calculation this
 * package can say anything reproducible about. An engine recipe is a method, its parameters, the input's digest and the
 * engine and environment identities: the one basis a re-run is promised from. A script's record is partial by its own
 * account (its arguments are not recorded and its other reads are unknown). The expected numbers carry the original's
 * declared tolerances, which are the only ones a comparison uses.
 *
 * @param {any} version
 * @param {{ recipe?: any, archivePathFor: (versionId: string) => string | null }} basis
 *   `recipe`: the frozen replay recipe of this version (`ResultReplayService.recipe`), when it has one.
 */
export function reproductionRecord(version, { recipe = null, archivePathFor }) {
  const values = (Array.isArray(version.machineValues) ? version.machineValues : [])
    .filter((/** @type {any} */ value) => typeof value?.key === 'string' && Number.isFinite(value?.value))
  if (!values.length) return null
  const snapshot = version.snapshot ?? {}
  const kept = values.slice(0, RESULT_LINEAGE_LIMITS.machineValues).map((/** @type {any} */ value) => ({
    key: value.key, value: value.value, unit: typeof value.unit === 'string' ? value.unit : null,
    absoluteTolerance: Number.isFinite(value.absoluteTolerance) ? value.absoluteTolerance : null,
    relativeTolerance: Number.isFinite(value.relativeTolerance) ? value.relativeTolerance : null,
  }))
  const expected = { source: 'frozen_original', values: kept, ...(values.length > kept.length ? { truncated: values.length - kept.length } : {}) }
  const inputs = (Array.isArray(version.inputs) ? version.inputs : []).map((/** @type {any} */ input) => ({
    kind: input.kind, id: input.id, path: input.path ?? null, digest: input.digest ?? null,
    archivePath: input.versionId ? archivePathFor(input.versionId) : null,
  }))
  const facts = snapshot.environment?.facts ?? null
  const environment = { digest: snapshot.environment?.digest ?? null, status: snapshot.environment?.status ?? 'unknown', ...(facts ?? {}) }
  /** @type {string[]} */
  const reasons = []
  if (values.length > kept.length) reasons.push('values_truncated')

  if (recipe?.recipe) {
    const frozen = recipe.recipe
    const input = inputs.find((/** @type {any} */ item) => item.digest === frozen.input?.sha256) ?? null
    if (!input?.archivePath) reasons.push('input_not_included')
    if (environment.status !== 'reported') reasons.push('environment_not_reported')
    const files = Array.isArray(snapshot.script?.files) ? snapshot.script.files : null
    return {
      versionId: version.versionId, digest: version.digest, basis: 'engine_recipe',
      status: reasons.length ? 'partial' : 'reconstructable', reasons,
      method: version.method ?? null,
      ...(R_ENGINE_METHODS.includes(frozen.method)
        ? { engine: 'vcr-engine (R service)', engineSource: R_ENGINE_SOURCE, invocation: null }
        : { engine: 'evimed_specialist_adapter.deterministic_replay (Python)', engineSource: PYTHON_ENGINE_SOURCE,
          engineRootVariable: /** @type {Record<string, string>} */ (PYTHON_ENGINE_ROOTS)[frozen.method] ?? null,
          invocation: 'python -m evimed_specialist_adapter.deterministic_replay --recipe recipe.json --input <the input file> --output output.json' }),
      recipe: { method: frozen.method, version: frozen.version ?? null, parameters: frozen.parameters ?? {},
        input: { path: frozen.input?.path ?? null, sha256: frozen.input?.sha256 ?? null },
        codeDigest: frozen.codeDigest ?? null, environmentDigest: frozen.environmentDigest ?? null },
      executionFiles: files,
      inputs: input ? [input] : [],
      environment, expected, steps: REPRODUCTION_STEPS.engine_recipe,
    }
  }

  if (snapshot.kind === 'skill_script' && snapshot.script) {
    const script = snapshot.script
    const scriptFile = version.code?.versionId ? archivePathFor(version.code.versionId) : null
    reasons.push('arguments_not_recorded')
    if (!scriptFile) reasons.push('script_not_included')
    if (!inputs.length || inputs.some((/** @type {any} */ input) => !input.archivePath)) reasons.push('inputs_not_included')
    if (Array.isArray(snapshot.unknown) && snapshot.unknown.includes('undeclared_dependencies')) reasons.push('undeclared_dependencies_unknown')
    if (script.executed !== true || script.verified !== true) reasons.push('execution_not_confirmed')
    return {
      versionId: version.versionId, digest: version.digest, basis: 'script_rerun', status: 'partial', reasons,
      method: version.method ?? null,
      script: { path: script.path ?? null, digest: script.digest ?? null, archivePath: scriptFile, interpreter: snapshot.method?.id ?? null },
      inputs, environment, expected, steps: REPRODUCTION_STEPS.script_rerun,
      ...(pythonEnvironment(snapshot, snapshot.method?.id ?? null) && facts?.packages ? { requirements: pinnedRequirements(facts.packages) } : {}),
    }
  }
  return null
}

/** A pip requirements listing of the Python packages a snapshot recorded, one `name==version` per line. @param {Record<string, string>} packages */
export function pinnedRequirements(packages) {
  return Object.entries(packages).sort(([left], [right]) => left.localeCompare(right)).map(([name, version]) => `${name}==${version}`).join('\n') + '\n'
}
