#!/usr/bin/env node
/**
 * The kernel candidate check: how far behind upstream the pin is, and what moving it would touch — report only.
 *
 * Hidden knowledge: the nightly matrix tests the pinned versions (`upstream-compat-matrix.mjs` says so itself: "it does
 * not test `latest`"), so nothing said that DSH had moved twenty days until a person looked on 2026-10-14. This is the
 * tier that is missing. It never upgrades, never writes to the repository and never blocks: the output is one JSON
 * file the operator console reads, and a row of lines for the log.
 *
 * What it does, per candidate (the versions npm's `dist-tags` of `@deepseek-ai/dsh` name — `latest`, `next`, `alpha` —
 * that are not the pin):
 *
 *   1. resolves the candidate's closure and its registry cutoff the way the image would (`kernel-install.mjs`:
 *      `computePublishedBefore`, so the cutoff is the closure's own and not "the CLI plus an hour"), installs it with
 *      `--ignore-scripts` into a scratch directory, and deletes that directory when it is done;
 *   2. reads how many days behind the pin is (`lagDays`: candidate's publish instant minus the pin's) and how old the
 *      candidate is (`ageDays`);
 *   3. diffs the composition the CLI itself ships for its `web` profile (`dsh --profile web --dump-config`, a fresh
 *      scratch `DSH_HOME`, no pnpm, no bundles of ours) against the pinned closure's: rows added, removed, changed;
 *   4. runs the seam check (`verify-harness-seams.mjs --candidate --json`) against the candidate's shipped code — names,
 *      event vocabulary, and the wire surface: any shipped method the manifest does not classify is listed by name;
 *   5. checks every third-party bundle's declared peer ranges against what the candidate closure installs, so
 *      "LoopX's range excludes it" is a line in the report and not a surprise at install;
 *   6. lists `@deepseek-ai/*` package names the candidate adds or drops against the pinned closure.
 *
 * And, for the pins that are not the kernel: it polls every npm, PyPI and GitHub pin in `deps-version.json`
 * (bundle versions, LoopX CLI and plugin, the OpenViking plugin and engine, OpenList, pgvector, OpenMed) for the newest
 * published version and its date. It polls `@deepseek-ai/dsh` and the named top-level packages only — never a `dsh-*`
 * subpackage's `latest` tag: 122 of them are stale at `0.0.1-rc.1`, and a script that read them would report that
 * the kernel went backwards.
 *
 * Usage:
 *   node scripts/ops/kernel-candidate-check.mjs [--out candidate-check.json] [--pinned-modules <node_modules>]
 *                                               [--only <version-or-tag>] [--no-pins]
 *
 * Output (`candidate-check.json`, schemaVersion 1):
 *   {
 *     schemaVersion: 1, checkedAt, pin: { dsh, publishedAt, cordis }, distTags: { latest, next, alpha },
 *     candidates: [{
 *       version, tags: ["alpha"], publishedAt, lagDays, ageDays,
 *       closure: { packages, cutoff, added: [name…], removed: [name…] },
 *       composition: { profile: "web", rows: { pinned, candidate }, added: [{id,name,disabled}], removed: [...], changed: [{id,from,to}] },
 *       seams: { ok, failed: [{ label, detail }], wire: { unclassified: [method…], phantom: [method…] } },
 *       peers: [{ bundle, peer, range, installed, satisfied }],
 *       verdict: "same-as-pin" | "movable" | "blocked", reasons: [string…]
 *     }],
 *     pins: [{ id, kind: "npm"|"pypi"|"github", source, pinned, pinnedAt, latest, latestAt, behind, lagDays, note }],
 *     unknown: [string…]   // what could not be learned, said out loud
 *   }
 * `verdict: "movable"` means the static checks pass; it is not a recommendation (the live gates — golden frames, the
 * frame walk, the battery — are what decide).
 *
 * @module kernel-candidate-check
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computePublishedBefore, installKernel, kernelInstallArgs } from "./kernel-install.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const REGISTRY = "https://registry.npmjs.org";
const DAY_MS = 86_400_000;

/** @param {string | undefined} a @param {string | undefined} b @returns {number | null} days from a to b, one decimal */
export function daysBetween(a, b) {
  const from = Date.parse(String(a)), to = Date.parse(String(b));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round(((to - from) / DAY_MS) * 10) / 10;
}

