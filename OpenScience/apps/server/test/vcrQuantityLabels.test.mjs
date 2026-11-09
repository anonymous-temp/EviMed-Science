// R24: a result names what it computed. The three uncertainty modes of a simulation are three quantities, assurance is its own,
// the joint "success" is said as not computed until all four things it rests on are there, and every simulated result carries the
// sentence about replicates. A scan holds the page, the reply and the fixtures to it: no 「功效」 on a mode-averaged number.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { VCR_RESULT_QUANTITY_LABELS_ZH, VCR_SIMULATION_ERROR_SENTENCE_ZH } from "@evimed/domain";
import { progressionCard } from "../src/vcrProgression.mjs";
import { vcrPremises } from "../src/vcrPremises.mjs";
import { vcrWithSimulationNote } from "../src/vcrSimulationNote.mjs";

const fixture = (name) => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/vcr-progression/${name}.json`, import.meta.url), "utf8")), id: "res_1", version: 1, kind: "progression_simulation", createdAt: "2026-11-04T00:00:00Z" });
const strings = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);
const row = (/** @type {Record<string, any>} */ card, /** @type {string} */ key) => card.premises.find((premise) => premise.key === key);

test("each uncertainty mode of an Alzheimer simulation names the chance it computed, and only the typical study is called power-at-the-parameters", () => {
  const base = fixture("alzheimer-beta-logit");
  base.diagnostics.progression.isNull = false;
  for (const [mode, quantity] of [["typical_study", "conditional_power_typical_study"], ["new_study", "expected_power_over_studies"], ["posterior_draws", "expected_power_over_parameters"]]) {
    const row_ = structuredClone(base);
    row_.diagnostics.progression.uncertainty = mode;
    const card = progressionCard(row_);
    assert.equal(card.powerName, VCR_RESULT_QUANTITY_LABELS_ZH[quantity], mode);
    assert.equal(card.powerQuantity, quantity, mode);
    if (mode !== "typical_study") for (const sentence of strings({ title: card.title, question: card.question, powerName: card.powerName, premises: card.premises })) assert.doesNotMatch(sentence, /功效/, `${mode}: ${sentence}`);
    const variation = row(card, "progression:ad:uncertainty");
    if (mode !== "typical_study") assert.ok(variation.value.includes(VCR_RESULT_QUANTITY_LABELS_ZH[quantity]), "the variation row names the quantity it makes");
  }
});

test("a null run keeps the name of the error it measures; a simulated result and a progression card carry the replicate sentence once", () => {
  const nul = progressionCard(fixture("null"));
  assert.equal(nul.powerName, "没有真实效应时误判有效的概率");
  assert.equal(nul.powerQuantity, null);
  assert.equal(row(progressionCard(fixture("alzheimer-beta-logit")), "lab:replicates").value, VCR_SIMULATION_ERROR_SENTENCE_ZH);
  const simulated = { id: "r", measures: [{ name: "power", value: 80, simulated: true, mcse: 0.4 }] };
  assert.equal(vcrWithSimulationNote(simulated).simulationNote, VCR_SIMULATION_ERROR_SENTENCE_ZH);
  assert.equal(vcrWithSimulationNote({ id: "g", diagnostics: { cells: [{ measures: [{ name: "power", simulated: true }] }] } }).simulationNote, VCR_SIMULATION_ERROR_SENTENCE_ZH, "a grid's cells count");
  const exact = { id: "e", measures: [{ name: "required_events", value: 508, simulated: false }] };
  assert.equal(vcrWithSimulationNote(exact), exact, "a closed-form result is returned as it is");
  assert.equal(vcrWithSimulationNote(vcrWithSimulationNote(simulated)).simulationNote, VCR_SIMULATION_ERROR_SENTENCE_ZH);
});

test("beside an assurance the premises say the trial-level success chance is not computed, and which of its four facts are missing", () => {
  const input = { endpointType: "time_to_event", designKind: "two_arm_fixed", configuration: { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" } }, hasAssurance: true, assuranceRan: true, simulated: true };
  const rows = Object.fromEntries(vcrPremises("trial", input).map((premise) => [premise.key, premise]));
  assert.equal(rows.trialSuccess.label, VCR_RESULT_QUANTITY_LABELS_ZH.trial_success_probability);
  assert.match(rows.trialSuccess.value, /^没有计算：还缺你给出的最小重要差异、研究之间的差异、与研究问题一致的分析方法$/, "the sourced prior is the assurance that ran");
  assert.equal(rows.trialSuccess.decisive, false);
  assert.equal(rows["lab:replicates"].value, VCR_SIMULATION_ERROR_SENTENCE_ZH);
  const complete = Object.fromEntries(vcrPremises("trial", { ...input, successFacts: { mid: true, betweenStudy: true, estimand: true } }).map((premise) => [premise.key, premise]));
  assert.equal(complete.trialSuccess, undefined, "all four hold: nothing is said missing");
  assert.equal(vcrPremises("trial", { ...input, assuranceRan: false }).some((premise) => premise.key === "trialSuccess"), false, "no assurance, nothing to be mistaken for it");
  assert.equal(vcrPremises("trial", { ...input, simulated: false }).some((premise) => premise.key === "lab:replicates"), false, "a closed-form page has no replicates");
});

const walk = (/** @type {string} */ dir) => readdirSync(dir).flatMap((name) => {
  const path = `${dir}/${name}`;
  return statSync(path).isDirectory() ? walk(path) : [path];
});

test("scan: no presenter or fixture labels an assurance or a mode-averaged number 「功效」", () => {
  const root = new URL("../", import.meta.url).pathname;
  // the fixtures of the pages: a measure called assurance is never labelled with 功效, whatever its neighbours say
  const fixtures = walk(`${root}test/fixtures`).filter((path) => path.endsWith(".json"));
  assert.ok(fixtures.length > 20, "the walk walked");
  let seen = 0;
  const visit = (/** @type {any} */ node, /** @type {string} */ path) => {
    if (Array.isArray(node)) return node.forEach((entry) => visit(entry, path));
    if (!node || typeof node !== "object") return;
    if (/^assurance(_simulated)?$/.test(String(node.name ?? node.key ?? ""))) {
      seen += 1;
      for (const field of ["label", "title", "header"]) if (typeof node[field] === "string") assert.doesNotMatch(node[field], /功效|成功把握/, `${path}: ${node[field]}`);
    }
    if (typeof node.quantity === "string" && /^(expected_|assurance|trial_success)/.test(node.quantity)) assert.doesNotMatch(JSON.stringify(node), /功效/, `${path}: ${node.quantity}`);
    for (const [key, value] of Object.entries(node)) visit(value, `${path}.${key}`);
  };
  for (const path of fixtures) visit(JSON.parse(readFileSync(path, "utf8")), path.replace(root, ""));
  assert.ok(seen > 0, "the fixtures hold an assurance to check");
  // the sources: a line that names the assurance by its words or the averaged modes' words never calls it 功效
  const sources = [...walk(`${root}src`), ...walk(new URL("../../web/src", import.meta.url).pathname)].filter((path) => /\.(mjs|ts|tsx)$/.test(path) && !/\.test\./.test(path));
  const offenders = [];
  for (const path of sources) {
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (/功效/.test(line) && /成功把握|expected_power|新研究.*功效|参数的不确定性.*功效|平均后.*功效/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) offenders.push(`${path.replace(root, "")}:${index + 1}`);
    }
  }
  assert.deepEqual(offenders, []);
});
