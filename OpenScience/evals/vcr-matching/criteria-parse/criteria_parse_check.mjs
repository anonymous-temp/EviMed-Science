#!/usr/bin/env node
/**
 * A deterministic check of how a trial's eligibility text was structured into criteria (M3).
 *
 * The parse of a registry trial's eligibility text is the weakest-measured link of every matching pipeline that parses once and reuses the
 * parse for every patient: PRISM's manual check of fifty trials found 1% of the questions missed, 2% malformed and about 89% of the Boolean
 * logic right, and a wrong line is wrong for every patient it is used on. This is the comparator for that check and a set of labelled
 * examples to run it on. It makes no model call and reads no network: a parse is a file, and so is the labelled structure.
 *
 *   node evals/vcr-matching/criteria-parse/criteria_parse_check.mjs [--parses <file>] [--out <report.json>]
 *
 * With no `--parses` it checks the stored parses beside it, which are authored, not a model's. Run on a frozen parse of the same texts
 * by the model the platform uses, it reports the figures PRISM reports. What the set can and cannot show is in README.md.
 *
 * A parse is compared to the labelled structure line by line:
 *
 * - **A line is the same line when it stands at the same characters of the eligibility text** (`locateSourceText`, the platform's own
 *   comparison: case, spacing, `>=` against `≥`, dashes and quotation marks fold; a near match is no match). The wording is how a parse
 *   is tied to the record, so it is how two parses are tied to each other.
 * - **missed**: a labelled line no parsed criterion stands at. **unlocated**: a parsed criterion whose wording is nowhere in the text (an
 *   invention or a paraphrase). **extra**: a parsed criterion that is in the text but is not a labelled line (a line split in two, a
 *   repeat, a sentence of narrative).
 * - **wrongKind**: the line is there and inclusion/exclusion is the other way round. **wrongStructure**: the line is there with its kind
 *   and its requirement or applicability is not the labelled one, after the comparison's canonical form: the operands of `all`/`any` in any
 *   order, a variable by any of its aliases, numbers as numbers, units and `op` names as written. A `language` node is a language node
 *   whatever its key and text: what it asks is the model's to answer, not the parse's to fix.
 * - **logicCorrect**: the line is there, with its kind, and its structure is the labelled one.
 *
 * Nothing here judges a patient, and an unknown is not a thing it counts: it checks a parse, not a verdict.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { validateRequirement } from "@evimed/domain";

import { locateSourceText } from "../../../apps/server/src/vcrPatientTrials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {unknown} value */
const text = (value) => String(value ?? "").trim();

/** The list marker in front of a line (`* `, `- `, `1. `, `2) `) is the list's, not the wording's: a parse that kept it is the same line. @param {unknown} value */
const bare = (value) => text(value).replace(/^(?:[*\-\u2022]|\d{1,3}[.)])\s+/u, "");

/**
 * A requirement in the form two equal readings of one line share: object keys in a fixed order, the operands of `all`/`any` sorted, a
 * variable replaced by the first name of its alias group, numbers as numbers, a `language` node reduced to the fact that it is one.
 * @param {any} node @param {Map<string, string>} aliasOf
 * @returns {any}
 */
export function canonicalRequirement(node, aliasOf = new Map()) {
  if (Array.isArray(node)) return node.map((item) => canonicalRequirement(item, aliasOf));
  if (!node || typeof node !== "object") return typeof node === "string" && /^-?\d+(\.\d+)?$/.test(node.trim()) ? Number(node) : node;
  if (node.op === "language") return { op: "language" };
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(node).sort()) {
    const value = node[key];
    if (value === undefined || value === null) continue;
    if (key === "variable") out[key] = aliasOf.get(text(value)) ?? text(value);
    else if (key === "operands") out[key] = canonicalRequirement(value, aliasOf).map((item) => JSON.stringify(item)).sort().map((item) => JSON.parse(item));
    else out[key] = canonicalRequirement(value, aliasOf);
  }
  return out;
}

/**
 * Where two canonical requirements differ, as paths (`requirement.operands[1].value`): empty when they are the same.
 * @param {any} a @param {any} b @param {string} where @returns {string[]}
 */
export function structureDifferences(a, b, where = "requirement") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      if (a.length !== b.length) return [`${where}.length`];
      return a.flatMap((item, at) => structureDifferences(item, b[at], `${where}[${at}]`));
    }
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((key) => structureDifferences(a[key], b[key], `${where}.${key}`));
  }
  return [where];
}

/**
 * One case: the labelled lines against a parse of the same text.
 * @param {{ text: string, expected: any[], parsed: any[], aliases?: string[][] }} input
 */
