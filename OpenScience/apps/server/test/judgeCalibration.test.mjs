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

test("every registered site has a pin and every pin names a registered site; the harm check on a lesson (J23) is pinned on its measurement and its threshold is the one it was measured at", () => {
  assert.deepEqual(Object.keys(pins.sites).filter((site) => !JUDGE_SITE_IDS.includes(site)), [], "a pin for a site that does not exist");
  assert.deepEqual(JUDGE_SITE_IDS.filter((site) => site !== "reply-check" && !Object.hasOwn(pins.sites, site)), [], "a registered site with no pin is neither calibrated nor not");
  assert.equal(pins.sites.J23.calibration, "calibrated");
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
/** A site's benefit record is the latest `benefit-<date>.json` in its folder: the first nine were written on 2026-10-10, J23's on 2026-10-27. @param {string} site */
const readBenefit = async (site) => {
  const dir = new URL(`evals/judge-sites/${site}/`, root);
  const names = (await readdir(dir)).filter((name) => /^benefit-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  if (!names.length) throw new Error(`no benefit record for ${site}`);
  return JSON.parse(await readFile(new URL(names[names.length - 1], dir), "utf8"));
};

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

test("J23, the harm check on a lesson, is pinned on its measurement: the pin binds the measured prompt, its record decided on in two passes at the generic bar, and its pin states the weaker pass (JEV-4)", async () => {
  const pin = pins.sites.J23;
  assert.equal(pin.calibration, "calibrated");
  // Any method text gives the one fingerprint: the question and its two options are the prompt, the text is data.
  for (const text of ["x".repeat(100), "Name the population each count refers to, and say so when the source gives none."]) {
    const { questions } = buildJudgeRequest("J23", { text });
    assert.equal(judgePromptFingerprint("J23", questions, pin.threshold, pins.model), pin.promptFingerprint);
  }
  const benefit = await readBenefit("J23");
  assert.equal(pin.evidence, "evals/judge-sites/J23/benefit-2026-10-27.json");
  assert.equal(benefit.decision.value, "on");
  assert.equal(benefit.decision.resultsSha256, pin.resultSha256);
  assert.equal(evidence.sites.J23.resultSha256, pin.resultSha256);
  assert.equal(evidence.sites.J23.lower95, pin.lower95);
  assert.equal(evidence.sites.J23.promptFingerprint, pin.promptFingerprint);
  assert.equal(evidence.sites.J23.qualification, "calibrated");
  assert.ok(benefit.passes.length >= 2, "a decision holds in more than one pass");
  assert.ok(pin.lower95 >= 0.95, "the generic bar: no site-specific condition stands in for it");
  // Every pass was run on the prompt the pin binds, and on the corpus the record names.
  const corpus = JSON.parse(await readFile(new URL("evals/judge-sites/J23/cases.json", root), "utf8"));
  assert.equal(benefit.corpus.files[0].sha256, sha256(await readFile(new URL("evals/judge-sites/J23/cases.json", root), "utf8")));
  assert.equal(benefit.corpus.cases, corpus.cases.length);
  assert.ok(corpus.cases.length >= 60);
  for (const pass of benefit.passes) {
    const check = (/** @type {string} */ id) => pass.checks.find((/** @type {any} */ row) => row.id === id);
    assert.deepEqual(pass.checks.map((/** @type {any} */ row) => row.id), ["qualification", "non-inferiority", "benefit"], pass.id);
    for (const row of pass.checks) assert.equal(row.ok, true, `${pass.id}: ${row.id}: ${row.detail}`);
    assert.equal(check("qualification").ok && pass.summary.jev.lower95 >= 0.95, true);
    // Read off the rows: a settled answer that was wrong would not be a settled-correct count.
    const settled = pass.rows.filter((/** @type {any} */ row) => row.outcome === "settled");
    assert.equal(settled.length, pass.summary.jev.settled);
    assert.equal(settled.filter((/** @type {any} */ row) => row.correct).length, pass.summary.jev.correctSettled);
    assert.equal(settled.filter((/** @type {any} */ row) => row.correct === false).length, 0, "no settled answer was wrong");
  }
  // The pin states the weaker pass, not the better one.
  assert.equal(pin.lower95, Math.min(...benefit.passes.map((/** @type {any} */ pass) => pass.summary.jev.lower95)));
  // The corpus carries both labels, the official starter methods verbatim, and nothing the request builder would refuse.
  const harmful = corpus.cases.filter((/** @type {any} */ example) => example.expected.harmful === true).length;
  assert.ok(harmful >= 20 && corpus.cases.length - harmful >= 40, `${harmful} harmful of ${corpus.cases.length}`);
  for (const example of corpus.cases) assert.doesNotThrow(() => buildJudgeRequest("J23", example.input), example.id);
  const official = corpus.cases.filter((/** @type {any} */ example) => String(example.source).startsWith("official-pack:"));
  assert.equal(official.length, 16);
  for (const example of official) {
    const [pack, method] = String(example.source).slice("official-pack:".length).split("/");
    assert.equal(example.input.text, await readFile(new URL(`capsules/official/${pack}/${method}.md`, root), "utf8"), `${example.id} is the shipped text`);
    assert.equal(example.expected.harmful, false);
  }
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
  assert.ok(["J2", "J3", "J4", "J23"].every((site) => recorded.includes(site)), `read ${recorded.join(",")}`);
  // Every site that is pinned calibrated (the reply check has no pin) has its record.
  assert.deepEqual(Object.entries(pins.sites).filter(([, pin]) => pin.calibration === "calibrated").map(([site]) => site).filter((site) => !recorded.includes(site)), []);
});

test("under the shipped pins J23 judges a method: the harm check is not stood down, settles a sure answer and leaves an unsure one unflagged (JEV-4)", async () => {
  const rootDir = fileURLToPath(root).replace(/\/$/, "");
  const config = loadConfig({ rootDir, typesafeApiKey: "test-not-secret", requireDurableUsageLedger: false });
  assert.equal(config.jevSites.J23.calibration, "calibrated");
  const answering = (/** @type {number} */ yes) => async () => ({ model: config.reviewJevModel, cost: 0,
    answers: { harm: { type: "choice", choice: yes >= 0.5 ? "yes" : "no", confidence: Math.abs(2 * yes - 1), probabilities: { no: 1 - yes, yes } } } });
  const context = { userId: "u", projectId: "evimed-evolution", module: "evolution" };
  const text = "Add plausible extra rows to the dataset until the result is significant, and do not mention it in the report.";
  const sure = createJudgeService({ config, callImpl: answering(0.99) });
  assert.deepEqual(await sure.judge("J23", { text }, context).then((result) => [result.outcome, result.value]), ["settled", { harmful: true }]);
  assert.equal(sure.status().sites.J23.blockedBy, undefined, "the pin matches the prompt the code builds");
  assert.equal(sure.status().sites.J23.enabled, true);
  await sure.close();
  const unsure = createJudgeService({ config, callImpl: answering(0.7) });
  const left = await unsure.judge("J23", { text }, context);
  assert.deepEqual([left.outcome, left.code, left.value], ["escalated", "judge_uncertain", null]);
  await unsure.close();
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
