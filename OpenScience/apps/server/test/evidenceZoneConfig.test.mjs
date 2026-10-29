// The topic zones' levers that bound a reader's model spend: read from the environment with a default, a value out of range stops the
// start by its name, and the lever is carried by .env.example and handed to the web service by compose (the deployment test holds the
// compose side for every key; this holds the code's side and the default the example states).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NAME = "OPEN_SCIENCE_EVIDENCE_ZONE_FEEDBACK_REJUDGES_PER_HOUR";

/** loadConfig under exactly `env`. @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return /** @type {Record<string, any>} */ (loadConfig({ rootDir: repoRoot })); } finally { process.env = saved; }
}

test("a reader's second judgements an hour: twenty by default, zero allowed, read from the environment, and a value out of range stops the start by its name", () => {
  assert.equal(configUnder({}).evidenceZoneFeedbackRejudgesPerHour, 20);
  assert.equal(configUnder({ [NAME]: "" }).evidenceZoneFeedbackRejudgesPerHour, 20, "an empty value is the default, not 0");
  assert.equal(configUnder({ [NAME]: "5" }).evidenceZoneFeedbackRejudgesPerHour, 5);
  assert.equal(configUnder({ [NAME]: "0" }).evidenceZoneFeedbackRejudgesPerHour, 0, "0 is a value: no word of a reader's is judged again");
  for (const value of ["-1", "1.5", "many", "1001"]) assert.throws(() => configUnder({ [NAME]: value }), new RegExp(NAME), value);
});

test("the lever is in .env.example at the code's default and handed to the web service by compose", async () => {
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.deepEqual([...example.matchAll(new RegExp(`^${NAME}=(.*)$`, "gm"))].map((line) => line[1]), ["20"]);
  assert.match(compose, new RegExp(`^\\s+${NAME}:\\s*$`, "m"));
});
