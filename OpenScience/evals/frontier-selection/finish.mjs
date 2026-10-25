#!/usr/bin/env node
/**
 * Turns a run file's raw model answers into scored rows (c3-select S8): the code side of the score, applied after the model — the
 * authority term, the ceilings (`frontierScoreCeilings`) and the total — so a ceiling can be fitted on dev without another model call.
 *
 *   node evals/frontier-selection/finish.mjs <run.json> [--no-ceilings] [--out <file>]
 *
 * The rows it writes are what `metrics.mjs --run` reads: `n`, `total`, `parts`, `practice`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as domain from "../../packages/domain/index.mjs";
import { loadGold } from "./metrics.mjs";

/** The score of a gold item from the model's raw parts and what the platform holds. @param {any} row @param {any} answer @param {{ ceilings?: boolean }} [options] */
export function scoredRow(row, answer, { ceilings = true } = {}) {
  const raw = answer.scoresRaw ?? answer.scores ?? null;
  if (!raw) return { n: row.n, total: null, parts: null, error: answer.error ?? "no_scores" };
  const max = domain.FRONTIER_SCORE_MAXIMA;
  const fixedType = domain.frontierEvidenceFromPublicationTypes(row.publication_types ?? []).evidenceType;
  const evidenceType = fixedType ?? answer.evidenceType ?? row.evidence_type;
  const preprint = row.source.type === "preprint";
  const authority = domain.frontierAuthorityScore({ authority: row.source.authority, evidenceType, preprint });
  const model = {
    impact: Math.min(max.impact, Math.max(0, raw.impact)), novelty: Math.min(max.novelty, Math.max(0, raw.novelty)), relevance: Math.min(max.relevance, Math.max(0, raw.relevance)),
  };
  let parts = { authority, ...model };
  let capped = [];
  if (ceilings && typeof domain.frontierScoreCeilings === "function") {
    const result = domain.frontierScoreCeilings({ parts, genre: row.genre, evidenceType, evidenceFixed: Boolean(fixedType), sourceType: row.source.type, authority: row.source.authority,
      sourceId: row.source.id, sourceName: row.source.name, preprint, studyFacts: null, flags: row.flags ?? [] });
    parts = result.parts; capped = result.reasons;
  }
  return { n: row.n, parts, total: parts.authority + parts.impact + parts.novelty + parts.relevance, capped, practice: answer.practice ?? null, evidenceType };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "no-ceilings": { type: "boolean", default: false }, out: { type: "string" } } });
  const run = JSON.parse(readFileSync(resolve(positionals[0]), "utf8"));
  const byN = new Map(loadGold().map((row) => [row.n, row]));
  const results = run.results.map((answer) => scoredRow(byN.get(answer.n), answer, { ceilings: !values["no-ceilings"] }));
  const out = values.out ?? resolve(positionals[0]).replace(/\.json$/, values["no-ceilings"] ? ".rows-raw.json" : ".rows.json");
  writeFileSync(out, `${JSON.stringify({ source: positionals[0], results }, null, 1)}\n`);
  process.stdout.write(`${out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) await main();
