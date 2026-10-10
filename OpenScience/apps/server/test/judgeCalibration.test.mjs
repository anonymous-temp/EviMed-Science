import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JUDGE_SITE_IDS, buildJudgeRequest, judgePromptFingerprint } from "../src/judgeSites.mjs";
import { driftSummaryFromRows } from "../src/judgePersistence.mjs";

const root = new URL("../../../", import.meta.url);
const pins = JSON.parse(await readFile(new URL("deps-version.json", root), "utf8")).typesafe.review;
const evidence = JSON.parse(await readFile(new URL("evals/judge-sites/release-readiness.json", root), "utf8"));

test("qualified site pins bind the measured production questions and explicit evidence", async () => {
  for (const site of ["J2", "J4"]) {
    const corpus = JSON.parse(await readFile(new URL(`evals/judge-sites/${site}/cases.json`, root), "utf8"));
    const { questions } = buildJudgeRequest(site, corpus.cases[0].input);
    const pin = pins.sites[site];
    assert.equal(pin.calibration, "calibrated");
    assert.equal(judgePromptFingerprint(site, questions, pin.threshold, pins.model), pin.promptFingerprint);
    assert.equal(evidence.sites[site].resultSha256, pin.resultSha256);
    assert.equal(evidence.sites[site].lower95, pin.lower95);
    assert.ok(pin.lower95 > 0.95);
  }
  assert.equal(pins.sites.J1.calibration, "uncalibrated");
  assert.equal(pins.sites.J3.calibration, "uncalibrated");
  assert.equal(evidence.productionModified, false);
});

test("changing a dynamic candidate criterion invalidates calibration without hashing private IDs", () => {
  const a = buildJudgeRequest("J2", { message: "Switch projects", projects: [{ id: "project-a", name: "A" }] });
  const b = buildJudgeRequest("J2", { message: "Switch projects", projects: [{ id: "project-b", name: "B" }] });
  const fingerprint = questions => judgePromptFingerprint("J2", questions, 0.8, pins.model);
  assert.equal(fingerprint(a.questions), fingerprint(b.questions));
  b.questions.switch_to.criteria["project-b"] = "The message merely mentions this project.";
  assert.notEqual(fingerprint(a.questions), fingerprint(b.questions));
});

test("every registered site has a pin and every pin names a registered site; the harm check on a lesson (J23) ships uncalibrated, so it is skipped and counted until it is measured", () => {
  assert.deepEqual(Object.keys(pins.sites).filter((site) => !JUDGE_SITE_IDS.includes(site)), [], "a pin for a site that does not exist");
  assert.deepEqual(JUDGE_SITE_IDS.filter((site) => site !== "reply-check" && !Object.hasOwn(pins.sites, site)), [], "a registered site with no pin is neither calibrated nor not");
  assert.equal(pins.sites.J23.calibration, "uncalibrated");
  assert.equal(pins.sites.J23.threshold, 0.8);
});

test("J4's pin carries the baseline its drift alert compares with, so JevCalibrationDrift can fire for the one site that is live and drift-sampled (J-3)", () => {
  // J4 is compared with its frozen regex, not a model, so its level is what production showed once the site had settled:
  // 2,855 comparisons from 2026-10-07 09:54Z to 2026-10-09 01:18Z, daily agreement 0.501 on the first, partial day (it ran before the
  // site settled) and 0.811 and 0.804 on the two days after. The pin had none, and a pin without one is a monitor that cannot fire.
  assert.equal(pins.sites.J4.baselineAgreement, 0.8);
  assert.equal(evidence.sites.J4.baselineAgreement, pins.sites.J4.baselineAgreement, "the readiness record states the same baseline as the pin");
  const config = { reviewJevModel: pins.model, jevSites: pins.sites };
  const at = new Date("2026-10-20T12:00:00Z");
  const days = Array.from({ length: 7 }, (_, i) => `2026-10-${String(19 - i).padStart(2, "0")}`);
  const rows = (/** @type {(day: string) => number} */ agreement) => days.map((day) => ({ site: "J4", model: pins.model, prompt_fingerprint: pins.sites.J4.promptFingerprint, day, observations: 50, agreement: agreement(day) }));
  const j4 = (/** @type {any[]} */ data) => driftSummaryFromRows(data, config, at).find((row) => row.site === "J4");
  assert.equal(j4(rows(() => 0.79))?.baselineConfigured, true);
  assert.equal(j4(rows(() => 0.79))?.belowBaselineSevenDays, true, "seven completed days under 0.80 alert");
  assert.equal(j4(rows((day) => (day === "2026-10-15" ? 0.81 : 0.79)))?.belowBaselineSevenDays, false, "one day at the baseline's level does not");
  assert.equal(j4(rows(() => 0.8))?.belowBaselineSevenDays, false, "the baseline's own level is not below it");
});
