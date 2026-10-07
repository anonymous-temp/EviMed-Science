// The scenario help a run reads (`vcr_simulate` action shape) is a file generated from the domain's schemas. What these tests
// pin is that it is current, that the check CI runs fails when it is not, and that an example the validator refuses never
// reaches it. The keys themselves are held to the validator in packages/domain/test/vcrScenarioHelp.test.mjs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VCR_SCENARIO_EXAMPLES, vcrScenarioHelp } from "@evimed/domain";
import { VCR_SCENARIO_HELP_FILE, renderVcrScenarioHelp } from "../../../scripts/build/generate-vcr-scenario-help.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/build/generate-vcr-scenario-help.mjs");

test("the committed help is what the generator writes from the schemas now", async () => {
  assert.equal(await fs.readFile(path.join(repoRoot, VCR_SCENARIO_HELP_FILE), "utf8"), renderVcrScenarioHelp(),
    "run `pnpm generate:vcr-scenario-help` and commit the result");
  assert.deepEqual(JSON.parse(renderVcrScenarioHelp()), JSON.parse(JSON.stringify(vcrScenarioHelp())), "the stored form loses nothing");
});

test("the check CI runs passes on the committed file and fails, naming the command, on a stale one", async () => {
  assert.match(execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" }), /up to date/);
  // The stale copy is a temporary file: the committed one is read by other test files running at the same time.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-help-"));
  try {
    const copy = path.join(directory, "vcr_scenario_help.json");
    const original = await fs.readFile(path.join(repoRoot, VCR_SCENARIO_HELP_FILE), "utf8");
    await fs.writeFile(copy, original, "utf8");
    assert.equal(spawnSync(process.execPath, [script, "--check", "--file", copy], { encoding: "utf8" }).status, 0);
    await fs.writeFile(copy, original.replace('"accrual.duration"', '"accrual.months"'), "utf8");
    const stale = spawnSync(process.execPath, [script, "--check", "--file", copy], { encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /out of date: .*vcr_scenario_help\.json/);
    assert.match(stale.stderr, /generate-vcr-scenario-help\.mjs/);
    // Writing it again is what repairs it.
    assert.equal(spawnSync(process.execPath, [script, "--file", copy], { encoding: "utf8" }).status, 0);
    assert.equal(await fs.readFile(copy, "utf8"), original);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an example the validator refuses stops the generator instead of reaching the file", () => {
  const examples = /** @type {Record<string, Array<{ label: string, scenario: Record<string, any> }>>} */ (/** @type {unknown} */ (VCR_SCENARIO_EXAMPLES));
  const list = examples["design.analytic"];
  list.push({ label: "a guess", scenario: { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { months: 24 } } });
  try {
    assert.throws(() => renderVcrScenarioHelp(), /example "a guess" of design\.analytic is refused by the validator: scenario_field_unknown@scenario\.accrual\.months/);
  } finally {
    list.pop();
  }
  assert.doesNotThrow(() => renderVcrScenarioHelp());
});
