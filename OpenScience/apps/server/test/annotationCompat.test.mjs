// The build-time edit that keeps the annotation bundle Chinese under the product's locale id.
//
// The bundle's `setLang` takes `zh`, `en` and `ru` exactly and reads every other id as English; the product's locale id
// is `zh-x-evimed`. `deploy/runtime-dsh/annotation-compat.mjs` changes that one line of the pinned bytes to a choice by
// the primary language subtag, and refuses to touch bytes it was not reviewed against. The reviewed bytes themselves are
// only in the image build (the bundle is installed there, not in this tree), so what is tested here is the edit, its
// guards, and that the build runs it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { adaptAnnotationLocale } from "../../../deploy/runtime-dsh/annotation-compat.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pins = JSON.parse(readFileSync(path.join(repo, "deps-version.json"), "utf8"));
const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");

/** What the bundle's own line reads, with unrelated text around it. */
const REVIEWED = [
  "// a stand-in for the reviewed client bundle",
  "var currentLang = 'zh'",
  "function setLang(id) {",
  "  // upstream comment",
  "  currentLang = (id === 'zh' || id === 'en' || id === 'ru') ? id : 'en'",
  "}",
  "exports.setLang = setLang",
  "",
].join("\n");

/** @returns {{ dir: string, pluginDir: string, pin: any, cleanup: () => void }} */
function bundle({ content = REVIEWED, version = pins.dsh.annotationVersion, sha = sha256(REVIEWED) } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "annotation-compat-"));
  const pluginDir = path.join(dir, "dsh-annotation");
  mkdirSync(pluginDir);
  writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "@changfenhuang/dsh-annotation", version }));
  writeFileSync(path.join(pluginDir, "client.js"), content);
  const pin = { annotationVersion: pins.dsh.annotationVersion, annotationCompatibility: { file: "client.js", sha256: sha } };
  return { dir, pluginDir, pin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The language the edited line would choose for a locale id, by running the line itself. */
function chosen(/** @type {string} */ source, /** @type {unknown} */ id) {
  const line = source.split("\n").find((entry) => entry.trim().startsWith("currentLang = "));
  assert.ok(line, "no assignment to currentLang in the edited source");
  return new Function("id", `var currentLang; ${line}; return currentLang`)(id);
}

test("the record names the reviewed file by digest, and the edit chooses by the primary language subtag", () => {
  assert.match(pins.dsh.annotationCompatibility.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pins.dsh.annotationCompatibility.file, "client.js");
  assert.ok(pins.dsh.annotationCompatibility.reason && pins.dsh.annotationCompatibility.upgradePath, "an adaptation records why it exists and when it can go");
  const { pluginDir, pin, cleanup } = bundle();
  try {
    const receipt = adaptAnnotationLocale({ pluginDir, pin });
    const adapted = readFileSync(path.join(pluginDir, "client.js"), "utf8");
    assert.equal(receipt.sourceSha256, sha256(REVIEWED));
    assert.equal(receipt.adaptedSha256, sha256(adapted));
    assert.notEqual(adapted, REVIEWED);
    const before = REVIEWED.split("\n"), after = adapted.split("\n");
    assert.equal(after.length, before.length);
    assert.deepEqual(before.map((line, index) => index).filter((index) => before[index] !== after[index]), [4], "only the assignment in setLang changed");
    // The product's id, the ids the kernel's own locale service would hand it, and the unknown ones.
    for (const [id, language] of [["zh-x-evimed", "zh"], ["zh", "zh"], ["zh-CN", "zh"], ["zh-Hans", "zh"], ["en", "en"], ["en-US", "en"], ["ru", "ru"], ["ru-RU", "ru"], ["fr", "en"], ["de", "en"], ["", "en"], [undefined, "en"], [null, "en"]]) {
      assert.equal(chosen(adapted, id), language, `locale id ${JSON.stringify(id)}`);
    }
    // And the line the edit replaced did read the product's id as English, which is what this exists for.
    assert.equal(chosen(REVIEWED, "zh-x-evimed"), "en");
    assert.deepEqual(JSON.parse(readFileSync(path.join(pluginDir, "evimed-compatibility.json"), "utf8")), receipt);
  } finally { cleanup(); }
});

test("applied again over its own output it verifies the reverse transformation and lands on the same bytes", () => {
  const { pluginDir, pin, cleanup } = bundle();
  try {
    const first = adaptAnnotationLocale({ pluginDir, pin });
    const bytes = readFileSync(path.join(pluginDir, "client.js"), "utf8");
    const second = adaptAnnotationLocale({ pluginDir, pin });
    assert.deepEqual(second, first);
    assert.equal(readFileSync(path.join(pluginDir, "client.js"), "utf8"), bytes);
  } finally { cleanup(); }
});

test("a changed upstream byte, or another version, fails by name and writes nothing", () => {
  const changed = bundle({ content: `${REVIEWED}// one more line upstream\n` });
  try {
    assert.throws(() => adaptAnnotationLocale({ pluginDir: changed.pluginDir, pin: changed.pin }), /differs from the reviewed compatibility input/);
    assert.equal(readFileSync(path.join(changed.pluginDir, "client.js"), "utf8"), `${REVIEWED}// one more line upstream\n`);
  } finally { changed.cleanup(); }
  const moved = bundle({ version: "9.9.9" });
  try {
    assert.throws(() => adaptAnnotationLocale({ pluginDir: moved.pluginDir, pin: moved.pin }), /not the pinned/);
  } finally { moved.cleanup(); }
  const unrecorded = bundle();
  try {
    assert.throws(() => adaptAnnotationLocale({ pluginDir: unrecorded.pluginDir, pin: { annotationVersion: pins.dsh.annotationVersion } }), /no annotationCompatibility record/);
    assert.throws(() => adaptAnnotationLocale({ pluginDir: unrecorded.pluginDir, pin: { ...unrecorded.pin, annotationCompatibility: { file: "client.js", sha256: "abc" } } }), /no annotationCompatibility record/);
  } finally { unrecorded.cleanup(); }
  // A line that appears twice is a different file, whatever its digest says.
  const doubled = `${REVIEWED}${REVIEWED}`;
  const twice = bundle({ content: doubled, sha: sha256(doubled) });
  try {
    assert.throws(() => adaptAnnotationLocale({ pluginDir: twice.pluginDir, pin: twice.pin }), /differs from the reviewed compatibility input/);
  } finally { twice.cleanup(); }
});

test("pnpm's content store keeps the reviewed bytes: the edit lands in a new file, not through the hard link", () => {
  const { dir, pluginDir, pin, cleanup } = bundle();
  try {
    const store = path.join(dir, "store-file");
    writeFileSync(store, REVIEWED);
    rmSync(path.join(pluginDir, "client.js"));
    linkSync(store, path.join(pluginDir, "client.js"));
    adaptAnnotationLocale({ pluginDir, pin });
    assert.equal(readFileSync(store, "utf8"), REVIEWED, "the store's copy was changed");
    assert.notEqual(readFileSync(path.join(pluginDir, "client.js"), "utf8"), REVIEWED);
  } finally { cleanup(); }
});

test("both images copy the module, and the profile seed runs it on the installed bundle before it freezes the profile", () => {
  const read = (/** @type {string} */ file) => readFileSync(path.join(repo, file), "utf8");
  for (const dockerfile of ["deploy/runtime-dsh/Dockerfile", "deploy/runtime-dsh/Dockerfile.agentbay"]) {
    const text = read(dockerfile);
    const copy = text.indexOf("COPY deploy/runtime-dsh/annotation-compat.mjs /usr/local/lib/evimed/annotation-compat.mjs");
    assert.ok(copy > 0, `${dockerfile} does not copy the annotation compatibility module`);
    assert.ok(copy < text.indexOf("install-runtime.sh profile-seed"), `${dockerfile} copies it after the profile is seeded`);
  }
  const install = read("deploy/runtime-dsh/install-runtime.sh");
  const run = install.indexOf('node /usr/local/lib/evimed/annotation-compat.mjs "${DSH_HOME_SEED}/profiles/evimed-runtime/node_modules/@changfenhuang/dsh-annotation"');
  assert.ok(run > 0, "profile_seed does not run the annotation compatibility edit");
  assert.ok(run > install.indexOf("loopx-compat.mjs \"${DSH_HOME_SEED}"), "it must follow the profile's bundles being installed");
  assert.ok(run < install.indexOf("node /usr/local/bin/evimed-profile-seed.mjs seal"), "it must run before the seed is sealed");
});
