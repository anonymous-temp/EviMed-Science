import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { digest } from "./evaluator.mjs";
/** Operator-only CLI: hidden cases never travel through a runtime API. */
export async function importCases(dataDir, sourceFile) {
  const definition = JSON.parse(await readFile(sourceFile, "utf8"));
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(definition.methodId) || definition.frozen !== true || !definition.cases?.length) throw new Error("Case definition must be frozen and method-bound.");
  for (const row of definition.cases) {
    if (!row.id || row.hidden !== true || row.independentQa?.passed !== true || row.independentQa.writer === row.independentQa.reviewer || !row.independentQa.writer || !row.independentQa.reviewer || !/^[a-f0-9]{64}$/.test(row.sourceHash)) throw new Error("Each case needs hidden identity, independent extraction QA and a primary-source hash.");
    if (row.kind === "published" && (!row.publicationId || !Object.keys(row.numeric ?? {}).length || !row.input)) throw new Error("Published reference requires publication, actual inputs and independently extracted numeric outputs.");
  }
  const directory = path.join(dataDir, "paper-gold", "candidate-cases");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(await realpath(directory), `${definition.methodId}.json`);
  await writeFile(target, JSON.stringify(definition), { mode: 0o600, flag: "wx" });
  return { methodId: definition.methodId, caseIds: definition.cases.map(row => row.id), hash: digest(definition) };
}
if (process.argv[1]?.endsWith("import_cases.mjs")) {
  if (!process.env.OPEN_SCIENCE_EVALUATION_DATA_DIR || !process.argv[2]) throw new Error("Usage: OPEN_SCIENCE_EVALUATION_DATA_DIR=/protected node import_cases.mjs cases.json");
  process.stdout.write(`${JSON.stringify(await importCases(process.env.OPEN_SCIENCE_EVALUATION_DATA_DIR, process.argv[2]))}\n`);
}
