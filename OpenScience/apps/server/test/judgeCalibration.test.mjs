import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JUDGE_SITE_IDS, buildJudgeRequest, judgePromptFingerprint } from "../src/judgeSites.mjs";
import { driftSummaryFromRows } from "../src/judgePersistence.mjs";
import { loadConfig } from "../src/config.mjs";
import { loadAgentRegistry } from "../src/agentRegistry.mjs";
import { createJudgeService } from "../src/judgeService.mjs";
import { SpecialistClassifier } from "../src/specialistClassifier.mjs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

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
  // J1 stays inert by decision (it is not a consolidation gate); J3 is pinned below, on the plan's launch conditions rather than this bar.
  assert.equal(pins.sites.J1.calibration, "uncalibrated");
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

const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");
/** @param {string} site */
const readBenefit = async (site) => JSON.parse(await readFile(new URL(`evals/judge-sites/${site}/benefit-2026-10-10.json`, root), "utf8"));

test("J3 is pinned on the plan's launch conditions: its pin binds the measured routing prompt whatever the catalogue, and its benefit record shows both conditions in every pass (JEV-4)", async () => {
  const pin = pins.sites.J3;
  assert.equal(pin.calibration, "calibrated");
  // The corpus case carries the question; the catalogue the runner and the server add is data, so any catalogue gives the one fingerprint.
  const corpus = JSON.parse(await readFile(new URL("evals/judge-sites/J3/cases.json", root), "utf8"));
  const catalogue = (/** @type {number} */ size) => Array.from({ length: size }, (_, i) => ({ id: `capability-${i}`, title: `T${i}`, description: `d${i}`, requiredInputs: [], starterPrompts: [] }));
  for (const size of [2, 25, 40]) {
    const { questions } = buildJudgeRequest("J3", { ...corpus.cases[0].input, capabilities: catalogue(size) });
    assert.equal(judgePromptFingerprint("J3", questions, pin.threshold, pins.model), pin.promptFingerprint, `${size} capabilities`);
  }
  const benefit = await readBenefit("J3");
  assert.equal(benefit.decision.value, "on");
  assert.equal(benefit.decision.resultsSha256, pin.resultSha256);
  assert.equal(evidence.sites.J3.resultSha256, pin.resultSha256);
  assert.equal(evidence.sites.J3.lower95, pin.lower95);
  assert.equal(evidence.sites.J3.qualification, "calibrated");
  assert.ok(benefit.passes.length >= 2, "a decision holds in more than one pass");
  for (const pass of benefit.passes) {
    const check = (/** @type {string} */ id) => pass.checks.find((/** @type {any} */ row) => row.id === id);
    assert.equal(check("plan-launch-conditions")?.ok, true, `${pass.id}: ${check("plan-launch-conditions")?.detail}`);
    assert.match(check("plan-launch-conditions").detail, /^0 of 50 title-to-paper questions routed to a specialist/);
    assert.equal(check("not-slower")?.ok, true, `${pass.id}: ${check("not-slower")?.detail}`);
    assert.equal(check("non-inferiority")?.ok, true);
    // The two conditions are read off the rows, not off a summary.
    const titleToPaper = pass.rows.filter((/** @type {any} */ row) => row.tag === "title-to-paper");
    assert.equal(titleToPaper.length, 50);
    assert.equal(titleToPaper.filter((/** @type {any} */ row) => row.falseSpecialist || row.finalRoute !== "none").length, 0, "none of the 50 was routed to a specialist");
    assert.ok(pass.rows.filter((/** @type {any} */ row) => row.falseSpecialist).length <= pass.rows.filter((/** @type {any} */ row) => row.baselineFalseSpecialist).length);
  }
  // The pin states the weaker pass, not the better one.
  assert.equal(pin.lower95, Math.min(...benefit.passes.map((/** @type {any} */ pass) => pass.summary.jev.lower95)));
});

