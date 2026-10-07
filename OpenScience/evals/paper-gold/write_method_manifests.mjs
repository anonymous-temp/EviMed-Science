#!/usr/bin/env node
// Operator-only: write the public manifests of the existing-engine method ruler from a scored receipt.
//
//   node evals/paper-gold/write_method_manifests.mjs <evaluation-dir> <methodId>:<reportHash> [...]
//
// A manifest is what the repository may hold about a ruler: identities, source hashes, how a case was
// admitted, and the outcome counts. No input and no reference number appears in one. The counts are
// taken from the control plane's own re-scoring of the receipt (`importExistingEngineReceipt`), so a
// manifest cannot say more than that scoring finds: every case that entered, with agree, disagree and
// could-not-run, and what was excluded before scoring and why.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { importExistingEngineReceipt } from "../../apps/server/src/existingEngineCalibration.mjs";

const [dataDir, ...receipts] = process.argv.slice(2);
if (!dataDir || !receipts.length || receipts.some(item => !/^[A-Za-z0-9_-]{1,100}:[a-f0-9]{64}$/.test(item))) throw new Error("Usage: node write_method_manifests.mjs <evaluation-dir> <methodId>:<reportHash> [...]");
const here = new URL("./", import.meta.url);
const files = { meta: "published-meta-method-manifest.json", pharmacovigilance: "published-faers-method-manifest.json", mr: "published-mr-method-manifest.json" };
const current = {};
for (const item of receipts) {
  const [methodId, reportHash] = item.split(":");
  const { units, ...receipt } = await importExistingEngineReceipt({ dataDir: path.resolve(dataDir), methodId, reportHash });
  const bytes = await fs.readFile(path.join(dataDir, "paper-gold", "candidate-cases", `${methodId}.json`), "utf8"), definition = JSON.parse(bytes);
  const excluded = definition.excluded ?? definition.rejected ?? [];
  const reasons = {};
  for (const row of excluded) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  const manifest = {
    schemaVersion: 2, methodId, track: units[0]?.track ?? null, engineId: receipt.engineId, executionKind: receipt.executionKind, benchmarkType: "method", controlPlaneOnlyGold: true,
    referenceHash: createHash("sha256").update(bytes).digest("hex"),
    status: "method-ruler-scored-every-admitted-case-reported-not-full-research",
    // What the row measures, in a sentence a reader cannot mistake for more.
    measures: receipt.executionKind === "library-component"
      ? "Two functions of the TwoSampleMR library on published per-variant inputs. The platform's MR engine (instrument selection, harmonisation, allele flips) is not executed and is not measured by this row."
      : "The engine's own statistics function on the frozen inputs of every admitted case.",
    referenceKinds: [...new Set(definition.cases.map(row => row.kind))],
    admission: definition.admission ?? null,
    rowsEntered: definition.rowsEntered ?? definition.cases.length + excluded.length, cases: definition.cases.length, excludedBeforeScoring: { count: excluded.length, reasons },
    distinctPublishedSources: new Set(definition.cases.map(row => row.publicationId)).size,
    ...(definition.sources ? { sources: definition.sources } : {}),
    references: definition.cases.map(row => ({ id: row.id, kind: row.kind, publicationId: row.publicationId, sourceHash: row.sourceHash, independentImplementation: row.independentImplementation?.implementationId ?? null,
      ...(row.referenceConsistency ? { referenceConsistency: row.referenceConsistency } : {}), outcome: units.find(unit => unit.caseId === row.id).outcome })),
    fullResearchReproductions: 0, actualCalibrationReceipt: receipt,
  };
  await fs.writeFile(new URL(files[receipt.engineId], here), `${JSON.stringify(manifest, null, 2)}\n`);
  current[receipt.engineId] = { methodId, manifest: files[receipt.engineId], executionKind: receipt.executionKind, reportHash, cases: receipt.cases, agree: receipt.agree, disagree: receipt.disagree, couldNotRun: receipt.couldNotRun,
    excludedBeforeScoring: receipt.excludedBeforeScoring, publishedSources: receipt.publishedSources, sourcesFullyAgreeing: receipt.sourcesFullyAgreeing, fullResearchReproductions: 0 };
  process.stdout.write(`${JSON.stringify(current[receipt.engineId])}\n`);
}
const indexFile = new URL("engine-reference-manifest.json", here), index = JSON.parse(await fs.readFile(indexFile, "utf8"));
index.currentPublishedCalibration = { ...index.currentPublishedCalibration, ...current };
await fs.writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
