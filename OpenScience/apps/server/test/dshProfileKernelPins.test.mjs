import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedProfileKernelPins, verifiedKernelPins } from "../../../deploy/runtime-dsh/profile-kernel-pins.mjs";

const dsh = JSON.parse(readFileSync(new URL("../../../deps-version.json", import.meta.url), "utf8")).dsh;
const pin = dsh.version;
const cordis = dsh.cordis;
const policyUrl = new URL("../../../deploy/runtime-dsh/profile-pnpm-workspace.yaml", import.meta.url);

function fixture(t, nested = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-kernel-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outerScope = path.join(root, "node_modules", "@deepseek-ai");
  const cliDir = path.join(outerScope, "dsh");
  const scope = nested ? path.join(cliDir, "node_modules", "@deepseek-ai") : outerScope;
  const put = (dir, name, version) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
  };
  put(cliDir, "@deepseek-ai/dsh", pin);
  for (const name of ["dsh-agent", "dsh-base", "dsh-web-app", ...Array.from({ length: 100 }, (_, i) => `dsh-fixture-${i}`)]) {
    put(path.join(scope, name), `@deepseek-ai/${name}`, pin);
  }
  put(path.join(scope, "cordis"), "@deepseek-ai/cordis", cordis);
  const profileDir = path.join(root, "profile");
  mkdirSync(profileDir);
  const manifest = { name: "dsh-profile-test", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "live" } } };
  writeFileSync(path.join(profileDir, "package.json"), JSON.stringify(manifest));
  return { cli: path.join(cliDir, "package.json"), scope, profileDir, manifest };
}

for (const nested of [false, true]) {
  test(`profile pins preserve activation and build policy (${nested ? "nested" : "hoisted"} CLI)`, (t) => {
    const f = fixture(t, nested);
    const pins = seedProfileKernelPins(f.cli, f.profileDir, policyUrl, pin, cordis);
    const manifest = JSON.parse(readFileSync(path.join(f.profileDir, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies, f.manifest.dependencies);
    assert.deepEqual(manifest.dsh, f.manifest.dsh, "peer providers must not become active bundle layers");
    assert.deepEqual(manifest.devDependencies, pins);
    assert.equal(pins["@deepseek-ai/dsh-agent"], pin);
    assert.equal(pins["@deepseek-ai/cordis"], cordis);
    const yaml = readFileSync(path.join(f.profileDir, "pnpm-workspace.yaml"), "utf8");
    assert.ok(yaml.startsWith(readFileSync(policyUrl, "utf8").trimEnd()));
    for (const [name, version] of Object.entries(pins)) assert.ok(yaml.includes(`${JSON.stringify(name)}: ${JSON.stringify(version)}`));
  });
}

test("a later transitive kernel release is rejected before profile mutation", (t) => {
  const f = fixture(t);
  const before = readFileSync(path.join(f.profileDir, "package.json"));
  writeFileSync(path.join(f.scope, "dsh-agent", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-agent", version: `${pin}-drift` }));
  assert.throws(() => seedProfileKernelPins(f.cli, f.profileDir, policyUrl, pin, cordis), /differs from the pin/);
  assert.deepEqual(readFileSync(path.join(f.profileDir, "package.json")), before);
});

test("a missing closure or mismatched cordis cannot produce a successful pin scan", (t) => {
  const f = fixture(t);
  assert.throws(() => verifiedKernelPins(f.cli, pin, "9.9.9"), /cordis/);
  rmSync(path.join(f.scope, "dsh-agent"), { recursive: true });
  assert.throws(() => verifiedKernelPins(f.cli, pin, cordis), /package is missing/);
  for (let i = 0; i < 100; i += 1) rmSync(path.join(f.scope, `dsh-fixture-${i}`), { recursive: true });
  assert.throws(() => verifiedKernelPins(f.cli, pin, cordis), /inventory is incomplete/);
});