test("every benefit record is what it says it is, and a site is pinned calibrated exactly when its record decided it is on (JEV-4)", async () => {
  const dir = new URL("evals/judge-sites/", root);
  const sites = (await readdir(dir)).filter((name) => /^J\d+$/.test(name));
  const recorded = [];
  for (const site of sites) {
    let benefit;
    try { benefit = await readBenefit(site); } catch { continue; }
    recorded.push(site);
    assert.equal(benefit.site, site);
    // The rows are the evidence the digests bind; a hand-edited number would not reproduce them.
    const { rowsDigest } = await import(new URL("evals/judge-sites/benefit.mjs", root).href);
    for (const pass of benefit.passes) assert.equal(pass.rowsSha256, rowsDigest(pass.rows), `${site} ${pass.id}`);
    assert.equal(benefit.decision.resultsSha256, sha256(benefit.passes.map((/** @type {any} */ pass) => pass.rowsSha256).join("\n")), site);
    // One decision from the passes: on only when every pass is.
    assert.equal(benefit.decision.value, benefit.passes.every((/** @type {any} */ pass) => pass.decision === "on") ? "on" : "original-path", site);
    assert.equal(pins.sites[site].calibration === "calibrated", benefit.decision.value === "on", `${site}: the pin and the record disagree`);
    if (benefit.decision.value === "on") assert.equal(evidence.sites[site].qualification, "calibrated", site);
    else assert.notEqual(evidence.sites[site].qualification, "calibrated", site);
  }
  assert.ok(["J2", "J3", "J4"].every((site) => recorded.includes(site)), `read ${recorded.join(",")}`);
  // Every site that is pinned calibrated (the reply check has no pin) has its record.
  assert.deepEqual(Object.entries(pins.sites).filter(([, pin]) => pin.calibration === "calibrated").map(([site]) => site).filter((site) => !recorded.includes(site)), []);
});

test("under the shipped pins J3 judges a question over the real capability registry: the pin is not stood down by the catalogue the server offers (JEV-4)", async () => {
  const rootDir = fileURLToPath(root).replace(/\/$/, "");
  const config = loadConfig({ rootDir, typesafeApiKey: "test-not-secret", requireDurableUsageLedger: false });
  assert.equal(config.jevSites.J3.calibration, "calibrated");
  const registry = await loadAgentRegistry({ packageDirs: config.agentPackageDirs, capabilityDirs: config.capabilityDirs });
  const agents = registry.list().filter((/** @type {any} */ agent) => agent.id !== "open-domain-answer");
  assert.ok(agents.length >= 20 && agents.some((/** @type {any} */ agent) => agent.id === "meta-analysis"), `read ${agents.length} capabilities`);
  // A provider that routes to meta-analysis with a sure answer, whatever options the question lists.
  const callImpl = async (/** @type {any} */ _deps, /** @type {any} */ call) => {
    const options = Object.keys(call.questions.agentId.criteria);
    const probabilities = Object.fromEntries(options.map((id) => [id, id === "meta-analysis" ? 0.97 : 0.03 / (options.length - 1)]));
    return { model: config.reviewJevModel, cost: 0, answers: { agentId: { type: "choice", choice: "meta-analysis", confidence: (options.length * 0.97 - 1) / (options.length - 1), probabilities } } };
  };
  const service = createJudgeService({ config, callImpl });
  const classifier = new SpecialistClassifier({ ...config, llmRoutingEnabled: true }, { judgeService: service, fetchImpl: async () => { throw new Error("Flash must not be asked"); } });
  const routed = await classifier.classify("请对他汀类药物的一级预防做一次 Meta 分析", agents);
  assert.equal(routed?.agentId, "meta-analysis");
  assert.match(routed?.reason ?? "", /^jev:0\.\d\d$/);
  assert.equal(service.status().sites.J3.blockedBy, undefined, "the catalogue did not stand the site down");
  assert.equal(service.status().sites.J3.enabled, true);
  await service.close();
});
