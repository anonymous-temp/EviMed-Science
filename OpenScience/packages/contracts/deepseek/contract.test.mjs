// The research model's pin (`deepseek` in deps-version.json) and every place
// that restates it. The model was written in the gateway's allowlist, the
// config defaults, `.env.example` and the compose fallbacks, and nothing held
// them equal (platform audit I1-13, 2026-09-26): a pin moved in one of them
// would leave a deployment certifying one model and running another, or
// refusing its own default. The wire itself is certified per release by the
// DeepSeek release receipt (scripts/ops/deepseek-kernel-release-gate.mjs),
// which is why this contract holds names and not recorded bodies.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultDeepSeekModel, supportedDeepSeekModels, certifiedDeepSeekModel } from "../../../apps/server/src/modelGateway.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const pins = JSON.parse(await readFile(path.join(root, "deps-version.json"), "utf8"));
const pin = pins.deepseek;

test("the pin names the gateway's default and exactly its allowlist", () => {
  assert.equal(pin.contractDir, "packages/contracts/deepseek");
  assert.equal(pin.model, defaultDeepSeekModel);
  assert.deepEqual([...pin.certified].sort(), [...supportedDeepSeekModels].sort());
  assert.ok(pin.certified.includes(pin.model), "the default is a certified model");
  assert.equal(certifiedDeepSeekModel({}), pin.model, "an unset OPEN_SCIENCE_DEEPSEEK_MODEL runs the pin");
  assert.equal(certifiedDeepSeekModel({ OPEN_SCIENCE_DEEPSEEK_MODEL: "deepseek-chat" }), null, "a name outside the pin is refused");
});

test("the deployment files carry the pinned model and endpoint", async () => {
  const example = await readFile(path.join(root, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(root, "deploy/web/docker-compose.yml"), "utf8");
  const value = (name) => example.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
  assert.equal(value("OPEN_SCIENCE_DEEPSEEK_MODEL"), pin.model);
  assert.equal(value("OPEN_SCIENCE_DEEPSEEK_BASE_URL"), pin.apiBase);
  for (const name of ["OPEN_SCIENCE_FRONTIER_MODEL", "OPEN_SCIENCE_MEMORY_EXTRACTION_MODEL"]) {
    const set = value(name);
    if (set !== undefined) assert.ok(pin.certified.includes(set), `${name}=${set} is not a certified model`);
  }
  assert.match(compose, new RegExp(`OPEN_SCIENCE_DEEPSEEK_MODEL: \\$\\{OPEN_SCIENCE_DEEPSEEK_MODEL:-${pin.model}\\}`));
  const fallbacks = [...compose.matchAll(/\$\{OPEN_SCIENCE_DEEPSEEK_BASE_URL:-([^}]+)\}/g)].map((match) => match[1]);
  assert.ok(fallbacks.length >= 2, `read the compose fallbacks (${fallbacks.length})`);
  for (const fallback of fallbacks) assert.equal(fallback, pin.apiBase);
  // The specialist engines name a model of their own; it must be one the
  // gateway would serve.
  const engines = [...compose.matchAll(/^\s+LLM_MODEL: (\S+)$/gm)].map((match) => match[1]);
  assert.ok(engines.length >= 3, `read the engines' models (${engines.length})`);
  for (const model of engines) assert.ok(pin.certified.includes(model), `an engine runs ${model}, which is not certified`);
});

test("the control plane's own defaults are the pin", async () => {
  const saved = {};
  for (const name of ["OPEN_SCIENCE_DEEPSEEK_MODEL", "OPEN_SCIENCE_DEEPSEEK_BASE_URL", "OPEN_SCIENCE_FRONTIER_MODEL", "OPEN_SCIENCE_MEMORY_EXTRACTION_MODEL"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    const { loadConfig } = await import("../../../apps/server/src/config.mjs");
    const config = loadConfig({ dataDir: "/tmp/evimed-deepseek-contract" });
    assert.equal(config.deepseekModel, pin.model);
    assert.equal(config.deepseekBaseUrl, pin.apiBase);
    assert.equal(config.frontierModel, pin.model);
    assert.equal(config.memoryExtractionModel, pin.model);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
});
