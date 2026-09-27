// The two scripts that cut and switch a release on the serving host. They ran
// out of /tmp until 2026-09-17, unversioned, and the switch recreated four
// containers from the release directory: every other container kept naming, by
// absolute path, a release that a later cleanup removed. These hold the three
// properties that incident turned on. They read the scripts as text because
// what they do needs a docker host to run; `bash -n` is what proves they parse.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const opsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const repoRoot = path.resolve(opsDir, "../..");
const scripts = ["host-delta-release.sh", "host-release-switch.sh", "host-engine-delta.sh"];

/** The script without its comments, so a sentence ABOUT `rm -rf` is not read as one. */
async function code(name) {
  const text = await readFile(path.join(opsDir, name), "utf8");
  return text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

test("every host release script parses", async () => {
  for (const name of scripts) await run("bash", ["-n", path.join(opsDir, name)]);
});

test("the switch moves `current` first and runs compose through it", async () => {
  const text = await code("host-release-switch.sh");
  const moved = text.indexOf('mv -T "${ROOT}/current.next" "${ROOT}/current"');
  const entered = text.indexOf('cd "${ROOT}/current/OpenScience/deploy/web"');
  const composed = text.indexOf('"${COMPOSE[@]}" config --hash');
  assert.ok(moved > 0 && entered > moved && composed > entered, "current is moved, then entered, then compose runs");
  assert.doesNotMatch(text, /cd "\$\{?REL\}?/, "compose must never run from the release directory");
});

test("old releases leave through release-retention, which refuses what a container still names", async () => {
  const text = await code("host-release-switch.sh");
  assert.match(text, /release-retention\.mjs prune "\$\{ROOT\}\/releases" --keep 2 --images --apply/);
  assert.doesNotMatch(text, /rm -rf[^\n]*releases/, "a release directory is never removed by hand");
  // And only after the switch has proved itself.
  assert.ok(text.indexOf("bind source(s) do not exist") < text.indexOf("release-retention.mjs"));
  assert.ok(text.indexOf("readiness is not ok") < text.indexOf("release-retention.mjs"));
});

test("the delta build applies the deletions an overlay cannot", async () => {
  const text = await code("host-delta-release.sh");
  assert.match(text, /src\/DELETED/);
  assert.match(text, /''\|\/\*\|\*\.\.\*\) echo "refusing deletion path/, "an absolute or traversing deletion path is refused");
});

test("a release whose kernel profile changed builds the runtime in full, through the host's mirrors", async () => {
  const text = await code("host-delta-release.sh");
  const full = text.slice(text.indexOf('if [ "${EVIMED_RUNTIME_BUILD:-delta}" = "full" ]'), text.indexOf("Dockerfile.delta \\"));
  assert.match(full, /-f deploy\/runtime-dsh\/Dockerfile \\/, "the full build uses the full Dockerfile");
  for (const arg of ["APT_MIRROR", "DEBIAN_SECURITY_MIRROR", "NODE_DIST_BASE", "NPM_REGISTRY", "GITHUB_DOWNLOAD_PREFIX", "PIP_INDEX_URL", "RELEASE_ID", "SOURCE_REVISION", "BUILD_CREATED"]) {
    assert.match(full, new RegExp(`--build-arg ${arg}=`), `the full build passes ${arg}`);
  }
});

test("an engine delta re-pins the adapter manifest for the package it ships", async () => {
  // 2026-09-27: the MR engine compares the adapter package with the manifest
  // the full build pinned at /adapter/adapter-evidence.json before it admits a
  // job. A delta that copied a changed package over the base image's manifest
  // left every MR start refused with audit_adapter_manifest_changed.
  const text = await code("host-engine-delta.sh");
  const packageCopy = text.indexOf("COPY OpenScience/deploy/specialist-adapter/evimed_specialist_adapter /adapter/evimed_specialist_adapter");
  const inputsCopy = text.indexOf("COPY OpenScience/deploy/specialist-adapter/Dockerfile OpenScience/deploy/specialist-adapter/Dockerfile.evidence OpenScience/deploy/specialist-adapter/requirements.txt /adapter/");
  const repin = text.indexOf("RUN rm -f /adapter/adapter-evidence.json && python -m evimed_specialist_adapter.audit_receipt --write-adapter-manifest /adapter/adapter-evidence.json");
  assert.ok(packageCopy > 0, "the delta copies the adapter package");
  assert.ok(inputsCopy > packageCopy, "the deployment inputs the manifest names are copied with it");
  assert.ok(repin > inputsCopy, "the manifest is written after both, from what the image now holds");
  // The same command the full build pins it with.
  const full = await readFile(path.join(repoRoot, "deploy/specialist-adapter/Dockerfile"), "utf8");
  assert.match(full, /^RUN python -m evimed_specialist_adapter\.audit_receipt --write-adapter-manifest \/adapter\/adapter-evidence\.json$/m);
});

test("the delta build replaces every skill tree the preset mounts from the source it is built from", async () => {
  // 2026-09-26 (platform audit I2-4): Dockerfile.delta copied the curated
  // skills and the GEO pack but not core, community or office, so the preset
  // re-copied the base image's trees and a changed mplstyle in core never
  // reached production while the release manifest recorded it.
  const install = await readFile(path.join(repoRoot, "deploy/runtime-dsh/install-runtime.sh"), "utf8");
  const delta = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile.delta"), "utf8");
  const presetRoots = [...install.matchAll(/^\s*cp -a \S+ \/opt\/evimed\/socket\/presets\/evimed-universal\/skills\/([a-z-]+)$/gm)].map((match) => match[1]);
  assert.ok(presetRoots.length >= 6, `read the preset's skill roots from install-runtime.sh (${presetRoots.join(", ")})`);
  for (const tree of presetRoots) {
    // `evimed` is the tree the image takes one agent package out of; the delta
    // copies that package file by file (open-domain-answer).
    const source = tree === "evimed" ? "runtime/skills/evimed/open-domain-answer" : `runtime/skills/${tree}`;
    assert.match(delta, new RegExp(`^COPY ${source} \\S+$`, "m"), `Dockerfile.delta does not copy ${source}`);
  }
});

test("a delta may move the community skills but not a bundle pin the profile seed was installed at", async () => {
  const delta = await readFile(path.join(repoRoot, "deploy/runtime-dsh/Dockerfile.delta"), "utf8");
  const script = delta.match(/node -e '([^']+)' \\\n\s+\/opt\/evimed\/skills\/community\/plugin-support\.json/)?.[1];
  assert.ok(script, "the pin guard is in Dockerfile.delta");
  const dir = await mkdtemp(path.join(tmpdir(), "delta-pins-"));
  try {
    const record = JSON.parse(await readFile(path.join(repoRoot, "runtime/skills/community/plugin-support.json"), "utf8"));
    const write = async (name, value) => { const file = path.join(dir, name); await writeFile(file, JSON.stringify(value)); return file; };
    const base = await write("base.json", record);
    const guard = async (file) => run(process.execPath, ["-e", script, base, file]);
    // Prose and the native-plugin list move freely.
    await guard(await write("prose.json", { ...record, nativePlugins: [...record.nativePlugins, "evimed-example"],
      communityToolBundles: record.communityToolBundles.map((bundle) => ({ ...bundle, testedOn: "2099-01-01" })) }));
    // A version the seed was installed at does not, nor the kernel.
    const moved = structuredClone(record);
    moved.communityClientBundles[0].version = "9.9.9";
    await assert.rejects(guard(await write("moved.json", moved)), /moved the kernel or a bundle pin/);
    await assert.rejects(guard(await write("kernel.json", { ...record, kernel: "@deepseek-ai/dsh@9.9.9" })), /moved the kernel or a bundle pin/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
