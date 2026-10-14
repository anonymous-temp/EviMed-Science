// A pinned third-party version is written once, in `deps-version.json`.
//
// `dsh-cite`'s version was a literal in eight places (five source modules, two Dockerfiles, a package.json). Moving the
// pin and missing one of them did not fail a build: it failed `cite_health` in a running container, as
// `plugin_apply_failed`, because the probe still approved the old bundle. The rule written in AGENTS.md ("versions are
// pinned in one place; tests assert every derived copy") held for the kernel, whose copies check-pin-inventory
// classifies, and not for the bundles beside it.
//
// This scans the code of the repository for each pinned bundle's version written next to the bundle's name, and for
// the bare quoted literal of the one bundle whose version a probe once compared against. What it allows is named,
// path by path, with the test that holds that copy equal to the pin: a copy nobody asserts is a stray.
//
// Qualified, not bare: `0.4.1` and `1.3.1` are version numbers of a hundred unrelated things, and a scan for them
// would be red for reasons that are not true. A version written beside the name of the thing it pins is not
// ambiguous.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pins = JSON.parse(readFileSync(path.join(repo, "deps-version.json"), "utf8"));

/** What is pinned, under which names a copy would write it. */
const PINNED = [
  { label: "dsh-cite", version: pins.dsh.citeVersion, names: ["dsh-cite"] },
  { label: "annotation", version: pins.dsh.annotationVersion, names: ["@changfenhuang/dsh-annotation", "dsh-annotation"] },
  { label: "mermaid", version: pins.dsh.mermaidVersion, names: ["dsh-mermaid"] },
  { label: "LoopX CLI", version: pins.loopx.version, names: ["loopx", "LoopX"] },
  { label: "LoopX plugin", version: pins.loopx.plugin.version, names: ["dsh-loopx-plugin"] },
  { label: "OpenViking memory plugin", version: pins.openviking.plugin.version, names: ["@openviking/dsh-memory-plugin", "dsh-memory-plugin"] },
];

/** Directories whose code is the repository's own. */
const SCANNED = ["apps", "packages", "deploy", "scripts", "runtime", "capabilities"];

/** Copies that are held equal to the pin by a test, and that test. A path here with no covering test is a stray. */
const DERIVED = [
  { file: "deploy/runtime-dsh/Dockerfile", test: "apps/server/test/runtimeImageBuild.test.mjs", why: "the image's build ARGs" },
  { file: "deploy/runtime-dsh/Dockerfile.agentbay", test: "apps/server/test/runtimeImageBuild.test.mjs", why: "the AgentBay image's build ARGs" },
  { file: "packages/socket/package.json", test: "packages/socket/test/citationBridge.test.mjs", why: "the socket's dependency on the bundle (a package.json cannot read another file)" },
  { file: "packages/harness-port/seam-manifest.json", test: "packages/contracts/dsh/contract.test.mjs", why: "the version the port's probe approves" },
  { file: "runtime/skills/community/plugin-support.json", test: "apps/server/test/communityRecords.test.mjs", why: "the compatibility record" },
  { file: "runtime/skills/community/try-install.json", test: "apps/server/test/communityRecords.test.mjs", why: "the candidate record" },
  { file: "runtime/skills/community/sources.json", test: "apps/server/test/communityRecords.test.mjs", why: "the vendoring record" },
  { file: "scripts/ops/check-kernel-defaults.mjs", test: "apps/server/test/pinInventory.test.mjs", why: "says which versions produced the stored baseline; moves when it is re-recorded" },
  { file: "scripts/dev/sync-community-records.mjs", test: "apps/server/test/communityRecords.test.mjs", why: "names the bundles it writes, not their versions" },
];
/** Recordings and the lockfile are what a service answered or what pnpm resolved, not copies. */
const NOT_COPIES = [/(^|\/)pnpm-lock\.yaml$/, /(^|\/)fixtures\//, /^packages\/contracts\//, /(^|\/)node_modules\//, /(^|\/)dist\//, /deps-version\.json$/];

/** @returns {string[]} tracked and untracked-but-not-ignored files under the scanned directories */
function candidateFiles() {
  const out = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard", "--", ...SCANNED], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((file) => file && !NOT_COPIES.some((pattern) => pattern.test(file)) && !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|xlsx|docx|pptx|zip|gz|tgz|wasm|sqlite|parquet|feather)$/i.test(file));
}

const escape = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The version written beside the name of what it pins, in the forms a copy takes. */
function qualified(/** @type {{ names: string[], version: string }} */ item) {
  const names = item.names.map(escape).join("|");
  // name@1.2.3, name-1.2.3.tgz, "name": "1.2.3", name = 1.2.3, name 1.2.3, name v1.2.3
  return new RegExp(`(?<![A-Za-z0-9_-])(?:${names})(?:@|-|["'\`]?\\s*[:=]\\s*["'\`]?\\s*| +)v?${escape(item.version)}(?![0-9A-Za-z.-])`);
}

/** Source files only: the one bare literal a probe once compared a runtime proof against. */
const SOURCE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/(?:src|plugins)|packages\/[^/]+\/index\.mjs|scripts\/(?!.*\/(?:test|fixtures)\/))[^]*\.(?:mjs|js|ts|tsx)$/;

