#!/usr/bin/env node
/**
 * One writer for the version of every community bundle the three records in
 * `runtime/skills/community/` carry, and the check that they agree.
 *
 * Why it exists. `plugin-support.json` (what booted, and at which version),
 * `try-install.json` (the candidates and what is installed) and `sources.json`
 * (what was vendored or deferred, and why) each wrote the same version by hand,
 * and they disagreed within one day (2026-10-13: academic-writing and translation
 * were "0.2.0" in the first and "0.3.2" in the other two). The version of an
 * installed bundle is `deps-version.json`'s; the version a candidate was tried
 * at is `try-install.json`'s; nothing else is a source.
 *
 * Only versions are written. What booted, when, and with what evidence are
 * facts someone observed (`testedOn`, `evidence`, `reason`) and are never
 * generated here.
 *
 *   node scripts/dev/sync-community-records.mjs           rewrite the version fields
 *   node scripts/dev/sync-community-records.mjs --check   exit 1 when a field disagrees
 *
 * @module sync-community-records
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = Object.freeze({
  pins: "deps-version.json",
  support: "runtime/skills/community/plugin-support.json",
  tryInstall: "runtime/skills/community/try-install.json",
  sources: "runtime/skills/community/sources.json",
});

/**
 * The installed bundles, in the order the image installs them.
 * @param {any} pins `deps-version.json`
 * @returns {{ npm: string, version: string, supportName: string, kind: "tool" | "client" }[]}
 */
export function installedBundles(pins) {
  const dsh = pins.dsh ?? {};
  return [
    { npm: "dsh-cite", version: String(dsh.citeVersion), supportName: "dsh-cite", kind: "tool" },
    { npm: "@changfenhuang/dsh-annotation", version: String(dsh.annotationVersion), supportName: "dsh-annotation", kind: "client" },
    { npm: "dsh-mermaid", version: String(dsh.mermaidVersion), supportName: "dsh-mermaid", kind: "client" },
  ];
}

/**
 * The three records with every version field set from its source, and the
 * list of fields that had to change. Pure: the input is not modified.
 * @param {{ pins: any, support: any, tryInstall: any, sources: any }} records
 * @returns {{ support: any, tryInstall: any, sources: any, changes: string[] }}
 */
export function syncedRecords(records) {
  const support = structuredClone(records.support);
  const tryInstall = structuredClone(records.tryInstall);
  const sources = structuredClone(records.sources);
  /** @type {string[]} */
  const changes = [];
  const set = (/** @type {any} */ holder, /** @type {string} */ key, /** @type {any} */ value, /** @type {string} */ label) => {
    if (holder[key] !== value) { changes.push(`${label}: ${JSON.stringify(holder[key])} -> ${JSON.stringify(value)}`); holder[key] = value; }
  };
  const bundles = installedBundles(records.pins);
  for (const bundle of bundles) {
    if (!/^\d+\.\d+\.\d+/.test(bundle.version)) throw new Error(`deps-version.json carries no version for ${bundle.npm}`);
  }
  set(support, "kernel", `@deepseek-ai/dsh@${records.pins.dsh.version}`, "plugin-support.json kernel");
  for (const bundle of bundles) {
    const list = bundle.kind === "tool" ? support.communityToolBundles : support.communityClientBundles;
    const entry = (list ?? []).find((/** @type {any} */ row) => row.name === bundle.supportName);
    if (!entry) throw new Error(`plugin-support.json has no ${bundle.kind} bundle ${bundle.supportName}`);
    set(entry, "version", bundle.version, `plugin-support.json ${bundle.supportName}`);
    const candidate = (tryInstall.candidates ?? []).find((/** @type {any} */ row) => row.name === bundle.npm);
    if (!candidate) throw new Error(`try-install.json has no candidate ${bundle.npm}`);
    set(candidate, "version", bundle.version, `try-install.json candidate ${bundle.npm}`);
  }
  const installed = bundles.map((bundle) => `${bundle.npm}@${bundle.version}`);
  if (JSON.stringify(tryInstall.installed) !== JSON.stringify(installed)) {
    changes.push(`try-install.json installed: ${JSON.stringify(tryInstall.installed)} -> ${JSON.stringify(installed)}`);
    tryInstall.installed = installed;
  }
  // A bundle that was tried and not taken carries the version it was tried at, which is the candidate's.
  for (const entry of support.communityToolBundles ?? []) {
    if (entry.status === "installed") continue;
    const candidate = (tryInstall.candidates ?? []).find((/** @type {any} */ row) => row.name === entry.name);
    if (candidate?.version && /^\d+\.\d+\.\d+/.test(String(candidate.version))) set(entry, "version", candidate.version, `plugin-support.json ${entry.name} (tried at)`);
  }
  const cite = (sources.deferred ?? []).find((/** @type {any} */ row) => row.name === "dsh-cite");
  if (cite && typeof cite.reason === "string") {
    const reason = cite.reason.replace(/Installed whole at \S+?;/, `Installed whole at ${bundles[0].version};`);
    set(cite, "reason", reason, "sources.json dsh-cite reason");
  }
  return { support, tryInstall, sources, changes };
}

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

/** The records as the repository holds them. */
export function readRecords() {
  return { pins: readJson(FILES.pins), support: readJson(FILES.support), tryInstall: readJson(FILES.tryInstall), sources: readJson(FILES.sources) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { support, tryInstall, sources, changes } = syncedRecords(readRecords());
  if (process.argv.includes("--check")) {
    if (changes.length) {
      process.stderr.write(`community records disagree with their sources:\n  ${changes.join("\n  ")}\nrun node scripts/dev/sync-community-records.mjs\n`);
      process.exitCode = 1;
    } else process.stdout.write("community records agree\n");
  } else {
    for (const [file, value] of [[FILES.support, support], [FILES.tryInstall, tryInstall], [FILES.sources, sources]]) {
      writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
    }
    process.stdout.write(changes.length ? `rewrote ${changes.length} field(s):\n  ${changes.join("\n  ")}\n` : "already in agreement\n");
  }
}
