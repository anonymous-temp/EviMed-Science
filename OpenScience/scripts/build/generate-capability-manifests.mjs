#!/usr/bin/env node
/**
 * Turns each capability's `capability.yaml` into the JSON the runtime image
 * carries, and validates every one of them.
 *
 * Hidden knowledge: why the runtime reads JSON while authors write YAML. The
 * manifests are authored as YAML because a human maintains them; they are read
 * as JSON because the runtime container should not carry a YAML parser and,
 * more importantly, because a manifest that failed validation at build time
 * must not be loadable at run time. Parsing once, here, makes that true by
 * construction: the image only ever contains manifests that passed.
 *
 * The persona and `whenToUse` fields did not exist under the old routing model,
 * where a package was bound to a session by the router. Under a single
 * composition the orchestrator has to be told when to delegate here and what
 * the child should be, so both are required and the generator refuses a
 * manifest missing either.
 *
 * It also writes the one derived fact the domain package cannot read for
 * itself: which contract kinds a `safetyClass: clinical` capability produces.
 * `CLINICAL_CONTRACT_KINDS` used to be a hand-kept list beside the manifests,
 * and three capabilities that declared themselves clinical were missing from it
 * — evidence-appraisal, manuscript-support and meta-analysis — so a single
 * mention of a medicine in their deliverables was rejected as
 * `clinical_content_without_clinical_contract`, advice none of them could act
 * on. The domain may not read files (§14 rule 3), so the table is generated
 * here into `packages/domain/src/capability-contracts.json` and imported as
 * content; `--check` fails when it drifts, which is what makes "a capability
 * declared clinical cannot be omitted" true rather than remembered.
 *
 * Usage:
 *   node scripts/build/generate-capability-manifests.mjs [--source dir] [--out dir] [--check]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { capabilityCatalogueLine, validateCapabilityManifest } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[name] = next;
      index += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(repoRoot, String(args.source ?? "capabilities"));
  const outDir = path.resolve(repoRoot, String(args.out ?? "deploy/runtime-dsh/capabilities"));
  const check = Boolean(args.check);

  const contractsTable = path.resolve(repoRoot, "packages/domain/src/capability-contracts.json");

  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!directories.length) {
    process.stderr.write(`no capabilities found under ${sourceDir}\n`);
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  const failures = [];
  /** @type {{ id: string, json: string, line: string }[]} */
  const generated = [];

  for (const name of directories) {
    const manifestPath = path.join(sourceDir, name, "capability.yaml");
    let raw;
    try {
      raw = parseYaml(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      failures.push(`${name}: capability.yaml is unreadable — ${error?.message ?? error}`);
      continue;
    }
    const result = validateCapabilityManifest(raw);
    if (!result.ok || !result.manifest) {
      for (const issue of result.issues) failures.push(`${name}: ${issue.field ? `${issue.field}: ` : ""}${issue.message}`);
      continue;
    }
    if (result.manifest.id !== name) {
      failures.push(`${name}: manifest id "${result.manifest.id}" does not match its directory`);
      continue;
    }
    // A skill body that the manifest names but the tree does not have would be
    // a capability the orchestrator can delegate to and the delegate tool
    // cannot assemble — the failure would surface as an empty child.
    for (const skill of result.manifest.skills) {
      const body = path.join(sourceDir, name, "SKILL.md");
      const shared = path.join(repoRoot, "capability-skills", skill, "SKILL.md");
      const own = skill === name ? body : shared;
      const exists = await fs.stat(own).then(() => true).catch(() => false);
      if (!exists) failures.push(`${name}: skill "${skill}" has no SKILL.md at ${path.relative(repoRoot, own)}`);
    }
    generated.push({
      id: result.manifest.id,
      json: `${JSON.stringify(result.manifest, null, 2)}\n`,
      line: capabilityCatalogueLine(result.manifest),
      manifest: result.manifest,
    });
  }

  if (failures.length) {
    process.stderr.write(`capability manifests rejected:\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

  const contractsJson = renderContractsTable(generated.map((entry) => entry.manifest));

  if (check) {
    let drifted = false;
    for (const manifest of generated) {
      const target = path.join(outDir, `${manifest.id}.json`);
      const current = await fs.readFile(target, "utf8").catch(() => null);
      if (current !== manifest.json) {
        drifted = true;
        process.stderr.write(`out of date: ${path.relative(repoRoot, target)}\n`);
      }
    }
    const currentContracts = await fs.readFile(contractsTable, "utf8").catch(() => null);
    if (currentContracts !== contractsJson) {
      drifted = true;
      process.stderr.write(`out of date: ${path.relative(repoRoot, contractsTable)}\n`);
    }
    if (drifted) {
      process.stderr.write("run `node scripts/build/generate-capability-manifests.mjs` and commit the result\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${generated.length} capability manifests up to date\n`);
    return;
  }

  await fs.mkdir(outDir, { recursive: true });
  const stale = (await fs.readdir(outDir).catch(() => [])).filter((file) => file.endsWith(".json"));
  for (const file of stale) {
    if (!generated.some((manifest) => `${manifest.id}.json` === file)) await fs.rm(path.join(outDir, file));
  }
  for (const manifest of generated) {
    await fs.writeFile(path.join(outDir, `${manifest.id}.json`), manifest.json, "utf8");
  }
  await fs.writeFile(contractsTable, contractsJson, "utf8");
  process.stdout.write(`${generated.length} capability manifests generated into ${path.relative(repoRoot, outDir)}\n`);
  process.stdout.write(`  safety-class table -> ${path.relative(repoRoot, contractsTable)}\n`);
  for (const manifest of generated) process.stdout.write(`  ${manifest.line}\n`);
}

/**
 * The safety-class table the domain imports as content.
 *
 * Only what the domain cannot restate for itself: the capability id, its
 * declared `safetyClass`, and the contract kinds it produces. Everything else
 * about a capability stays in its own manifest — a second copy of a manifest is
 * a second thing to drift.
 * @param {Record<string, any>[]} manifests
 * @returns {string}
 */
function renderContractsTable(manifests) {
  const capabilities = manifests
    .map((manifest) => ({
      id: manifest.id,
      safetyClass: manifest.safetyClass,
      contractKinds: manifest.produces.map((/** @type {any} */ entry) => entry.contractKind),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return `${JSON.stringify({
    schemaVersion: 1,
    description:
      "Generated by scripts/build/generate-capability-manifests.mjs from capabilities/*/capability.yaml. Do not edit by hand: edit the capability manifest and re-run the generator. The domain derives CLINICAL_CONTRACT_KINDS from the safetyClass column here, so a capability that declares itself clinical cannot be left off the list.",
    capabilities,
  }, null, 2)}\n`;
}

await main();
