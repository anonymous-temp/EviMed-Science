#!/usr/bin/env node
// Operator-only offline derivation. No model requests or research-runtime dispatch.
import path from "node:path";
import { createPaperGoldEvaluator } from "../../apps/server/src/paperGoldEvaluator.mjs";
const [directory, sourceCycleId, cycleId, ...methodIds] = process.argv.slice(2);
if (!directory || !sourceCycleId || !cycleId) throw new Error("Supply protected evaluation directory, source cycle, new cycle, and optional frozen method IDs.");
const evaluator = createPaperGoldEvaluator({ config: { dataDir: path.resolve(directory), evaluationDataDir: path.resolve(directory) } });
process.stdout.write(`${JSON.stringify(await evaluator.prepareBenchmarks({ sourceCycleId, cycleId, methodIds }))}\n`);
