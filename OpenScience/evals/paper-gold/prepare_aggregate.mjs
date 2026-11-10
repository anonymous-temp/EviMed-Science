// Operator-only local curation runner. R executes trusted formulas with preserved primary inputs; nothing here calls a model or the server.
//
//   node evals/paper-gold/prepare_aggregate.mjs /protected/evaluation-control diagnostic-posterior|decision-net-benefit
//
// Reads the preserved primary arithmetic seed `paper-gold/method-sources/<methodId>.json`, checks each case against its preserved source (hash, independent QA,
// every reference number printed in the source and bounded by tolerance.mjs), reproduces the numbers with aggregate_reference.py (R), and freezes
// `paper-gold/candidate-cases/<methodId>.json`. A reference the R formula does not reproduce stops the run; it is never loosened to fit.
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { numericScore } from "./evaluator.mjs";
import { curatedReference } from "./tolerance.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const METHODS = ["diagnostic-posterior", "decision-net-benefit"];
const [dataDir, methodId] = process.argv.slice(2);
if (!dataDir || !METHODS.includes(methodId)) throw new Error(`Usage: node evals/paper-gold/prepare_aggregate.mjs /protected/evaluation-control ${METHODS.join("|")}`);
const referenceFile = new URL("./aggregate_reference.py", import.meta.url);
const code = await readFile(referenceFile, "utf8");
const directory = path.join(path.resolve(dataDir), "paper-gold", "method-sources");
const seed = JSON.parse(await readFile(path.join(directory, `${methodId}.json`), "utf8"));
if (seed.methodId !== methodId || new Set(seed.cases.map(row => row.publicationId)).size < 2) throw new Error("Two independent primary publications are required.");
/** The independent R reference of one specification: the last stdout line is the JSON of its numbers. @param {any} specification */
function independentlyComputed(specification) {
  const run = spawnSync("python3", ["-I", referenceFile.pathname], { input: JSON.stringify({ referenceMethod: methodId, specification }), encoding: "utf8", timeout: 60000, maxBuffer: 65536, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
  if (run.status !== 0) throw new Error("Independent R reference execution is unavailable.");
  return JSON.parse(run.stdout.trim().split("\n").at(-1)).numeric;
}
const root = await realpath(directory);
const cases = [];
for (let reference of seed.cases) {
  if (!/^[A-Za-z0-9_.-]+$/.test(reference.sourceFile)) throw new Error("Invalid primary source path.");
  const sourcePath = await realpath(path.join(root, reference.sourceFile));
  if (!sourcePath.startsWith(`${root}${path.sep}`)) throw new Error("Primary source escaped evaluator storage.");
  const source = await readFile(sourcePath, "utf8");
  if (hash(source) !== reference.sourceHash || reference.independentQa?.passed !== true) throw new Error("Preserved primary source or extraction QA changed.");
  const frozenNumeric = {};
  for (const [key, row] of Object.entries(reference.numeric)) {
    const numeric = /** @type {any} */ (row);
    if (typeof numeric.sourceToken !== "string" || !source.includes(numeric.sourceToken)) throw new Error("Published numerical quotation bond failed.");
    // The token has to print this very number, and its tolerance is the printed precision unless the seed names a reason inside the rule's bounds (tolerance.mjs).
    const curated = curatedReference({ value: numeric.value, printed: numeric.sourceToken, quantity: numeric.quantity, absoluteTolerance: numeric.absoluteTolerance, relativeTolerance: numeric.relativeTolerance, toleranceReason: numeric.toleranceReason }, { allowLoosening: true });
    if (!curated.ok) throw new Error(`Published numerical reference refused: ${curated.code}.`);
    frozenNumeric[key] = { ...numeric, ...curated.reference };
  }
  reference = { ...reference, numeric: frozenNumeric };
  const computed = independentlyComputed(reference.input.specification);
  if (!Object.entries(reference.numeric).every(([key, value]) => numericScore(computed[key], value).valid)) throw new Error(`Published arithmetic disagreement: ${reference.id}.`);
  cases.push({ ...reference, hidden: true, kind: "published", independentQa: { ...reference.independentQa, reviewer: "independent_R_formula_execution", passed: true },
    independentImplementation: { implementationId: "trusted_primary_formula_R", numeric: Object.fromEntries(Object.keys(reference.numeric).map(key => [key, computed[key]])) } });
}
const definition = { methodId, frozen: true, publicInputCount: 2, cases, note: seed.note, referenceCodeHash: hash(code) };
const destination = path.join(path.resolve(dataDir), "paper-gold", "candidate-cases", `${methodId}.json`);
await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
await writeFile(destination, JSON.stringify(definition), { mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify({ methodId, caseIds: cases.map(row => row.id), publishedReferenceCount: new Set(cases.map(row => row.publicationId)).size, hash: hash(JSON.stringify(definition)) })}\n`);
