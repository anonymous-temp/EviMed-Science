#!/usr/bin/env node
// The engine's numeric suite runs in CI as shards (`vcr-engine-numeric`, a matrix job) and a short final job that assembles
// them. Which case runs where is one committed file, `项目代码/vcr-engine/tests/numeric-partition.json`:
//
//   { "version": 1, "basis": "...", "shards": [[<case ids>], ...], "final": [<case ids>] }
//
// Hidden knowledge: this is the guard that makes sharding safe. A case in two shards runs twice and a case in none runs
// never, and either reads as a green run. So every `vcr_case("<id>"` at the start of a line in tests/numeric/*.R must be in
// exactly one list, and a list may name nothing the source does not declare. A new case fails this check, in seconds and in the
// cheap `web` job, until it is added: `--assign` says where (the shard with the fewest cases), `--write` puts it there.
// `final` holds the cases that need the whole run's record (Z99 reads which methods every other case ran); they run after the
// shards, on their merged coverage.
//
//   node scripts/vcr/numeric-partition.mjs                  check (exit 1 and the reasons on stderr)
//   node scripts/vcr/numeric-partition.mjs --assign         print the shard each unlisted case would go to
//   node scripts/vcr/numeric-partition.mjs --write          add unlisted cases to the lightest shard
//   node scripts/vcr/numeric-partition.mjs --count <shard>  number of cases a shard owns (1.., or final)
//   node scripts/vcr/numeric-partition.mjs --ids <shard>    the ids, one per line
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ENGINE = path.resolve(HERE, '../../../项目代码/vcr-engine');
const CASE_LINE = /^vcr_case\(/;
const CASE_ID = /^vcr_case\("([A-Za-z0-9-]+)"\s*,/;

/** The case ids tests/numeric declares, in file order, with the line that declares each. @param {string} engine */
export function declaredCases(engine = DEFAULT_ENGINE) {
  const directory = path.join(engine, 'tests', 'numeric');
  const found = [];
  const unreadable = [];
  for (const name of fs.readdirSync(directory).filter(entry => entry.endsWith('.R')).sort()) {
    fs.readFileSync(path.join(directory, name), 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (!CASE_LINE.test(line)) return;
      const id = CASE_ID.exec(line)?.[1];
      if (id) found.push({ id, file: name, line: index + 1 });
      else unreadable.push(`${name}:${index + 1}`);
    });
  }
  return { found, unreadable };
}

/** @param {string} engine */
export function readPartition(engine = DEFAULT_ENGINE) {
  const value = JSON.parse(fs.readFileSync(path.join(engine, 'tests', 'numeric-partition.json'), 'utf8'));
  return value;
}

/** Every reason the partition is not the source's cases exactly once each. [] is a sound partition.
 * @param {{ found: {id:string,file:string,line:number}[], unreadable: string[] }} declared @param {any} partition */
export function partitionProblems(declared, partition) {
  const problems = [];
  if (declared.found.length === 0) return ['no vcr_case( found under tests/numeric: the scan read nothing'];
  for (const place of declared.unreadable) problems.push(`${place}: a vcr_case( line whose id the scan cannot read (the id must be a quoted literal first argument)`);
  if (partition?.version !== 1 || !Array.isArray(partition.shards) || partition.shards.length < 2 || !Array.isArray(partition.final)
    || ![...partition.shards, partition.final].every(list => Array.isArray(list) && list.every(id => typeof id === 'string'))) {
    return [...problems, 'numeric-partition.json: expected { version: 1, shards: [[ids], [ids], ...] (at least two), final: [ids] }'];
  }
  for (const [index, list] of partition.shards.entries()) if (list.length === 0) problems.push(`shard ${index + 1} owns no case`);
  const declaredIds = new Map();
  for (const { id, file, line } of declared.found) {
    if (declaredIds.has(id)) problems.push(`${id} is declared twice (${declaredIds.get(id)} and ${file}:${line})`);
    else declaredIds.set(id, `${file}:${line}`);
  }
  const owner = new Map();
  const lists = [...partition.shards.map((list, index) => [String(index + 1), list]), ['final', partition.final]];
  for (const [name, list] of lists) {
    for (const id of list) {
      if (!declaredIds.has(id)) problems.push(`${id} is in ${name === 'final' ? 'final' : `shard ${name}`} and no vcr_case declares it`);
      else if (owner.has(id)) problems.push(`${id} is in ${owner.get(id)} and in ${name === 'final' ? 'final' : `shard ${name}`}: it would run twice`);
      else owner.set(id, name === 'final' ? 'final' : `shard ${name}`);
    }
  }
  for (const [id, where] of declaredIds) if (!owner.has(id)) problems.push(`${id} (${where}) is in no shard: it would never run in CI; add it with \`node scripts/vcr/numeric-partition.mjs --write\``);
  return problems;
}

/** The shard with the fewest cases takes each unlisted id; a partition is returned, the input is not changed.
 * @param {{ found: {id:string}[] }} declared @param {any} partition */
export function assignMissing(declared, partition) {
  const next = { ...partition, shards: partition.shards.map((/** @type {string[]} */ list) => [...list]) };
  const listed = new Set([...next.shards.flat(), ...next.final]);
  const added = [];
  for (const { id } of declared.found) {
    if (listed.has(id)) continue;
    const lightest = next.shards.reduce((best, list, index) => (list.length < next.shards[best].length ? index : best), 0);
    next.shards[lightest].push(id);
    listed.add(id);
    added.push({ id, shard: lightest + 1 });
  }
  return { partition: next, added };
}

export function shardIds(partition, shard) {
  if (shard === 'final') return partition.final;
  const list = partition.shards[Number(shard) - 1];
  if (!/^[1-9][0-9]*$/.test(String(shard)) || !list) throw new Error(`no shard '${shard}' (1..${partition.shards.length} or final)`);
  return list;
}

function main(argv) {
  const engine = process.env.VCR_ENGINE_ROOT ? path.resolve(process.env.VCR_ENGINE_ROOT) : DEFAULT_ENGINE;
  const declared = declaredCases(engine);
  const partition = readPartition(engine);
  const [flag, value] = argv;
  if (flag === '--count' || flag === '--ids') {
    const ids = shardIds(partition, value);
    process.stdout.write(flag === '--count' ? `${ids.length}\n` : `${ids.join('\n')}\n`);
    return 0;
  }
  if (flag === '--assign' || flag === '--write') {
    const { partition: next, added } = assignMissing(declared, partition);
    for (const { id, shard } of added) process.stdout.write(`${id} -> shard ${shard}\n`);
    if (flag === '--write' && added.length) fs.writeFileSync(path.join(engine, 'tests', 'numeric-partition.json'), serialize(next));
    return 0;
  }
  const problems = partitionProblems(declared, partition);
  if (problems.length) {
    process.stderr.write(`numeric-partition: ${problems.length} problem(s)\n${problems.map(line => `  ${line}`).join('\n')}\n`);
    return 1;
  }
  const sizes = partition.shards.map((/** @type {string[]} */ list) => list.length);
  process.stdout.write(`numeric-partition: ${declared.found.length} cases, each in exactly one of ${sizes.length} shards (${sizes.join('/')}) or final (${partition.final.length})\n`);
  return 0;
}

/** Ten ids to a line, so a diff shows only the ids that moved. @param {any} partition */
export function serialize(partition) {
  const block = (/** @type {string[]} */ list) => `[\n${Array.from({ length: Math.ceil(list.length / 10) }, (_, row) => `      ${list.slice(row * 10, row * 10 + 10).map(id => JSON.stringify(id)).join(', ')}`).join(',\n')}\n    ]`;
  return `{\n  "version": ${partition.version},\n  "basis": ${JSON.stringify(partition.basis)},\n  "shards": [\n    ${partition.shards.map(block).join(',\n    ')}\n  ],\n  "final": ${JSON.stringify(partition.final)}\n}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { process.stderr.write(`numeric-partition: ${error.message}\n`); process.exitCode = 1; }
}
