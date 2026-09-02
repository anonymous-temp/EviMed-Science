// The installed harness must be one release, not a mixture of them.
//
// `deps-version.json` pins `@deepseek-ai/dsh`, and every workspace manifest
// wrote that exact string, so every check we had said the pin held. It did
// not: the lockfile resolved twelve `@deepseek-ai/dsh-*` packages to
// `0.1.1-rc.2` while five sat at `0.1.2-alpha.3`, and `rc.2` does not satisfy
// the `^0.1.2-alpha.3` peer range those five declare. The tree we tested
// against was one no release had ever shipped.
//
// Two upstream behaviours produced it, and both are worth naming because the
// obvious fix does not address either:
//
//   1. pnpm's `auto-install-peers` cannot resolve a prerelease range. Given
//      `^0.1.2-alpha.3` it falls back to the `latest` dist-tag, and DSH
//      publishes prereleases under a separate `alpha` tag — so `latest` was
//      still `0.1.1-rc.2`, a *lower* version that the range excludes.
//   2. `pnpm.overrides` does not reach an auto-installed peer. Adding the
//      overrides moved 249 lockfile entries and left 12 untouched; only
//      declaring those packages explicitly in `harness-port` fixed them.
//      Both mechanisms are in place now, which is why the manifest carries
//      devDependencies that look redundant with the overrides. They are not.
//
// This is the lockfile twin of the whole-tree assertion in
// `deploy/runtime-dsh/Dockerfile`: same defect, same shape, one for what we
// install here and one for what the image installs there.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Every `@deepseek-ai/dsh…@<version>` the lockfile names, however nested.
 *  Peer suffixes are parenthesised, so a version runs to the first delimiter. */
const DSH_AT_VERSION = /@deepseek-ai\/(dsh[a-z-]*)@(\d[^ ()',]*)/g;

/** Below this the scan, not the tree, is what is wrong. The lockfile named 19
 *  distinct harness packages when this was written; a scan that suddenly finds
 *  a handful has stopped matching, and a handful that all agree would
 *  otherwise read as a clean tree. */
const MINIMUM_PACKAGES_EXPECTED = 12;

test("every @deepseek-ai/dsh package in the lockfile is the pinned release", async () => {
  const pins = JSON.parse(await readFile(new URL("../../../deps-version.json", import.meta.url), "utf8"));
  const pin = pins.dsh.version;
  assert.match(pin, /^\d+\.\d+\.\d+/, "deps-version.json must carry a concrete dsh version");

  const lock = await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

  /** @type {Map<string, Set<string>>} package name -> versions seen */
  const seen = new Map();
  for (const [, name, version] of lock.matchAll(DSH_AT_VERSION)) {
    if (!seen.has(name)) seen.set(name, new Set());
    seen.get(name).add(version);
  }

  assert.ok(
    seen.size >= MINIMUM_PACKAGES_EXPECTED,
    `only ${seen.size} @deepseek-ai/dsh* packages found in ${repoRoot}pnpm-lock.yaml; ` +
      "the scan, not the tree, is wrong — an empty scan agrees with itself",
  );

  const drifted = [...seen]
    .flatMap(([name, versions]) => [...versions].map((version) => ({ name, version })))
    .filter(({ version }) => version !== pin);

  assert.deepEqual(
    drifted,
    [],
    `${drifted.length} of ${seen.size} @deepseek-ai/dsh* packages are not ${pin}: ` +
      `${drifted.map((d) => `${d.name}@${d.version}`).join(", ")}. ` +
      "A transitive peer resolved elsewhere — add it to packages/harness-port devDependencies " +
      "at the pin (an override alone will not reach an auto-installed peer) and reinstall.",
  );
});
