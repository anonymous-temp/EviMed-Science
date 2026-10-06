/**
 * NCBI Gene Expression Omnibus (GEO) series to differential expression: the vocabulary both sides read, and the
 * contract findings for the capability that delivers it (plan 2026-10-02 §11.3 N17).
 *
 * This is the public data resource at ncbi.nlm.nih.gov/geo. It has nothing to do with 「循证传播」 (the pharma
 * generative-engine-optimisation module: `geo*.mjs`, `geo_read`/`geo_write`, the `geo-*` capabilities), and every
 * name here is `gene-expression` / `gene_expression` / `ncbi_geo` so the two can never be mistaken for each other.
 *
 * Hidden knowledge:
 *
 * - **The computation is the platform's, not the model's.** `gene_expression_differential` runs a Welch t-test per
 *   probe on log2 values with Benjamini-Hochberg adjustment in a child process and writes results, a rendered table
 *   and a receipt as files. The model never types a statistic; the report takes numbers through
 *   `research_calculate` action=render from those files. It is **not limma** (no empirical-Bayes moderation), and
 *   every result says so (`GENE_EXPRESSION_NOT_LIMMA`).
 * - **Every finding here is advice.** A contract finding labels a package; it never withholds one (ruling of
 *   2026-09-17). A refused computation (a group of two, an over-limit series, a platform that does not match) is a
 *   refusal of that computation with its reason, and the rest of the research goes on.
 * - **Limits protect resources, not opinions** (principle 15). Six limits, each a key in the control plane's config
 *   (`OPEN_SCIENCE_GENE_EXPRESSION_*`) forwarded to the runtime as `EVIMED_GENE_EXPRESSION_*`, each with a counter
 *   on the operator's metrics. The defaults live here once; `runtime/mcp/evimed-research/gene_expression.py` holds
 *   the same numbers for a runtime started without them, and a test holds the two equal.
 *
 * Pure, browser-safe, no I/O.
 * @module @evimed/domain/geneExpression
 */

export const GENE_EXPRESSION_CAPABILITY_ID = 'gene-expression-analysis'
export const GENE_EXPRESSION_CONTRACT_KIND = 'gene-expression-analysis-package'
export const GENE_EXPRESSION_RESULTS_KIND = 'gene-expression-differential'
export const GENE_EXPRESSION_SCHEMA_VERSION = 1
export const GENE_EXPRESSION_METHOD_ID = 'welch-bh-log2'
/** Where the runtime preserves a GEO series: `<root>/<GSE>-<GPL>/<content hash>/`. */
export const GENE_EXPRESSION_SOURCES_ROOT = '.evimed-sources/gene-expression'

/** The files one analysis writes into its output directory, by role. */
export const GENE_EXPRESSION_RESULT_FILES = Object.freeze({
  results: 'gene-expression-results.json',
  table: 'gene-expression-de-table.tsv',
  topTable: 'gene-expression-top-table.md',
  analysedMatrix: 'gene-expression-analysed-matrix.tsv.gz',
  request: 'gene-expression-request.json',
  code: 'gene_expression.py',
  receipt: 'gene-expression-receipt.json',
})
/** The report a package delivers beside them. */
export const GENE_EXPRESSION_REPORT_FILE = 'gene-expression-report.md'

/** What every result says about the method, once, here (the engine writes the same words). */
export const GENE_EXPRESSION_NOT_LIMMA =
  'This is not limma. It runs a Welch t-test per probe on log2 values with Benjamini-Hochberg adjustment and does no empirical-Bayes moderation of the variances, so with small groups the per-probe variances are less stable and the top table can differ from a limma analysis of the same series, in order as well as in p-values.'

/** @type {Readonly<Record<string, RegExp>>} */
export const GENE_EXPRESSION_ACCESSIONS = Object.freeze({
  series: /^GSE[1-9][0-9]{0,8}$/,
  platform: /^GPL[1-9][0-9]{0,8}$/,
  sample: /^GSM[1-9][0-9]{0,9}$/,
})

/** The six limits, by the name a counter and a refusal carry. */
export const GENE_EXPRESSION_LIMIT_NAMES = Object.freeze(['matrix_bytes', 'annotation_bytes', 'samples', 'probes', 'memory', 'wall_clock'])