export function compareParse({ text: eligibility, expected, parsed, aliases = [] }) {
  const aliasOf = new Map();
  for (const group of aliases) for (const name of group) aliasOf.set(name, group[0]);
  const spans = (/** @type {any[]} */ lines) => lines.map((line) => locateSourceText(bare(line?.sourceText), eligibility));
  const expectedSpans = spans(expected);
  const parsedSpans = spans(parsed);

  /** @type {Map<number, number>} labelled index -> the parsed index that stands at it (the first) */
  const matchedTo = new Map();
  /** @type {Array<{ sourceText: string }>} */
  const unlocated = [];
  /** @type {Array<{ sourceText: string, reason: "split_or_repeated_or_narrative" }>} */
  const extra = [];
  parsed.forEach((line, at) => {
    const span = parsedSpans[at];
    if (!span) { unlocated.push({ sourceText: text(line?.sourceText) }); return; }
    const hit = expectedSpans.findIndex((candidate) => candidate && candidate.start === span.start && candidate.end === span.end);
    if (hit >= 0 && !matchedTo.has(hit)) matchedTo.set(hit, at);
    else extra.push({ sourceText: text(line?.sourceText), reason: "split_or_repeated_or_narrative" });
  });

  /** @type {Array<{ sourceText: string }>} */
  const missed = [];
  /** @type {Array<{ sourceText: string, expected: string, got: string }>} */
  const wrongKind = [];
  /** @type {Array<{ sourceText: string, differences: string[] }>} */
  const wrongStructure = [];
  let logicCorrect = 0;
  expected.forEach((line, at) => {
    if (!matchedTo.has(at)) { missed.push({ sourceText: text(line.sourceText) }); return; }
    const got = parsed[/** @type {number} */ (matchedTo.get(at))];
    if (line.kind !== got?.kind) { wrongKind.push({ sourceText: text(line.sourceText), expected: line.kind, got: text(got?.kind) }); return; }
    const differences = [
      ...structureDifferences(canonicalRequirement(line.requirement, aliasOf), canonicalRequirement(got?.requirement, aliasOf), "requirement"),
      ...structureDifferences(canonicalRequirement(line.applicability ?? null, aliasOf), canonicalRequirement(got?.applicability ?? null, aliasOf), "applicability"),
    ];
    if (differences.length) wrongStructure.push({ sourceText: text(line.sourceText), differences });
    else logicCorrect += 1;
  });
  return {
    expected: expected.length, parsed: parsed.length, matched: matchedTo.size, logicCorrect,
    missed, unlocated, extra, wrongKind, wrongStructure,
    complete: !missed.length && !unlocated.length && !extra.length && !wrongKind.length && !wrongStructure.length,
  };
}

/** @param {number} n @param {number} of */
const share = (n, of) => (of ? Math.round((n / of) * 1000) / 10 : null);

/**
 * Every case of a set against its parse, and the figures PRISM reports: the share of labelled lines missed, the share of the lines found
 * that are malformed (the wrong kind or the wrong structure), and the share of labelled lines whose logic is right. A case with no parse is
 * counted as all lines missed, never skipped.
 * @param {{ cases: Array<{ id: string, text: string, expected: any[], aliases?: string[][] }> }} set
 * @param {{ parses: Record<string, any[]> }} stored
 */
export function scoreParses(set, stored) {
  const perCase = set.cases.map((item) => ({ id: item.id, ...compareParse({ text: item.text, expected: item.expected, parsed: stored.parses?.[item.id] ?? [], aliases: item.aliases }) }));
  const total = (/** @type {(row: typeof perCase[number]) => number} */ pick) => perCase.reduce((sum, row) => sum + pick(row), 0);
  const expected = total((row) => row.expected);
  const matched = total((row) => row.matched);
  const malformed = total((row) => row.wrongKind.length + row.wrongStructure.length);
  return {
    cases: perCase.length,
    casesComplete: perCase.filter((row) => row.complete).length,
    criteria: { expected, parsed: total((row) => row.parsed), matched },
    missed: total((row) => row.missed.length),
    unlocated: total((row) => row.unlocated.length),
    extra: total((row) => row.extra.length),
    wrongKind: total((row) => row.wrongKind.length),
    wrongStructure: total((row) => row.wrongStructure.length),
    logicCorrect: total((row) => row.logicCorrect),
    percent: {
      missed: share(total((row) => row.missed.length), expected),
      malformedOfFound: share(malformed, matched),
      logicCorrect: share(total((row) => row.logicCorrect), expected),
    },
    perCase,
  };
}

/**
 * The lines of a set or a parse that the platform's own grammar would refuse (`vcr_criterion_malformed`): a parse is only worth comparing
 * if it could have been written. Returns the findings as `case: path: detail`.
 * @param {Array<{ id: string, lines: any[] }>} groups @returns {string[]}
 */
export function grammarFindings(groups) {
  /** @type {string[]} */
  const out = [];
  for (const group of groups) {
    group.lines.forEach((line, at) => {
      for (const field of ["requirement", "applicability"]) {
        if (line?.[field] === undefined || line?.[field] === null) continue;
        for (const issue of validateRequirement(line[field], { path: field })) out.push(`${group.id}[${at}].${field}: ${issue.field ?? ""} ${issue.detail ?? ""}`.trim());
      }
      if (!["inclusion", "exclusion"].includes(line?.kind)) out.push(`${group.id}[${at}].kind: not inclusion or exclusion`);
      if (line?.kind === "exclusion" && line?.requirement?.op === "not" && line.requirement.operand?.op === "not") out.push(`${group.id}[${at}]: an exclusion is written as stated, not negated twice`);
    });
  }
  return out;
}

/** Read a JSON file; a file that is not a labelled set or a parse file is refused by name. @param {string} file */
async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { throw new Error(`${file} is not readable JSON.`); }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { cases: { type: "string" }, parses: { type: "string" }, out: { type: "string" } }, strict: true }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let set;
  let stored;
  try {
    set = await readJson(values.cases ?? path.join(here, "cases.json"));
    stored = await readJson(values.parses ?? path.join(here, "stored-parses.json"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!Array.isArray(set?.cases) || !set.cases.length || !stored?.parses || typeof stored.parses !== "object") {
    process.stderr.write("The cases file needs a non-empty \"cases\" array and the parses file a \"parses\" object keyed by case id.\n");
    return 2;
  }
  const report = { synthetic: Boolean(stored.synthetic), ...scoreParses(set, stored) };
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) await writeFile(values.out, body); else process.stdout.write(body);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
