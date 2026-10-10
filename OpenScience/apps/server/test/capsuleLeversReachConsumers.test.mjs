// The levers of sharing and of the capsule store are read where their constants used to be (2026-10-10 review, C4b and C4e): a key
// config.mjs reads and nothing hands to the code it limits is a knob that does nothing and says nothing, and a default written in
// two places is two defaults. This holds the first to the composition root and the second to the module that falls back on it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SHARE_CORROBORATION_KEPT_DAYS, SHARE_CORROBORATION_MIN_ACCOUNTS, SHARE_CORROBORATION_MIN_ACCOUNT_AGE_DAYS, SHARE_CORROBORATION_MIN_FINISHED_RUNS,
} from "../src/capsuleShareTrust.mjs";
import { loadConfig } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverSource = readFile(path.join(root, "apps/server/src/server.mjs"), "utf8");

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return /** @type {Record<string, any>} */ (loadConfig({ rootDir: root })); } finally { process.env = saved; }
}

/** The text of the first call of `name(`…`)` in `source`, braces and all. @param {string} source @param {string} name */
function callOf(source, name) {
  const start = source.indexOf(`${name}({`);
  assert.ok(start >= 0, `${name} is not called in server.mjs`);
  return source.slice(start, source.indexOf("})", start) + 2);
}

test("the corroboration levers are handed to the guest-influence check, and its fallbacks are the defaults config writes", async () => {
  const call = callOf(await serverSource, "createGuestInfluence");
  for (const key of ["capsuleShareCorroborationMinAccounts", "capsuleShareCorroborationKeptDays", "capsuleShareCorroborationMinAccountAgeDays", "capsuleShareCorroborationMinFinishedRuns"]) {
    assert.match(call, new RegExp(`config\\.${key}\\b`), `${key} never reaches createGuestInfluence`);
  }
  const defaults = configUnder({});
  assert.deepEqual(
    [defaults.capsuleShareCorroborationMinAccounts, defaults.capsuleShareCorroborationKeptDays, defaults.capsuleShareCorroborationMinAccountAgeDays, defaults.capsuleShareCorroborationMinFinishedRuns],
    [SHARE_CORROBORATION_MIN_ACCOUNTS, SHARE_CORROBORATION_KEPT_DAYS, SHARE_CORROBORATION_MIN_ACCOUNT_AGE_DAYS, SHARE_CORROBORATION_MIN_FINISHED_RUNS],
    "config.mjs and capsuleShareTrust.mjs write the same four defaults",
  );
  assert.deepEqual([SHARE_CORROBORATION_MIN_ACCOUNT_AGE_DAYS, SHARE_CORROBORATION_MIN_FINISHED_RUNS], [14, 3], "the owner's defaults: fourteen days old, three finished runs");
});