test("a pinned bundle version is written once: no copy outside deps-version.json and the copies a test holds equal", () => {
  const files = candidateFiles();
  assert.ok(files.length > 500, `only ${files.length} files were scanned; the listing, not the tree, is wrong`);
  const derived = new Set(DERIVED.map((entry) => entry.file));
  /** @type {string[]} */
  const strays = [];
  for (const item of PINNED) {
    assert.match(String(item.version), /^\d+\.\d+\.\d+/, `deps-version.json carries no version for ${item.label}`);
    const pattern = qualified(item);
    for (const file of files) {
      if (derived.has(file)) continue;
      let text;
      try { text = readFileSync(path.join(repo, file), "utf8"); } catch { continue; }
      if (!text.includes(item.version)) continue;
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (pattern.test(line)) strays.push(`${file}:${index + 1}  ${item.label} ${item.version}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(strays, [], "a version written beside a bundle's name outside deps-version.json — read it from there (apps/server/src/pinnedVersions.mjs, the seam manifest) or add the file to DERIVED with the test that holds it");
});

test("the bare literal of the cite bundle's version is nowhere in source", () => {
  // `binaryVersion !== '0.3.2'` was the shape of five of the eight copies: a quoted number, no name beside it.
  const literal = new RegExp(`['"\`]${escape(pins.dsh.citeVersion)}['"\`]`);
  const derived = new Set(DERIVED.map((entry) => entry.file));
  const strays = [];
  for (const file of candidateFiles()) {
    if (derived.has(file) || !SOURCE.test(file) || /(^|\/)(test|tests|__tests__)\//.test(file) || /\.test\.[mc]?[jt]sx?$/.test(file)) continue;
    const text = readFileSync(path.join(repo, file), "utf8");
    if (!text.includes(pins.dsh.citeVersion)) continue;
    text.split("\n").forEach((line, index) => { if (literal.test(line)) strays.push(`${file}:${index + 1}  ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(strays, []);
});

test("every allowed copy names a test that exists and reads the pin", () => {
  for (const entry of DERIVED) {
    assert.ok(existsSync(path.join(repo, entry.file)), `${entry.file} is allowed here and does not exist; remove it from DERIVED`);
    const covering = path.join(repo, entry.test);
    assert.ok(existsSync(covering), `${entry.file} is allowed because ${entry.test} holds it equal to the pin, and that test does not exist`);
    const text = readFileSync(covering, "utf8");
    assert.match(text, /deps-version|citeVersion|annotationVersion|mermaidVersion|syncedRecords|pinInventory|SEAMS\.dsh/, `${entry.test} does not read the pin, so it holds nothing equal to it`);
  }
});

test("the derived copies this allows are the pin", () => {
  const read = (/** @type {string} */ file) => readFileSync(path.join(repo, file), "utf8");
  const arg = (/** @type {string} */ text, /** @type {string} */ name) => new RegExp(`^ARG ${name}=\"?([^\"\\s]+)\"?$`, "m").exec(text)?.[1];
  for (const dockerfile of ["deploy/runtime-dsh/Dockerfile", "deploy/runtime-dsh/Dockerfile.agentbay"]) {
    const text = read(dockerfile);
    assert.equal(arg(text, "DSH_CITE_BUNDLE"), `dsh-cite@${pins.dsh.citeVersion}`, dockerfile);
    assert.equal(arg(text, "DSH_ANNOTATION_BUNDLE"), `@changfenhuang/dsh-annotation@${pins.dsh.annotationVersion}`, dockerfile);
    assert.equal(arg(text, "DSH_MERMAID_BUNDLE"), `dsh-mermaid@${pins.dsh.mermaidVersion}`, dockerfile);
    assert.equal(arg(text, "DSH_PUBLISHED_BEFORE"), pins.dsh.publishedBefore, dockerfile);
    assert.equal(arg(text, "DSH_VERSION"), pins.dsh.version, dockerfile);
  }
  assert.equal(JSON.parse(read("packages/socket/package.json")).dependencies["dsh-cite"], pins.dsh.citeVersion);
  assert.equal(JSON.parse(read("packages/harness-port/seam-manifest.json")).plugins["dsh-cite"], pins.dsh.citeVersion);
  assert.equal(JSON.parse(read("packages/harness-port/seam-manifest.json")).dsh, pins.dsh.version);
});
