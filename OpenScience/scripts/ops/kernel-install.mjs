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
 * Where that cutoff comes from. It was "the CLI's publish instant plus one
 * hour", written by hand. That rule gave ETARGET for 0.2.0-rc.2: one of its
 * subpackages (`dsh-client-ui-settings-account`) was re-published an hour and
 * twenty minutes after the CLI, so a cutoff an hour after the CLI excluded a
 * member of the closure it was meant to fence. The cutoff is a property of the
 * closure, not of the CLI, so it is computed from the closure: the latest
 * publish instant of every `@deepseek-ai/dsh*` package the pin resolves to,
 * plus one minute (`cutoffFor`, `computePublishedBefore`). Nobody types it.
 * `node scripts/ops/kernel-install.mjs cutoff` prints, `--write` records it
 * in `deps-version.json` and `--check` fails when the recorded one is not the
 * computed one.
 *
 * @module kernel-install
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { officialYamlPackage, patchYamlInstallation } from "../../deploy/runtime-dsh/runtime-yaml-security.mjs";

/**
 * The npm arguments that install the pinned kernel closure into `prefix`.
 * `--ignore-scripts` by default because an audit that reads upstream code
 * should not also run upstream install scripts; nothing it checks is built by
 * one. A caller that needs the native addons (`node-pty`, `koffi`, the sandbox
 * helpers) — a kernel that is going to be run, as the image's `npm install -g`
 * does — asks for them with `{ scripts: true }`.
 * @param {Record<string, any>} pins `deps-version.json`
 * @param {string} prefix
 * @param {{ scripts?: boolean }} [options]
 * @returns {string[]}
 */
export function kernelInstallArgs(pins, prefix, options = {}) {
  const dsh = pins?.dsh ?? {};
  if (!/^\d+\.\d+\.\d+/.test(String(dsh.version ?? ""))) throw new Error("deps-version.json carries no dsh.version");
  if (!Number.isFinite(Date.parse(String(dsh.publishedBefore ?? "")))) {
    throw new Error("deps-version.json carries no dsh.publishedBefore; without a cutoff the ranges inside the pin resolve to whatever is newest");
  }
  return [
    "install", "--prefix", prefix, "--no-save", ...(options.scripts ? [] : ["--ignore-scripts"]), "--no-fund", "--no-audit",
    `--before=${dsh.publishedBefore}`, `${dsh.npmPackage ?? "@deepseek-ai/dsh"}@${dsh.version}`,
  ];
}

/** The margin added to the closure's latest publish instant. A minute is enough to absorb a rounding second and too little to admit a release published after the closure. */
export const CUTOFF_MARGIN_MS = 60_000;
/** How far past the CLI's own publish instant a closure is resolved before its exact members are known. A package re-published after the CLI is still inside it; whatever floats in beyond is a member and moves the cutoff, which the check below then proves. */
export const RESOLUTION_WINDOW_MS = 24 * 3_600_000;
/** A kernel package: the subpackages carry the pin and are what the cutoff is taken over. */
const KERNEL_PACKAGE = /^@deepseek-ai\/dsh(?:-|$)/;

/**
 * The cutoff a resolved closure needs: its latest publish instant plus a margin.
 * @param {readonly { name: string, version: string, time: string }[]} members every `@deepseek-ai/dsh*` package of the closure and when its version was published
 * @param {{ marginMs?: number, minimumMembers?: number }} [options] `minimumMembers` is the image's own floor (50): a resolver that found a handful of packages is broken, not finished
 * @returns {{ publishedBefore: string, latest: { name: string, version: string, time: string }, members: number }}
 */
export function cutoffFor(members, options = {}) {
  const { marginMs = CUTOFF_MARGIN_MS, minimumMembers = 50 } = options;
  if (!Array.isArray(members) || members.length < minimumMembers) {
    throw new Error(`the kernel closure has ${members?.length ?? 0} member(s); a cutoff taken over a broken resolution would fence nothing`);
  }
  /** @type {{ name: string, version: string, time: string, ms: number } | null} */
  let latest = null;
  for (const member of members) {
    const ms = Date.parse(member.time);
    if (!Number.isFinite(ms)) throw new Error(`${member.name}@${member.version} has no publish time (${JSON.stringify(member.time)}); the cutoff cannot be taken over it`);
    if (!latest || ms > latest.ms) latest = { ...member, ms };
  }
  const found = /** @type {NonNullable<typeof latest>} */ (latest);
  return {
    publishedBefore: new Date(found.ms + marginMs).toISOString(),
    latest: { name: found.name, version: found.version, time: found.time },
    members: members.length,
  };
}

