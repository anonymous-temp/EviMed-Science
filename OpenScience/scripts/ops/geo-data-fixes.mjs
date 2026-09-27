#!/usr/bin/env node
/**
 * The 2026-09-26 GEO audit's data corrections for one project, as one
 * transaction: rolled back unless `--apply` (the report is the same either
 * way), idempotent under `--apply` (a second run changes nothing).
 *
 *   node scripts/ops/geo-data-fixes.mjs --geo-project <id>                      # dry run: what would change, numbers before and after
 *   node scripts/ops/geo-data-fixes.mjs --geo-project <id> --apply
 *     [--our-single-source true|false]              whether our generic has one approved holder (G5)
 *     [--our-generic-alias <name>]                  the generic as answers write it (玛仕度肽 for 玛仕度肽注射液); repeatable
 *     [--competitor-single-source <name>=true|false] per rival, by its brand or generic name; repeatable
 *     [--strategy-file <path>]                      the strategy run's deliverables/geo-strategy/strategy.json (G4)
 *     [--keep-owned]                                do not disown lillymedical.cn / lm.qa.lilly.cn (G22)
 *     [--disown <domain>]                           disown another domain as well; repeatable
 *     [--no-materials] [--no-collected]             skip attaching corrections (G7) / dating real phrasings (G9)
 *
 * Every run ends by counting the project's stored answers again under the
 * registry as it now stands and re-measuring every round (G2) — no model is
 * asked. It reads the database from the same sources the server does and
 * prints one JSON object with counts and the headline numbers, never a
 * record's text. Run it after the release that carries `geoDataFixes.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { GEO_NOT_OWNED_DOMAINS, runGeoDataFixes } from "../../apps/server/src/geoDataFixes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string} value @param {string} flag */
function bool(value, flag) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${flag} takes true or false`);
}

/** @param {string[]} argv */
export function parseGeoDataFixArguments(argv) {
  /** @type {{ apply: boolean, geoProjectId: string | null, ourSingleSource: boolean | null, ourGenericAliases: string[],
   *   competitorSingleSource: Record<string, boolean>, strategyFile: string | null, disown: string[], materials: boolean, collected: boolean }} */
  const options = { apply: false, geoProjectId: null, ourSingleSource: null, ourGenericAliases: [], competitorSingleSource: {}, strategyFile: null,
    disown: [...GEO_NOT_OWNED_DOMAINS], materials: true, collected: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next == null || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--apply") options.apply = true;
    else if (flag === "--geo-project") options.geoProjectId = value();
    else if (flag === "--our-single-source") options.ourSingleSource = bool(value(), flag);
    else if (flag === "--our-generic-alias") options.ourGenericAliases.push(value());
    else if (flag === "--competitor-single-source") {
      const [name, setting] = value().split("=");
      if (!name || setting == null) throw new Error(`${flag} takes <name>=true|false`);
      options.competitorSingleSource[name] = bool(setting, flag);
    } else if (flag === "--strategy-file") options.strategyFile = value();
    else if (flag === "--keep-owned") options.disown = options.disown.filter((domain) => !GEO_NOT_OWNED_DOMAINS.includes(domain));
    else if (flag === "--disown") options.disown.push(value().toLowerCase());
    else if (flag === "--no-materials") options.materials = false;
    else if (flag === "--no-collected") options.collected = false;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.geoProjectId || !/^[A-Za-z0-9_-]{1,80}$/.test(options.geoProjectId)) throw new Error("--geo-project <id> is required");
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
  const options = parseGeoDataFixArguments(process.argv.slice(2));
  const strategy = options.strategyFile ? JSON.parse(fs.readFileSync(options.strategyFile, "utf8")) : null;
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const report = await runGeoDataFixes({ database, geoProjectId: /** @type {string} */ (options.geoProjectId), apply: options.apply,
      disown: options.disown, ourSingleSource: options.ourSingleSource, ourGenericAliases: options.ourGenericAliases,
      competitorSingleSource: options.competitorSingleSource, strategy,
      materials: options.materials, collected: options.collected });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`geo_data_fixes_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
