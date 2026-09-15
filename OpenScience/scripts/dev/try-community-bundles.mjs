#!/usr/bin/env node
/**
 * Install each tool-form community bundle into a scratch DSH profile inside the
 * runtime image, boot it, scan what got installed, and report.
 *
 * A bundle is all-or-nothing in a way a skill is not: it joins the host
 * composition and registers model-facing tools, so the only honest way to
 * evaluate one is to compose it and start it. That is also the only way to find
 * the failures that matter — a peer dependency the profile cannot resolve, a row
 * whose plugin will not import, a tool name that collides with one of ours.
 *
 * The source scan is a second reading of the same installed tree: how many files
 * reach the network, start processes, write files, evaluate strings, read the
 * environment, or mount an HTTP route, plus what `package.json` declares. It is
 * a tool, not an approval — it counts, it does not decide, and nothing here
 * refuses a candidate on a count. What it buys is that a reviewer opening
 * `try-install.json` sees the shape of a package without unpacking it, and that
 * a version bump that starts reaching the network shows up as a number that
 * changed.
 *
 * This does not change the runtime image. Moving a candidate into it is a
 * deliberate Dockerfile edit with an exact version.
 *
 * Usage: node scripts/dev/try-community-bundles.mjs [image-tag] [--write] [--json]
 *   --write  record the run in try-install.json's lastCompatibilityTest
 *   --json   print the whole result object on stdout as one line
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(root, "runtime/skills/community/try-install.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const args = process.argv.slice(2);
const write = args.includes("--write");
const asJson = args.includes("--json");
const image = args.find((arg) => !arg.startsWith("--")) ?? "evimed-runtime-dsh:latest";

// One container per candidate: a bundle that breaks the composition must not be
// able to decide the verdict for the ones after it.
//
// The scratch profile composes the SAME base the real one does. An earlier
// version installed only the candidate, which has no host app at all — every
// candidate "failed to boot" and the verdict said nothing about the candidate.
// A harness that fails everything is indistinguishable from a harness that
// works and everything is broken, so it has to compose what production
// composes.
const script = (name, version) => `
export DSH_HOME=/var/tmp/try-${name.replace(/[^a-zA-Z0-9]+/g, "-")}
# From the binary, not from a build ARG: DSH_VERSION exists at build time and
# is not an image environment variable, so reading it here yielded an empty
# pin and \`@deepseek-ai/dsh-base@\` — which resolves to the \`latest\` dist-tag,
# i.e. the first release ever cut (see the pinning note in the Dockerfile).
dsh_version=$(dsh --version 2>/dev/null | head -1 | tr -d '[:space:]')
rm -rf "$DSH_HOME"; mkdir -p "$DSH_HOME/profiles/t"
cp /opt/evimed/profile-pnpm-workspace.yaml "$DSH_HOME/profiles/t/pnpm-workspace.yaml"
install_log=$(dsh plugin --profile t add \
  "@deepseek-ai/dsh-base@\${dsh_version}" "@deepseek-ai/dsh-web-app@\${dsh_version}" \
  "${name}@${version}" 2>&1)
if [ $? -ne 0 ]; then
  echo "INSTALL_FAILED: $(echo "$install_log" | grep -vE '^$' | tail -2 | tr '\n' ' ' | cut -c1-300)"
  exit 0
fi

# ---- source scan -------------------------------------------------------
# Reads what pnpm actually placed on disk, not what the registry page claims.
# No backslashes anywhere in this block on purpose: it is a shell script inside
# a JS template literal, where a lone backslash is an escape the literal eats,
# so a find -type f with escaped parens reached the container as an
# unbalanced paren and every installable candidate reported a shell syntax
# error instead of a scan.
# Bracket expressions say the same thing and survive both layers.
pkg_dir=$(readlink -f "$DSH_HOME/profiles/t/node_modules/${name}" 2>/dev/null)
if [ -n "$pkg_dir" ] && [ -d "$pkg_dir" ]; then
  srcfiles="--include=*.js --include=*.mjs --include=*.cjs --include=*.ts --include=*.tsx --include=*.jsx"
  count() { grep -rIlE "$1" "$pkg_dir" $srcfiles 2>/dev/null | wc -l | tr -d " "; }
  files=$(count ".")
  net=$(count "(^|[^a-zA-Z0-9_.])fetch[(]|https?[.]request[(]|net[.]connect[(]|new WebSocket[(]|(axios|undici|node-fetch)")
  proc=$(count "child_process|execSync[(]|execFileSync[(]|spawnSync?[(]|node-pty")
  fswrite=$(count "writeFile(Sync)?[(]|mkdir(Sync)?[(]|rm(Sync)?[(]|unlink(Sync)?[(]|rename(Sync)?[(]")
  evalish=$(count "(^|[^a-zA-Z0-9_.])eval[(]|new Function[(]|vm[.]runIn")
  env=$(count "process[.]env")
  websrv=$(count "webServer|createServer[(]|[.]listen[(]")
  meta=$(node -e '
    const p = require(process.argv[1] + "/package.json");
    const s = p.scripts || {};
    const hooks = ["preinstall", "install", "postinstall", "prepare"].filter((k) => s[k]);
    process.stdout.write([
      "installScripts=" + (hooks.length ? hooks.join("+") : "none"),
      "bundle=" + (p.dsh && p.dsh.bundle ? "yes" : "no"),
      "client=" + (p.dsh && p.dsh.client ? "yes" : "no"),
      "license=" + (p.license || "unstated"),
      "deps=" + Object.keys(p.dependencies || {}).length,
      "peers=" + (Object.keys(p.peerDependencies || {}).join(",") || "none").slice(0, 160),
    ].join(" "));
  ' "$pkg_dir" 2>/dev/null || echo "packageJson=unreadable")
  echo "SCAN: files=$files net=$net proc=$proc fsWrite=$fswrite eval=$evalish env=$env httpRoute=$websrv $meta"
else
  echo "SCAN: installed package directory not found"
fi

# ---- boot --------------------------------------------------------------
# A baseline boot of base+web-app alone would also have to pass for the verdict
# to mean anything; it does, because that is what the image's own seed profile
# is built from and the build smoke boots it every time.
out=$(timeout 120 dsh --profile t --no-open --port 45997 2>&1)
if echo "$out" | grep -q "dsh web:"; then
  echo "BOOTED"
else
  reason=$(echo "$out" | grep -vE '^[[:space:]]+at |ExperimentalWarning|--trace-warnings' \
    | grep -oE 'failed to apply loader entry [a-z0-9-]+ \\([^)]*\\)[^\"]{0,120}|Cannot find package .[^ ]+|invalid config:.{0,120}' | head -1)
  echo "BOOT_FAILED: \${reason:-$(echo "$out" | grep -vE '^[[:space:]]+at ' | tail -2 | tr '\n' ' ' | cut -c1-300)}"
fi
`;

/** @type {{name: string, version: string, verdict: string, scan: string|null}[]} */
const results = [];
for (const candidate of manifest.candidates) {
  const run = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "sh", image, "-c", script(candidate.name, candidate.version)],
    { encoding: "utf8", timeout: 600_000 },
  );
  const stdout = (run.stdout ?? "").trim();
  const stderr = (run.stderr ?? "").trim();
  const lines = stdout.split("\n").filter(Boolean);
  const scan = lines.find((line) => line.startsWith("SCAN:")) ?? null;
  const verdict = lines.filter((line) => !line.startsWith("SCAN:")).at(-1)
    || stderr.split("\n").filter(Boolean).at(-1)
    || `docker exited ${run.status ?? "without status"}${run.signal ? ` (${run.signal})` : ""}`;
  results.push({ name: candidate.name, version: candidate.version, verdict, scan: scan ? scan.slice("SCAN:".length).trim() : null });
  process.stdout.write(`${candidate.name}@${candidate.version}: ${verdict}\n`);
  if (scan) process.stdout.write(`  ${scan}\n`);
}

