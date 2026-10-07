// The citation gift's levers (evidence-flywheel F07, 2026-10-05): off and worth 0 by default, read from the environment, a
// value outside its range stopping the start by its name, and both documented in .env.example and handed over by compose.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** @param {Record<string, string>} env */
function configUnder(env) {
  const saved = process.env;
  process.env = { ...env };
  try { return /** @type {Record<string, any>} */ (loadConfig({ rootDir: repoRoot })); } finally { process.env = saved; }
}

test("the gift is off and worth nothing until the owner chooses, and an empty value reads as unset", () => {
  const config = configUnder({});
  assert.equal(config.evidenceCitationGiftEnabled, false);
  assert.equal(config.evidenceCitationGiftAmount, 0);
  const empty = configUnder({ OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_ENABLED: "", OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_AMOUNT: "" });
  assert.deepEqual([empty.evidenceCitationGiftEnabled, empty.evidenceCitationGiftAmount], [false, 0]);
  const on = configUnder({ OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_ENABLED: "true", OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_AMOUNT: "12.5" });
  assert.deepEqual([on.evidenceCitationGiftEnabled, on.evidenceCitationGiftAmount], [true, 12.5]);
});

test("an amount outside its range stops the start by the variable's name", () => {
  for (const value of ["-1", "lots", "10001", "NaN"]) {
    assert.throws(() => configUnder({ OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_AMOUNT: value }), /OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_AMOUNT/, value);
  }
});

test("each lever is documented in .env.example at the code's default and passed value-less by compose", async () => {
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const defaults = configUnder({});
  for (const [name, key] of [["OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_ENABLED", "evidenceCitationGiftEnabled"], ["OPEN_SCIENCE_EVIDENCE_CITATION_GIFT_AMOUNT", "evidenceCitationGiftAmount"]]) {
    const lines = [...example.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
    assert.equal(lines.length, 1, `${name} appears once in .env.example`);
    assert.equal(String(lines[0][1]), String(defaults[key]), `${name} in .env.example is the code's default`);
    assert.match(compose, new RegExp(`^\\s+${name}:\\s*$`, "m"), `${name} is passed by compose`);
  }
});
