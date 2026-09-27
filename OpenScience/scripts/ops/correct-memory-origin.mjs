#!/usr/bin/env node
/**
 * Correct whose words a stored memory holds, when extraction got it wrong.
 *
 * Written for the 2026-09-26 audit (M-2): the GEO orchestrator's own dispatch
 * brief reached the user slot with no platform tag, and the extractor stored
 * its product line as the researcher's statement (`explicit`) under the key
 * `project.geo.product`. The dispatch is tagged now; this puts the record that
 * was already written right. The value, the summary and the evidence stay as
 * they are — only the origin changes, as a revision by the platform with the
 * reason, so the page stops showing it as 「你说的」 and the history says why.
 *
 *   node scripts/ops/correct-memory-origin.mjs --user <userId> --key project.geo.product            # report only
 *   node scripts/ops/correct-memory-origin.mjs --user <userId> --key project.geo.product --apply    # correct
 *   ... [--project <projectId>] [--from explicit] [--to system] [--reason "<why>"]
 *
 * Idempotent: a corrected record no longer has the `--from` origin, so a
 * second run finds nothing. It reads and writes only the control-plane
 * database, with the configuration the server runs with, and prints ids,
 * keys and origins — never a memory's text.
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REASON = "its only evidence is a platform-dispatched brief, not the researcher's words (audit 2026-09-26, M-2)";

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { apply: false, user: "", key: "", project: "", from: "explicit", to: "system", reason: DEFAULT_REASON };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { options.apply = true; continue; }
    const field = { "--user": "user", "--key": "key", "--project": "project", "--from": "from", "--to": "to", "--reason": "reason" }[argument];
    if (!field) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    /** @type {any} */ (options)[field] = value;
    index += 1;
  }
  if (!options.user || !options.key) throw new Error("give --user <id> and --key <memory key>");
  if (options.from === options.to) throw new Error("--from and --to name the same origin");
  return options;
}

/**
 * The records one run would correct, and — with `apply` — the correction.
 * @param {any} researchMemory the store
 * @param {ReturnType<typeof parseArguments>} options
 */
export async function correctMemoryOrigin(researchMemory, options) {
  const records = (await researchMemory.listAllRecords(options.user))
    .filter((/** @type {any} */ record) => record.key === options.key && record.origin === options.from
      && (!options.project || (record.scope === "project" && record.scopeId === options.project)));
  const matched = records.map((/** @type {any} */ record) => ({
    id: record.id, scope: record.scope, scopeId: record.scopeId, kind: record.kind, key: record.key, origin: record.origin, version: record.version,
  }));
  if (!options.apply) return { applied: false, matched, corrected: [] };
  const corrected = [];
  for (const record of matched) {
    const result = await researchMemory.correctOrigin(options.user, record.id, { origin: options.to, reason: options.reason, expectedVersion: record.version });
    corrected.push({ id: record.id, origin: result.record.origin, version: result.record.version, changed: result.changed });
  }
  return { applied: true, matched, corrected };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [{ loadConfig }, { createStore }, { ResearchMemoryStore }] = await Promise.all([
    import("../../apps/server/src/config.mjs"),
    import("../../apps/server/src/store.mjs"),
    import("../../apps/server/src/researchMemory.mjs"),
  ]);
  const config = loadConfig();
  const store = createStore(config);
  const database = "database" in store ? store.database : null;
  try {
    if (!database) throw new Error("no control-plane database is configured");
    const result = await correctMemoryOrigin(new ResearchMemoryStore(config, { database }), options);
    process.stdout.write(`${JSON.stringify({ user: options.user, key: options.key, from: options.from, to: options.to, ...result }, null, 2)}\n`);
  } finally {
    await store.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`correct_memory_origin_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