const failed = results.filter((result) => !result.verdict.startsWith("BOOTED"));
process.stdout.write(`\n${results.length - failed.length}/${results.length} boot in a scratch profile.\n`);

if (write) {
  // The kernel the verdicts were judged against is read from the image itself.
  // Writing the pin we believe is in there would let the file claim a kernel the
  // run never touched, which is the exact confusion this rewrite exists to end.
  const kernel = spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", "dsh --version 2>/dev/null | head -1"], { encoding: "utf8", timeout: 120_000 });
  const version = (kernel.stdout ?? "").trim().split(/\s+/).pop() || "unknown";
  manifest.lastCompatibilityTest = {
    testedAt: new Date().toISOString().slice(0, 10),
    kernel: `@deepseek-ai/dsh@${version}`,
    image,
    results: Object.fromEntries(results.map((result) => [
      `${result.name}@${result.version}`,
      result.verdict.startsWith("BOOTED") ? "booted" : result.verdict.replace(/^(INSTALL_FAILED|BOOT_FAILED):\s*/, (match) => `${match.startsWith("INSTALL") ? "install failed" : "boot failed"}: `).trim(),
    ])),
    scan: Object.fromEntries(results.filter((result) => result.scan).map((result) => [`${result.name}@${result.version}`, result.scan])),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`recorded in ${path.relative(root, manifestPath)}\n`);
}

if (asJson) process.stdout.write(`${JSON.stringify({ image, results })}\n`);
// Not a gate: this reports, it does not decide. Nothing here is in the image.
process.exit(0);