/**
 * The versions the dist-tags name, with the tags that name each.
 * @param {Record<string, string>} distTags @param {string} pin
 * @returns {{ version: string, tags: string[], samePin: boolean }[]}
 */
export function candidateVersions(distTags, pin) {
  /** @type {Map<string, string[]>} */
  const byVersion = new Map();
  for (const tag of ["latest", "next", "alpha"]) {
    const version = distTags?.[tag];
    if (typeof version === "string" && version) byVersion.set(version, [...(byVersion.get(version) ?? []), tag]);
  }
  return [...byVersion].map(([version, tags]) => ({ version, tags, samePin: version === pin }));
}

/**
 * The rows of a `--dump-config` document: id, package name and whether it is disabled, keyed by id.
 * Nothing here executes YAML: rows are read by their `- id:` line and the two keys that matter for a diff.
 * @param {string} text
 * @returns {Map<string, { id: string, name: string, disabled: string }>}
 */
export function parseCompositionRows(text) {
  /** @type {Map<string, { id: string, name: string, disabled: string }>} */
  const rows = new Map();
  for (const block of String(text).split(/\n(?=(?:# [^\n]*\n)*- id: )/)) {
    const id = /^- id: (\S+)/m.exec(block)?.[1];
    if (!id) continue;
    const name = /^ {2}name: '?([^'\n]+)'?/m.exec(block)?.[1] ?? "";
    const disabled = /^ {2}disabled: (.+)$/m.exec(block)?.[1]?.trim() ?? "";
    rows.set(id, { id, name, disabled });
  }
  return rows;
}

/**
 * What changed between two compositions.
 * @param {Map<string, { id: string, name: string, disabled: string }>} pinned
 * @param {Map<string, { id: string, name: string, disabled: string }>} candidate
 */
export function compositionDiff(pinned, candidate) {
  const added = [...candidate.values()].filter((row) => !pinned.has(row.id));
  const removed = [...pinned.values()].filter((row) => !candidate.has(row.id));
  /** @type {{ id: string, from: string, to: string }[]} */
  const changed = [];
  for (const [id, row] of candidate) {
    const before = pinned.get(id);
    if (!before) continue;
    const from = `${before.name} ${before.disabled}`.trim(), to = `${row.name} ${row.disabled}`.trim();
    if (from !== to) changed.push({ id, from, to });
  }
  return { rows: { pinned: pinned.size, candidate: candidate.size }, added, removed, changed };
}

/**
 * @param {readonly string[]} pinnedNames @param {readonly string[]} candidateNames
 */
export function packageNameDiff(pinnedNames, candidateNames) {
  const a = new Set(pinnedNames), b = new Set(candidateNames);
  return { added: [...b].filter((name) => !a.has(name)).sort(), removed: [...a].filter((name) => !b.has(name)).sort() };
}

/**
 * Each declared peer range of each bundle against what the candidate closure installs.
 * A peer that is not a kernel package is checked against the pin recorded for it (`communityPeerPins`), never against the
 * kernel: the bare `cordis` annotation asks for is not `@deepseek-ai/cordis`.
 * @param {{ bundle: string, peers: Record<string, string> }[]} bundles
 * @param {{ kernel: string, installed: Map<string, string>, communityPeers: Record<string, string>, satisfies: (version: string, range: string) => boolean }} context
 */
export function peerFindings(bundles, { kernel, installed, communityPeers, satisfies }) {
  /** @type {{ bundle: string, peer: string, range: string, installed: string | null, satisfied: boolean | null }[]} */
  const findings = [];
  for (const { bundle, peers } of bundles) {
    for (const [peer, range] of Object.entries(peers ?? {})) {
      const version = peer === "@deepseek-ai/dsh" ? kernel : (installed.get(peer) ?? communityPeers[peer] ?? null);
      let satisfied = null;
      if (version) { try { satisfied = satisfies(version, range); } catch { satisfied = null; } }
      findings.push({ bundle, peer, range, installed: version, satisfied });
    }
  }
  return findings;
}

/**
 * The static verdict for one candidate.
 * @param {{ samePin: boolean, seams: { ok: boolean, failed: { label: string }[], wire: { unclassified: string[], phantom: string[] } } | null,
 *   peers: { bundle: string, peer: string, satisfied: boolean | null }[], composition: { removed: any[] } | null, installed: boolean }} input
 * @returns {{ verdict: "same-as-pin" | "movable" | "blocked" | "unknown", reasons: string[] }}
 */
export function verdictFor({ samePin, seams, peers, installed }) {
  if (samePin) return { verdict: "same-as-pin", reasons: [] };
  /** @type {string[]} */
  const reasons = [];
  if (!installed) return { verdict: "unknown", reasons: ["the candidate closure could not be installed"] };
  if (!seams) reasons.push("the seam check did not run");
  else {
    for (const failure of seams.failed) reasons.push(`seam: ${failure.label}`);
    if (seams.wire.unclassified.length) reasons.push(`${seams.wire.unclassified.length} wire method(s) the manifest does not classify: ${seams.wire.unclassified.join(", ")}`);
  }
  for (const peer of peers.filter((entry) => entry.satisfied === false)) reasons.push(`${peer.bundle}: peer ${peer.peer} is not satisfied by the candidate`);
  return { verdict: reasons.length ? "blocked" : "movable", reasons };
}

/**
 * The pins that are not the kernel, as polling descriptors.
 * @param {Record<string, any>} pins `deps-version.json`
 * @returns {{ id: string, kind: "npm" | "pypi" | "github", source: string, pinned: string, tagPrefix?: string }[]}
 */
export function pollDescriptors(pins) {
  /** @type {any[]} */
  const out = [];
  const push = (/** @type {any} */ entry) => { if (entry.pinned && entry.source) out.push(entry); };
  push({ id: "dsh", kind: "npm", source: pins.dsh?.npmPackage ?? "@deepseek-ai/dsh", pinned: pins.dsh?.version });
  push({ id: "dsh-cite", kind: "npm", source: "dsh-cite", pinned: pins.dsh?.citeVersion });
  push({ id: "dsh-annotation", kind: "npm", source: "@changfenhuang/dsh-annotation", pinned: pins.dsh?.annotationVersion });
  push({ id: "dsh-mermaid", kind: "npm", source: "dsh-mermaid", pinned: pins.dsh?.mermaidVersion });
  push({ id: "openviking-memory-plugin", kind: "npm", source: pins.openviking?.plugin?.name ?? "@openviking/dsh-memory-plugin", pinned: pins.openviking?.plugin?.version });
  push({ id: "loopx-cli", kind: "pypi", source: "loopx", pinned: pins.loopx?.version });
  push({ id: "loopx-plugin", kind: "github", source: pins.loopx?.githubRepo, pinned: pins.loopx?.plugin?.version, tagPrefix: "dsh-loopx-plugin-v" });
  push({ id: "openviking-engine", kind: "github", source: pins.openviking?.githubRepo, pinned: pins.openviking?.version, tagPrefix: "v" });
  push({ id: "openlist", kind: "github", source: pins.openlist?.githubRepo, pinned: pins.openlist?.version, tagPrefix: "v" });
  push({ id: "pgvector", kind: "github", source: pins.pgvector?.githubRepo, pinned: pins.pgvector?.version, tagPrefix: "v" });
  push({ id: "openmed", kind: "github", source: pins.openmed?.githubRepo, pinned: pins.openmed?.version, tagPrefix: "v" });
  return out;
}

/** @param {string} url @param {Record<string, string>} [headers] */
async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

/** The registry's full document, which is the one that has `time`. @param {string} name */
const packument = (name) => getJson(`${REGISTRY}/${name.replace("/", "%2f")}`);

/**
 * One poll. Never throws: a pin that cannot be read is a row that says so.
 * @param {ReturnType<typeof pollDescriptors>[number]} descriptor
 */
async function pollOne(descriptor) {
  const row = { id: descriptor.id, kind: descriptor.kind, source: descriptor.source, pinned: descriptor.pinned, pinnedAt: /** @type {string | null} */ (null),
    latest: /** @type {string | null} */ (null), latestAt: /** @type {string | null} */ (null), behind: /** @type {boolean | null} */ (null),
    lagDays: /** @type {number | null} */ (null), note: "" };
  try {
    if (descriptor.kind === "npm") {
      const doc = await packument(descriptor.source);
      // The `latest` tag of the top-level package named here, and nothing else: subpackages are not read.
      row.latest = doc["dist-tags"]?.latest ?? null;
      row.pinnedAt = doc.time?.[descriptor.pinned] ?? null;
      row.latestAt = row.latest ? doc.time?.[row.latest] ?? null : null;
      if (descriptor.id === "dsh") row.note = `next ${doc["dist-tags"]?.next ?? "?"}, alpha ${doc["dist-tags"]?.alpha ?? "?"}`;
    } else if (descriptor.kind === "pypi") {
      const doc = await getJson(`https://pypi.org/pypi/${descriptor.source}/json`);
      row.latest = doc.info?.version ?? null;
      row.pinnedAt = doc.releases?.[descriptor.pinned]?.[0]?.upload_time_iso_8601 ?? null;
      row.latestAt = row.latest ? doc.releases?.[row.latest]?.[0]?.upload_time_iso_8601 ?? null : null;
    } else {
      const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
      const releases = await getJson(`https://api.github.com/repos/${descriptor.source}/releases?per_page=50`, { accept: "application/vnd.github+json", ...headers });
      // A release's tag is its prefix and its version; one repository can publish more than one product (LoopX's CLI and its
      // DSH plugin), and a tag without this product's prefix is another product's.
      const prefix = descriptor.tagPrefix ?? "v";
      const matching = (Array.isArray(releases) ? releases : []).filter((release) => !release.draft && String(release.tag_name ?? "").startsWith(prefix) && /^\d/.test(String(release.tag_name).slice(prefix.length)));
      const strip = (/** @type {string} */ tag) => tag.slice(prefix.length);
      const first = matching.find((release) => !release.prerelease) ?? matching[0];
      row.latest = first ? strip(String(first.tag_name)) : null;
      row.latestAt = first?.published_at ?? null;
      const pinnedRelease = matching.find((release) => strip(String(release.tag_name)) === descriptor.pinned);
      row.pinnedAt = pinnedRelease?.published_at ?? null;
    }
    row.behind = row.latest ? row.latest !== descriptor.pinned : null;
    row.lagDays = row.behind && row.pinnedAt && row.latestAt ? daysBetween(row.pinnedAt, row.latestAt) : null;
    if (row.latest === null) row.note = row.note || "the source named no release matching the pattern";
  } catch (error) {
    row.note = `could not be read: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`;
  }
  return row;
}

/** @param {string} dir the unpacked closure's `node_modules` @returns {Map<string, string>} name -> version of every @deepseek-ai package */
function installedKernelPackages(dir) {
  /** @type {Map<string, string>} */
  const found = new Map();
  const scope = path.join(dir, "@deepseek-ai");
  /** @type {string[]} */
  let names = [];
  try { names = readdirSync(scope); } catch { return found; }
  for (const name of names) {
    try { found.set(`@deepseek-ai/${name}`, JSON.parse(readFileSync(path.join(scope, name, "package.json"), "utf8")).version); } catch { /* not a package */ }
  }
  return found;
}

/** The web profile the CLI ships, composed in a scratch home. @param {string} modulesDir @returns {string} */
function dumpWebProfile(modulesDir) {
  const home = mkdtempSync(path.join(os.tmpdir(), "evimed-dsh-home-"));
  try {
    return execFileSync(path.join(modulesDir, ".bin", "dsh"), ["--profile", "web", "--dump-config"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
      env: { PATH: process.env.PATH ?? "", DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", HOME: home },
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Declared peers of the pinned third-party bundles. @param {Record<string, any>} pins */
async function bundlePeers(pins) {
  /** @type {{ bundle: string, peers: Record<string, string> }[]} */
  const bundles = [];
  /** @type {string[]} */
  const unknown = [];
  const fromRegistry = async (/** @type {string} */ name, /** @type {string} */ version) => {
    try {
      const doc = await getJson(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
      bundles.push({ bundle: `${name}@${version}`, peers: doc.peerDependencies ?? {} });
    } catch (error) { unknown.push(`peers of ${name}@${version}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 100)}`); }
  };
  await fromRegistry("dsh-cite", pins.dsh.citeVersion);
  await fromRegistry("@changfenhuang/dsh-annotation", pins.dsh.annotationVersion);
  await fromRegistry("dsh-mermaid", pins.dsh.mermaidVersion);
  await fromRegistry(pins.openviking.plugin.name, pins.openviking.plugin.version);
  // LoopX's plugin is a release asset, not an npm package: the pinned archive's own package.json.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "evimed-loopx-peers-"));
  try {
    const archive = path.join(scratch, "plugin.tgz");
    const response = await fetch(pins.loopx.plugin.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    const manifest = JSON.parse(execFileSync("tar", ["-xzOf", archive, "package/package.json"], { encoding: "utf8" }));
    bundles.push({ bundle: `${manifest.name}@${manifest.version}`, peers: manifest.peerDependencies ?? {} });
  } catch (error) { unknown.push(`peers of the LoopX plugin: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 100)}`); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
  return { bundles, unknown };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { args[argv[i].slice(2)] = next; i += 1; } else args[argv[i].slice(2)] = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pins = JSON.parse(readFileSync(path.join(repoRoot, "deps-version.json"), "utf8"));
  const out = path.resolve(String(args.out ?? "candidate-check.json"));
  /** @type {string[]} */
  const unknown = [];
  const root = await packument(pins.dsh.npmPackage ?? "@deepseek-ai/dsh");
  const distTags = root["dist-tags"] ?? {};
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    pin: { dsh: pins.dsh.version, publishedAt: root.time?.[pins.dsh.version] ?? null, cordis: pins.dsh.cordis },
    distTags: { latest: distTags.latest ?? null, next: distTags.next ?? null, alpha: distTags.alpha ?? null },
    candidates: /** @type {any[]} */ ([]),
    pins: /** @type {any[]} */ ([]),
    unknown,
  };

  const wanted = candidateVersions(distTags, pins.dsh.version).filter((entry) => !args.only || entry.version === args.only || entry.tags.includes(String(args.only)));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "evimed-candidate-"));
  try {
    // The pinned closure: reused when the caller has it (the nightly job just installed it), installed otherwise.
    /** @type {string | null} */
    let pinnedModules = args["pinned-modules"] ? path.resolve(String(args["pinned-modules"])) : null;
    if (!pinnedModules && wanted.some((entry) => !entry.samePin)) {
      try { pinnedModules = await installKernel(pins, { dir: mkdtempSync(path.join(scratch, "pinned-")) }); }
      catch (error) { unknown.push(`the pinned closure could not be installed: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 160)}`); }
    }
    const pinnedPackages = pinnedModules ? installedKernelPackages(pinnedModules) : new Map();
    const pinnedRows = pinnedModules ? parseCompositionRows(dumpWebProfile(pinnedModules)) : null;
    const peers = wanted.some((entry) => !entry.samePin) ? await bundlePeers(pins) : { bundles: [], unknown: [] };
    unknown.push(...peers.unknown);

    for (const entry of wanted) {
      const row = {
        version: entry.version, tags: entry.tags, publishedAt: root.time?.[entry.version] ?? null,
        lagDays: daysBetween(report.pin.publishedAt, root.time?.[entry.version]),
        ageDays: daysBetween(root.time?.[entry.version], new Date().toISOString()),
        closure: /** @type {any} */ (null), composition: /** @type {any} */ (null), seams: /** @type {any} */ (null),
        peers: /** @type {any[]} */ ([]), verdict: "", reasons: /** @type {string[]} */ ([]),
      };
      if (entry.samePin) {
        Object.assign(row, verdictFor({ samePin: true, seams: null, peers: [], composition: null, installed: true }));
        report.candidates.push(row);
        continue;
      }
      let modules = null;
      try {
        const computed = await computePublishedBefore({ npmPackage: pins.dsh.npmPackage, version: entry.version });
        const dir = mkdtempSync(path.join(scratch, "candidate-"));
        const candidatePins = { dsh: { ...pins.dsh, version: entry.version, publishedBefore: computed.publishedBefore } };
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "evimed-kernel-candidate", private: true }));
        execFileSync("npm", kernelInstallArgs(candidatePins, dir), { stdio: ["ignore", "ignore", "inherit"], timeout: 900_000 });
        modules = path.join(dir, "node_modules");
        const installed = installedKernelPackages(modules);
        row.closure = { packages: installed.size, cutoff: computed.publishedBefore, ...packageNameDiff([...pinnedPackages.keys()], [...installed.keys()]) };
        if (pinnedRows) row.composition = { profile: "web", ...compositionDiff(pinnedRows, parseCompositionRows(dumpWebProfile(modules))) };
        else unknown.push(`${entry.version}: no pinned closure to diff the composition against`);
        // The seam check, as the script that exists for it: JSON on stdout, the lines on stderr.
        try {
          const stdout = execFileSync("node", [path.join(here, "verify-harness-seams.mjs"), "--modules", modules, "--candidate", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
          const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
          row.seams = shapeSeams(parsed);
        } catch (error) {
          const stdout = String(/** @type {any} */ (error)?.stdout ?? "");
          try { row.seams = shapeSeams(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")); }
          catch { unknown.push(`${entry.version}: the seam check did not produce a verdict`); }
        }
        const requireFrom = createRequire(path.join(modules, "noop.js"));
        let satisfies = (/** @type {string} */ version, /** @type {string} */ range) => { void version; void range; throw new Error("semver unavailable"); };
        try { const semver = requireFrom("semver"); satisfies = (version, range) => semver.satisfies(version, range, { includePrerelease: true }); }
        catch { unknown.push(`${entry.version}: semver is not in the candidate closure; peer ranges were not evaluated`); }
        row.peers = peerFindings(peers.bundles, { kernel: entry.version, installed, communityPeers: pins.dsh.communityPeerPins ?? {}, satisfies });
        Object.assign(row, verdictFor({ samePin: false, seams: row.seams, peers: row.peers, composition: row.composition, installed: true }));
      } catch (error) {
        row.reasons = [`the candidate could not be installed or read: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`];
        row.verdict = "unknown";
      } finally {
        if (modules) rmSync(path.dirname(modules), { recursive: true, force: true });
      }
      report.candidates.push(row);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }

  if (!args["no-pins"]) report.pins = await Promise.all(pollDescriptors(pins).map(pollOne));
  const staging = `${out}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(staging, out);

  const line = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);
  line(`kernel candidate check -> ${out}`);
  line(`  pin ${report.pin.dsh} (${report.pin.publishedAt ?? "?"}); dist-tags ${JSON.stringify(report.distTags)}`);
  for (const candidate of report.candidates) {
    line(`  ${candidate.version} [${candidate.tags.join(",")}] ${candidate.verdict}: ${candidate.lagDays ?? "?"} days after the pin, ${candidate.ageDays ?? "?"} days old` +
      `${candidate.composition ? `, composition +${candidate.composition.added.length} -${candidate.composition.removed.length} ~${candidate.composition.changed.length}` : ""}`);
    for (const reason of candidate.reasons) line(`      - ${reason}`);
  }
  for (const entry of report.pins.filter((row) => row.behind)) line(`  behind: ${entry.id} ${entry.pinned} -> ${entry.latest}${entry.lagDays != null ? ` (${entry.lagDays} days)` : ""}`);
  for (const note of unknown) line(`  unknown: ${note}`);
}

/** The verify script's JSON as this report carries it. @param {any} parsed */
export function shapeSeams(parsed) {
  const checks = Array.isArray(parsed?.checks) ? parsed.checks : [];
  const failed = checks.filter((/** @type {any} */ c) => c && c.ok === false).map((/** @type {any} */ c) => ({ label: String(c.label), detail: String(c.detail ?? "") }));
  const list = (/** @type {any} */ value) => (Array.isArray(value) ? value.map(String) : []);
  return {
    ok: failed.length === 0 && checks.length > 0,
    failed,
    wire: { unclassified: list(parsed?.wire?.unclassified), phantom: list(parsed?.wire?.phantom) },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
