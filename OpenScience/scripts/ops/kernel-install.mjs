/**
 * The pinned kernel closure, installed the way the runtime image installs it.
 *
 * The image installs `@deepseek-ai/dsh@<pin>` with npm under
 * `--before=<publishedBefore>` and then asserts every package it got. The
 * nightly seam check installed the same pin with `pnpm add` and no cutoff, so
 * every range the pinned release itself declares (`cordis ~4.0.x`,
 * `schemastery ~3.18.x`, and at 0.1.5 the subpackages' own carets) resolved to
 * whatever was newest that night. From 2026-09-22, the day 0.1.5-rc.3 and
 * cordis 4.0.4 were published, it verified a tree no image had ever held — and
 * went red on cordis every night after, for a reason that said nothing about
 * the pin. One cutoff, read from `deps-version.json`, for both.
 *
 * @module kernel-install
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { officialYamlPackage, patchYamlInstallation } from "../../deploy/runtime-dsh/runtime-yaml-security.mjs";

/**
 * The npm arguments that install the pinned kernel closure into `prefix`.
 * `--ignore-scripts` because an audit that reads upstream code should not also
 * run upstream install scripts; nothing it checks is built by one.
 * @param {Record<string, any>} pins `deps-version.json`
 * @param {string} prefix
 * @returns {string[]}
 */
export function kernelInstallArgs(pins, prefix) {
  const dsh = pins?.dsh ?? {};
  if (!/^\d+\.\d+\.\d+/.test(String(dsh.version ?? ""))) throw new Error("deps-version.json carries no dsh.version");
  if (!Number.isFinite(Date.parse(String(dsh.publishedBefore ?? "")))) {
    throw new Error("deps-version.json carries no dsh.publishedBefore; without a cutoff the ranges inside the pin resolve to whatever is newest");
  }
  return [
    "install", "--prefix", prefix, "--no-save", "--ignore-scripts", "--no-fund", "--no-audit",
    `--before=${dsh.publishedBefore}`, `${dsh.npmPackage ?? "@deepseek-ai/dsh"}@${dsh.version}`,
  ];
}

/**
 * Every `@deepseek-ai/dsh*` package in a closure that is not the pin, and the
 * cordis the closure resolved.
 * @param {Map<string, { version: string }>} installed name -> package
 * @param {Record<string, any>} pins
 * @returns {{ drifted: string[], cordis: string | null, count: number }}
 */
export function closureDrift(installed, pins) {
  const kernel = [...installed].filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/.test(name));
  return {
    drifted: kernel.filter(([, pkg]) => pkg.version !== pins.dsh.version).map(([name, pkg]) => `${name}@${pkg.version}`).sort(),
    cordis: installed.get("@deepseek-ai/cordis")?.version ?? null,
    count: kernel.length,
  };
}

/**
 * Install the pinned closure into a fresh temporary directory.
 * @param {Record<string, any>} pins
 * @returns {Promise<string>} its `node_modules`
 */
export async function installKernel(pins) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evimed-kernel-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "evimed-kernel-probe", private: true }, null, 2));
  execFileSync("npm", kernelInstallArgs(pins, dir), { stdio: "inherit" });
  const cache = mkdtempSync(path.join(os.tmpdir(), "evimed-kernel-security-"));
  try {
    const { pin, official } = await officialYamlPackage(fileURLToPath(new URL("../../deps-version.json", import.meta.url)), cache);
    patchYamlInstallation(path.join(dir, "node_modules"), official, pin);
  } finally { rmSync(cache, { recursive: true, force: true }); }
  return path.join(dir, "node_modules");
}
