#!/usr/bin/env node
/**
 * The nightly compatibility matrix.
 *
 * Hidden knowledge: how a dependency that promises nothing is tracked without
 * either freezing forever or breaking without warning.
 *
 * One job, looping over the keys of `deps-version.json`. That is the whole
 * design decision worth stating: four tracked dependencies with four copies of
 * the same discipline is four things to keep in step, and the copies drift the
 * same way the code they watch does.
 *
 * What it does per dependency: find the newest upstream release, compare it to
 * the pin, and run that dependency's contract tests **at the pinned version**.
 * A red row means the build is broken where it stands. A `behind` row means
 * upstream moved and someone should look.
 *
 * What it does not do, stated because the two are easy to confuse: it does not
 * test `latest`. The contract run is `contractAtPin` — that name is the honest
 * one — so a green row says nothing about whether the newest release would
 * pass. A real test-latest tier has to install the candidate into a scratch
 * tree and re-run the contracts there, and the four tracked dependencies do not
 * install alike (`dsh` is npm, `mineru` is PyPI, `openlist` is a container
 * image, `memos` is a self-hosted service), so it is its own piece of work
 * rather than a flag on this one. Until it exists, an upgrade PR still has to
 * run the contracts by hand after moving the pin.
 *
 * What it also does not do: upgrade anything. The pin moves in a PR a person reads.
 *
 * A security fix does not wait for this job — the release notes are read the day
 * they land, and the same checks run then.
 *
 * Usage:
 *   node scripts/ops/upstream-compat-matrix.mjs [--dep dsh] [--out compat-matrix.json] [--offline]
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @param {string[]} argv @returns {Record<string, string | boolean>} */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[token.slice(2)] = next;
      index += 1;
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

/**
 * The newest release that belongs to the product being tracked.
 *
 * Split out and exported so it can be tested without the network: the defect it
 * exists for is a data-shape one, and reaching GitHub to reproduce it would
 * make the test both slow and dependent on what upstream happens to have
 * published today.
 *
 * @param {readonly Record<string, any>[]} releases GitHub's release feed, newest first
 * @param {string} [tagPattern] override for a project whose tags are not plain versions
 * @returns {{ latest: string | null, reason: string }}
 */
export function selectReleaseVersion(releases, tagPattern) {
  const pattern = tagPattern ? new RegExp(tagPattern) : /^v?\d+\.\d+/;
  const match = (Array.isArray(releases) ? releases : [])
    .filter((release) => !release?.draft && !release?.prerelease)
    .map((release) => String(release?.tag_name ?? ""))
    .find((tag) => pattern.test(tag));
  // Nothing matching is "cannot be learned", not "unchanged": a pattern that
  // stops matching after an upstream renaming must show up as unknown rather
  // than as a silent green.
  if (!match) return { latest: null, reason: `github: no release tag matched ${pattern}` };
  return { latest: match.replace(/^v/, ""), reason: "github" };
}

/**
 * The newest release upstream published, or null when it cannot be learned.
 *
 * "Cannot be learned" is a distinct outcome from "unchanged": a matrix that
 * silently reports green because the network was down is a matrix that reports
 * green forever.
 *
 * @param {string} name @param {Record<string, any>} pin @param {boolean} offline
 * @returns {Promise<{ latest: string | null, reason: string }>}
 */
