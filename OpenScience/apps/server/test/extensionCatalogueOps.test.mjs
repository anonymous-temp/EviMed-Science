import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { canonicalJson, EXTENSION_SUPPORTED_DSH_VERSION } from "@evimed/domain";
import { extensionToolArtifactDigest } from "../src/extensionToolController.mjs";
import { loadExtensionDeployment } from "../src/extensionDeployment.mjs";
import { CatalogueError, emptyManifest, listing, loaderAccepts, main, manifestPath, ownershipCommands, parseArgs, readManifest, withPackage, withoutPackage, writeManifest } from "../../../scripts/ops/extension-catalogue.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const scratch = [];
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });
function dataDir() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "catalogue-ops-"));
  fs.chmodSync(dir, 0o755);
  scratch.push(dir);
  return dir;
}
const coordinate = (name) => ({ kind: "github", repository: `owner/${name}`, commit: sha(name).slice(0, 40) });

/** A reviewed package of a class that needs no isolated image: a catalogue row alone. */
function viewer(name = "doc-viewer") {
  return { catalogue: { id: name, title: "文档查看器", coordinate: coordinate(name), executionClass: "restricted-viewer", integrity: `sha256:${sha(`${name}-bytes`)}`, settingsSchema: {} } };
}
/** A reviewed isolated tool: the rows an acceptance run measures, bound to each other the way the loader checks them. */
function isolated(name = "tool-pack") {
  const integrity = `sha256:${sha(`${name}-bytes`)}`, imageId = `sha256:${sha(`${name}-image`)}`;
  const descriptor = { coordinate: coordinate(name), integrity, imageId, closureExpectedSHA: sha(`${name}-closure`), runnerSHA: sha("runner"), policySHA: sha("policy"), inventorySHA: sha("inventory") };
  descriptor.adapterDigest = `sha256:${sha(canonicalJson({ runnerSHA: descriptor.runnerSHA, policySHA: descriptor.policySHA, inventorySHA: descriptor.inventorySHA }))}`;
  const row = { id: name, ...descriptor };
  descriptor.artifactDigest = extensionToolArtifactDigest(row);
  return {
    catalogue: { id: name, title: "隔离工具", coordinate: coordinate(name), executionClass: "isolated-tool", integrity, settingsSchema: { timeoutSeconds: { type: "integer", default: 30, min: 5, max: 120 } } },
    descriptor, artifact: { coordinate: coordinate(name), integrity, artifactDigest: descriptor.artifactDigest, adapterRevision: descriptor.adapterDigest, suiteRevision: `sha256:${sha("suite")}` },
    surface: { client: false, browser: false, externalActions: false, descriptorDigest: `sha256:${sha("surface")}` },
  };
}

test("an empty file is what the loader calls configured, and a deployment with no file is nothing configured", () => {
  const dir = dataDir();
  assert.equal(readManifest(dir), null);
  assert.equal(loadExtensionDeployment({ dataDir: dir }).status, "unconfigured");
  assert.deepEqual(loaderAccepts(emptyManifest()), { ok: true, catalogue: 0 });
  assert.equal(emptyManifest().dshVersion, EXTENSION_SUPPORTED_DSH_VERSION);
});

test("add writes a file the platform's own loader reads, with the mode it demands, and prints what the operator still runs", () => {
  const dir = dataDir(), lines = [];
  fs.writeFileSync(path.join(dir, "reviewed.json"), JSON.stringify(viewer()));
  assert.equal(main(["add", path.join(dir, "reviewed.json"), "--data-dir", dir], { write: (line) => lines.push(line) }), 0);
  const target = manifestPath(dir);
  assert.equal(fs.statSync(target).mode & 0o7777, 0o440);
  assert.equal(fs.statSync(path.join(dir, ".openscience")).mode & 0o022, 0, "the loader refuses a directory others can write");
  const deployment = loadExtensionDeployment({ dataDir: dir });
  assert.equal(deployment.status, "configured");
  assert.deepEqual(deployment.catalogue.map((row) => row.id), ["doc-viewer"]);
  assert.ok(lines.some((line) => line.includes("chown root")) && lines.some((line) => line.includes("chmod 0440")), lines.join("\n"));
  assert.deepEqual(fs.readdirSync(path.join(dir, ".openscience")), ["extensions-deployment.json"], "no staging file is left behind");
});

