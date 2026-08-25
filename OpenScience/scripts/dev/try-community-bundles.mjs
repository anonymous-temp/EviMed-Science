#!/usr/bin/env node
/**
 * Install each tool-form community bundle into a scratch DSH profile inside the
 * runtime image, boot it, and report which ones survive.
 *
 * A bundle is all-or-nothing in a way a skill is not: it joins the host
 * composition and registers model-facing tools, so the only honest way to
 * evaluate one is to compose it and start it. That is also the only way to find
 * the failures that matter — a peer dependency the profile cannot resolve, a row
 * whose plugin will not import, a tool name that collides with one of ours.
 *
 * This does not change the runtime image. Moving a candidate into it is a
 * deliberate Dockerfile edit with an exact version.
 *
 * Usage: node scripts/dev/try-community-bundles.mjs [image-tag]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "runtime/skills/community/try-install.json"), "utf8"));
const image = process.argv[2] ?? "evimed-runtime-dsh:latest";

// One container per candidate: a bundle that breaks the composition must not be
// able to decide the verdict for the ones after it.
const script = (name, version) => `
set -e
export DSH_HOME=/var/tmp/try-${name}
rm -rf "$DSH_HOME"; mkdir -p "$DSH_HOME/profiles/t"
cp /opt/evimed/profile-pnpm-workspace.yaml "$DSH_HOME/profiles/t/pnpm-workspace.yaml"
dsh plugin --profile t add "${name}@${version}" >/dev/null 2>&1 || { echo "INSTALL_FAILED"; exit 0; }
out=$(timeout 40 dsh --profile t --no-open --port 45997 2>&1 || true)
if echo "$out" | grep -q "dsh web:"; then echo "BOOTED"
else echo "BOOT_FAILED: $(echo "$out" | grep -oE "failed to apply loader entry [a-z-]+|Cannot find package .[^ ]+" | head -1)"; fi
`;

/** @type {{name: string, verdict: string}[]} */
const results = [];
for (const candidate of manifest.candidates) {
  const run = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "sh", image, "-c", script(candidate.name, candidate.version)],
    { encoding: "utf8", timeout: 300_000 },
  );
  const verdict = (run.stdout ?? "").trim().split("\n").pop() ?? `docker exited ${run.status}`;
  results.push({ name: candidate.name, verdict });
  process.stdout.write(`${candidate.name}@${candidate.version}: ${verdict}\n`);
}

const failed = results.filter((result) => !result.verdict.startsWith("BOOTED"));
process.stdout.write(`\n${results.length - failed.length}/${results.length} boot in a scratch profile.\n`);
// Not a gate: this reports, it does not decide. Nothing here is in the image.
process.exit(0);