/**
 * The `@deepseek-ai/dsh*` members a `package-lock.json` resolved.
 * @param {any} lock
 * @returns {{ name: string, version: string }[]}
 */
export function closureFromLock(lock) {
  /** @type {Map<string, { name: string, version: string }>} */
  const found = new Map();
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    const at = key.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const name = key.slice(at + "node_modules/".length);
    if (!KERNEL_PACKAGE.test(name)) continue;
    const version = String(/** @type {any} */ (entry)?.version ?? "");
    if (version) found.set(`${name}@${version}`, { name, version });
  }
  return [...found.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

/**
 * The publish instant of one package version, read from its registry document.
 * Not the abbreviated install document: that one carries no `time`.
 * @param {string} registry @param {string} name @param {string} version
 * @param {typeof fetch} fetchImpl
 */
export async function publishTime(registry, name, version, fetchImpl = fetch) {
  const response = await fetchImpl(`${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${name}: the registry answered ${response.status}`);
  const time = /** @type {any} */ (await response.json())?.time?.[version];
  if (typeof time !== "string") throw new Error(`${name}@${version} has no publish time in the registry document`);
  return time;
}

/**
 * Resolve the pinned closure, publish times included, and compute the cutoff
 * that fences it. The resolution is npm's own (`--package-lock-only`, nothing
 * laid down), run under a generous window past the CLI's publish instant so a
 * re-published subpackage is inside it; the cutoff is then the closure's
 * latest member plus a minute, and a resolution under that cutoff is the same
 * closure (every pick was published at or before it).
 *
 * @param {{ npmPackage?: string, version: string, registry?: string, fetchImpl?: typeof fetch,
 *   npm?: (args: string[]) => void, concurrency?: number }} input
 * @returns {Promise<ReturnType<typeof cutoffFor> & { root: { name: string, version: string, time: string }, window: string, resolved: { name: string, version: string, time: string }[] }>}
 */
export async function computePublishedBefore(input) {
  const registry = input.registry ?? "https://registry.npmjs.org";
  const fetchImpl = input.fetchImpl ?? fetch;
  const npmPackage = input.npmPackage ?? "@deepseek-ai/dsh";
  const run = input.npm ?? ((args) => { execFileSync("npm", args, { stdio: ["ignore", "ignore", "inherit"] }); });
  const rootTime = await publishTime(registry, npmPackage, input.version, fetchImpl);
  const window = new Date(Date.parse(rootTime) + RESOLUTION_WINDOW_MS).toISOString();
  const dir = mkdtempSync(path.join(os.tmpdir(), "evimed-kernel-cutoff-"));
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "evimed-kernel-cutoff", private: true }, null, 2));
    run(["install", "--prefix", dir, "--package-lock-only", "--ignore-scripts", "--no-fund", "--no-audit", `--before=${window}`, `--registry=${registry}`, `${npmPackage}@${input.version}`]);
    const closure = closureFromLock(JSON.parse(readFileSync(path.join(dir, "package-lock.json"), "utf8")));
    const concurrency = Math.max(1, input.concurrency ?? 8);
    /** @type {{ name: string, version: string, time: string }[]} */
    const resolved = new Array(closure.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, closure.length) }, async () => {
      for (let index = next++; index < closure.length; index = next++) {
        const member = closure[index];
        resolved[index] = { ...member, time: await publishTime(registry, member.name, member.version, fetchImpl) };
      }
    }));
    return { ...cutoffFor(resolved), root: { name: npmPackage, version: input.version, time: rootTime }, window, resolved };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Whether `deps-version.json` records the computed cutoff, and what to say when it does not.
 * @param {Record<string, any>} pins @param {string} computed
 * @returns {{ ok: boolean, recorded: string | null, computed: string }}
 */
export function cutoffVerdict(pins, computed) {
  const recorded = typeof pins?.dsh?.publishedBefore === "string" ? pins.dsh.publishedBefore : null;
  return { ok: recorded === computed, recorded, computed };
}