test("an isolated tool needs its descriptor, artifact and surface, and the loader accepts the bound set", () => {
  const manifest = emptyManifest();
  const partial = isolated(); delete partial.surface;
  assert.throws(() => withPackage(manifest, partial), CatalogueError);
  const next = withPackage(manifest, isolated());
  assert.deepEqual(loaderAccepts(next), { ok: true, catalogue: 1 });
  assert.deepEqual(listing(next).map((row) => [row.id, row.admitted]), [["tool-pack", true]]);
  assert.throws(() => withPackage(manifest, { ...viewer(), surface: { client: false } }), /Only an isolated tool/);
});

test("a package whose digests do not bind is refused before anything is written", () => {
  const dir = dataDir(), reviewed = isolated();
  reviewed.descriptor.artifactDigest = `sha256:${sha("forged")}`;
  assert.throws(() => writeManifest(dir, withPackage(emptyManifest(), reviewed)), /refused by the platform's own loader/);
  assert.equal(fs.existsSync(manifestPath(dir)), false, "a rejected file is never left on disk");
});

test("an id already listed is refused, and remove takes every row of it", () => {
  const dir = dataDir();
  writeManifest(dir, withPackage(withPackage(emptyManifest(), viewer("a-viewer")), isolated("b-tool")));
  const manifest = readManifest(dir);
  assert.throws(() => withPackage(manifest, viewer("a-viewer")), /already listed/);
  const after = withoutPackage(manifest, "b-tool");
  assert.deepEqual([after.catalogue, after.admittedArtifacts, after.admittedDescriptors, after.surfaces].map((rows) => rows.map((row) => row.id)), [["a-viewer"], [], [], []]);
  assert.throws(() => withoutPackage(manifest, "never-listed"), /not listed/);
  writeManifest(dir, after);
  assert.deepEqual(loadExtensionDeployment({ dataDir: dir }).catalogue.map((row) => row.id), ["a-viewer"]);
});

test("restamp re-measures the policy label; without it an existing file keeps the one it was written under", () => {
  const manifest = emptyManifest();
  manifest.policy = { adapterRevision: `sha256:${sha("old-a")}`, permissionProfileRevision: `sha256:${sha("old-p")}` };
  assert.deepEqual(withPackage(manifest, viewer()).policy, manifest.policy);
  assert.notDeepEqual(withPackage(manifest, viewer(), { restamp: true }).policy, manifest.policy);
});

test("the command line: list on nothing, bad input, unknown options and the usage line", () => {
  const dir = dataDir(), lines = [];
  const out = (line) => lines.push(line);
  assert.equal(main(["list", "--data-dir", dir], { write: out }), 0);
  assert.match(lines.join("\n"), /no package is offered/);
  assert.equal(main(["add", path.join(dir, "missing.json"), "--data-dir", dir], { write: out }), 1);
  fs.writeFileSync(path.join(dir, "bad.json"), "{ not json");
  assert.equal(main(["add", path.join(dir, "bad.json"), "--data-dir", dir], { write: out }), 1);
  assert.equal(main(["remove", "x", "--data-dir", dir], { write: out }), 1);
  assert.equal(main(["frobnicate"], { write: out }), 2);
  assert.equal(main(["list", "--nope"], { write: out }), 1);
  assert.throws(() => parseArgs(["list", "--data-dir"]), CatalogueError);
  assert.ok(ownershipCommands("/data/.openscience/extensions-deployment.json").every((line) => typeof line === "string"));
});

test("the runbook names the command and the file it writes", () => {
  const runbook = fs.readFileSync(new URL("../../../docs/WEB_OPERATIONS_RUNBOOK.md", import.meta.url), "utf8");
  assert.match(runbook, /extension-catalogue\.mjs/);
  assert.match(runbook, /extensions-deployment\.json/);
});