async function latestVersion(name, pin, offline) {
  if (offline) return { latest: null, reason: "offline" };
  try {
    if (pin.npmPackage) {
      const { stdout } = await execFileAsync("npm", ["view", pin.npmPackage, "versions", "--json"], { timeout: 60_000 });
      const versions = JSON.parse(stdout);
      const list = Array.isArray(versions) ? versions : [versions];
      return { latest: list.at(-1) ?? null, reason: "npm" };
    }
    if (pin.pipPackage) {
      const response = await fetch(`https://pypi.org/pypi/${pin.pipPackage}/json`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) return { latest: null, reason: `pypi ${response.status}` };
      const body = await response.json();
      return { latest: String(body?.info?.version ?? "") || null, reason: "pypi" };
    }
    if (pin.githubRepo) {
      // An image tag is not a version list; the release feed is.
      //
      // The feed, not `releases/latest`: one repository can publish more than
      // one product. `MemTensor/MemOS` ships both MemOS itself (`v2.0.30`, the
      // thing pinned here) and a separate local plugin
      // (`memos-local-plugin-v2.0.17`), and `releases/latest` answers with
      // whichever was published most recently. That made the matrix report
      // `memos 2.0.30 → memos-local-plugin-v2.0.16`: not a version, a different
      // product, and a downgrade — an upgrade instruction an operator could
      // have followed. Releases whose tag is not a plain version are another
      // product's, and are skipped.
      const response = await fetch(`https://api.github.com/repos/${pin.githubRepo}/releases?per_page=100`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) return { latest: null, reason: `github ${response.status}` };
      const body = await response.json();
      return selectReleaseVersion(Array.isArray(body) ? body : [], pin.releaseTagPattern);
    }
    // A dependency whose upstream cannot be polled is reported as such rather
    // than assumed current: a matrix that reports green because it could not
    // look is a matrix that reports green forever.
    return { latest: null, reason: "no machine-readable release feed configured" };
  } catch (error) {
    return { latest: null, reason: `lookup failed: ${error?.message ?? error}` };
  }
}

/**
 * @param {string} name @param {Record<string, any>} pin
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
async function runContractTests(name, pin) {
  const dir = path.join(repoRoot, String(pin.contractDir ?? `packages/contracts/${name}`));
  try {
    const { stdout } = await execFileAsync("node", ["--test", `${dir}/*.test.mjs`], { cwd: repoRoot, timeout: 300_000, shell: true });
    return { ok: true, output: stdout.slice(-4000) };
  } catch (error) {
    return { ok: false, output: `${error?.stdout ?? ""}${error?.stderr ?? ""}`.slice(-4000) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const offline = Boolean(args.offline);
  const pins = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
  const names = args.dep ? [String(args.dep)] : Object.keys(pins).filter((key) => !key.startsWith("$"));

  /** @type {Record<string, any>[]} */
  const rows = [];
  for (const name of names) {
    const pin = pins[name];
    const { latest, reason } = await latestVersion(name, pin, offline);
    const behind = Boolean(latest && latest !== pin.version);
    const contract = await runContractTests(name, pin);
    rows.push({
      dependency: name,
      pinned: pin.version,
      latest,
      latestSource: reason,
      behind,
      // A contract failure at the *pinned* version is a broken build, not an
      // upgrade signal; the two read very differently and must not be merged.
      contractAtPin: contract.ok ? "pass" : "fail",
      ...(contract.ok ? {} : { output: contract.output }),
      verdict: contract.ok
        ? (behind ? "upgrade-candidate" : latest ? "current" : "unknown-upstream")
        : "broken-at-pin",
    });
  }

  const matrix = {
    // A timestamp is passed in rather than read, so a re-run of the same inputs
    // produces the same file and a diff means something changed upstream.
    generatedAt: String(args.at ?? new Date().toISOString()),
    rows,
    failures: rows.filter((row) => row.verdict === "broken-at-pin").map((row) => row.dependency),
    upgradeCandidates: rows.filter((row) => row.verdict === "upgrade-candidate").map((row) => `${row.dependency} ${row.pinned} → ${row.latest}`),
    unknownUpstream: rows.filter((row) => row.verdict === "unknown-upstream").map((row) => `${row.dependency}: ${row.latestSource}`),
  };

  const out = String(args.out ?? "");
  if (out) await writeFile(path.resolve(repoRoot, out), `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
  // Only a contract failing at the pinned version fails the job. Being behind
  // upstream is information, not a defect — treating it as one trains everyone
  // to ignore the job.
  if (matrix.failures.length) process.exitCode = 1;
}

await main();
