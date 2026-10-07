#!/usr/bin/env node
/**
 * The operator's command for the extension centre's catalogue: which reviewed
 * packages a deployment offers under 「发现」.
 *
 * Hidden knowledge: the catalogue is not a feature switch and not a database
 * table. It is one allow-list file, `<dataDir>/.openscience/extensions-deployment.json`,
 * that `extensionDeployment.mjs` reads at start-up, and a missing file is
 * "nothing configured" — which is why the page's discovery list has been empty
 * since the centre shipped: nothing ever wrote that file outside the acceptance
 * harness. The file's own checks are strict on purpose (the kernel version, the
 * digests that bind a descriptor to an artifact to a catalogue row, a mode and
 * an owner that a package cannot have written), so this command does not
 * restate them: it merges one reviewed package into the file, then asks the
 * real loader to read the result from a private copy, and writes the file only
 * if the loader accepts it. A rejected file is never left on disk.
 *
 * It never reviews a package. The descriptor it takes (`add`) is the record of a
 * review that already happened: the catalogue row, and for an isolated tool the
 * descriptor, artifact and surface rows the acceptance run measured. Nothing is
 * downloaded and no digest is computed here for a package it has not been given
 * evidence for.
 *
 * Usage:
 *   node scripts/ops/extension-catalogue.mjs list   [--data-dir DIR]
 *   node scripts/ops/extension-catalogue.mjs add    <reviewed-package.json> [--data-dir DIR] [--restamp]
 *   node scripts/ops/extension-catalogue.mjs remove <id> [--data-dir DIR]
 *
 * `--data-dir` defaults to OPEN_SCIENCE_DATA_DIR, then ./.openscience-web-data.
 * The reviewed-package file is one JSON object:
 *   { "catalogue": { id, title, coordinate, executionClass, integrity, settingsSchema },
 *     "descriptor": { ... }, "artifact": { ... }, "surface": { ... } }
 * where the last three are required for an `isolated-tool` and absent otherwise.
 * After a write the command prints the owner and mode to give the file (the
 * loader refuses a file a package could have written).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, EXTENSION_SUPPORTED_DSH_VERSION } from "@evimed/domain";
import { currentExtensionSourcePolicy, loadExtensionDeployment } from "../../apps/server/src/extensionDeployment.mjs";

const FILE = "extensions-deployment.json";
const KEYS = ["schemaVersion", "generatedAt", "dshVersion", "policy", "catalogue", "admittedArtifacts", "admittedDescriptors", "surfaces"];

/** A refusal the operator can act on: a sentence, never a stack. */
export class CatalogueError extends Error {}
/** @param {string} message */
const refuse = (message) => { throw new CatalogueError(message); };

/** @param {string} dataDir */
export const manifestPath = (dataDir) => path.join(path.resolve(dataDir), ".openscience", FILE);

/** The file's parsed content, or null where there is none. @param {string} dataDir */
export function readManifest(dataDir) {
  const target = manifestPath(dataDir);
  let text;
  try { text = fs.readFileSync(target, "utf8"); } catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") return null; throw error; }
  let manifest;
  try { manifest = JSON.parse(text); } catch { return refuse(`${target} is not JSON. Fix or remove it, then run the command again.`); }
  if (!manifest || typeof manifest !== "object" || KEYS.some((key) => !Object.hasOwn(manifest, key))) refuse(`${target} is not an extension deployment file (a field is missing).`);
  return manifest;
}

/** A new, empty file's content, stamped with the source policy of the code that is deployed now. */
export function emptyManifest() {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), dshVersion: EXTENSION_SUPPORTED_DSH_VERSION, policy: currentExtensionSourcePolicy(),
    catalogue: [], admittedArtifacts: [], admittedDescriptors: [], surfaces: [] };
}

/**
 * Whether the real loader accepts this content: it is written to a private
 * directory the way the loader demands (owner-only, mode 0400) and read back by
 * `loadExtensionDeployment`, which is the only judge of the file.
 * @param {any} manifest @returns {{ ok: boolean, catalogue: number }}
 */
