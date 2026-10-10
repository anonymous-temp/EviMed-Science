// A rule the owner's table declares is a rule the code reads, under its name, or the table says why it is not (Q-10). Six groups of
// constants sat in `geo/metrics.json` that no code read — VF_PROVIDER_VALID_SHARE_MIN, IRON_02_*, CONTROL_CLUSTER_SHARE_*, STD_MIN_*,
// RECHECK_WEEKS, EC_CLOSE_REPEATS — and two of them were already restated by hand in the code that should have read them, where a
// change to the table would have gone nowhere. The table's `_provenance` now lists what nothing reads: `documentation_only` (no
// behaviour implements it, and why) and `held_by_copy` (a copy of the same number sits in code, held equal here).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GEO_METRICS, GEO_PROBE_SANITY, geoConstant } from "@evimed/domain";
import { GEO_SCHEDULE } from "../src/geoOrchestrator.mjs";
import { GEO_CONTROL_RANGE, GEO_MEASURED_RANGE } from "../src/geoWrites.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE_ROOTS = [path.join(root, "apps", "server", "src"), path.join(root, "packages", "domain", "src")];

/** @param {string} directory @returns {Promise<string[]>} */
async function sourceFiles(directory) {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const provenance = /** @type {Record<string, Record<string, string>>} */ (/** @type {unknown} */ (GEO_METRICS._provenance));
const names = Object.keys(GEO_METRICS.constants);
const documentationOnly = provenance.documentation_only ?? {};
const heldByCopy = provenance.held_by_copy ?? {};

/**
 * The keys of the table under which a constant's name is written as a value (`gvi.cap`, `net_effect.window_weeks`, …): code that reads
 * the constant through that key reads it by name.
 * @returns {Map<string, string>}
 */
function pointerKeys() {
  /** @type {Map<string, string>} */
  const keys = new Map();
  /** @param {unknown} value @param {string} key */
  const walk = (value, key) => {
    if (typeof value === "string") { if (names.includes(value)) keys.set(value, key); return; }
    if (Array.isArray(value)) { for (const entry of value) walk(entry, key); return; }
    if (value && typeof value === "object") for (const [child, entry] of Object.entries(value)) walk(entry, child);
  };
  for (const [section, value] of Object.entries(GEO_METRICS)) if (section !== "constants" && section !== "_provenance") walk(value, section);
  return keys;
}

/** The code the rules are read in, as one text. */
async function code() {
  return (await Promise.all((await Promise.all(SOURCE_ROOTS.map(sourceFiles))).flat().map((file) => readFile(file, "utf8")))).join("\n");
}

/** @param {string} text @param {string} name */
const readsByName = (text, name) => new RegExp(String.raw`\b(?:geoConstant|catalogue)\(\s*["'\x60]${name}["'\x60]`, "u").test(text);
/** @param {string} text @param {string} key */
const readsThroughKey = (text, key) => new RegExp(String.raw`\b(?:geoConstant|catalogue)\(\s*[\w.]*\.${key}\b`, "u").test(text);

test("every rule geo/metrics.json declares is read by code under its name, or the table says why it is not (Q-10)", async () => {
  const text = await code();
  const through = pointerKeys();
  const read = names.filter((name) => readsByName(text, name) || (through.has(name) && readsThroughKey(text, /** @type {string} */ (through.get(name)))));
  const listed = new Set([...Object.keys(documentationOnly), ...Object.keys(heldByCopy)]);

  assert.ok(read.length >= 16, `the scan finds the rules the code reads (${read.length})`);
  assert.deepEqual(names.filter((name) => !read.includes(name) && !listed.has(name)), [],
    "a rule nothing reads must say why in `_provenance.documentation_only` or `_provenance.held_by_copy`, or the code must read it");
  assert.deepEqual([...listed].filter((name) => read.includes(name)), [],
    "a rule the code reads is not documentation-only: take it off the list");
  assert.deepEqual([...listed].filter((name) => !names.includes(name)), [], "only a constant of the table can be listed");
  assert.deepEqual(Object.keys(documentationOnly).filter((name) => name in heldByCopy), [], "one list for each rule");
  for (const [name, reason] of [...Object.entries(documentationOnly), ...Object.entries(heldByCopy)]) {
    assert.ok(typeof reason === "string" && reason.length >= 40, `${name} says why in a sentence`);
  }
});

test("the rules the code restated by hand are read from the table: the control groups, their share, the minimal set (Q-10)", () => {
  const share = [Number(geoConstant("CONTROL_CLUSTER_SHARE_MIN")), Number(geoConstant("CONTROL_CLUSTER_SHARE_MAX"))];
  const groups = [GEO_METRICS.net_effect.control_group_count_min, GEO_METRICS.net_effect.control_group_count_max];
  const minimal = Number(geoConstant("SINGLE_STEP_MIN_QUESTIONS"));
  // The delivery contract holds no bounds of its own any more (G10f); the lock check's are the table's with the five points of tolerance it has always given the share.
  assert.deepEqual([...GEO_CONTROL_RANGE.groups], groups);
  assert.deepEqual([...GEO_CONTROL_RANGE.share], [Math.round((share[0] - 0.05) * 100) / 100, Math.round((share[1] + 0.05) * 100) / 100]);
  assert.equal(GEO_MEASURED_RANGE.minimal[0], minimal);
});

test("the copies of a rule that sit in code are the table's, until the code reads the table (Q-10)", () => {
  // name -> [what the code holds, how it is held]. Every `held_by_copy` entry has its line here, and a line for a rule that is read by
  // name too is a second guard: the orchestrator's schedule restates the sentinel and noise numbers beside the queue's own reads.
  /** @type {Record<string, unknown>} */
  const copies = {
    RECHECK_WEEKS: [...GEO_SCHEDULE.postPublicationWeeks],
    MI_SENTINEL_ENGINE_COUNT: GEO_SCHEDULE.sentinelEngines,
    PROBE_SANITY_MIN_ANSWER_CHARS: GEO_PROBE_SANITY.min_answer_chars,
    MI_SENTINEL_QUESTION_COUNT: GEO_SCHEDULE.sentinelQuestions,
    PROBE_NOISE_QUESTION_COUNT: GEO_SCHEDULE.noiseQuestions,
    PROBE_NOISE_SAMPLE_N: GEO_SCHEDULE.noiseRepeat,
  };
  for (const [name, held] of Object.entries(copies)) assert.deepEqual(held, geoConstant(name), name);
  assert.deepEqual(Object.keys(heldByCopy).filter((name) => !(name in copies)), [], "a rule held by copy is pinned here");
});
