#!/usr/bin/env node
// Put the numeric suite's shards back together as the one run the method-validation importer
// (`scripts/ops/import-vcr-method-validation.mjs`) reads.
//
//   node scripts/vcr/merge-numeric-shards.mjs coverage --shards <dir> --out <coverage.json>
//       the methods every shard ran, for the final shard's coverage case (Z99)
//   node scripts/vcr/merge-numeric-shards.mjs assemble --shards <dir> --final-report <json> --final-log <log> \
//       --out-report <json> --out-log <log>
//       the merged evidence report and log
//
// Hidden knowledge: <dir> holds one subdirectory per downloaded shard artifact, each with `vcr-numerical-evidence.json` and
// `vcr-numeric.log` (`actions/download-artifact` without merge-multiple). A merged report is `complete` only when
//   - every shard and the final run report that they are the partition's shards, from one revision, one R, one package lock
//     and the same method registry, each `pass` and not `complete` by itself (a shard is never the whole suite),
//   - the cases they ran are, shard by shard, exactly the partition's lists, and the union is every case the source declares
//     exactly once (the same check as scripts/vcr/numeric-partition.mjs, against the files, not the report),
// so a shard that died, a shard that ran twice, or a case that no shard owns refuses the merge by name. The output carries
// only the fields the importer allows and the original case records (id, ac, pass, detail, seconds) untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ENGINE, declaredCases, partitionProblems, readPartition } from './numeric-partition.mjs';

const fail = message => { throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CASE_LINE = /^([A-Za-z0-9-]+)\s+(PASS|FAIL)\s+[^\n]*\|\s+[^\n]+$/;

/** Every shard artifact found under a directory, as { shard, report, log }. @param {string} directory */
export function readShards(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const report = path.join(directory, entry.name, 'vcr-numerical-evidence.json');
    const log = path.join(directory, entry.name, 'vcr-numeric.log');
    if (!fs.existsSync(report) || !fs.existsSync(log)) fail(`${entry.name}: the shard artifact lacks its report or its log`);
    const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
    found.push({ name: entry.name, report: parsed, log: fs.readFileSync(log, 'utf8') });
  }
  return found;
}

/** @param {string} id @param {any} report @param {string[]} ids */
function checkRun(label, report, ids) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.cases)) fail(`${label}: not a numerical evidence report`);
  if (report.testOnly !== '' || (report.skippedCaseIds ?? []).length) fail(`${label}: a filtered run or a skipped case`);
  const ran = report.cases.map((/** @type {any} */ item) => item.id);
  if (new Set(ran).size !== ran.length) fail(`${label}: a case reported twice`);
  const failing = report.cases.filter((/** @type {any} */ item) => item.pass !== true).map((/** @type {any} */ item) => item.id);
  if (failing.length) fail(`${label}: failing cases ${failing.join(', ')}`);
  if (!same([...ran].sort(), [...ids].sort())) {
    const missing = ids.filter(id => !ran.includes(id));
    const extra = ran.filter((/** @type {string} */ id) => !ids.includes(id));
    fail(`${label}: it ran the wrong cases (missing ${missing.join(', ') || 'none'}; unexpected ${extra.join(', ') || 'none'})`);
  }
}

/** Validate the whole set and return { shards: [{report, log}...ordered], partition }.
 * @param {{ name: string, report: any, log: string }[]} found @param {any} partition */
export function orderedShards(found, partition) {
  const byShard = new Map();
  for (const item of found) {
    const shard = String(item.report.shard ?? '');
    if (byShard.has(shard)) fail(`shard ${shard} is present twice`);
    byShard.set(shard, item);
  }
  const wanted = partition.shards.map((/** @type {unknown} */ _, /** @type {number} */ index) => String(index + 1));
  const ordered = wanted.map((/** @type {string} */ shard) => byShard.get(shard) ?? fail(`shard ${shard} produced no evidence`));
  if (byShard.size !== wanted.length) fail(`unexpected shard(s): ${[...byShard.keys()].filter(key => !wanted.includes(key)).join(', ')}`);
  ordered.forEach((item, index) => checkRun(`shard ${index + 1}`, item.report, partition.shards[index]));
  return ordered;
}

/** The facts every run must share: one revision, one R, one lock, one method registry. */
function checkSameBuild(runs) {
  const [first, ...rest] = runs;
  for (const run of rest) {
    for (const key of ['sourceRevision', 'rVersion', 'packageLockHash', 'methods']) {
      if (!same(run[key], first[key])) fail(`the runs disagree on ${key}`);
    }
  }
}

