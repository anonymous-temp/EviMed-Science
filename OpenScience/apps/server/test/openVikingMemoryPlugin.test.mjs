// The official OpenViking memory plugin as the runtime image carries it.
//
// The plugin is built in the way LoopX's is — one digest-pinned archive, fetched at build time, added to the seeded profile,
// never installed during a turn — but it is not adapted: no byte is edited. These tests hold what that depends on: the pin is
// whole, the installed files are the archive's files, the bundle is ordered before the socket's on every volume (a patch can
// only reach a row an earlier bundle made), the build refuses an image in which it is not, and the three Dockerfiles, the
// phase script and the build smoke all say so. What a booted kernel does with it was measured on the real kernel and is
// recorded in the hand-off; `packages/harness-port/test/memoryBridge.test.mjs` holds the bridge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (/** @type {string} */ relative) => readFileSync(new URL(relative, root), "utf8");
const installer = await import(new URL("deploy/runtime-dsh/install-openviking-plugin.mjs", root).href);
const { mergeProfileBundles } = await import(new URL("deploy/runtime-dsh/profile-seed.mjs", root).href);
const pins = JSON.parse(read("deps-version.json"));
const sha256 = (/** @type {Buffer | string} */ bytes) => createHash("sha256").update(bytes).digest("hex");

/** A scratch directory, removed after the test. @param {import("node:test").TestContext} t */
function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ov-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A small package shaped like the plugin's archive, packed as npm packs one (everything under `package/`), and the pins that
 * name it.
 * @param {string} dir @param {Record<string, string>} [files]
 */
function archive(dir, files = {}) {
  const pkg = path.join(dir, "src", "package");
  mkdirSync(pkg, { recursive: true });
  const content = {
    "package.json": JSON.stringify({ name: "@openviking/dsh-memory-plugin", version: "9.9.9" }),
    "cordis.patch.yml": "- insert:\n    - id: openviking-memory-runtime\n      name: '@openviking/dsh-memory-plugin'\n",
    "index.mjs": "export const name = 'ov'\n",
    "skills/openviking-memory/SKILL.md": "---\nname: openviking-memory\n---\n",
    ...files,
  };
  for (const [relative, body] of Object.entries(content)) {
    mkdirSync(path.dirname(path.join(pkg, relative)), { recursive: true });
    writeFileSync(path.join(pkg, relative), body);
  }
  const archiveRoot = path.join(dir, "archive");
  mkdirSync(archiveRoot, { recursive: true });
  const file = path.join(archiveRoot, "dsh-memory-plugin-9.9.9.tgz");
  execFileSync("tar", ["-czf", file, "-C", path.join(dir, "src"), "package"]);
  const fixturePins = { openviking: { plugin: { ...pins.openviking.plugin, version: "9.9.9", filename: "dsh-memory-plugin-9.9.9.tgz", sha256: sha256(readFileSync(file)) } } };
  return { pkg, archiveRoot, pins: fixturePins };
}

test("the pin is whole: an exact version, a digest, the registry address of that version, and the row the socket's patch addresses", () => {
  const pin = installer.openVikingPluginPin(pins);
  assert.equal(pin.name, "@openviking/dsh-memory-plugin");
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.equal(pin.url, `https://registry.npmjs.org/@openviking/dsh-memory-plugin/-/${pin.filename}`);
  assert.equal(pin.filename, `dsh-memory-plugin-${pin.version}.tgz`);
  assert.equal(pins.openviking.npmPackage, pin.name);
  assert.equal(pin.bundleRow, "openviking-memory-runtime");
  assert.match(read("packages/socket/cordis.patch.yml"), new RegExp(`^- id: ${pin.bundleRow}$`, "m"), "the socket's patch overrides the plugin's row");
  for (const broken of [{ ...pin, sha256: "abc" }, { ...pin, filename: "../x.tgz" }, { ...pin, filename: "x.zip" }, { ...pin, url: undefined }]) {
    assert.throws(() => installer.openVikingPluginPin({ openviking: { plugin: broken } }), /not a complete pin|plain \.tgz/);
  }
  assert.throws(() => installer.openVikingPluginPin({}), /not a complete pin/);
});

test("an archive whose digest is not the pin's is refused before anything is installed from it", (t) => {
  const dir = scratch(t);
  const { archiveRoot, pins: fixturePins } = archive(dir);
  const file = path.join(archiveRoot, fixturePins.openviking.plugin.filename);
  assert.equal(installer.verifyOpenVikingPluginArchive(file, fixturePins.openviking.plugin.sha256), fixturePins.openviking.plugin.sha256);
  assert.throws(() => installer.verifyOpenVikingPluginArchive(file, "0".repeat(64)), /digest mismatch/);
  assert.throws(() => installer.verifyOpenVikingPluginArchive(file, "not-a-digest"), /digest mismatch/);
  // Already fetched and verified: nothing is downloaded (the pin's address is unreachable here, so a fetch would throw).
  assert.equal(installer.fetchOpenVikingPlugin({ pins: { openviking: { plugin: { ...fixturePins.openviking.plugin, url: "http://127.0.0.1:9/never.tgz" } } }, root: archiveRoot }), file);
});

