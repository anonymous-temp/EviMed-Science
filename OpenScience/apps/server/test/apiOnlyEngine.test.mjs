// The API-only shape (the CDSS's memory service) keeps its accounts on the platform's own records unless its operator says otherwise:
// an episode, a pending record and the confirm step exist only there. The base file leaves the engine lever value-less, so with
// OpenViking in the stack every new account would take the native engine unless this overlay says it does not.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const deployDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy/web");
const environmentOf = async (name) => YAML.parse(await readFile(path.join(deployDir, name), "utf8"), { merge: true }).services["open-science-web"].environment;

test("the API-only overlay defaults the native memory engine off, and .env can still move it; the base file leaves it value-less", async () => {
  const overlay = await environmentOf("docker-compose.api-only.yml");
  assert.equal(overlay.OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED, "${OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED:-false}");
  const base = await environmentOf("docker-compose.yml");
  assert.equal(Object.hasOwn(base, "OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED"), true);
  assert.equal(base.OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED ?? null, null, "value-less: unset, it is the code's own default (on when OpenViking is the index)");
  // The comment says why, so the next reader does not take the pin for an accident: the line before it explains the engine.
  const text = await readFile(path.join(deployDir, "docker-compose.api-only.yml"), "utf8");
  assert.match(text, /not on OpenViking's native memory engine/);
  assert.match(text, /docs\/AGENT_MEMORY_API\.md, "Which engine"/);
});
