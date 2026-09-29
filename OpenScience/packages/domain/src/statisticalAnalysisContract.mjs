/** Mechanical, advisory checks for native statistical output. No method registry. */

/** @param {unknown} value @returns {value is Record<string, any>} */
const record = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value */
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
/** @param {unknown} value */
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
/** @param {unknown} value */
const fingerprint = (value) => record(value) && typeof value.path === 'string' && value.path.length > 0 && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)

/**
 * Absent outputs and failed calculations cannot invalidate completed work.
 * Hash shapes are checked here; the execution helper hashes the actual bytes.
 * @param {{files: Map<string, string>}} input
 * @returns {{issues: import('./contractRegistry.mjs').GateIssue[], metrics: Record<string, unknown>}}
 */
export function statisticalAnalysisFindings(input) {
  /** @type {import('./contractRegistry.mjs').GateIssue[]} */
  const issues = []
  const metrics = { statisticalComplete: 0, statisticalPartial: 0, statisticalUnsupported: 0, statisticalExecutions: 0 }
  /** @param {import('./contractRegistry.mjs').GateIssue[]} target @param {string} check @param {string} path @param {string} message */
  const notice = (target, check, path, message) => target.push({ code: 'statistical_analysis_notice', severity: 'advisory', check, path, message })
  /** @param {string} path @param {string} check @returns {any} */
  const read = (path, check) => {
    if (!input.files.has(path)) return null
    try { return JSON.parse(input.files.get(path) ?? '') }
    catch { notice(issues, check, path, `${path} cannot be read as JSON; retain the readable results.`); return undefined }
  }
  const shape = 'statistical-results-shape'
  const provenance = 'statistical-execution-provenance'
  const resultPath = 'analysis-results.json'
  const receiptPath = 'analysis-run.json'
  const results = read(resultPath, shape)
  if (input.files.has(resultPath) && (!record(results) || !Array.isArray(results.analyses) || !results.analyses.length)) {
    if (results !== undefined) notice(issues, 'statistical-results-shape', resultPath, 'Results should carry a nonempty analyses array; preserve other artifacts.')
  } else if (results) {
    for (const analysis of results.analyses) {
      if (!record(analysis)) { notice(issues, 'statistical-results-shape', resultPath, 'An analysis entry is not an object.'); continue }
      const id = typeof analysis.id === 'string' ? analysis.id : 'unnamed'
      if (analysis.id != null && typeof analysis.id !== 'string') notice(issues, 'statistical-results-shape', resultPath, 'An analysis id must be a string when provided.')
      if (analysis.status === 'complete') metrics.statisticalComplete += 1
      else if (analysis.status === 'unsupported') metrics.statisticalUnsupported += 1
      else metrics.statisticalPartial += 1
      if (analysis.status === 'complete' && Object.hasOwn(analysis, 'estimate') && !finite(analysis.estimate)) {
        notice(issues, 'statistical-finite-results', resultPath, `${id}: the complete estimate is not finite; describe the affected calculation as unavailable.`)
      }
      if (record(analysis.interval) && ['lower', 'upper'].some((bound) => Object.hasOwn(analysis.interval, bound) && !finite(analysis.interval[bound]))) {
        notice(issues, 'statistical-finite-results', resultPath, `${id}: a provided interval bound is not a finite number; retain the valid estimate and explain the unavailable bound.`)
      }
      if (record(analysis.interval) && finite(analysis.interval.lower) && finite(analysis.interval.upper) && analysis.interval.lower > analysis.interval.upper) {
        notice(issues, 'statistical-results-shape', resultPath, `${id}: interval lower bound exceeds its upper bound.`)
      }
      if (analysis.pValue != null && (!finite(analysis.pValue) || analysis.pValue < 0 || analysis.pValue > 1)) {
        notice(issues, 'statistical-results-shape', resultPath, `${id}: pValue is outside the finite range [0, 1].`)
      }
      const counts = record(analysis.n) ? Object.values(analysis.n) : analysis.n == null ? [] : [analysis.n]
      if (counts.some((n) => !finite(n) || n < 0)) notice(issues, 'statistical-results-shape', resultPath, `${id}: sample counts must be nonnegative finite numbers.`)
    }
  }
  const receipt = read(receiptPath, provenance)
  if (input.files.has(receiptPath) && receipt !== undefined) {
    if (!record(receipt) || !Array.isArray(receipt.executions) || !receipt.executions.length) {
      notice(issues, 'statistical-execution-provenance', receiptPath, 'The receipt has no execution records.')
    } else {
      metrics.statisticalExecutions = receipt.executions.length
      for (const execution of receipt.executions) {
        if (!record(execution)) { notice(issues, 'statistical-execution-provenance', receiptPath, 'An execution record is not an object.'); continue }
        if (!fingerprint(execution.script) || !Array.isArray(execution.inputs) || !execution.inputs.length || execution.inputs.some((entry) => !fingerprint(entry))) {
          notice(issues, 'statistical-execution-provenance', receiptPath, 'An execution lacks real source/script SHA-256 fingerprints and paths.')
        }
        if (record(execution.script) && typeof execution.script.path === 'string' && !input.files.has(execution.script.path)) {
          notice(issues, 'statistical-execution-provenance', receiptPath, `The linked script ${execution.script.path} is not included in the package.`)
        }
        if (!Array.isArray(execution.argv) || !execution.argv.length || execution.argv.some((value) => typeof value !== 'string') || !record(execution.versions) || typeof execution.versions.interpreter !== 'string' || !execution.versions.interpreter || !record(execution.versions.libraries) || !Number.isInteger(execution.exitCode) || !timestamp(execution.startedAt) || !timestamp(execution.endedAt)) {
          notice(issues, 'statistical-execution-provenance', receiptPath, 'An execution lacks command, observed versions, timestamps or exit status.')
        }
        if (execution.sourcesUnchanged === false || execution.exitCode !== 0 || !record(execution.output) || execution.output.observedWrite !== true) {
          notice(issues, 'statistical-execution-provenance', receiptPath, 'This attempt failed, changed its sources, or did not observe a results write; earlier valid results remain available.')
        }
      }
    }
  }
  const missing = [resultPath, receiptPath].filter((path) => !input.files.has(path))
  if (missing.length && (input.files.has('statistical-report.md') || input.files.has(resultPath))) {
    notice(issues, 'statistical-execution-provenance', receiptPath, `Optional traceability is incomplete (${missing.join(', ')}); native execution and partial results remain deliverable.`)
  }
  return { issues, metrics }
}
