import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALL_ERROR_CODES, CONTRACT_KINDS, GENE_EXPRESSION_CONTRACT_KIND, GENE_EXPRESSION_ERROR_CODES, GENE_EXPRESSION_LIMITS, GENE_EXPRESSION_LIMIT_NAMES,
  GENE_EXPRESSION_NOT_LIMMA, GENE_EXPRESSION_RESULT_FILES, MCP_TOOL_BASE_NAMES, classifyEvidenceSourceError, errorCodeMessage, geneExpressionFindings,
  isClinicalContractKind, mcpToolBaseName, runGate, toolViewPhrase,
} from '../index.mjs'

// NCBI Gene Expression Omnibus series to differential expression (the public data resource, not 循证传播).

const receipt = () => ({
  schemaVersion: 1,
  executions: [{
    id: 'a'.repeat(32), parent: null, argv: ['python3', 'gene_expression.py', 'differential'],
    script: { path: 'deliverables/x/gene_expression.py', sha256: 'a'.repeat(64), bytes: 10 },
    inputs: [{ path: '.evimed-sources/gene-expression/GSE5583-GPL81/h/series_matrix.txt.gz', sha256: 'b'.repeat(64), bytes: 10 }],
    transforms: [], startedAt: '2026-10-04T13:00:00+00:00', endedAt: '2026-10-04T13:00:01+00:00', exitCode: 0,
    versions: { interpreter: '3.12', libraries: { numpy: '2.2.6', scipy: '1.15.3' } },
    output: { before: null, after: { path: 'deliverables/x/gene-expression-results.json', sha256: 'c'.repeat(64), bytes: 10 }, observation: 'created', observedWrite: true },
    sourcesUnchanged: true,
  }],
})

const results = () => ({
  schemaVersion: 1, kind: 'gene-expression-differential',
  method: { id: 'welch-bh-log2', isLimma: false, statement: GENE_EXPRESSION_NOT_LIMMA, randomness: 'none', seed: null },
  series: { accession: 'GSE5583', platform: 'GPL81' },
  design: { reference: 'wild type', comparison: 'knock out', groups: [
    { label: 'wild type', n: 3, samples: ['GSM130365', 'GSM130366', 'GSM130367'] }, { label: 'knock out', n: 3, samples: ['GSM130368', 'GSM130369', 'GSM130370'] }] },
  transformation: { requested: 'auto', applied: 'log2', distribution: { looksLinear: true } },
  identity: { samples: { status: 'ok' }, genomeBuild: { status: 'unknown' } },
  diagnostics: { groupSizes: { reference: 3, comparison: 3 }, probesTested: 12488 },
  top: [{ rank: 1, probe: '101451_at', logFC: 1.47, ciLow: 1.38, ciHigh: 1.56, pValue: 2.16e-6, adjPValue: 0.0237 }],
})

const files = (overrides = {}) => new Map(Object.entries({
  'gene-expression-report.md': 'The knock-out arrays differ from wild type.',
  'gene-expression-results.json': JSON.stringify(results()),
  'gene-expression-receipt.json': JSON.stringify(receipt()),
  'gene_expression.py': '# the code that ran',
  ...overrides,
}))

test('a complete package has no finding, and its metrics count what the tool wrote', () => {
  const { issues, metrics } = geneExpressionFindings({ files: files(), packagePath: 'deliverables/x' })
  assert.deepEqual(issues, [])
  assert.deepEqual(metrics, { geneExpressionProbesTested: 12488, geneExpressionTopRows: 1, geneExpressionExecutions: 1 })
})

test('every finding is advice, and a defective package is still delivered', () => {
  const broken = { ...results(), method: { id: 'welch-bh-log2', isLimma: true }, design: { groups: [{ label: 'a', n: 2, samples: ['GSM1', 'GSM2'] }] },
    transformation: {}, top: [{ probe: 'p', logFC: 1, pValue: 0.5, adjPValue: 0.1 }, { probe: 'q', logFC: 1, pValue: 0.5, adjPValue: 1.5 }, { probe: 'r' }],
    identity: { platform: { status: 'mismatch' } }, diagnostics: {} }
  const found = geneExpressionFindings({ files: files({ 'gene-expression-results.json': JSON.stringify(broken), 'gene-expression-receipt.json': '{"executions":[]}' }) })
  assert.ok(found.issues.length >= 6)
  assert.ok(found.issues.every((issue) => issue.severity === 'advisory' && issue.code === 'gene_expression_notice'))
  assert.deepEqual([...new Set(found.issues.map((issue) => issue.check))].sort(),
    ['gene-expression-design', 'gene-expression-execution-provenance', 'gene-expression-method-statement', 'gene-expression-results-shape'])
  const verdict = runGate({ contractKind: GENE_EXPRESSION_CONTRACT_KIND, expectedOutputs: [{ path: 'gene-expression-report.md', required: false }],
    files: files({ 'gene-expression-results.json': JSON.stringify(broken) }) })
  assert.equal(verdict.ok, true, 'a finding labels a package; it never withholds one')
  assert.ok(verdict.issues.some((issue) => issue.check === 'gene-expression-design'))
})