test("the installed package must be the archive, file for file: a changed byte, an extra file and a missing one each fail by name", (t) => {
  const dir = scratch(t);
  const { archiveRoot, pins: fixturePins } = archive(dir);
  const extract = (/** @type {string} */ name) => {
    const target = path.join(dir, name);
    mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(archiveRoot, fixturePins.openviking.plugin.filename), "-C", target, "--strip-components=1"]);
    return target;
  };
  const verify = (/** @type {string} */ pluginDir) => installer.verifyInstalledOpenVikingPlugin({ pluginDir, pins: fixturePins, root: archiveRoot });
  const same = extract("same");
  assert.deepEqual(verify(same), { schemaVersion: 1, name: "@openviking/dsh-memory-plugin", version: "9.9.9", archiveSha256: fixturePins.openviking.plugin.sha256, files: 4, adaptation: "none" });

  const edited = extract("edited");
  writeFileSync(path.join(edited, "index.mjs"), "export const name = 'ov' // edited\n");
  assert.throws(() => verify(edited), /differs from the pinned archive in: index\.mjs/);

  const extra = extract("extra");
  writeFileSync(path.join(extra, "postinstall.mjs"), "x\n");
  assert.throws(() => verify(extra), /extra \[postinstall\.mjs\]/);

  const missing = extract("missing");
  rmSync(path.join(missing, "skills"), { recursive: true });
  assert.throws(() => verify(missing), /missing \[skills\/openviking-memory\/SKILL\.md\]/);

  const wrongVersion = extract("wrong-version");
  writeFileSync(path.join(wrongVersion, "package.json"), JSON.stringify({ name: "@openviking/dsh-memory-plugin", version: "9.9.8" }));
  assert.throws(() => verify(wrongVersion), /not the pinned/);
});

test("a plugin that no longer inserts the row the socket's patch addresses is refused", (t) => {
  const dir = scratch(t);
  const { archiveRoot, pins: fixturePins } = archive(dir, { "cordis.patch.yml": "- insert:\n    - id: openviking-memory\n      name: '@openviking/dsh-memory-plugin'\n" });
  const target = path.join(dir, "installed");
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(archiveRoot, fixturePins.openviking.plugin.filename), "-C", target, "--strip-components=1"]);
  assert.throws(() => installer.verifyInstalledOpenVikingPlugin({ pluginDir: target, pins: fixturePins, root: archiveRoot }), /no longer inserts the row openviking-memory-runtime/);
});

test("the bundle goes before the socket's whatever order pnpm left, and a profile without exactly one of each is refused", (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "package.json");
  const bundle = "@openviking/dsh-memory-plugin";
  const write = (/** @type {string[]} */ bundles) => writeFileSync(file, JSON.stringify({ name: "profile", dsh: { profile: { bundles } } }));
  const order = () => JSON.parse(readFileSync(file, "utf8")).dsh.profile.bundles;
  // pnpm's own order: by package name, so `@openviking/…` comes after `@evimed/…`.
  write(["@deepseek-ai/dsh-base", "dsh-loopx-plugin", "@evimed/dsh-socket", bundle, "dsh-cite"]);
  assert.deepEqual(installer.orderBundleBeforeSocket(file, bundle), ["@deepseek-ai/dsh-base", "dsh-loopx-plugin", bundle, "@evimed/dsh-socket", "dsh-cite"]);
  assert.deepEqual(order(), ["@deepseek-ai/dsh-base", "dsh-loopx-plugin", bundle, "@evimed/dsh-socket", "dsh-cite"]);
  const before = readFileSync(file, "utf8");
  installer.orderBundleBeforeSocket(file, bundle);
  assert.equal(readFileSync(file, "utf8"), before, "already ordered: the file is not rewritten");
  write(["@deepseek-ai/dsh-base", "@evimed/dsh-socket"]);
  assert.throws(() => installer.orderBundleBeforeSocket(file, bundle), /exactly one/);
  write(["@deepseek-ai/dsh-base", bundle, bundle, "@evimed/dsh-socket"]);
  assert.throws(() => installer.orderBundleBeforeSocket(file, bundle), /exactly one/);
});

