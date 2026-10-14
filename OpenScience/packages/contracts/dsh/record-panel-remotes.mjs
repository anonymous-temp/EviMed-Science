#!/usr/bin/env node
/**
 * Record which host namespaces each browser package of the pinned kernel reaches (`panelRemotes.mjs`).
 *
 *   node packages/contracts/dsh/record-panel-remotes.mjs <node_modules of the kernel closure>          write panel-remotes.json
 *   node packages/contracts/dsh/record-panel-remotes.mjs <node_modules of the kernel closure> --check  exit 1 when the committed file differs
 *
 * `scripts/ops/kernel-install.mjs install --dir <d>` lays the closure down; its `node_modules` is the argument.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FORMS_PROVIDER, panelRemotes } from "./panelRemotes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const target = path.join(here, "panel-remotes.json");

/**
 * The document this script records, from an installed closure.
 * @param {string} modulesDir
 */
export function recordPanelRemotes(modulesDir) {
  const pins = JSON.parse(readFileSync(path.join(repo, "deps-version.json"), "utf8"));
  const kernel = JSON.parse(readFileSync(path.join(modulesDir, "@deepseek-ai", "dsh", "package.json"), "utf8"));
  if (kernel.version !== pins.dsh.version) throw new Error(`the closure is ${kernel.version}, the pin is ${pins.dsh.version}; record from the pinned closure`);
  const baseline = readFileSync(path.join(repo, "deploy/runtime-dsh/dump-config.baseline.json"), "utf8");
  const { packages, unreadable } = panelRemotes(modulesDir, baseline);
  const provider = packages[CONFIG_FORMS_PROVIDER];
  if (!provider?.remotes.includes("settings")) {
    throw new Error(`${CONFIG_FORMS_PROVIDER} no longer reaches remote.settings; the configForms rule in panelRemotes.mjs is stale`);
  }
  return {
    $comment: "Which host namespaces each browser package the composition mounts reaches through its own client bundle (lib/client.js), recorded by record-panel-remotes.mjs; re-record on every DSH pin change. `configForms` marks a package that goes through the generic form client, which reaches `settings`. A package with no entry has no client bundle.",
    pin: pins.dsh.version,
    configFormsProvider: CONFIG_FORMS_PROVIDER,
    packages,
    noClientBundle: unreadable,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modules, flag] = process.argv.slice(2);
  if (!modules) {
    console.error("usage: record-panel-remotes.mjs <node_modules of the kernel closure> [--check]");
    process.exit(2);
  }
  const text = `${JSON.stringify(recordPanelRemotes(path.resolve(modules)), null, 2)}\n`;
  if (flag === "--check") {
    const same = readFileSync(target, "utf8") === text;
    console.log(same ? "panel-remotes.json equals the installed closure" : "panel-remotes.json differs from the installed closure; re-record it");
    process.exitCode = same ? 0 : 1;
  } else {
    writeFileSync(target, text);
    console.log(`recorded ${Object.keys(JSON.parse(text).packages).length} packages to ${path.relative(repo, target)}`);
  }
}