test('unreadable or absent files are notices, never a refusal', () => {
  assert.ok(geneExpressionFindings({ files: files({ 'gene-expression-results.json': '{ not json' }) }).issues.some((issue) => issue.check === 'gene-expression-results-shape'))
  const orphan = geneExpressionFindings({ files: new Map([['gene-expression-report.md', 'a report with numbers']]) })
  assert.equal(orphan.issues.length, 1)
  assert.match(orphan.issues[0].message, /no machine results/)
  assert.deepEqual(geneExpressionFindings({ files: new Map() }).issues, [])
})

test('two groups that share a sample, and a receipt whose script is not in the package, are noticed', () => {
  const shared = results()
  shared.design.groups[1].samples[0] = 'GSM130365'
  assert.ok(geneExpressionFindings({ files: files({ 'gene-expression-results.json': JSON.stringify(shared) }) }).issues.some((issue) => /share a sample/.test(issue.message)))
  const elsewhere = receipt()
  elsewhere.executions[0].script.path = 'somewhere/else.py'
  assert.ok(geneExpressionFindings({ files: files({ 'gene-expression-receipt.json': JSON.stringify(elsewhere) }), packagePath: 'deliverables/x' }).issues.some((issue) => /not included in the package/.test(issue.message)))
})

test('the kind is registered, labelled, clinical like its sibling data analysis, and named apart from 循证传播', () => {
  assert.ok(CONTRACT_KINDS.includes(GENE_EXPRESSION_CONTRACT_KIND))
  assert.equal(isClinicalContractKind(GENE_EXPRESSION_CONTRACT_KIND), true)
  assert.ok(!GENE_EXPRESSION_CONTRACT_KIND.startsWith('geo-'))
  for (const name of ['gene_expression_series', 'gene_expression_differential']) {
    assert.ok(MCP_TOOL_BASE_NAMES.includes(name), name)
    assert.equal(mcpToolBaseName(`mcp__evimed__${name}`), name)
    assert.ok(toolViewPhrase(`mcp__evimed__${name}`)?.verb, `${name} has a conversation phrase`)
  }
  assert.ok(Object.values(GENE_EXPRESSION_RESULT_FILES).every((file) => file.startsWith('gene-expression') || file === 'gene_expression.py'))
})

test('every refusal code is classified, registered and has a Chinese sentence', () => {
  assert.ok(GENE_EXPRESSION_ERROR_CODES.length >= 10)
  for (const code of GENE_EXPRESSION_ERROR_CODES) {
    assert.notEqual(classifyEvidenceSourceError(code), 'unknown', code)
    assert.ok(ALL_ERROR_CODES.includes(code), code)
    assert.match(errorCodeMessage(code), /[一-鿿]/, code)
  }
  assert.equal(classifyEvidenceSourceError('gene_expression_input_over_limit'), 'recoverable', 'an over-limit input is a limitation to report')
  assert.equal(classifyEvidenceSourceError('gene_expression_groups_invalid'), 'terminal', 'a group the run declared wrongly is the run to fix')
  assert.match(errorCodeMessage('gene_expression_input_over_limit'), /上限/)
})

test('the six limits have their domain bounds and unit, and the defaults sit inside them', () => {
  assert.deepEqual(Object.values(GENE_EXPRESSION_LIMITS).map((spec) => spec.limit).sort(), [...GENE_EXPRESSION_LIMIT_NAMES].sort())
  for (const spec of Object.values(GENE_EXPRESSION_LIMITS)) {
    assert.ok(spec.min <= spec.default && spec.default <= spec.max, spec.limit)
    assert.match(spec.configKey, /^geneExpressionMax[A-Z]/)
    assert.match(spec.env, /^GENE_EXPRESSION_MAX_/)
  }
})
