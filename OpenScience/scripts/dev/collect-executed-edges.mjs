#!/usr/bin/env node
/**
 * Merge the execution receipts real runs left into the evaluation corpus.
 *
 * Hidden knowledge: this step is separate, manual and boring on purpose. The
 * control plane writes one receipt file per finished run, under the project's
 * own meta directory, and nothing in the running system ever touches
 * `evals/tool-graph/executed-edges.jsonl`. That file decides which tool chains
 * the paired evaluation is allowed to build tasks on — it is the corpus's
 * definition of "this pair really runs" — and a server that could append to it
 * while serving traffic would be a system that quietly widens what it is
 * measured against. Someone runs this, looks at the diff, and commits it.
 *
 * The merge is a union keyed by `(capability, from, to)`, keeping the first run
 * id that established each pair. Deliberately not "the most recent": the id is
 * there so a reader can go and check the claim, and rewriting it on every
 * collection would keep pointing at runs whose transcripts have since been
 * pruned.
 *
 * Usage:
 *   node scripts/dev/collect-executed-edges.mjs --from=<dir> [--out=<file>] [--check] [--capability=<id>]
 *
 *   --from        a directory searched recursively for `tool-edges/*.jsonl`
 *                 (a data root, a single project, or an exported bundle)
 *   --out         defaults to evals/tool-graph/executed-edges.jsonl
 *   --check       report what would change and exit 1 if anything would, so CI
 *                 can hold the corpus to what is committed
 *   --capability  keep only one capability's receipts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT = path.join(root, "evals", "tool-graph", "executed-edges.jsonl");

const USAGE = `Usage: node scripts/dev/collect-executed-edges.mjs --from=<dir> [--out=<file>] [--check] [--capability=<id>]

  --from=<dir>         directory searched recursively for tool-edges/*.jsonl receipts
  --out=<file>         corpus file to merge into (default evals/tool-graph/executed-edges.jsonl)
  --check              write nothing; exit 1 if the corpus would change
  --capability=<id>    keep only this capability's receipts
`;

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith("--")) continue;
    const [name, value] = entry.slice(2).split("=");
    args[name] = value === undefined ? true : value;
  }
  return args;
}

/**
 * Every receipt file under a directory.
 * @param {string} dir @param {number} [depth]
 * @returns {string[]}
 */
export function receiptFiles(dir, depth = 0) {
  if (depth > 8) return [];
  /** @type {string[]} */
  const found = [];
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Never follow a link out of the tree being collected: a receipt directory
    // lives inside user data, and this runs on an operator's machine.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { found.push(...receiptFiles(full, depth + 1)); continue; }
    if (path.basename(dir) === "tool-edges" && entry.name.endsWith(".jsonl")) found.push(full);
  }
  return found.sort();
}

/**
 * Union of every receipt, keyed by the pair, first run id wins.
 *
 * A receipt with no run id behind it is dropped here as well as at the graph
 * builder. Two refusals of the same thing is not duplication: this one keeps
 * the corpus file clean, and that one is what makes the corpus trustworthy even
 * if someone hand-edits it afterwards.
 *
 * @param {readonly string[]} texts
 * @param {{capability?: string}} [options]
 * @returns {{edges: any[], skipped: string[]}}
 */
export function mergeReceipts(texts, options = {}) {
  /** @type {Map<string, any>} */
  const byPair = new Map();
  /** @type {string[]} */
  const skipped = [];
  for (const [fileIndex, text] of texts.entries()) {
    for (const [lineIndex, line] of String(text ?? "").split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        skipped.push(`file ${fileIndex}, line ${lineIndex + 1}: unreadable`);
        continue;
      }
      if (!raw?.capability || !raw?.from || !raw?.to || !raw?.validatedBy) {
        skipped.push(`file ${fileIndex}, line ${lineIndex + 1}: incomplete receipt`);
        continue;
      }
      if (options.capability && raw.capability !== options.capability) continue;
      const key = `${raw.capability}\u0000${raw.from}\u0000${raw.to}`;
      if (byPair.has(key)) continue;
      byPair.set(key, {
        capability: String(raw.capability),
        from: String(raw.from),
        to: String(raw.to),
        type: raw.type === "semantic" ? "semantic" : "parameter",
        validatedBy: String(raw.validatedBy),
        ...(Array.isArray(raw.matchedIdentifiers) && raw.matchedIdentifiers.length
          ? { matchedIdentifiers: raw.matchedIdentifiers.slice(0, 8).map(String) }
          : {}),
      });
    }
  }
  const edges = [...byPair.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([, edge]) => edge);
  return { edges, skipped };
}

/** @param {readonly any[]} edges @returns {string} */
export function serializeCorpus(edges) {
  return edges.length ? `${edges.map((edge) => JSON.stringify(edge)).join("\n")}\n` : "";
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.from) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }
  const from = path.resolve(String(args.from));
  const out = args.out ? path.resolve(String(args.out)) : DEFAULT_OUT;
  const files = receiptFiles(from);
  if (!files.length) {
    // Not an error, and said plainly. "No run has written a receipt yet" is a
    // true state of a deployment that has just been turned on, and reporting it
    // as a failure would teach whoever sees it to stop looking.
    process.stdout.write(`no receipt files under ${from}; nothing to merge\n`);
    return 0;
  }
  const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const { edges, skipped } = mergeReceipts(
    [existing, ...files.map((file) => fs.readFileSync(file, "utf8"))],
    args.capability ? { capability: String(args.capability) } : {},
  );
  const text = serializeCorpus(edges);
  const existingCount = existing.split("\n").filter((line) => line.trim()).length;

  if (args.check) {
    if (text === existing) {
      process.stdout.write(`executed-edges corpus is up to date (${edges.length} edge(s) from ${files.length} run receipt file(s))\n`);
      return 0;
    }
    process.stderr.write(`executed-edges corpus is stale: ${existingCount} committed, ${edges.length} after merging ${files.length} file(s)\n`);
    return 1;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, "utf8");
  process.stdout.write([
    `merged ${files.length} receipt file(s) into ${path.relative(root, out)}`,
    `  ${existingCount} edge(s) before, ${edges.length} after`,
    skipped.length ? `  ${skipped.length} line(s) skipped: ${skipped.slice(0, 3).join("; ")}` : "",
    "",
    "Rebuild the graphs so the new edges become sampleable:",
    "  node scripts/dev/build-tool-graph.mjs",
    "",
  ].filter(Boolean).join("\n"));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
