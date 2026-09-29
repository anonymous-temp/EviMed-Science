/**
 * The domain's verdict on every job and result of the parity fixture, as JSON.
 *
 * Hidden knowledge: the engine's `vcr_validate_job` is a second implementation
 * of the domain's `validateEngineJob`, written in another language against the
 * same generated tables (`R/domain-snapshot.json`). Case N00 keeps them equal by
 * running the same jobs through both and comparing the whole verdict, sorted.
 * The jobs are the domain package's fixture file — one file, read by both
 * languages — and this helper is the JavaScript half: it prints
 * `{ jobs, results }`, each `[{ name, issues: ["code@field", ...] }]` in the
 * fixture's order, valid ones first. Results are held to the same account:
 * `vcr_validate_result` is the second implementation of `validateEngineResult`,
 * and the engine runs it on its own output.
 *
 * Run: node tests/helpers/emit-job-verdicts.mjs [fixturePath]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const domain = resolve(here, '../../../../OpenScience/packages/domain')
const { validateEngineJob, validateEngineResult } = await import(`${domain}/src/vcrEngineJob.mjs`)

const fixturePath = resolve(process.argv[2] ?? `${domain}/test/fixtures/vcr-engine-jobs.json`)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const sorted = (issues) => issues.map((issue) => `${issue.code}@${issue.field}`).sort()
const verdicts = {
  jobs: [...fixture.valid, ...fixture.invalid].map((item) => ({ name: item.name, issues: sorted(validateEngineJob(item.job)) })),
  results: [...fixture.validResults, ...fixture.invalidResults].map((item) => ({ name: item.name, issues: sorted(validateEngineResult(item.result)) })),
}
process.stdout.write(`${JSON.stringify(verdicts)}\n`)
