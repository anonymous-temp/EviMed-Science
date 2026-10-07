import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildJudgeRequest, judgePromptFingerprint } from "../src/judgeSites.mjs";

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
