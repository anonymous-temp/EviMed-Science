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
    });
  }

  if (failures.length) {
    process.stderr.write(`capability manifests rejected:\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

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
  process.stdout.write(`${generated.length} capability manifests generated into ${path.relative(repoRoot, outDir)}\n`);
  for (const manifest of generated) process.stdout.write(`  ${manifest.line}\n`);
}

await main();
