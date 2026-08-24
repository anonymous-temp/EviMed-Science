#!/usr/bin/env node
/**
 * Checks `seam-manifest.json` against a real DeepSeek Harness install.
 *
 * Hidden knowledge: which failure this catches, and why the existing tests
 * cannot. The contract tests replay golden frames and the port's unit tests run
 * against fakes — both prove the control plane handles the protocol it was told
 * about. Neither notices when upstream renames the thing being handled, and DSH
 * says outright that it will "rename or repackage freely" before its first
 * tagged release. A renamed event does not throw; it silently never fires, and
 * the seam goes quiet while everything still passes.
 *
 * So this reads the shipped code and asks four questions the fakes cannot:
 *
 *   1. Does every package the manifest names exist in a real install?
 *   2. Do the exports the port actually calls exist in them?
 *   3. Does every seam name — event, session-event type, turn-end kind, service
 *      — appear literally in the shipped code?
 *   4. Is the wire surface the manifest classifies *exactly* the surface DSH
 *      exposes? Both directions matter, and the second is the dangerous one: a
 *      method that is neither allowed nor denied is a method the control plane
 *      has no opinion about.
 *
 * Usage:
 *   node scripts/ops/verify-harness-seams.mjs --install
 *   node scripts/ops/verify-harness-seams.mjs --modules /path/to/node_modules
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const seamPath = path.join(repoRoot, "packages/harness-port/seam-manifest.json");
const seams = JSON.parse(readFileSync(seamPath, "utf8"));
const pins = JSON.parse(readFileSync(path.join(repoRoot, "deps-version.json"), "utf8"));

/** Exports the port calls by name. A rename here is a hard failure at first use. */
const REQUIRED_EXPORTS = {
  "@deepseek-ai/dsh-tools": ["defineTool"],
  "@deepseek-ai/dsh-storage-domain": ["defineDomain", "domainTable"],
  "@deepseek-ai/cordis": ["Context", "Service"],
  "@deepseek-ai/schemastery": ["default"],
};

/**
 * Every DeepSeek package in a node_modules tree, flat or pnpm-isolated.
 * @param {string} modulesDir
 * @returns {Map<string, { version: string, dir: string }>}
 */
function indexInstall(modulesDir) {
  /** @type {Map<string, { version: string, dir: string }>} */
  const found = new Map();
  /** @param {string} scopeDir @param {string} scope */
  const readScope = (scopeDir, scope) => {
    if (!existsSync(scopeDir)) return;
    for (const pkg of readdirSync(scopeDir)) {
      const manifest = path.join(scopeDir, pkg, "package.json");
      if (!existsSync(manifest)) continue;
      const name = `${scope}/${pkg}`;
      if (found.has(name)) continue;
      try {
        found.set(name, { version: JSON.parse(readFileSync(manifest, "utf8")).version, dir: path.join(scopeDir, pkg) });
      } catch {
        // A package with an unreadable manifest is not a package we can vouch for.
      }
    }
  };
  readScope(path.join(modulesDir, "@deepseek-ai"), "@deepseek-ai");
  const store = path.join(modulesDir, ".pnpm");
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      readScope(path.join(store, entry, "node_modules", "@deepseek-ai"), "@deepseek-ai");
    }
  }
  return found;
}

/**
 * Whether a literal string appears in any shipped source file.
 * @param {readonly {dir: string}[]} packages @param {string} needle
 * @returns {boolean}
 */
function appearsInCode(packages, needle) {
  for (const pkg of packages) {
    try {
      execFileSync("grep", ["-rIqF", "--include=*.js", "--include=*.mjs", "--include=*.cjs", "--include=*.ts", needle, pkg.dir]);
      return true;
    } catch {
      // grep exits non-zero when it finds nothing; that is not an error here.
    }
  }
  return false;
}

/** @param {string} version @returns {string} a temp node_modules with a real install */
function install(version) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evimed-seam-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "evimed-seam-probe", private: true }, null, 2));
  // pnpm, not npm: npm's resolver runs out of heap on this dependency graph on
  // a small host, which reads as a flaky check rather than as a memory limit.
  const direct = Object.keys(REQUIRED_EXPORTS).filter((name) => name.startsWith("@deepseek-ai/dsh-"));
  execFileSync("pnpm", ["add", `@deepseek-ai/dsh@${version}`, ...direct.map((name) => `${name}@${version}`)], {
    cwd: dir,
    stdio: "inherit",
  });
  return path.join(dir, "node_modules");
}

/**
 * A package's entry file.
 *
 * Resolved from the manifest rather than by importing the directory, because
 * ESM refuses a directory import and the answer differs per package here:
 * schemastery ships CommonJS, the dsh packages ship ESM, and both have to be
 * loadable by the same check.
 *
 * @param {string} dir
 * @returns {string | null}
 */
