#!/usr/bin/env node
// Writes the evidence incidents the learning loop recorded as eval cases (evidence-flywheel plan §5.5, F15, 2026-10-06; principle 6).
//
// A running server cannot write repository files, so the loop writes an `evidence-incident` document for each correction or withdrawal of a published
// card and this script, run by a person with the database URL, turns the pending exportable ones into `evals/evidence-incidents/cases/<id>.json` — the
// shape of `evals/writing-incidents/cases/` — and marks each exported. Only incidents of cards the platform produced, or whose author opened them to the
// internet, are exportable; a platform-visible card's incident stays a ledger row and is never listed here. A case file that already exists is left as it
// is (the marking still happens), so running it twice writes nothing twice.
//
//   OPEN_SCIENCE_DATABASE_URL=… node scripts/evals/export-evidence-incidents.mjs [--out evals/evidence-incidents/cases] [--dry-run] [--limit 100]
//
// `--dry-run` lists what would be written and marks nothing. Nothing is printed of a card beyond the case's own id.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { evidenceIncidentCase } from "../../apps/server/src/evidenceIncidents.mjs";
import { EVIDENCE_PROJECT_ID } from "../../apps/server/src/internalProjects.mjs";
import { ProductDocuments } from "../../apps/server/src/productStore.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CASES_DIR = path.join(repoRoot, "evals/evidence-incidents/cases");

/**
 * Write the pending exportable incidents as case files and mark them exported.
 * @param {{ database: any, outDir?: string, dryRun?: boolean, limit?: number, now?: () => Date, ownerId?: string, projectId?: string }} options
 * @returns {Promise<{ written: string[], existing: string[], pending: number }>}
 */
export async function exportEvidenceIncidents({ database, outDir = DEFAULT_CASES_DIR, dryRun = false, limit = 100, now = () => new Date(), ownerId = PLATFORM_PUBLISHER_USER_ID, projectId = EVIDENCE_PROJECT_ID }) {
  const documents = new ProductDocuments(database);
  const page = await documents.list(ownerId, "knowledge", { limit: Math.max(1, Math.min(100, limit)), projectId,
    filter: { recordType: "evidence-incident", exportable: true, exportedAt: null } });
  // Oldest first, so the files appear in the order things happened.
  const pending = page.items.slice().reverse();
  /** @type {string[]} */ const written = [];
  /** @type {string[]} */ const existing = [];
  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });
  for (const row of pending) {
    const made = evidenceIncidentCase(row.payload);
    if (!/^[a-z0-9][a-z0-9._-]{0,200}$/.test(made.id)) continue;
    const file = path.join(outDir, `${made.id}.json`);
    const present = fs.existsSync(file);
    (present ? existing : written).push(made.id);
    if (dryRun) continue;
    if (!present) fs.writeFileSync(file, `${JSON.stringify(made, null, 2)}\n`, { flag: "wx" });
    // A counter-like update of the record: marking it exported moves its revision and keeps its content's history.
    await documents.put(ownerId, "knowledge", row.id, { ...row.payload, exportedAt: now().toISOString() }, { expectedRevision: row.revision, projectId, telemetry: true });
  }
  return { written, existing, pending: pending.length };
}

function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

/** @param {string[]} argv @param {string} name */
const flag = (argv, name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

async function main() {
  const argv = process.argv.slice(2);
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const outDir = flag(argv, "--out");
    const limit = flag(argv, "--limit");
    const result = await exportEvidenceIncidents({ database, dryRun: argv.includes("--dry-run"), ...(outDir ? { outDir: path.resolve(outDir) } : {}), ...(limit ? { limit: Number(limit) } : {}) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`export_evidence_incidents_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
