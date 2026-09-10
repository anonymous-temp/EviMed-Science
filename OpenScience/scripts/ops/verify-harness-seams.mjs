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
  // `--ignore-scripts`, for two reasons that point the same way. pnpm 10 and
  // later exit **non-zero** on ERR_PNPM_IGNORED_BUILDS after a successful
  // install, so without this the probe reported "Command failed: pnpm add" on
  // an install that had in fact just written 501 packages — a check that cannot
  // run reads exactly like a check that has nothing to say. And an audit that
  // reads upstream code should not also execute upstream install scripts.
  execFileSync("pnpm", ["add", "--ignore-scripts", `@deepseek-ai/dsh@${version}`, ...direct.map((name) => `${name}@${version}`)], {
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

/**
 * A manifest key, or a named failure.
 *
 * This used to read `seams.wire.muxFrameTypes`, a key the manifest has not had
 * since the 0.1.2 migration renamed it to `muxClientFrames`/`muxServerFrames`.
 * `undefined.filter` threw, and the script — the only check that reads the
 * kernel's *shipped* code and would notice upstream renaming a seam — has been
 * unrunnable ever since, failing before the wire section it exists for. It is
 * wired to a manual `verify:seams` and to no CI job, so nothing said so.
 *
 * A renamed key is now the finding it always was: reported, counted, and the
 * run continues to the checks after it.
 * @param {string} label @param {string} keyPath @returns {string[]}
 */
function names(label, keyPath) {
  let node = /** @type {any} */ (seams);
  for (const key of keyPath.split(".")) node = node?.[key];
  const list = Array.isArray(node) ? node.map(String) : (node && typeof node === "object" ? Object.values(node).map(String) : null);
  if (!list) {
    report(`${label}: seam-manifest has ${keyPath}`, false, "key missing or not a list — the manifest was renamed under this check");
    return [];
  }
  return list;
}

const nameGroups = {
  events: names("events", "events"),
  "session event types": names("session event types", "sessionEventTypes"),
  "turn-end kinds": names("turn-end kinds", "turnEndKinds"),
  "required services": names("required services", "services.required"),
  "optional services": names("optional services", "services.optional"),
  "stream endpoints": names("stream endpoints", "wire.streamEndpoints"),
};
for (const [group, list] of Object.entries(nameGroups)) {
  if (!list.length) continue;
  const absent = list.filter((name) => !appearsInCode(deepseekPackages, `"${name}"`) && !appearsInCode(deepseekPackages, `'${name}'`));
  report(`${group}: ${list.length - absent.length}/${list.length} appear in shipped code`, absent.length === 0, absent.join(", "));
}

// The mux vocabulary, checked in the shape it is written rather than as bare
// words. `open`, `item`, `end` and `error` appear in any JavaScript ever
// written, so a plain literal search over them is a check that cannot fail —
// worse than no check, because it reports coverage. The gateway writes them as
// `type: "<frame>"`, and that is what is looked for.
const muxFrames = [...names("mux client frames", "wire.muxClientFrames"), ...names("mux server frames", "wire.muxServerFrames")];
if (muxFrames.length) {
  const absent = muxFrames.filter((frame) => !appearsInCode(deepseekPackages, `type: "${frame}"`) && !appearsInCode(deepseekPackages, `type: '${frame}'`));
  report(`mux frames: ${muxFrames.length - absent.length}/${muxFrames.length} are emitted as a frame type`, absent.length === 0, absent.join(", "));
}

// Paths are literal and specific enough to search for as they are.
for (const [label, keyPath] of [["mux endpoint", "wire.mux"], ["downlink endpoints", "wire.downlink"]]) {
  const paths = typeof seams.wire?.[keyPath.split(".")[1]] === "string"
    ? [String(seams.wire[keyPath.split(".")[1]])]
    : names(label, keyPath);
  if (!paths.length) continue;
  const absent = paths.filter((endpoint) => !appearsInCode(deepseekPackages, `"${endpoint}"`) && !appearsInCode(deepseekPackages, `'${endpoint}'`));
  report(
    `${label}: ${paths.length - absent.length}/${paths.length} appear in shipped code`,
    absent.length === 0,
    absent.length ? `${absent.join(", ")} — DSH 0.1.2 removed the ApiProxy downlink; update seam-manifest.json wire.${keyPath.split(".")[1]}` : "",
  );
}

/**
 * Every RPC method the installed harness registers.
 *
 * `@deepseek-ai/dsh-host-apiproxy` used to enumerate the surface and this check
 * grepped its `lib/` for anything shaped like `"a.b"`. That package does not
 * exist in 0.1.2 — ApiProxy is gone — so the check reported "api proxy present:
 * FAIL, cannot verify the wire surface" and stopped, on a run that never got
 * this far anyway because of the manifest key above.
 *
 * The surface is declared structurally in 0.1.2: every host-side endpoint owner
 * ships a `typert.host.js` carrying `id: '<package>#<namespace>/<method>'`. That
 * is read here instead of a shape heuristic, deliberately. The obvious
 * replacement — grep the client bundle for `"x/y"` — sweeps in MIME types
 * (`image/png`), session events (`turn/end`, `tool/call`) and stream endpoints,
 * and 45 of its 90 hits are not methods at all. A check that is red for reasons
 * that are not true is how an audit stops being read.
 * @returns {Map<string, string[]>} method -> the packages declaring it
 */
function declaredMethods() {
  /** @type {Map<string, string[]>} */
  const found = new Map();
  for (const pkg of deepseekPackages) {
    let out = "";
    try {
      out = execFileSync("grep", ["-rhoE", "id: ['\"][^'\"#]+#[A-Za-z][A-Za-z0-9]*/[A-Za-z][A-Za-z0-9]*['\"]", "--include=typert.host.js", pkg.dir], { encoding: "utf8" });
    } catch {
      continue; // grep exits non-zero when a package has no host endpoints
    }
    for (const line of out.split("\n")) {
      const method = /#([A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*)['"]/.exec(line)?.[1];
      if (!method) continue;
      found.set(method, [...(found.get(method) ?? []), pkg.dir.split("/").at(-1) ?? ""]);
    }
  }
  return found;
}

const methods = declaredMethods();
// Prove the scan scanned. A rename upstream that empties this map would
// otherwise leave every method "classified" and both checks green, which is the
// precise failure this whole script exists to catch one level up.
report("the wire surface was read from shipped code", methods.size >= 40, `${methods.size} RPC methods declared across ${deepseekPackages.length} packages`);
if (methods.size) {
  // Stream endpoints are classified under `wire.streamEndpoints`, and the
  // gateway registers them as methods too. Counting them as unclassified would
  // report three findings nobody can act on.
  const streams = new Set(Object.values(seams.wire?.streamEndpoints ?? {}).map(String));
  const declared = new Set([...(seams.wire?.unary ?? []), ...(seams.wire?.denied ?? [])]);
  const unclassified = [...methods.keys()].filter((name) => !declared.has(name) && !streams.has(name)).sort();
  // Our own plugin's methods are registered by `packages/socket`, not by DSH,
  // so upstream never ships them and their absence is not a finding.
  const phantom = [...declared].filter((name) => !methods.has(name) && !name.startsWith("evimedPlugins/")).sort();
  report(
    `wire surface classified (${declared.size} declared, ${methods.size} shipped)`,
    unclassified.length === 0,
    unclassified.length ? `${unclassified.length} method(s) the control plane has no opinion about — add each to seam-manifest.json wire.unary or wire.denied: ${unclassified.join(", ")}` : "",
  );
  report(
    "no method declared that DSH does not expose",
    phantom.length === 0,
    phantom.length ? `${phantom.length} phantom method(s) — retired upstream, still in seam-manifest.json wire.denied: ${phantom.join(", ")}` : "",
  );
}

process.stdout.write(`\n${failures.length ? `${failures.length} seam check(s) failed` : "every seam in the manifest matches the shipped harness"}\n`);
process.exitCode = failures.length ? 1 : 0;