function packageEntry(dir) {
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  /** @param {any} node @returns {string | null} */
  const pick = (node) => {
    if (typeof node === "string") return node;
    if (node && typeof node === "object") {
      for (const key of ["import", "module", "require", "node", "default"]) {
        const found = pick(node[key]);
        if (found) return found;
      }
    }
    return null;
  };
  const candidate = pick(manifest.exports?.["."]) ?? pick(manifest.exports) ?? manifest.module ?? manifest.main ?? "index.js";
  const resolved = path.join(dir, candidate);
  return existsSync(resolved) ? resolved : null;
}

const args = process.argv.slice(2);
const modulesArg = args.indexOf("--modules");
const modulesDir = modulesArg >= 0 ? path.resolve(String(args[modulesArg + 1])) : install(pins.dsh.version);

const installed = indexInstall(modulesDir);
/** @type {string[]} */
const failures = [];
/** @param {string} label @param {boolean} ok @param {string} [detail] */
function report(label, ok, detail = "") {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures.push(label);
}

const dsh = installed.get("@deepseek-ai/dsh");
report("dsh installed", Boolean(dsh), dsh?.version ?? "not found");
report("dsh version matches deps-version.json", dsh?.version === pins.dsh.version, `${dsh?.version} vs ${pins.dsh.version}`);
report("dsh version matches seam-manifest", dsh?.version === seams.dsh, `${dsh?.version} vs ${seams.dsh}`);
const cordis = installed.get("@deepseek-ai/cordis");
report("cordis version matches seam-manifest", cordis?.version === seams.cordis, `${cordis?.version} vs ${seams.cordis}`);

const missingPackages = Object.keys(seams.packages).filter((name) => !installed.has(name));
report(`all ${Object.keys(seams.packages).length} seam packages present`, missingPackages.length === 0, missingPackages.join(", "));

for (const [name, exports] of Object.entries(REQUIRED_EXPORTS)) {
  const pkg = installed.get(name);
  if (!pkg) {
    report(`${name} exports`, false, "package missing");
    continue;
  }
  const entry = packageEntry(pkg.dir);
  if (!entry) {
    report(`${name} exports`, false, "no resolvable entry point");
    continue;
  }
  const mod = await import(entry).catch((error) => ({ __error: error?.message ?? String(error) }));
  if (mod.__error) {
    report(`${name} exports`, false, mod.__error);
    continue;
  }
  const absent = exports.filter((key) => typeof mod[key] === "undefined");
  report(`${name} exports ${exports.join(", ")}`, absent.length === 0, absent.join(", "));
}

const deepseekPackages = [...installed.values()];
const nameGroups = {
  events: Object.values(seams.events),
  "session event types": seams.sessionEventTypes,
  "turn-end kinds": seams.turnEndKinds,
  "required services": seams.services.required,
  "optional services": seams.services.optional,
  "mux frame types": seams.wire.muxFrameTypes,
  downlink: seams.wire.downlink,
};
for (const [group, names] of Object.entries(nameGroups)) {
  const absent = names.filter((name) => !appearsInCode(deepseekPackages, `"${name}"`) && !appearsInCode(deepseekPackages, `'${name}'`));
  report(`${group}: ${names.length - absent.length}/${names.length} appear in shipped code`, absent.length === 0, absent.join(", "));
}

// The wire surface, both directions. The api-proxy package is the one that
// enumerates it; reading the names out of the shipped code is what makes this a
// check on DSH rather than on our own copy of the list.
const proxy = installed.get("@deepseek-ai/dsh-host-apiproxy");
if (!proxy) {
  report("api proxy present", false, "cannot verify the wire surface without it");
} else {
  const dotted = new Set();
  const out = execFileSync("grep", ["-rhoE", "['\"][a-zA-Z]+\\.[a-zA-Z][a-zA-Z]+['\"]", "--include=*.js", path.join(proxy.dir, "lib")], {
    encoding: "utf8",
  });
  for (const raw of out.split("\n")) {
    const name = raw.replace(/['"]/g, "").trim();
    // `powershell.exe` and friends are file names, not methods.
    if (name && !name.endsWith(".exe")) dotted.add(name);
  }
  const declared = new Set([...seams.wire.unary, ...seams.wire.denied]);
  const unclassified = [...dotted].filter((name) => !declared.has(name)).sort();
  const phantom = [...declared].filter((name) => !dotted.has(name)).sort();
  report(`wire surface classified (${declared.size} methods)`, unclassified.length === 0, `unclassified: ${unclassified.join(", ")}`);
  report("no method declared that DSH does not expose", phantom.length === 0, `phantom: ${phantom.join(", ")}`);
}

process.stdout.write(`\n${failures.length ? `${failures.length} seam check(s) failed` : "every seam in the manifest matches the shipped harness"}\n`);
process.exitCode = failures.length ? 1 : 0;
