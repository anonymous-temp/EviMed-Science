// The API-only shape (the CDSS's memory service) keeps its accounts' memory on OpenViking like every other deployment: there is one memory
// engine, so nothing in this shape pins another, and the stack must compose the engine and what it needs. (Until 2026-10-25 the overlay
// pinned the legacy PostgreSQL-records engine, because episodes and the confirm step existed only there.)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const deployDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy/web");
const read = async (name) => YAML.parse(await readFile(path.join(deployDir, name), "utf8"), { merge: true });

test("the API-only overlay pins no memory engine, and the base file has no memory-engine lever left", async () => {
  const overlay = (await read("docker-compose.api-only.yml")).services["open-science-web"].environment;
  const base = (await read("docker-compose.yml")).services["open-science-web"].environment;
  assert.equal(Object.hasOwn(overlay, "OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED"), false);
  assert.equal(Object.hasOwn(base, "OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED"), false);
});

test("the API-only stack still composes OpenViking and the web service waits for it: every account's memory is kept there", async () => {
  const overlay = await read("docker-compose.api-only.yml");
  const base = await read("docker-compose.yml");
  assert.ok(base.services["evimed-openviking"], "the base stack composes the engine");
  assert.ok(base.services["evimed-openviking-init"], "and the one-shot that prepares its configuration and memory templates");
  assert.equal(overlay.services["evimed-openviking"]?.profiles, undefined, "the overlay does not move the engine behind a profile");
  assert.equal(overlay.services["evimed-openviking-init"]?.profiles, undefined);
  const depends = base.services["open-science-web"].depends_on;
  assert.ok(Object.hasOwn(depends, "evimed-openviking"), "the control plane starts after the engine");
  const text = await readFile(path.join(deployDir, "docker-compose.api-only.yml"), "utf8");
  assert.match(text, /there is no second engine/);
});
