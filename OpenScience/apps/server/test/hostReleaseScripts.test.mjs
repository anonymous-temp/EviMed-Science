// The two scripts that cut and switch a release on the serving host. They ran
// out of /tmp until 2026-09-17, unversioned, and the switch recreated four
// containers from the release directory: every other container kept naming, by
// absolute path, a release that a later cleanup removed. These hold the three
// properties that incident turned on. They read the scripts as text because
// what they do needs a docker host to run; `bash -n` is what proves they parse.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const opsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const scripts = ["host-delta-release.sh", "host-release-switch.sh"];

/** The script without its comments, so a sentence ABOUT `rm -rf` is not read as one. */
async function code(name) {
  const text = await readFile(path.join(opsDir, name), "utf8");
  return text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

test("both host release scripts parse", async () => {
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