/**
 * `deps-version.json` with `dsh.publishedBefore` replaced, every other byte as it was.
 * A parse and a stringify would rewrite the file's unicode escapes; the key is unique, so one anchored replace does the job.
 * @param {string} text @param {string} publishedBefore
 */
export function withPublishedBefore(text, publishedBefore) {
  if (!Number.isFinite(Date.parse(publishedBefore))) throw new Error(`not an instant: ${JSON.stringify(publishedBefore)}`);
  const pattern = /("publishedBefore"\s*:\s*")[^"]*(")/g;
  if ((text.match(pattern) ?? []).length !== 1) throw new Error("deps-version.json must carry exactly one dsh.publishedBefore");
  return text.replace(pattern, `$1${publishedBefore}$2`);
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
 * Install the pinned closure into a fresh directory (a temporary one unless
 * `dir` is given), the YAML4 security backport applied the way the image does.
 * @param {Record<string, any>} pins
 * @param {{ scripts?: boolean, dir?: string }} [options] `scripts` runs the install scripts (native addons) — a kernel that is going to be run; `dir` is where the closure goes
 * @returns {Promise<string>} its `node_modules`
 */
export async function installKernel(pins, options = {}) {
  const dir = options.dir ?? mkdtempSync(path.join(os.tmpdir(), "evimed-kernel-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "evimed-kernel-probe", private: true }, null, 2));
  execFileSync("npm", kernelInstallArgs(pins, dir, { scripts: options.scripts }), { stdio: "inherit" });
  const cache = mkdtempSync(path.join(os.tmpdir(), "evimed-kernel-security-"));
  try {
    const { pin, official } = await officialYamlPackage(fileURLToPath(new URL("../../deps-version.json", import.meta.url)), cache);
    patchYamlInstallation(path.join(dir, "node_modules"), official, pin);
  } finally { rmSync(cache, { recursive: true, force: true }); }
  return path.join(dir, "node_modules");
}

/**
 * `node scripts/ops/kernel-install.mjs cutoff [--version V] [--write] [--check] [--record FILE]`
 *
 *   (no flag)       print the cutoff the closure of V (default: the pin) needs, and its latest member
 *   --write         record it as `dsh.publishedBefore` in deps-version.json
 *   --check         exit 1 when deps-version.json records anything else
 *   --record FILE   keep the registry times the cutoff was computed from, the fixture the unit test replays
 *
 * `install [--dir DIR] [--scripts]` lays the pinned closure down the way the image does.
 */
async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => rest.includes(`--${name}`);
  const value = (name) => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : undefined; };
  const pinsFile = fileURLToPath(new URL("../../deps-version.json", import.meta.url));
  const text = readFileSync(pinsFile, "utf8");
  const pins = JSON.parse(text);
  if (command === "cutoff") {
    const version = value("version") ?? pins.dsh.version;
    const computed = await computePublishedBefore({ npmPackage: pins.dsh.npmPackage, version });
    const verdict = cutoffVerdict(version === pins.dsh.version ? pins : { dsh: {} }, computed.publishedBefore);
    process.stdout.write(`${JSON.stringify({ version, publishedBefore: computed.publishedBefore, latest: computed.latest, members: computed.members, root: computed.root, recorded: verdict.recorded })}\n`);
    if (value("record")) {
      writeFileSync(value("record"), `${JSON.stringify({
        recordedAt: new Date().toISOString(), registry: "https://registry.npmjs.org", root: computed.root, window: computed.window,
        expected: { publishedBefore: computed.publishedBefore, latest: computed.latest, members: computed.members }, members: computed.resolved,
      }, null, 1)}\n`);
    }
    if (flag("write")) writeFileSync(pinsFile, withPublishedBefore(text, computed.publishedBefore));
    if (flag("check") && version === pins.dsh.version && !verdict.ok) {
      process.stderr.write(`deps-version.json records dsh.publishedBefore ${verdict.recorded}, the closure of ${version} needs ${verdict.computed}; run \`node scripts/ops/kernel-install.mjs cutoff --write\`\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "install") {
    const modules = await installKernel(pins, { scripts: flag("scripts"), dir: value("dir") });
    process.stdout.write(`${modules}\n`);
    return;
  }
  process.stderr.write("usage: kernel-install.mjs cutoff [--version V] [--write] [--check] [--record FILE] | install [--dir DIR] [--scripts]\n");
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