/**
 * Defaults and bounds of the six limits. `configKey` is the key in `config.mjs`, `env` the name without its
 * `OPEN_SCIENCE_` (control plane) or `EVIMED_` (runtime) prefix. `max` is the largest value an operator may
 * set; a deployment that needs more says so by changing it here, in review.
 */
export const GENE_EXPRESSION_LIMITS = Object.freeze({
  matrixBytes: Object.freeze({ configKey: 'geneExpressionMaxMatrixBytes', limit: 'matrix_bytes', env: 'GENE_EXPRESSION_MAX_MATRIX_BYTES', unit: 'bytes', default: 64 * 1024 * 1024, min: 1024 * 1024, max: 512 * 1024 * 1024 }),
  annotationBytes: Object.freeze({ configKey: 'geneExpressionMaxAnnotationBytes', limit: 'annotation_bytes', env: 'GENE_EXPRESSION_MAX_ANNOTATION_BYTES', unit: 'bytes', default: 128 * 1024 * 1024, min: 1024 * 1024, max: 1024 * 1024 * 1024 }),
  samples: Object.freeze({ configKey: 'geneExpressionMaxSamples', limit: 'samples', env: 'GENE_EXPRESSION_MAX_SAMPLES', unit: 'samples', default: 200, min: 6, max: 2000 }),
  probes: Object.freeze({ configKey: 'geneExpressionMaxProbes', limit: 'probes', env: 'GENE_EXPRESSION_MAX_PROBES', unit: 'probes', default: 100_000, min: 1000, max: 1_000_000 }),
  memoryBytes: Object.freeze({ configKey: 'geneExpressionMaxMemoryBytes', limit: 'memory', env: 'GENE_EXPRESSION_MAX_MEMORY_BYTES', unit: 'bytes', default: 2 * 1024 * 1024 * 1024, min: 128 * 1024 * 1024, max: 16 * 1024 * 1024 * 1024 }),
  wallClockSeconds: Object.freeze({ configKey: 'geneExpressionMaxWallClockSeconds', limit: 'wall_clock', env: 'GENE_EXPRESSION_MAX_WALL_CLOCK_SECONDS', unit: 'seconds', default: 120, min: 10, max: 900 }),
})

/** What a limit counter may be incremented for, and by whom the observation was made. */
export const GENE_EXPRESSION_LIMIT_ACTIONS = Object.freeze(['refused'])

/**
 * The tool's own refusals. `RUN_FIXES` are the ones a run repairs by changing what it sent; the rest say this one
 * computation or retrieval could not be done, and the researcher's other work goes on.
 */
export const GENE_EXPRESSION_RUN_FIX_ERROR_CODES = Object.freeze([
  'gene_expression_input_invalid',
  'gene_expression_groups_invalid',
  'gene_expression_output_exists',
  'gene_expression_capture_invalid',
  'public_source_gene_expression_capture_failed',
])
export const GENE_EXPRESSION_LIMITATION_ERROR_CODES = Object.freeze([
  'gene_expression_input_over_limit',
  'gene_expression_identity_mismatch',
  'gene_expression_matrix_empty',
  'gene_expression_matrix_unreadable',
  'gene_expression_platform_unreadable',
  'gene_expression_engine_unavailable',
])
export const GENE_EXPRESSION_ERROR_CODES = Object.freeze([...GENE_EXPRESSION_RUN_FIX_ERROR_CODES, ...GENE_EXPRESSION_LIMITATION_ERROR_CODES])
export const GENE_EXPRESSION_ERROR_MESSAGE_ZH = '基因表达数据（NCBI GEO）这次没能完成这一步；报告会写明这一步没有做，其余的研究照常继续。'
/** The sentence for an input over a limit, which says what to do about it. */
export const GENE_EXPRESSION_LIMIT_MESSAGE_ZH = '这份基因表达数据超过了一次计算的资源上限（样本数、探针数、文件大小、内存或时间之一），这次计算没有做；可以换一份更小的数据集。'

/** @param {unknown} value @returns {value is Record<string, any>} */
const record = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value */
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
/** @param {unknown} value */
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
/** @param {unknown} value */
const fingerprint = (value) => record(value) && typeof value.path === 'string' && value.path.length > 0 && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)

