/** @param {unknown} value */
const text = (value) => value == null ? 'Not reported' : String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')

/** @param {any} value @param {string} prefix @param {[string, any][]} rows @returns {[string, any][]} */
function flatten(value, prefix = '', rows = []) {
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, rows)
  } else rows.push([prefix, value])
  return rows
}

/** Reader-facing summary of fields actually returned by the scientific engine. */
/** @param {Record<string, any>} result @param {Record<string, any> | null} request @returns {string} */
export function renderResearchReport(result, request) {
  const rows = Array.isArray(result.measures) ? result.measures : []
  const contributions = Object.values(result.diagnostics?.stageResults ?? {}).filter((/** @type {any} */ stage) => stage && typeof stage === 'object')
  const combined = contributions.length > 1
  const lines = ['# Research results', '', `${combined ? 'Requested method' : 'Method'}: ${text(result.method)} (version ${text(result.methodVersion)})`,
    `Conclusion: ${text(result.conclusion)}`, '', '## Measures', '', '| Measure | Value | Unit | Interval | MCSE |', '| --- | ---: | --- | --- | ---: |']
  if (!rows.length) lines.push('| No measures reported | — | — | — | — |')
  for (const measure of rows) {
    const interval = measure.interval ? `${text(measure.interval.kind)} ${text(measure.interval.low)} to ${text(measure.interval.high)}${measure.interval.level == null ? '' : ` (level ${text(measure.interval.level)})`}` : 'Not reported'
    lines.push(`| ${text(measure.name)} | ${text(measure.value)} | ${text(measure.unit)} | ${interval} | ${text(measure.mcse)} |`)
  }
  if (combined) {
    lines.push('', '## Contributing computations', '', 'This research record combines computations. They may use different scenarios or random seeds. The assumptions below describe the requested job; compare each value with its contributing computation in the associated reproduction JSON.', '',
      '| Stage | Method | Version | State |', '| --- | --- | --- | --- |')
    for (const stage of contributions) lines.push(`| ${text(stage.stage)} | ${text(stage.method)} | ${text(stage.methodVersion)} | ${stage.stale === true ? 'Carried forward; not rerun' : text(stage.conclusion)} |`)
  }
  const quality = result.diagnostics?.quality
  if (quality && typeof quality === 'object') {
    lines.push('', '## Population quality', '', 'A completed computation or an estimable result is not a quality pass.', '')
    const bands = quality.bands && typeof quality.bands === 'object' ? Object.entries(quality.bands) : []
    if (bands.some(([, band]) => band === 'red')) lines.push('Some quality measures exceed the reported reference ranges; this population has not passed all quality checks.', '')
    if (bands.length) {
      lines.push('| Quality check | Reported band |', '| --- | --- |')
      for (const [key, band] of bands) lines.push(`| ${text(key)} | ${text(band)} |`)
    }
    const global = quality.fidelity?.global
    if (global?.available === false || bands.some(([, band]) => band === 'unknown')) lines.push('', 'Unavailable or unknown checks were not passed. Some quality measures could not be computed under the data conditions or design size.', '')
    if (quality.disclosure?.available === false) lines.push('Disclosure-risk assessment is unavailable; no privacy guarantee is established.', '')
  }
  lines.push('', '## Assumptions and sources', '')
  if (request?.configurationStatus === 'withheld') lines.push('Record-selection configuration is withheld from this model-facing response. Use the authorized host research record; the job state and computed result are still shown.', '')
  else if (request?.configurationAvailable === false) lines.push('Some frozen configuration details are unavailable in this response; the recorded job state and result are still shown.', '')
  if (Number(request?.unavailableInputReferences) > 0) lines.push('Not all execution input references are included in this response. Consult the host research record for the complete inputs.', '')
  if (request?.job?.scenario) {
    const items = flatten(request.job.scenario)
    if (items.length) {
      lines.push('| Scenario field | Value |', '| --- | --- |')
      for (const [field, value] of items.slice(0, 100)) lines.push(`| ${text(field)} | ${text(value)} |`)
      if (items.length > 100) lines.push('| Additional fields | See associated reproduction JSON |')
    } else lines.push('The recorded scenario is empty.')
    /** @type {Record<string, any>[]} */
    const inputs = request.job.inputs || []
    lines.push('', `Recorded inputs: ${inputs.length ? inputs.map(input => `${text(input.kind)} ${text(input.id)}`).join('; ') : 'none reported'}.`)
    const bindings = Array.isArray(request.parameterProvenance?.bindings) ? request.parameterProvenance.bindings : []
    if (bindings.length) {
      lines.push('', 'The host checked these quotations against the original user message. The model asserted their parameter meaning; that interpretation remains an assumption.', '')
      for (const binding of bindings) lines.push(`- ${text(binding.path)} = ${text(binding.value)} ${text(binding.unit)}; context: ${text(binding.context)}; original quotation: ${text(binding.quote)}`)
    }
    if (request.sources?.length) {
      lines.push('', 'Source assertions and the recorded host checks follow. An assertion alone is not verified evidence.', '')
      for (const source of request.sources) {
        const checks = (request.sourceChecks ?? []).filter((/** @type {any} */ check) => check.field === source.field)
        lines.push(`- ${text(source.field)}: ${text(source.publication ?? source.origin)}; asserted quotation: ${text(source.quote)}; ${checks.length ? checks.map((/** @type {any} */ check) => `${text(check.state)}: ${text(check.message)}`).join('; ') : 'not been verified by this adapter'}`)
      }
    }
    if (request.bound?.length) {
      lines.push('', 'Frozen evidence input versions:', '')
      for (const binding of request.bound) lines.push(`- ${text(binding.path)} = ${text(binding.value)}; ${text(binding.key)} (version ${text(binding.version)})`)
    }
    if (!request.sources?.length && !bindings.length && !request.bound?.length) lines.push('No source bindings were supplied; scenario values are assumptions unless established separately.')
  } else lines.push('The host did not supply the request and source details; consult the host research record.')
  lines.push('', '## Scope and limitations', '', 'Results apply to the stated method, input data and assumptions; applicability outside that setting has not been established.')
  if (result.notEstimableRule) lines.push(`Not estimable: ${text(typeof result.notEstimableRule === 'object' ? JSON.stringify(result.notEstimableRule) : result.notEstimableRule)}.`)
  const issues = Array.isArray(result.issues) ? result.issues : []
  for (const issue of issues) lines.push(`- ${text(issue.message ?? issue.code ?? issue)}`)
  lines.push('', '## Reproducibility', '')
  if (request?.job) lines.push(`Requested job seed: ${text(request.job.seed)}. Requested replicates: ${text(request.job.replicates)}. The method may apply a replication floor or cap; consult the completed result for what ran.`, '')
  lines.push('The associated reproduction JSON contains the machine-readable result and the request when available.', '')
  return lines.join('\n')
}
