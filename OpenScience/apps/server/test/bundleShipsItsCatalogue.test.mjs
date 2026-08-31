// A bundle with no capability catalogue can delegate to nothing, and says so in
// a message about the request rather than about the deployment: "not in the
// catalogue" for every capability the product advertises.
//
// The manifests are generated from capability.yaml into a *deploy* directory,
// which the image copies. Nothing put them in a published package, so anyone
// installing @evimed/dsh-socket from npm got the plugins, the preset, and an
// empty catalogue. `prepack` generates them into the package at pack time, so
// the tarball can never carry a stale copy either.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const socketDir = path.join(repoRoot, "packages/socket");

test("the socket package declares a prepack that builds the catalogue, and ships it", async () => {
  const manifest = JSON.parse(await readFile(path.join(socketDir, "package.json"), "utf8"));
  assert.ok(manifest.scripts?.prepack, "no prepack: a published tarball would carry whatever happened to be on disk");
  for (const entry of ["capabilities", "capability-skills"]) {
    assert.ok(manifest.files?.includes(entry), `files[] omits ${entry}, so prepack would build it and npm would drop it`);
  }
  assert.ok(!manifest.private, "a private package publishes nothing at all");
});

test("prepack produces one manifest per capability, and every skill body they name", async () => {
  // Run it, rather than trusting the declaration. A prepack that errors leaves
  // an empty directory, and an empty catalogue is the exact failure this is for.
  await rm(path.join(socketDir, "capabilities"), { recursive: true, force: true });
  await rm(path.join(socketDir, "capability-skills"), { recursive: true, force: true });
  await execFileAsync("npm", ["run", "prepack"], { cwd: socketDir });

  const sources = (await readdir(path.join(repoRoot, "capabilities"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const built = (await readdir(path.join(socketDir, "capabilities")))
    .filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, "")).sort();
  assert.ok(sources.length >= 10, `only ${sources.length} capabilities on disk — the walk read nothing`);
  assert.deepEqual(built, sources, "every capability must reach the tarball as a manifest");

  // Each manifest names its skills; a named body that did not ship delegates a
  // child that is told less than the catalogue promised.
  const shipped = new Set((await readdir(path.join(socketDir, "capability-skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const missing = [];
  for (const name of built) {
    const parsed = JSON.parse(await readFile(path.join(socketDir, "capabilities", `${name}.json`), "utf8"));
    for (const skill of parsed.skills ?? []) {
      if (!shipped.has(skill)) missing.push(`${name} -> ${skill}`);
    }
  }
  assert.deepEqual(missing, [], "a manifest naming a skill body the tarball does not carry");
});
