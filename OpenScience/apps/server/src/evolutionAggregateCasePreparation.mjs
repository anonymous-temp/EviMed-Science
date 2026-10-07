import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { numericScore } from "../../../evals/paper-gold/evaluator.mjs";
import { curatedReference } from "../../../evals/paper-gold/tolerance.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
export const AGGREGATE_REFERENCE_METHODS = ["diagnostic-posterior", "decision-net-benefit"];
/** Independently reproduce preserved primary-paper arithmetic with R before freezing.
 * No hidden input or expected value is returned to discovery or development. @param {any} dependencies */
export function createEvolutionAggregateCasePreparation({ config, controller }) {
  const dataDir = config.evaluationDataDir || path.join(config.dataDir, "evaluation-control");
  return {
    /** @param {any} card @param {any} [options] */
    async prepareCases(card, { signal } = {}) {
      const methodId = card.methodId ?? card.id;
      if (!AGGREGATE_REFERENCE_METHODS.includes(methodId)) return null;
      const directory = path.join(dataDir, "paper-gold", "method-sources");
      let seed;
      try { seed = JSON.parse(await readFile(path.join(directory, `${methodId}.json`), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; return { ok: false, status: "waiting_resource", resourceCode: "preserved_primary_arithmetic_unavailable" }; }
      if (seed.methodId !== methodId || new Set(seed.cases.map(row => row.publicationId)).size < 2) throw new Error("Two independent primary publications are required.");
      const code = await readFile(new URL("../../../evals/paper-gold/aggregate_reference.py", import.meta.url), "utf8");
      const cases = [];
      for (let reference of seed.cases) {
        signal?.throwIfAborted();
        if (!/^[A-Za-z0-9_.-]+$/.test(reference.sourceFile)) throw new Error("Invalid primary source path.");
        const root = await realpath(directory), sourcePath = await realpath(path.join(root, reference.sourceFile));
        if (!sourcePath.startsWith(`${root}${path.sep}`)) throw new Error("Primary source escaped evaluator storage.");
        const source = await readFile(sourcePath, "utf8");
        if (hash(source) !== reference.sourceHash || reference.independentQa?.passed !== true) throw new Error("Preserved primary source or extraction QA changed.");
        const frozenNumeric = {};
        for (const [key, row] of Object.entries(reference.numeric)) {
          const numeric = /** @type {any} */ (row);
          if (typeof numeric.sourceToken !== "string" || !source.includes(numeric.sourceToken)) throw new Error("Published numerical quotation bond failed.");
          // The token has to print this very number, and its tolerance is the printed precision unless the seed
          // names a reason inside the rule's bounds (`tolerance.mjs`). Being in the source somewhere is not a bond.
          const curated = curatedReference({ value: numeric.value, printed: numeric.sourceToken, quantity: numeric.quantity, absoluteTolerance: numeric.absoluteTolerance, relativeTolerance: numeric.relativeTolerance, toleranceReason: numeric.toleranceReason }, { allowLoosening: true });
          if (!curated.ok) throw new Error(`Published numerical reference refused: ${curated.code}.`);
          frozenNumeric[key] = { ...numeric, ...curated.reference };
        }
        reference = { ...reference, numeric: frozenNumeric };
        const result = await controller.execVerify({ files: {}, code, input: { referenceMethod: methodId, specification: reference.input.specification } }, { signal });
        if (result.ok !== true || result.joined !== true) return { ok: false, status: "waiting_resource", resourceCode: "independent_R_reference_execution_unavailable" };
        const independentlyComputed = JSON.parse(String(result.output).trim().split("\n").at(-1)).numeric;
        if (!Object.entries(reference.numeric).every(([key, value]) => numericScore(independentlyComputed[key], value).valid)) return { ok: false, status: "waiting_resource", resourceCode: "published_arithmetic_disagreement", caseIds: [reference.id] };
        cases.push({ ...reference, hidden: true, kind: "published", independentQa: { ...reference.independentQa, reviewer: "independent_R_formula_execution", passed: true }, independentImplementation: { implementationId: "trusted_primary_formula_R", numeric: Object.fromEntries(Object.keys(reference.numeric).map(key => [key, independentlyComputed[key]])) } });
      }
      const definition = { methodId, frozen: true, publicInputCount: 2, cases, note: seed.note, referenceCodeHash: hash(code) };
      const destination = path.join(dataDir, "paper-gold", "candidate-cases", `${methodId}.json`);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, JSON.stringify(definition), { mode: 0o600, flag: "wx" });
      return { ok: true, caseIds: cases.map(row => row.id), publishedReferenceCount: new Set(cases.map(row => row.publicationId)).size, publicInputCount: 2, sourceHashes: cases.map(row => row.sourceHash), access: "evaluation-only", hash: hash(JSON.stringify(definition)) };
    },
  };
}
