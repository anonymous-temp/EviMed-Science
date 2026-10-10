// The public 「模拟研究」 column is on wherever 「虚拟临床研究」 is on, and what fills it is still the study lead's own act.
//
// It used to default to off, so a deployment that turned the module on had a publish route that answered 404 until somebody
// found the key (the owner's ruling of 2026-10-10: a working feature is never off by default). Flipping the default is only
// safe because nothing publishes by itself: the one caller of `publications.publish` is the lead's route
// (`POST /studies/:id/publications`, behind `manage_study`), which `vcrRoutes.test.mjs` holds to the lead.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** loadConfig under exactly `env` — nothing from the shell that runs the test. */
function configUnder(/** @type {Record<string, string>} */ env) {
  const saved = process.env;
  process.env = { ...env };
  try {
    return loadConfig({ rootDir: repoRoot });
  } finally {
    process.env = saved;
  }
}

test("the public column is on by default, and a deployment can still turn it off by name", () => {
  assert.equal(configUnder({}).vcrPublicSimulationsEnabled, true, "unset: on");
  assert.equal(configUnder({ OPEN_SCIENCE_VCR_PUBLIC_SIMULATIONS_ENABLED: "" }).vcrPublicSimulationsEnabled, true, "an empty value is unset, as compose passes it");
  assert.equal(configUnder({ OPEN_SCIENCE_VCR_PUBLIC_SIMULATIONS_ENABLED: "false" }).vcrPublicSimulationsEnabled, false, "off stays a lever");
  assert.equal(configUnder({ OPEN_SCIENCE_VCR_PUBLIC_SIMULATIONS_ENABLED: "true" }).vcrPublicSimulationsEnabled, true);
});

test("nothing publishes by itself: the only caller of publications.publish is the lead's route", async () => {
  const files = (await readdir(serverSrc)).filter((name) => name.endsWith(".mjs"));
  assert.ok(files.includes("vcrRoutes.mjs") && files.length > 200, `the scan saw ${files.length} files; it walked the wrong directory`);
  /** @type {string[]} */
  const callers = [];
  for (const name of files) {
    const source = await readFile(path.join(serverSrc, name), "utf8");
    for (const _ of source.matchAll(/\bpublications\??\.publish\(/g)) callers.push(name);
  }
  assert.deepEqual(callers, ["vcrRoutes.mjs"], "a second caller would publish without the lead's request");
});
