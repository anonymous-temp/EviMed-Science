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
//
// The scratch profile composes the SAME base the real one does. An earlier
// version installed only the candidate, which has no host app at all — every
// candidate "failed to boot" and the verdict said nothing about the candidate.
// A harness that fails everything is indistinguishable from a harness that
// works and everything is broken, so it has to compose what production
// composes.
const script = (name, version) => `
export DSH_HOME=/var/tmp/try-${name}
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
# A baseline boot of base+web-app alone would also have to pass for the verdict
# to mean anything; it does, because that is what the image's own seed profile
# is built from and the build smoke boots it every time.
out=$(timeout 60 dsh --profile t --no-open --port 45997 2>&1)
if echo "$out" | grep -q "dsh web:"; then
  echo "BOOTED"
else
  reason=$(echo "$out" | grep -vE '^[[:space:]]+at |ExperimentalWarning|--trace-warnings' \
    | grep -oE "failed to apply loader entry [a-z0-9-]+ \\([^)]*\\)[^\"]{0,120}|Cannot find package .[^ ]+|invalid config:.{0,120}" | head -1)
  echo "BOOT_FAILED: \${reason:-$(echo "$out" | grep -vE '^[[:space:]]+at ' | tail -2 | tr '\n' ' ' | cut -c1-300)}"
fi
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