test("a project volume keeps the image's order: the plugin lands before the socket on a volume made before it existed, and after LoopX", () => {
  const image = ["@deepseek-ai/dsh-base", "@changfenhuang/dsh-annotation", "@deepseek-ai/dsh-web-app", "dsh-loopx-plugin", "@openviking/dsh-memory-plugin", "@evimed/dsh-socket", "dsh-cite", "dsh-mermaid"];
  const withoutPlugin = image.filter((name) => name !== "@openviking/dsh-memory-plugin");
  // Production's list today: made before the plugin existed.
  assert.deepEqual(mergeProfileBundles(withoutPlugin, image), image);
  // A volume an earlier sync appended it to, after the socket: the socket's patch would find no row to switch off, and the
  // plugin would mount enabled on its own defaults for every account (measured on the seeded kernel, 2026-10-13).
  assert.deepEqual(mergeProfileBundles([...withoutPlugin, "@openviking/dsh-memory-plugin"], image), image);
  assert.deepEqual(mergeProfileBundles(["user-plugin", ...withoutPlugin], image), ["user-plugin", ...image], "an operator's own bundle keeps its slot");
  assert.deepEqual(mergeProfileBundles(image, image), image);
});

test("every image recipe fetches the archive, adds it to the seed, orders it, verifies it, and refuses an image in which a patch row found no target", () => {
  const phases = read("deploy/runtime-dsh/install-runtime.sh");
  assert.match(phases, /^\s+system\|.*\|openviking-plugin\|profile-seed\|/m, "the phase is a known phase");
  assert.match(phases, /openviking-plugin\) openviking_plugin ;;/);
  const seed = phases.slice(phases.indexOf("profile_seed() {"), phases.indexOf("\n}\n", phases.indexOf("profile_seed() {")));
  assert.match(seed, /openviking_archive=.*openviking\.plugin\.filename/);
  assert.match(seed, /dsh plugin --profile evimed-runtime add .*"\$\{loopx_archive\}" "\$\{openviking_archive\}" file:\/opt\/evimed\/socket/);
  const calls = [...seed.matchAll(/install-openviking-plugin\.mjs (order|verify)/g)].map((match) => match[1]);
  assert.deepEqual(calls, ["order", "verify"]);
  assert.ok(seed.indexOf("install-openviking-plugin.mjs order") < seed.indexOf("--dump-config"), "the order is fixed before the composition is recorded");
  // The serving kernel prints nothing when a patch row finds no target; only the dump says so, and the build must read it.
  assert.match(seed, /grep -E "patch\( insert\)\?: entry \.\* not found" \/opt\/evimed\/dump-config\.stderr/);
  assert.match(seed, /dump-config\.stderr/);
  for (const file of ["Dockerfile", "Dockerfile.agentbay"]) {
    const dockerfile = read(`deploy/runtime-dsh/${file}`);
    assert.match(dockerfile, /COPY deploy\/runtime-dsh\/install-openviking-plugin\.mjs \/usr\/local\/lib\/evimed\/install-openviking-plugin\.mjs/, file);
    assert.ok(dockerfile.indexOf("install-runtime.sh openviking-plugin") > dockerfile.indexOf("install-runtime.sh loopx"), `${file}: after LoopX`);
    assert.ok(dockerfile.indexOf("install-runtime.sh openviking-plugin") < dockerfile.indexOf("install-runtime.sh profile-seed"), `${file}: before the seed that adds it`);
  }
  // The delta recipe rebuilds the socket on a base image, so the base must already hold the plugin the socket configures.
  const delta = read("deploy/runtime-dsh/Dockerfile.delta");
  assert.match(delta, /@openviking\/dsh-memory-plugin\/package\.json/);
  assert.match(delta, /patch\( insert\)\?: entry \.\* not found/);
});

test("the build smoke boots the composition twice — an ordinary account and a native-memory one — and fails on what a missing target looks like", () => {
  const smoke = read("deploy/runtime-dsh/build-smoke.sh");
  assert.match(smoke, /grep -q "did not activate"/);
  assert.match(smoke, /patch\( insert\)\?: entry \.\* not found/);
  assert.match(smoke, /skipping profile bundle/);
  assert.match(smoke, /include:openviking-memory-runtime/);
  assert.match(smoke, /include:evimed-memory-bridge/);
  assert.match(smoke, /boot_and_probe "ordinary account"/);
  assert.match(smoke, /boot_and_probe "native memory account"/);
  assert.match(smoke, /export EVIMED_MEMORY_GATEWAY_URL="http:\/\/127\.0\.0\.1:9\//, "the native boot meets a gateway that refuses connections, which must not fail the session");
});

test("what is switched is a row of the pinned plugin, named in the support record that the pin inventory reads", () => {
  const support = JSON.parse(read("runtime/skills/community/plugin-support.json"));
  const entry = support.hostExtensions.find((/** @type {any} */ item) => item.name === "@openviking/dsh-memory-plugin");
  assert.ok(entry, "plugin-support.json knows the plugin");
  assert.equal(entry.pin, "deps-version.json#openviking.plugin");
  assert.equal(entry.row, pins.openviking.plugin.bundleRow);
  assert.equal(entry.management, "immutable-release");
  assert.match(entry.adaptation, /^None:/);
  assert.ok(support.nativePlugins.includes("evimed-memory-bridge"));
  assert.equal(entry.contract, "apps/server/test/openVikingMemoryPlugin.test.mjs");
});
