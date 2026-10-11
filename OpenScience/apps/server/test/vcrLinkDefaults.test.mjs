// Two links of 「虚拟临床研究」 that were built and then left off by default (flywheel F24 and F26, 2026-10-06): the frontier feed's
// trial events for a study's subject, and platform knowledge packs. The owner's ruling of 2026-10-10 is that a working feature is not
// off by default; both stay levers. Neither acts by itself: a platform pack is offered only on the study lead's request, and the
// trial events only read the frontier feed, so they are composed only where that feed is on (vcrFrontierEvents.integration.test.mjs).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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

test("platform knowledge packs are on by default, and a deployment can still turn them off by name", () => {
  assert.equal(configUnder({}).vcrPlatformPacksEnabled, true, "unset: on");
  assert.equal(configUnder({ OPEN_SCIENCE_VCR_PLATFORM_PACKS_ENABLED: "" }).vcrPlatformPacksEnabled, true, "an empty value is unset, as compose passes it");
  assert.equal(configUnder({ OPEN_SCIENCE_VCR_PLATFORM_PACKS_ENABLED: "false" }).vcrPlatformPacksEnabled, false, "off stays a lever");
});

test("the frontier's trial events for a study are on by default, and a deployment can still turn them off by name", () => {
  assert.equal(configUnder({}).vcrFrontierEventsEnabled, true, "unset: on");
  assert.equal(configUnder({ OPEN_SCIENCE_VCR_FRONTIER_EVENTS_ENABLED: "" }).vcrFrontierEventsEnabled, true, "an empty value is unset, as compose passes it");
  assert.equal(configUnder({ OPEN_SCIENCE_VCR_FRONTIER_EVENTS_ENABLED: "false" }).vcrFrontierEventsEnabled, false, "off stays a lever");
});