export const GENE_EXPRESSION_CHECK_IDS = Object.freeze([
  'gene-expression-results-shape',
  'gene-expression-method-statement',
  'gene-expression-design',
  'gene-expression-execution-provenance',
])

/**
 * Advisory findings over a gene-expression package: what a reader or a replay needs in the machine results, said as
 * notices. Absent files and failed computations never invalidate completed work. The report's prose is not read here
 * (principle 5: no prose patterns); its numbers are bound to the results by the platform's render and value bindings.
 * @param {{files: Map<string, string>, packagePath?: string}} input
 * @returns {{issues: import('./contractRegistry.mjs').GateIssue[], metrics: Record<string, unknown>}}
 */
export function geneExpressionFindings(input) {
  /** @type {import('./contractRegistry.mjs').GateIssue[]} */
  const issues = []
  const metrics = { geneExpressionProbesTested: 0, geneExpressionTopRows: 0, geneExpressionExecutions: 0 }
  /** @param {import('./contractRegistry.mjs').GateIssue[]} target @param {string} check @param {string} path @param {string} message */
  const notice = (target, check, path, message) => {
    if (target.some((item) => item.check === check && item.path === path && item.message === message)) return
    target.push({ code: 'gene_expression_notice', severity: 'advisory', check, path, message })
  }
  /** @param {string} path @param {string} check @returns {any} */
  const read = (path, check) => {
    if (!input.files.has(path)) return null
    try { return JSON.parse(input.files.get(path) ?? '') } catch { notice(issues, check, path, `${path} cannot be read as JSON; retain the readable results.`); return undefined }
  }
  const resultsPath = GENE_EXPRESSION_RESULT_FILES.results
  const receiptPath = GENE_EXPRESSION_RESULT_FILES.receipt
  const results = read(resultsPath, 'gene-expression-results-shape')
  if (results && !record(results)) {
    notice(issues, 'gene-expression-results-shape', resultsPath, 'The results are not a JSON object.')
  } else if (results) {
    if (results.schemaVersion !== GENE_EXPRESSION_SCHEMA_VERSION || results.kind !== GENE_EXPRESSION_RESULTS_KIND) {
      notice(issues, 'gene-expression-results-shape', resultsPath, `The results should carry schemaVersion ${GENE_EXPRESSION_SCHEMA_VERSION} and kind ${GENE_EXPRESSION_RESULTS_KIND}.`)
    }
    const method = record(results.method) ? results.method : {}
    if (method.isLimma !== false || typeof method.statement !== 'string' || !method.statement.trim()) {
      notice(issues, 'gene-expression-method-statement', resultsPath, 'The results should state the method and that it is not limma (method.isLimma false and method.statement), so a reader knows what the p-values are.')
    }
    const series = record(results.series) ? results.series : {}
    if (typeof series.accession !== 'string' || !GENE_EXPRESSION_ACCESSIONS.series.test(series.accession) || typeof series.platform !== 'string' || !GENE_EXPRESSION_ACCESSIONS.platform.test(series.platform)) {
      notice(issues, 'gene-expression-design', resultsPath, 'The results should name one GEO series accession and the one platform accession it was computed on.')
    }
    const groups = record(results.design) && Array.isArray(results.design.groups) ? results.design.groups : []
    if (groups.length !== 2 || groups.some((/** @type {unknown} */ group) => !record(group) || !Array.isArray(group.samples) || group.samples.length < 3 || group.n !== group.samples.length)) {
      notice(issues, 'gene-expression-design', resultsPath, 'The design should declare two groups of at least three samples each, with their sample accessions.')
    } else {
      const seen = new Set(groups[0].samples)
      if (groups[1].samples.some((/** @type {string} */ sample) => seen.has(sample))) notice(issues, 'gene-expression-design', resultsPath, 'The two groups share a sample.')
    }
    const transformation = record(results.transformation) ? results.transformation : {}
    if (!['log2', 'none'].includes(String(transformation.applied)) || !record(transformation.distribution)) {
      notice(issues, 'gene-expression-results-shape', resultsPath, 'The results should state the transformation applied (log2 or none) and the distribution check behind it.')
    }
    const identity = record(results.identity) ? results.identity : {}
    if (Object.values(identity).some((entry) => record(entry) && entry.status === 'mismatch')) {
      notice(issues, 'gene-expression-design', resultsPath, 'An identity check (samples, platform, organism) is recorded as a mismatch, yet results exist; read them as unverified.')
    }
    const diagnostics = record(results.diagnostics) ? results.diagnostics : {}
    if (!finite(diagnostics.probesTested) || !record(diagnostics.groupSizes)) {
      notice(issues, 'gene-expression-results-shape', resultsPath, 'The results should carry diagnostics: probes tested and group sizes.')
    } else {
      metrics.geneExpressionProbesTested = diagnostics.probesTested
    }
    const top = Array.isArray(results.top) ? results.top : []
    metrics.geneExpressionTopRows = top.length
    for (const row of top) {
      const label = record(row) && typeof row.probe === 'string' ? row.probe : 'a top-table row'
      if (!record(row) || !finite(row.logFC) || !finite(row.pValue) || !finite(row.adjPValue)) {
        notice(issues, 'gene-expression-results-shape', resultsPath, `${label}: logFC, pValue and adjPValue should be finite numbers.`)
        continue
      }
      if (row.pValue < 0 || row.pValue > 1 || row.adjPValue < row.pValue - 1e-12 || row.adjPValue > 1) {
        notice(issues, 'gene-expression-results-shape', resultsPath, `${label}: a Benjamini-Hochberg adjusted p-value lies between the raw p-value and 1.`)
      }
      if (finite(row.ciLow) && finite(row.ciHigh) && row.ciLow > row.ciHigh) notice(issues, 'gene-expression-results-shape', resultsPath, `${label}: the interval's lower bound exceeds its upper bound.`)
    }
  }
  /** @param {string} path */
  const inPackage = (path) => {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return false
    if (input.files.has(path)) return true
    const root = input.packagePath
    return typeof root === 'string' && root.length > 0 && path.startsWith(`${root}/`) && input.files.has(path.slice(root.length + 1))
  }
  const receipt = read(receiptPath, 'gene-expression-execution-provenance')
  if (input.files.has(receiptPath) && receipt !== undefined) {
    if (!record(receipt) || !Array.isArray(receipt.executions) || !receipt.executions.length) {
      notice(issues, 'gene-expression-execution-provenance', receiptPath, 'The receipt has no execution records.')
    } else {
      metrics.geneExpressionExecutions = receipt.executions.length
      for (const execution of receipt.executions) {
        if (!record(execution)) { notice(issues, 'gene-expression-execution-provenance', receiptPath, 'An execution record is not an object.'); continue }
        if (!fingerprint(execution.script) || !Array.isArray(execution.inputs) || !execution.inputs.length || execution.inputs.some((/** @type {unknown} */ entry) => !fingerprint(entry))) {
          notice(issues, 'gene-expression-execution-provenance', receiptPath, 'An execution lacks real script and input SHA-256 fingerprints and paths.')
        }
        if (record(execution.script) && typeof execution.script.path === 'string' && !inPackage(execution.script.path)) {
          notice(issues, 'gene-expression-execution-provenance', receiptPath, `The linked script ${execution.script.path} is not included in the package.`)
        }
        if (!record(execution.versions) || typeof execution.versions.interpreter !== 'string' || !record(execution.versions.libraries) || !Number.isInteger(execution.exitCode) || !timestamp(execution.startedAt) || !timestamp(execution.endedAt)) {
          notice(issues, 'gene-expression-execution-provenance', receiptPath, 'An execution lacks observed versions, timestamps or an exit status.')
        }
        if (execution.exitCode !== 0 || !record(execution.output) || execution.output.observedWrite !== true || !record(execution.output.after) || execution.output.after.path === undefined) {
          notice(issues, 'gene-expression-execution-provenance', receiptPath, 'This attempt failed or did not observe a results write; earlier valid results remain available.')
        }
      }
    }
  }
  if (input.files.has(GENE_EXPRESSION_REPORT_FILE) && !input.files.has(resultsPath)) {
    notice(issues, 'gene-expression-results-shape', resultsPath, `The report has no machine results beside it (${resultsPath}), so its numbers cannot be traced to a computation; the analysis tool writes them.`)
  }
  return { issues, metrics }
}
