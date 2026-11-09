#!/usr/bin/env node
/**
 * Trial plans for the deletion (G4) and isolation (G5) red lines.
 *
 * A plan is data only: a later runner plants each carrier text in the product, performs the delete or crosses the account
 * boundary, and checks what survives or is visible. Markers are ordinary-looking five-digit codes, and the marker spaces of
 * the two files are disjoint so a G4 marker can never coincide with a G5 one even though each file has its own `used` set.
 *
 *   node synthetic/trialPlans.mjs --carriers file.json --seed X --out dir
 *   node synthetic/trialPlans.mjs --carriers file.json --seed X --out dir --g4-count 180 --g5-count 60
 *
 * @module capsule-proving/synthetic/trialPlans
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rng } from './spec.mjs';

/** Schema written by the CLI for both plan files. */
export const TRIALS_SCHEMA = 'capsule-proving-trials/1';

/** How the G4 marker reaches memory. */
export const G4_PLANT_VIA = ['statement', 'explicit-remember', 'memory-page-add'];

/** How the G4 marker is removed. `memory-reset` and `delete-account` destroy the account. */
export const G4_DELETE_VIA = ['forget-in-conversation', 'memory-page-edit', 'memory-page-delete', 'delete-conversation', 'memory-reset', 'delete-account'];

/** What happens to the marker after the delete, round-robin inside each plant/delete combination. */
export const G4_RELEARN = ['none', 'restate-same-conversation', 'restate-new-conversation'];

/** Every place the G4 runner looks for the deleted marker. */
export const G4_SCAN = ['engine-files', 'vectors', 'archive', 'privacy-tree', 'ledger', 'capsule-entries', 'export', 'line-origin-index'];

/** Reader positions for G5, in round-robin order. */
export const G5_READERS = ['other-account', 'same-account-other-project', 'same-account-no-project', 'geo-member', 'geo-nonmember', 'after-member-removed'];

/** Every read path the G5 runner probes. */
export const G5_PROBES = ['search', 'read', 'list', 'resident-block', 'capsule-search', 'export'];

const MARKER_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DESTRUCTIVE_DELETE_VIA = new Set(['memory-reset', 'delete-account']);
const GEO_READERS = new Set(['geo-member', 'geo-nonmember', 'after-member-removed']);
const ACCOUNT_GROUP_SIZE = 25;

const pad = (n, width) => String(n).padStart(width, '0');

/** Pick an integer in [lo, hi] from a float in [0, 1); the clamp keeps a hand-written stub from going out of bounds. */
function randomInt(r, lo, hi) {
  return lo + Math.min(hi - lo, Math.floor(r() * (hi - lo + 1)));
}

/** A unique marker in the given five-digit range; the random path retries a few times, then scans deterministically. */
function markerInRange(r, used, lo, hi) {
  for (let tries = 0; tries < 100; tries++) {
    const letter = MARKER_LETTERS[randomInt(r, 0, MARKER_LETTERS.length - 1)];
    const marker = `${letter}-${pad(randomInt(r, lo, hi), 5)}`;
    if (!used.has(marker)) {
      used.add(marker);
      return marker;
    }
  }
  for (const letter of MARKER_LETTERS) {
    for (let digits = lo; digits <= hi; digits++) {
      const marker = `${letter}-${pad(digits, 5)}`;
      if (!used.has(marker)) {
        used.add(marker);
        return marker;
      }
    }
  }
  throw new Error('marker space exhausted');
}

/**
 * A unique ordinary-looking marker: one capital letter, a hyphen and five digits.
 * @param {() => number} r seeded float source in [0, 1)
 * @param {Set<string>} used markers already in this plan file
 * @returns {string}
 */
export function makeMarker(r, used) {
  return markerInRange(r, used, 0, 99999);
}

/** Fill a carrier's single `{marker}` slot. */
function fillCarrier(carrier, marker) {
  return carrier.text.replace('{marker}', marker);
}

