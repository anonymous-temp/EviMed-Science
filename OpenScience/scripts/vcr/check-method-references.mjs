#!/usr/bin/env node
/**
 * Say, before the 40-60 minute numerical run, whether every method the engine
 * dispatches has a reference case the validation evidence can record.
 *
 *   node scripts/vcr/check-method-references.mjs [engine-root]
 *
 * Hidden knowledge: the deployed evidence once covered 12 of 24 methods because a
 * hand-written table named 15 cases and nothing noticed the rest. The methods are
 * read from the engine's own registry (`R/domain-snapshot.json`, which the engine's
 * start-up check holds equal to its handler table); the cases are the literal
 * `vcr_case(` declarations under `tests/numeric`; the table is
 * `scripts/ops/vcr-method-references.mjs`. A method with no reference case, an
 * entry naming a method the engine does not have, an anchor that is no longer
 * in its case, and a `crossChecks` label that names an R package of a lock which no
 * case calls (2026-11-03: `simsurv` and `IPDfromKM` were labels nothing ran) all exit 1
 * and name themselves. Node's own modules only: the CI job
 * that runs this has no `pnpm install`.
 *
 * Environment: VCR_ENGINE_ROOT (default: 项目代码/vcr-engine beside OpenScience).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NUMERIC_REFERENCES, crossCheckLabelProblems, methodsWithoutReference, referenceProblems, sourceCases } from '../ops/vcr-method-references.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(process.argv[2] ?? process.env.VCR_ENGINE_ROOT ?? path.join(here, '../../../项目代码/vcr-engine'));
const registry = JSON.parse(readFileSync(path.join(engine, 'R/domain-snapshot.json'), 'utf8')).methods ?? {};
const methods = Object.keys(registry);
if (methods.length === 0) { console.error('check-method-references: the registry names no method — the scan read nothing'); process.exit(1); }
const caseDirectory = path.join(engine, 'tests/numeric');
const files = readdirSync(caseDirectory).filter(name => /\.R$/.test(name)).sort()
  .map(name => ({ path: `tests/numeric/${name}`, bytes: readFileSync(path.join(caseDirectory, name)) }));
const definitions = sourceCases(files);
// the packages of both locks: a label that names one is a claim the cases have to back with a call (crossCheckLabelProblems)
const lockedPackages = ['R/package-lock.json', 'tests/package-lock.crosscheck.json']
  .flatMap(lock => JSON.parse(readFileSync(path.join(engine, lock), 'utf8')).packages ?? []).map(entry => String(entry.package));

const problems = [];
const missing = methodsWithoutReference(methods, definitions);
for (const method of missing) problems.push(`${method}: no reference case holds it (add one to NUMERIC_REFERENCES, or write one)`);
for (const { caseId, problem } of referenceProblems(methods, definitions)) problems.push(`${caseId}: ${problem}`);
for (const { method, label, packageName } of crossCheckLabelProblems(registry, lockedPackages, files)) {
  problems.push(`${method}: the label ${JSON.stringify(label)} names ${packageName}, which no case under tests/numeric calls (pkg::, library(pkg) or requireNamespace("pkg")) -- make the label true or drop it`);
}
for (const method of methods) {
  const cases = Object.entries(NUMERIC_REFERENCES).filter(([id, spec]) => definitions.has(id) && spec.methods.includes(method)).map(([id]) => id);
  console.log(`${method.padEnd(34)} ${cases.length ? cases.join(', ') : 'NO REFERENCE CASE'}`);
}
if (problems.length) {
  console.error(`\ncheck-method-references: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`\ncheck-method-references: all ${methods.length} dispatched methods have a reference case`);
