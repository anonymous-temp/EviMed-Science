#!/usr/bin/env node
/**
 * Give the 虚拟临床研究 results the old conversation path left without a subject the research object they were computed for.
 *
 *   node scripts/vcr/backfill-result-subjects.mjs                        # report, for every study that has such results
 *   node scripts/vcr/backfill-result-subjects.mjs --study <std_…>        # report, for one study
 *   node scripts/vcr/backfill-result-subjects.mjs --study <std_…> --apply
 *
 * Why it exists: a computation a conversation queued through `vcr_simulate` carried no subject, so `recordResult` — which supersedes by
 * (kind, subject) — made every design's result a version of the same one: the later replaced the earlier, whichever design it was for, and
 * the trial tab showed designs with no numbers (live study, 2026-10-07: three `design.analytic` and four `design.simulate` jobs). A result
 * is matched to its design by the job that made it — the kind of design, the endpoint and the allocation share the job's scenario states,
 * the numbers in it breaking a tie — and never guessed among several designs that fit equally well: those are listed as unmatched.
 * For the other four kinds of object (population, patient set, comparator, grid) a result is given to the study's one current object of
 * that kind, or to nobody. Then each design's newest result is the current one and every earlier one of the same design is superseded by
 * it (undoing the supersessions that crossed from one design to another), and the design points at its current result.
 *
 * The report is the same with or without `--apply`; `--apply` writes it, one transaction per study, and a second run changes nothing. It
 * prints one JSON object — ids, subjects and counts, never a result's numbers or a study's words. Reads the database the way the server
 * does (`OPEN_SCIENCE_DATABASE_URL`, or the owner-only file it names).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { VcrStore } from "../../apps/server/src/vcrStore.mjs";
import { backfillResultSubjects } from "../../apps/server/src/vcrSubjects.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string[]} argv */
export function parseBackfillArguments(argv) {
  /** @type {{ apply: boolean, studyId: string | null }} */
  const options = { apply: false, studyId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--study") {
      const next = argv[index + 1];
      if (next == null || next.startsWith("--")) throw new Error("--study needs a study id");
      index += 1;
      options.studyId = next;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (options.studyId != null && !/^[A-Za-z0-9_-]{1,80}$/.test(options.studyId)) throw new Error("--study takes a study id");
  return options;
}

/** The control-plane database, from the same sources the server reads it from. */
function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

async function main() {
  const options = parseBackfillArguments(process.argv.slice(2));
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const store = new VcrStore({ database });
    const report = await backfillResultSubjects({ store, studyId: options.studyId, apply: options.apply });
    console.log(JSON.stringify({
      mode: options.apply ? "applied" : "report only (nothing was written; pass --apply to write)",
      studies: report.studies.map((entry) => ({
        studyId: entry.studyId,
        resultsGivenASubject: entry.assigned,
        resultsLeftWithNoSubject: entry.unmatched,
        supersessionsUndone: entry.unsuperseded,
        supersessionsRestoredWithinADesign: entry.resuperseded,
        objectsPointedAtTheirCurrentResult: entry.landed,
      })),
    }, null, 2));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`backfill-result-subjects: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