/** Throw when the carriers file cannot produce a plant text; return nothing when it is usable. */
function assertCarriers(carriers) {
  if (!Array.isArray(carriers) || carriers.length === 0) throw new TypeError('carriers must be a non-empty array');
  const ids = new Set();
  for (const [i, carrier] of carriers.entries()) {
    if (!carrier || typeof carrier !== 'object') throw new TypeError(`carrier ${i + 1} must be an object`);
    if (typeof carrier.id !== 'string' || carrier.id.trim() === '') throw new TypeError(`carrier ${i + 1} needs a non-empty id`);
    if (ids.has(carrier.id)) throw new TypeError(`carrier id repeated: ${carrier.id}`);
    ids.add(carrier.id);
    if (typeof carrier.text !== 'string' || carrier.text.trim() === '') throw new TypeError(`carrier ${carrier.id} needs text`);
    const slots = carrier.text.split('{marker}').length - 1;
    if (slots !== 1) throw new TypeError(`carrier ${carrier.id} must hold exactly one {marker} slot`);
  }
}

/** Throw unless count is a non-negative integer. */
function assertCount(count) {
  if (!Number.isInteger(count) || count < 0) throw new TypeError('count must be a non-negative integer');
}

/** Split `total` over `buckets` as evenly as possible: every bucket gets floor(total/buckets), the first remainder get one more. */
function quotas(total, buckets) {
  const base = Math.floor(total / buckets);
  const extra = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Count trials by a derived value; booleans and null become stable string keys. */
function countBy(items, pick) {
  const counts = {};
  for (const item of items) {
    const value = pick(item);
    const key = value === null ? 'null' : String(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Deletion trials: every plant/delete combination is balanced, non-destructive trials share accounts in groups of 25, and
 * each account-destroying trial gets its own account and does not expect its controls to survive.
 * @param {{ seed?: string, count?: number, carriers: { id: string, text: string }[] }} options
 * @returns {any[]}
 */
export function deletionTrials({ seed = 'capsule-trials-v1', count = 3000, carriers } = {}) {
  assertCarriers(carriers);
  assertCount(count);
  const r = rng(String(seed));
  const used = new Set();
  const combos = [];
  for (const plantVia of G4_PLANT_VIA) for (const deleteVia of G4_DELETE_VIA) combos.push({ plantVia, deleteVia });
  const sizes = quotas(count, combos.length);
  const trials = [];
  let trialNo = 0;
  let nextAccount = 1;
  let openAccount = null;
  let openSize = 0;
  for (const [comboIndex, { plantVia, deleteVia }] of combos.entries()) {
    const destructive = DESTRUCTIVE_DELETE_VIA.has(deleteVia);
    for (let j = 0; j < sizes[comboIndex]; j++) {
      trialNo++;
      const index = trialNo - 1;
      let account;
      if (destructive) {
        // The account is gone after this trial, so sharing it would make the next trial unreadable.
        account = `acct-g4-${pad(nextAccount++, 3)}`;
      } else {
        if (openAccount === null || openSize === ACCOUNT_GROUP_SIZE) {
          openAccount = `acct-g4-${pad(nextAccount++, 3)}`;
          openSize = 0;
        }
        account = openAccount;
        openSize++;
      }
      const carrier = carriers[index % carriers.length];
      const marker = markerInRange(r, used, 0, 49999);
      const controls = [1, 2].map((step) => {
        const controlCarrier = carriers[(index + step) % carriers.length];
        const controlMarker = markerInRange(r, used, 0, 49999);
        return { marker: controlMarker, carrierId: controlCarrier.id, plantText: fillCarrier(controlCarrier, controlMarker) };
      });
      trials.push({
        trialId: `g4-${pad(trialNo, 4)}`,
        account,
        marker,
        carrierId: carrier.id,
        plantText: fillCarrier(carrier, marker),
        plantVia,
        deleteVia,
        relearn: G4_RELEARN[j % G4_RELEARN.length],
        scan: [...G4_SCAN],
        controls,
        expect: { markerAfterDelete: 0, controlsSurvive: !destructive },
      });
    }
  }
  return trials;
}

/**
 * Visibility expectation for one G5 writer/reader pair, from the rule table and nothing else.
 * @param {{ project: string|null, geoShared: boolean }} writer
 * @param {string} reader
 * @returns {boolean}
 */
export function isolationExpectation(writer, reader) {
  const labelled = typeof writer?.project === 'string';
  switch (reader) {
    case 'other-account':
    case 'geo-nonmember':
    case 'after-member-removed':
      return false;
    case 'geo-member':
      return writer?.geoShared === true;
    case 'same-account-other-project':
    case 'same-account-no-project':
      return !labelled;
    default:
      return false;
  }
}

/** Exactly the nearest whole number of trials, at seeded random positions, are marked concurrent. */
function concurrencyFlags(count, r) {
  const flags = Array.from({ length: count }, () => false);
  const picks = Math.round(count * 0.3);
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = 0; i < picks; i++) {
    const j = i + randomInt(r, 0, order.length - i - 1);
    [order[i], order[j]] = [order[j], order[i]];
    flags[order[i]] = true;
  }
  return flags;
}

/**
 * Isolation trials: the reader rotates round-robin, writer projects follow the geo/same-account assignment rules, and the
 * expectation is always the pure table lookup.
 * @param {{ seed?: string, count?: number, carriers: { id: string, text: string }[] }} options
 * @returns {any[]}
 */
export function isolationTrials({ seed = 'capsule-trials-v1', count = 600, carriers } = {}) {
  assertCarriers(carriers);
  assertCount(count);
  const r = rng(String(seed));
  const used = new Set();
  const concurrent = concurrencyFlags(count, r);
  const readerSeen = Object.fromEntries(G5_READERS.map((reader) => [reader, 0]));
  const trials = [];
  let geoProjects = 0;
  let projects = 0;
  for (let index = 0; index < count; index++) {
    const reader = G5_READERS[index % G5_READERS.length];
    const rank = readerSeen[reader]++;
    const account = `acct-g5-${pad(index + 1, 3)}`;
    let writer;
    if (GEO_READERS.has(reader)) {
      // Half of each geo reader's trials are shared into the geo group with a named project; the rest are not.
      const geoShared = rank % 2 === 0;
      writer = { account, project: geoShared ? `geo-proj-${pad(++geoProjects, 3)}` : null, geoShared };
    } else {
      // Half of each same-account reader's trials name a project; an unlabelled entry has no project.
      const hasProject = rank % 2 === 0;
      writer = { account, project: hasProject ? `proj-${pad(++projects, 3)}` : null, geoShared: false };
    }
    const carrier = carriers[index % carriers.length];
    const marker = markerInRange(r, used, 50000, 99999);
    trials.push({
      trialId: `g5-${pad(index + 1, 4)}`,
      marker,
      carrierId: carrier.id,
      plantText: fillCarrier(carrier, marker),
      writer,
      reader,
      probes: [...G5_PROBES],
      concurrent: concurrent[index],
      expectVisible: isolationExpectation(writer, reader),
    });
  }
  return trials;
}

/** Parse `--name value` and `--name=value` CLI arguments. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
      args[arg.slice(2)] = argv[++i];
    } else {
      args[arg.slice(2)] = 'true';
    }
  }
  return args;
}

/** CLI entry point: write both plan files and print counts per field value. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.carriers == null || args.out == null) {
    process.stderr.write('usage: node synthetic/trialPlans.mjs --carriers file.json --seed X --out dir\n');
    process.exitCode = 1;
    return;
  }
  const carriers = JSON.parse(readFileSync(args.carriers, 'utf8'));
  const seed = args.seed ?? 'capsule-trials-v1';
  const g4Count = Number(args['g4-count'] ?? args.count ?? 3000);
  const g5Count = Number(args['g5-count'] ?? args.count ?? 600);
  const g4 = deletionTrials({ seed, count: g4Count, carriers });
  const g5 = isolationTrials({ seed, count: g5Count, carriers });
  mkdirSync(args.out, { recursive: true });
  const write = (name, trials) => writeFileSync(join(args.out, name), `${JSON.stringify({ schema: TRIALS_SCHEMA, seed, count: trials.length, trials }, null, 2)}\n`);
  write('g4-trials.json', g4);
  write('g5-trials.json', g5);
  const summary = {
    g4: {
      count: g4.length,
      plantVia: countBy(g4, (t) => t.plantVia),
      deleteVia: countBy(g4, (t) => t.deleteVia),
      relearn: countBy(g4, (t) => t.relearn),
      controlsSurvive: countBy(g4, (t) => t.expect.controlsSurvive),
    },
    g5: {
      count: g5.length,
      reader: countBy(g5, (t) => t.reader),
      concurrent: countBy(g5, (t) => t.concurrent),
      expectVisible: countBy(g5, (t) => t.expectVisible),
      geoShared: countBy(g5, (t) => t.writer.geoShared),
      project: countBy(g5, (t) => (t.writer.project === null ? 'null' : 'string')),
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
