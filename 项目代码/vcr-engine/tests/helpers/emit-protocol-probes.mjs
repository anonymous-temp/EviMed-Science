/**
 * The domain's answer to each small question the engine's protocol mirror must
 * answer the same way, as JSON. Case N00 calls it, asks R the same question, and
 * compares.
 *
 * Hidden knowledge: every function here is one the engine re-implements in R
 * (`R/protocol.R`) because the container has no Node — canonical JSON, the
 * scenario hash, the output hash, the id patterns, the replicate floor, the null
 * predicate. A second implementation is only true while a test says so; this file
 * is the JavaScript half of that test.
 *
 * Run: node tests/helpers/emit-protocol-probes.mjs <probe> [file]
 *   canonical <cases.json>     canonical JSON and sha256 of each JSON text in the file
 *   scenario-hash <job.json>   sha256 of the canonical scenario of a job file
 *   output-hash <result.json>  sha256 of the output payload of a result file
 *   result <result.json>       the domain's verdict on a result file, its output hash and its scenario hash
 *   job-scenario-hash <job.json>  sha256 of the canonical scenario of a job file (alias of scenario-hash)
 *   patterns                   each id/hash pattern against the probe strings
 *   replicates                 the replicate floor for a fixed set of scenarios
 *   null                       the null predicate for a fixed set of scenarios
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const domain = resolve(here, '../../../../OpenScience/packages/domain/src')
const job = await import(`${domain}/vcrEngineJob.mjs`)
const sha = (text) => createHash('sha256').update(text).digest('hex')
const read = (path) => readFileSync(path, 'utf8')

const [probe, file] = process.argv.slice(2)

/** Strings that separate the patterns: the edges each regex was written to have. */
export const PATTERN_PROBES = [
  '', 'a', 'A1', '1', '_x', '-x', '.x', 'job_1', 'std_1.v2:3', 'a'.repeat(121), 'a'.repeat(122), 'asm_1@3', 'asm_1@', 'asm_1@0', 'asm_1@03', '@3',
  'asm 1', 'asm/1', 'asm\n', '中文', 'x'.repeat(141), 'x'.repeat(142), 'a'.repeat(64), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65),
  `${'a'.repeat(63)}\n`, 'std_1/snp_1/subject.csv', '../x', '.hidden', 'a_b.c@d:e+f=g,h-i', 'a b', 'a\\b',
]

if (probe === 'canonical') {
  const cases = JSON.parse(read(file))
  const out = cases.map((text) => { const canonical = job.canonicalScenarioJson(JSON.parse(text)); return { canonical, sha256: sha(canonical) } })
  process.stdout.write(`${JSON.stringify(out)}\n`)
} else if (probe === 'scenario-hash') {
  const doc = JSON.parse(read(file))
  process.stdout.write(`${JSON.stringify({ sha256: sha(job.canonicalScenarioJson(doc.scenario)) })}\n`)
} else if (probe === 'output-hash') {
  process.stdout.write(`${JSON.stringify({ sha256: sha(job.vcrResultOutputPayload(JSON.parse(read(file)))) })}\n`)
} else if (probe === 'result') {
  const doc = JSON.parse(read(file))
  const issues = job.validateEngineResult(doc).map((issue) => `${issue.code}@${issue.field}`)
  process.stdout.write(`${JSON.stringify({ issues, outputHash: sha(job.vcrResultOutputPayload(doc)) })}\n`)
} else if (probe === 'patterns') {
  const out = {}
  for (const [name, source] of Object.entries(job.VCR_PATTERNS)) {
    const re = new RegExp(source)
    out[name] = PATTERN_PROBES.map((text) => re.test(text))
  }
  out.location = PATTERN_PROBES.concat(['a/b', 'a//b', 'a/b/', '/a', 'a/../b', 'a/./b', 'std_1/snp_1/x.csv']).map((text) => job.vcrLocationIsValid(text))
  process.stdout.write(`${JSON.stringify({ probes: PATTERN_PROBES, verdicts: out })}\n`)
} else if (probe === 'replicates') {
  const rows = [
    [true, null, 0.025], [true, 0.001, 0.025], [true, 0.001, 0.05], [true, 0.0011, 0.025], [false, null, 0.025], [false, 0.005, 0.025],
    [false, 0.001, 0.025], [true, 0.0007, 0.31], [true, 0.01, 0.05],
  ]
  const out = rows.map(([isNull, targetMcse, alpha]) => job.replicateFloor({ isNull, targetMcse, alpha }))
  process.stdout.write(`${JSON.stringify({ rows, floors: out })}\n`)
} else if (probe === 'null') {
  const scenarios = nullScenarios()
  process.stdout.write(`${JSON.stringify(scenarios.map((scenario) => job.vcrIsNullScenario(scenario)))}\n`)
} else if (probe === 'null-scenarios') {
  process.stdout.write(`${JSON.stringify(nullScenarios())}\n`)
} else {
  process.stderr.write('unknown probe\n')
  process.exit(2)
}

/** The scenarios the null predicate is asked about: each family, both sides of zero, the tolerance, an explicit flag. */
function nullScenarios() {
  const ep = (type) => ({ type })
  return [
    { endpoint: ep('continuous'), truth: { effect: 0 } },
    { endpoint: ep('continuous'), truth: { effect: 0.5 } },
    { endpoint: ep('continuous'), truth: { effect: 1e-13 } },
    { endpoint: ep('continuous'), truth: { effect: 1e-9 } },
    { endpoint: ep('continuous'), truth: {} },
    { endpoint: ep('time_to_event'), truth: { hazardRatio: 1 } },
    { endpoint: ep('time_to_event'), truth: { hazardRatio: 0.7 } },
    { endpoint: ep('time_to_event'), truth: { hazardRatio: 1 + 1e-13 } },
    { endpoint: ep('time_to_event'), truth: { hazardRatio: 0 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, treatmentRate: 0.3 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, treatmentRate: 0.45 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, riskDifference: 0 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, riskDifference: 0.1 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, oddsRatio: 1 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, oddsRatio: 2 } },
    { endpoint: ep('binary'), truth: { treatmentRate: 0.3 } },
    { endpoint: ep('continuous'), truth: { effect: 0.5, null: true } },
    { endpoint: ep('continuous'), truth: { effect: 0, null: false } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, treatmentRate: 0.45, null: true } },
    { endpoint: ep('ordinal'), truth: { effect: 0 } },
    { truth: { effect: 0 } },
    { endpoint: ep('continuous') },
    {},
    // The edges: a difference the tolerance is there to decide (1e-12, absolute).
    { endpoint: ep('binary'), truth: { controlRate: 0.3, treatmentRate: 0.3 + 1e-9 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, treatmentRate: 0.3 + 1e-13 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, riskDifference: 1e-9 } },
    { endpoint: ep('time_to_event'), truth: { hazardRatio: 1 + 1e-9 } },
    { endpoint: ep('time_to_event'), truth: { hazardRatio: 1 - 5e-13 } },
    { endpoint: ep('binary'), truth: { controlRate: 0.3, oddsRatio: 1 + 1e-9 } },
  ]
}
