// Operator-only local curation runner. R executes trusted formulas with preserved primary inputs.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createEvolutionCasePreparation } from "../../apps/server/src/evolutionCasePreparation.mjs";
const [dataDir, methodId] = process.argv.slice(2);
if (!dataDir || !["diagnostic-posterior", "decision-net-benefit"].includes(methodId)) throw new Error("Usage: node evals/paper-gold/prepare_aggregate.mjs /protected/evaluation-control diagnostic-posterior|decision-net-benefit");
const execute = promisify(execFile);
const controller = { async execVerify({ code, input }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evimed-primary-reference-"));
  try {
    const reference = await readFile(new URL("./aggregate_reference.py", import.meta.url), "utf8");
    if (code !== reference) throw new Error("Only the checked-in trusted arithmetic reference may run locally.");
    const program = `import json,sys,io\nsys.stdin=io.StringIO(${JSON.stringify(JSON.stringify(input))})\n${code}`;
    const result = await execute("python3", ["-c", program], { cwd: directory, timeout: 60000, maxBuffer: 65536, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
    return { ok: true, joined: true, output: result.stdout };
  } finally { await rm(directory, { recursive: true, force: true }); }
} };
const result = await createEvolutionCasePreparation({ config: { evaluationDataDir: path.resolve(dataDir) }, controller }).prepareCases({ methodId });
process.stdout.write(`${JSON.stringify(result)}\n`);