/** @param {any[]} reports */
function unionCoverage(reports) {
  const methodsRun = [...new Set(reports.flatMap(report => [].concat(report.methodsRun ?? [])))].sort();
  const methodsByCase = {};
  for (const report of reports) {
    for (const [id, methods] of Object.entries(report.methodsByCase ?? {})) {
      if (Object.hasOwn(methodsByCase, id)) fail(`${id}: two shards recorded the same case`);
      methodsByCase[id] = [].concat(methods);
    }
  }
  return { methodsRun, methodsByCase };
}

export function coverage(directory, engine = DEFAULT_ENGINE) {
  const partition = readPartition(engine);
  const problems = partitionProblems(declaredCases(engine), partition);
  if (problems.length) fail(`the partition is not the source's cases: ${problems[0]}`);
  const shards = orderedShards(readShards(directory), partition);
  checkSameBuild(shards.map(item => item.report));
  return unionCoverage(shards.map(item => item.report));
}

/** @returns {{ report: any, log: string }} */
export function assemble({ directory, finalReport, finalLog, engine = DEFAULT_ENGINE }) {
  const partition = readPartition(engine);
  const declared = declaredCases(engine);
  const problems = partitionProblems(declared, partition);
  if (problems.length) fail(`the partition is not the source's cases: ${problems[0]}`);
  const shards = orderedShards(readShards(directory), partition);
  const final = { report: finalReport, log: finalLog };
  if (finalReport.shard !== 'final') fail('the final report is not the final shard');
  checkRun('final', finalReport, partition.final);
  const reports = [...shards.map(item => item.report), finalReport];
  checkSameBuild(reports);
  const cases = reports.flatMap(report => report.cases);
  const declaredIds = declared.found.map(item => item.id);
  if (cases.length !== declaredIds.length || !same(cases.map(item => item.id).sort(), [...declaredIds].sort())) fail('the shards together are not every declared case exactly once');
  // The final shard's coverage record was loaded from the other shards; its own record of cases is the final cases only.
  const methodsByCase = {};
  for (const report of reports) for (const [id, methods] of Object.entries(report.methodsByCase ?? {})) {
    if (!cases.some(item => item.id === id)) fail(`${id} has a method record and no case`);
    methodsByCase[id] = methodsByCase[id] ?? [].concat(methods);
  }
  const report = {
    schemaVersion: 1, sourceRevision: reports[0].sourceRevision, rVersion: reports[0].rVersion, packageLockHash: reports[0].packageLockHash,
    methods: reports[0].methods, cases, methodsByCase, testOnly: '', skippedCaseIds: [], complete: true,
  };
  const body = [...shards, final].map((item, index) => {
    const lines = item.log.split(/\r?\n/).filter(line => !/^PASSED \d+\/\d+\s*$/.test(line));
    return `== ${index === shards.length ? 'final' : `shard ${index + 1}`} ==\n${lines.join('\n').trim()}\n`;
  }).join('\n');
  const logged = body.split('\n').filter(line => CASE_LINE.test(line)).map(line => CASE_LINE.exec(line)?.[1]);
  if (logged.length !== cases.length || new Set(logged).size !== cases.length) fail('the logs together do not hold each case once');
  return { report, log: `${body}\nPASSED ${cases.length}/${cases.length}\n` };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index].startsWith('--') || rest[index + 1] === undefined) fail(`bad argument ${rest[index]}`);
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function main(argv) {
  const { command, options } = parseArguments(argv);
  const engine = process.env.VCR_ENGINE_ROOT ? path.resolve(process.env.VCR_ENGINE_ROOT) : DEFAULT_ENGINE;
  if (command === 'coverage') {
    fs.writeFileSync(options.out, `${JSON.stringify(coverage(options.shards, engine))}\n`);
    return;
  }
  if (command === 'assemble') {
    const merged = assemble({ directory: options.shards, engine, finalReport: JSON.parse(fs.readFileSync(options['final-report'], 'utf8')), finalLog: fs.readFileSync(options['final-log'], 'utf8') });
    fs.writeFileSync(options['out-report'], `${JSON.stringify(merged.report, null, 2)}\n`);
    fs.writeFileSync(options['out-log'], merged.log);
    process.stdout.write(`merge-numeric-shards: ${merged.report.cases.length} cases from every shard and the final run, each once\n`);
    return;
  }
  fail('usage: merge-numeric-shards.mjs coverage|assemble ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`merge-numeric-shards: ${error.message}\n`); process.exitCode = 1; }
}