export function loaderAccepts(manifest) {
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "extension-catalogue-"));
  try {
    fs.chmodSync(scratch, 0o700);
    fs.mkdirSync(path.join(scratch, ".openscience"), { mode: 0o700 });
    const target = path.join(scratch, ".openscience", FILE);
    fs.writeFileSync(target, `${canonicalJson(manifest)}\n`, { mode: 0o400 });
    const deployment = loadExtensionDeployment({ dataDir: scratch });
    return { ok: deployment.status === "configured", catalogue: deployment.catalogue.length };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** The ids a file lists, and whether each carries the rows an isolated tool needs. @param {any} manifest */
export function listing(manifest) {
  return manifest.catalogue.map((/** @type {any} */ row) => ({
    id: row.id, title: row.title, executionClass: row.executionClass,
    admitted: row.executionClass !== "isolated-tool" || (manifest.admittedDescriptors.some((/** @type {any} */ d) => d.id === row.id)
      && manifest.admittedArtifacts.some((/** @type {any} */ a) => a.id === row.id) && manifest.surfaces.some((/** @type {any} */ s) => s.id === row.id)),
  }));
}

/**
 * The file's content with one reviewed package added. An id already listed is refused (remove it first): a silent
 * replacement is how a package's digests would change under an installation that was made against the old ones.
 * @param {any} manifest @param {any} reviewed @param {{ restamp?: boolean }} [options]
 */
export function withPackage(manifest, reviewed, { restamp = false } = {}) {
  if (!reviewed || typeof reviewed !== "object" || !reviewed.catalogue || typeof reviewed.catalogue.id !== "string") refuse("The reviewed-package file needs a \"catalogue\" object with an id.");
  const id = reviewed.catalogue.id;
  if (manifest.catalogue.some((/** @type {any} */ row) => row.id === id)) refuse(`${id} is already listed. Remove it first if its review has changed.`);
  const isolated = reviewed.catalogue.executionClass === "isolated-tool";
  for (const part of ["descriptor", "artifact", "surface"]) {
    if (isolated && !reviewed[part]) refuse(`An isolated tool needs its "${part}" from the acceptance run.`);
    if (!isolated && reviewed[part]) refuse(`Only an isolated tool carries a "${part}"; ${id} is ${reviewed.catalogue.executionClass}.`);
  }
  const next = structuredClone(manifest);
  next.catalogue.push(reviewed.catalogue);
  if (isolated) {
    next.admittedDescriptors.push({ id, ...reviewed.descriptor });
    next.admittedArtifacts.push({ id, ...reviewed.artifact });
    next.surfaces.push({ id, ...reviewed.surface });
  }
  next.generatedAt = new Date().toISOString();
  if (restamp) next.policy = currentExtensionSourcePolicy();
  return next;
}

/** The file's content without one id. @param {any} manifest @param {string} id */
export function withoutPackage(manifest, id) {
  if (!manifest.catalogue.some((/** @type {any} */ row) => row.id === id)) refuse(`${id} is not listed.`);
  const next = structuredClone(manifest);
  for (const key of ["catalogue", "admittedArtifacts", "admittedDescriptors", "surfaces"]) next[key] = next[key].filter((/** @type {any} */ row) => row.id !== id);
  next.generatedAt = new Date().toISOString();
  return next;
}

/**
 * Write the file atomically, only after the loader has accepted its content.
 * Mode 0440 so the control plane's group can read it once the operator gives it
 * to root; the loader refuses any other mode and any other owner.
 * @param {string} dataDir @param {any} manifest
 */
export function writeManifest(dataDir, manifest) {
  if (!loaderAccepts(manifest).ok) refuse("The extension deployment file would be refused by the platform's own loader, so nothing was written. Check the reviewed-package file against the acceptance run.");
  const target = manifestPath(dataDir), parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  const staging = `${target}.${process.pid}.next`;
  try {
    // A previous root-owned 0440 file is replaced by rename, which needs the directory and not the file.
    fs.writeFileSync(staging, `${canonicalJson(manifest)}\n`, { mode: 0o440 });
    fs.chmodSync(staging, 0o440);
    fs.renameSync(staging, target);
  } finally { fs.rmSync(staging, { force: true }); }
  return target;
}

/** The two commands the operator still has to run, as the loader's checks require. @param {string} target */
export function ownershipCommands(target) {
  return [`sudo chown root:<the control plane's group> ${target}`, `sudo chmod 0440 ${target}`, "Then restart the web service; the file is read once at start-up."];
}

/** @param {string[]} argv @returns {{ command: string, positional: string[], flags: Record<string, string | boolean> }} */
export function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  /** @type {string[]} */ const positional = [];
  /** @type {Record<string, string | boolean>} */ const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === "--restamp") flags.restamp = true;
    else if (word === "--data-dir") { flags.dataDir = rest[index + 1] ?? refuse("--data-dir needs a directory."); index += 1; }
    else if (word.startsWith("--")) refuse(`Unknown option ${word}.`);
    else positional.push(word);
  }
  return { command, positional, flags };
}

/** @param {string[]} argv @param {{ write?: (line: string) => void }} [io] @returns {number} the exit code */
export function main(argv, { write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  try {
    const { command, positional, flags } = parseArgs(argv);
    const dataDir = String(flags.dataDir ?? process.env.OPEN_SCIENCE_DATA_DIR ?? ".openscience-web-data");
    if (command === "list" && positional.length === 0) {
      const manifest = readManifest(dataDir);
      const rows = manifest ? listing(manifest) : [];
      write(manifest ? `${manifestPath(dataDir)}: ${rows.length} package(s)` : `${manifestPath(dataDir)} does not exist: no package is offered (this is the state a deployment starts in).`);
      for (const row of rows) write(`  ${row.id}\t${row.executionClass}\t${row.admitted ? "admitted" : "INCOMPLETE"}\t${row.title}`);
      return 0;
    }
    if (command === "add" && positional.length === 1) {
      const reviewed = JSON.parse(fs.readFileSync(positional[0], "utf8"));
      const target = writeManifest(dataDir, withPackage(readManifest(dataDir) ?? emptyManifest(), reviewed, { restamp: flags.restamp === true }));
      write(`Added ${reviewed.catalogue.id} to ${target}.`);
      for (const line of ownershipCommands(target)) write(line);
      return 0;
    }
    if (command === "remove" && positional.length === 1) {
      const manifest = readManifest(dataDir) ?? refuse(`${manifestPath(dataDir)} does not exist: nothing to remove.`);
      const target = writeManifest(dataDir, withoutPackage(manifest, positional[0]));
      write(`Removed ${positional[0]} from ${target}.`);
      for (const line of ownershipCommands(target)) write(line);
      return 0;
    }
    write("Usage: extension-catalogue.mjs list | add <reviewed-package.json> [--restamp] | remove <id>   [--data-dir DIR]");
    return 2;
  } catch (error) {
    write(error instanceof CatalogueError ? error.message : `extension-catalogue: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
