/**
 * The domain's verdict on a population profile, as JSON: `{ issues: ["code@field", ...] }`.
 *
 * Hidden knowledge: the profile block of a population result (`diagnostics.profile`)
 * is written by R (`R/population.R`) and read by the control plane's page, and its
 * contract is `validatePopulationProfile` in `@evimed/domain`. Case N44 writes the
 * profile a real run produced to a file and asks the domain whether it is one, so the
 * two languages cannot drift apart without a case saying so.
 *
 * Run: node tests/helpers/emit-profile-verdict.mjs <profile.json>
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const domain = resolve(here, '../../../../OpenScience/packages/domain')
const { validatePopulationProfile } = await import(`${domain}/src/vcrPopulationProfile.mjs`)
const profile = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'))
const issues = validatePopulationProfile(profile).map((issue) => `${issue.code}@${issue.field}`).sort()
process.stdout.write(`${JSON.stringify({ issues })}\n`)
