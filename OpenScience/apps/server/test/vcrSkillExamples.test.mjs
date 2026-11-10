// The five capability skills of 「虚拟临床研究」 that this module's runtime writes are
// taught in (protocol, analysis, evidence, matching, package) tell a run exactly what to
// call. This test holds every such instruction to the real thing:
//
// - every `mcp__evimed__<tool>` a skill names is a tool the MCP server defines
//   AND one the capability's manifest actually gives the run;
// - every `what: "<word>"` is a word the read / write vocabulary has;
// - every JSON example that is a `vcr_write` call — or an object the analysis
//   skill tags `vcr:object:<what>`, which is that write's `data` — is run through
//   the REAL write path (`vcrRuntimeWrite`, the real validators, the real
//   grammar) against stores that refuse to be reached — so a field the writer
//   would refuse, a value outside a closed word list or a requirement outside the
//   domain's grammar makes the skill's own example fail here, not in a run;
// - an example scenario the analysis skill tags `vcr:design_analytic` is a job the
//   domain's own validator accepts;
// - the pair of each skill (capabilities/ and capability-skills/) is one text.
//
// A skill that teaches a call the tool cannot take is the failure this exists
// to make impossible: it looks like nothing having happened — the run follows
// its instructions and is refused, item by item, for something the skill said.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, normalize } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MCP_TOOL_BASE_NAMES, VCR_ENGINE_METHODS, VCR_ENGINE_PROTOCOL_VERSION, VCR_EXPORT_KINDS, VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_MODEL_DOCUMENT_KINDS,
  VCR_MODEL_DOCUMENT_SECTIONS, normalizeVcrAssessment, validateEngineJob, vcrAssessmentIssues, vcrModelDocumentTakesProse,
} from "@evimed/domain";

import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { vcrBuildStages } from "../src/vcrOrchestrator.mjs";
import { presentComparatorTab } from "../src/vcrViewsTabs.mjs";
import { VCR_READ_WHATS, VCR_WRITE_WHATS } from "../src/vcrService.mjs";
import { VcrAccess } from "../src/vcrAccess.mjs";
import { createVcrCurveEvidence } from "../src/vcrCurveEvidence.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = ["vcr-protocol", "vcr-analysis", "vcr-evidence", "vcr-matching", "vcr-package"];
/**
 * A file of the repository; for a skill's SKILL.md, the whole skill — the entry and the references it sends the model to
 * (`references/*.md` beside it), because a skill split by task (C3) teaches its examples and its rules in all of them.
 * @param {string} path
 */
const read = (path) => {
  const text = readFileSync(join(root, path), "utf8");
  if (!path.endsWith("/SKILL.md")) return text;
  const references = join(root, dirname(path), "references");
  return [text, ...(existsSync(references) ? readdirSync(references).filter((name) => name.endsWith(".md")).sort().map((name) => readFileSync(join(references, name), "utf8")) : [])].join("\n");
};

test("every VCR skill resolves one mirrored shared operating contract", () => {
  const shared = read("capabilities/vcr-protocol/references/operating-contract.md");
  assert.equal(shared, read("capability-skills/vcr-protocol/references/operating-contract.md"));
  for (const skill of SKILLS) {
    for (const tree of ["capabilities", "capability-skills"]) {
      const body = read(`${tree}/${skill}/SKILL.md`);
      const links = [...body.matchAll(/\]\(([^)]+operating-contract\.md)\)/g)];
      assert.equal(links.length, 1, `${tree}/${skill} has one shared contract`);
      assert.equal(read(normalize(join(tree, skill, links[0][1]))), shared);
      assert.ok(body.length > 1000, "the specialty method remains in its own skill");
    }
    const tools = manifestTools(skill);
    for (const [, name] of shared.matchAll(/mcp__evimed__([a-z_]+)/g)) assert.ok(tools.has(name), `${skill} can use shared ${name}`);
  }
});

// The names the platform mounts (the domain's closed list), and the ones the MCP server of this
// module defines itself: a skill may name a tool of either.
const serverTools = new Set([
  ...MCP_TOOL_BASE_NAMES,
  ...read("runtime/mcp/evimed-research/vcr_platform.py").matchAll(/"name":\s*"([a-z_]+)"/g).map((match) => match[1]),
]);

/** The tools a capability manifest gives the run. @param {string} id */
function manifestTools(id) {
  const text = read(`capabilities/${id}/capability.yaml`);
  const block = /^tools:\n((?:- .+\n)+)/m.exec(text)?.[1] ?? "";
  return new Set([...block.matchAll(/^- mcp__evimed__([a-z_]+)$/gm)].map((match) => match[1]));
}

/**
 * The JSON code blocks of a skill, with the tag on the fence when there is one
 * (`json vcr:object:population`). @param {string} text
 * @returns {Array<{ tag: string, text: string }>}
 */
function taggedBlocks(text) {
  return [...text.matchAll(/```json(?: (vcr:\S+))?\n([\s\S]*?)```/g)].map((match) => ({ tag: match[1] ?? "", text: match[2] }));
}

/** The JSON code blocks of a skill. @param {string} text */
function jsonBlocks(text) {
  return taggedBlocks(text).map((block) => block.text);
}

/**
 * A documentation placeholder made into a value the writer's own checks accept: a
 * `<…>` stands for a number a run reads off the document (each distinct, rising, so a
 * low bound stays under its high bound), a bare `…` for a number.
 * @param {string} block
 */
function concrete(block) {
  let next = 1;
  return block
    .replace(/<[^>\n]+>/g, () => String(next++ * 3))
    .replace(/\[\s*…\s*\]/g, "[]")
    .replace(/(:\s*)…(\s*[,}])/g, "$10.5$2");
}

/** Stores and ports that fail the way a database does, after every check of the writer has passed. */
const unreachable = () => new Proxy({}, {
  get: () => async () => { throw Object.assign(new Error("stub"), { code: "XX000" }); },
});

test("every tool a skill names is defined by the MCP server and given to the run by the capability", () => {
  assert.ok(serverTools.size > 40 && serverTools.has("vcr_write") && serverTools.has("evidence_pool") && serverTools.has("kb_search"), "the walk found the tools");
  for (const skill of SKILLS) {
    const named = new Set([...read(`capabilities/${skill}/SKILL.md`).matchAll(/mcp__evimed__([a-z_]+)/g)].map((match) => match[1]));
    assert.ok(named.size >= 2, `${skill}: the walk found the tools it names`);
    const given = manifestTools(skill);
    assert.ok(given.size >= 4, `${skill}: the walk found the manifest's tools`);
    for (const tool of named) {
      assert.ok(serverTools.has(tool), `${skill} names ${tool}, which the MCP server does not define`);
      assert.ok(given.has(tool), `${skill} names ${tool}, which capabilities/${skill}/capability.yaml does not give the run`);
    }
  }
});

test("every what a skill teaches is a word the read or write vocabulary has, and every job kind is one the queue takes", () => {
  let whats = 0;
  for (const skill of SKILLS) {
    const text = read(`capabilities/${skill}/SKILL.md`);
    for (const match of text.matchAll(/what:?"?\s*:?\s*"([a-z_]+)"/g)) {
      whats += 1;
      assert.ok([...VCR_READ_WHATS, ...VCR_WRITE_WHATS].includes(match[1]), `${skill} teaches what: "${match[1]}", which is neither readable nor writable`);
    }
    for (const match of text.matchAll(/"kind":\s*"([a-z_]+)"\s*[,}]/g)) {
      if (!/"action":\s*"start"[^}]*"kind":\s*"([a-z_]+)"/.test(text)) continue;
      if (VCR_JOB_KINDS.includes(match[1])) continue;
      assert.ok([...VCR_EXPORT_KINDS, "exclusion", "inclusion", "study_specific", "routine_care", "post_exit"].includes(match[1]),
        `${skill} teaches kind "${match[1]}", which is neither a job kind nor a word of the write it sits in`);
    }
  }
  assert.ok(whats >= 25, `the walk found the whats (${whats})`);
});

test("every vcr_write example in a skill passes the real write path's own checks", async () => {
  let checked = 0;
  const analysisObjects = [];
  for (const skill of SKILLS) {
    for (const block of taggedBlocks(read(`capabilities/${skill}/SKILL.md`))) {
      // Receipt references depend on authenticated source input; the next test
      // resolves that example through the real curve service before writing it.
      if (block.tag === "vcr:curve_receipt") continue;
      const raw = block.text;
      const object = /^vcr:object:([a-z_]+)$/.exec(block.tag);
      // An object the analysis skill tags is the `data` of a write of that `what`.
      const parsed = object ? { what: object[1], data: JSON.parse(concrete(raw)) } : JSON.parse(concrete(raw));
      if (!VCR_WRITE_WHATS.includes(parsed?.what)) continue;
      const stub = unreachable();
      // The plane's copy of a document is whatever the example quotes: the check that a
      // quotation is the document's own still runs, against the words the skill gave.
      const quotes = [...JSON.stringify(parsed).matchAll(/"quote":\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
      const documents = { read: async (/** @type {any} */ _study, /** @type {{ documentId: string }} */ input) => ({ id: input.documentId, text: quotes.join("\n"), visibleAt: null }) };
      /** @type {string[]} */
      const reported = [];
      const outcome = await vcrRuntimeWrite({
        store: stub, service: stub, orchestrator: null, study: { id: "std_x", userId: "u_x", dataTier: "T0" },
        what: parsed.what, items: parsed.items ?? null, data: parsed.data ?? null,
        evidence: stub, evidenceStore: stub, matchStore: stub, matching: stub, seal: stub, dataPlane: stub, documents,
        report: (code) => reported.push(code),
      });
      // What is left after the writer's own checks is the stub refusing to be reached; anything else is the skill's mistake.
      const own = outcome.issues.filter((entry) => entry.code !== "vcr_write_refused");
      assert.deepEqual(own, [], `${skill}: the ${parsed.what} example is refused by the writer`);
      checked += 1;
      if (skill === "vcr-analysis") analysisObjects.push(parsed.what);
    }
  }
  assert.ok(checked >= 12, `the walk found the write examples (${checked})`);
  assert.deepEqual(analysisObjects.sort(), ["comparator", "design_grid", "model_assessment", "patient_set", "patient_set", "population", "trial_scenario", "trial_scenario"],
    "the ordinary analysis objects retain population, both patient-set shapes (one outcome, one trajectory), comparator, both trial designs and the grid, and the model's assessment record is written beside them");
});

test("the analysis skill's curve example uses a recorded receipt and passes the real write path", async (t) => {
  const blocks = taggedBlocks(read("capabilities/vcr-analysis/SKILL.md")).filter((block) => block.tag === "vcr:curve_receipt");
  assert.equal(blocks.length, 1, "the literature comparator has a separate source-bound receipt example");
  const example = JSON.parse(blocks[0].text);
  assert.equal(example.what, "comparator");
  assert.equal(example.data.route, "literature_control");
  assert.deepEqual(example.data.configuration, { provenance: { receiptId: "crv_example_from_evidence_read" } },
    "the model supplies the receipt identifier, never points or an origin label");

  const workspaceDir = await mkdtemp(join(os.tmpdir(), "vcr-skill-curve-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=", "base64");
  await writeFile(join(workspaceDir, "figure.png"), image);
  const study = { id: "std_example", userId: "u_example", projectId: "p_example", dataTier: "T0" };
  const receipts = new Map();
  const audit = [];
  const curves = createVcrCurveEvidence({
    store: {
      async saveCurveExtraction(row) { receipts.set(row.id, structuredClone(row)); return row; },
      async curveExtraction(studyId, id) { const row = receipts.get(id); return row?.studyId === studyId ? structuredClone(row) : null; },
    },
    studyStore: { async studyById(id) { return id === study.id ? study : null; } },
    access: new VcrAccess({ store: /** @type {any} */ ({
      async studyForAccess(id) { return id === study.id ? study : null; },
      async rolesOf() { return []; },
      async audit(row) { audit.push(row); },
    }) }),
    resolveProject: async () => ({ workspaceDir }),
  });
  const points = { curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.5 }], riskTable: [{ time: 0, atRisk: 100 }, { time: 12, atRisk: 50 }] };
  const receipt = await curves.recordSelection({ studyId: study.id, principal: study.userId, imageArtifactId: "figure.png", points });
  example.data.configuration.provenance.receiptId = receipt.id;
  const verified = await curves.curveVerifier({ studyId: study.id, principal: study.userId, scenario: example.data.configuration, inputs: [] });
  assert.deepEqual(verified.scenario.curve, points.curve);
  assert.ok(verified.inputs.some((input) => input.id === `evidence:${receipt.id}@1`));
  assert.deepEqual(audit.map((row) => row.action), ["access.write", "access.run"]);

  let saved;
  const outcome = await vcrRuntimeWrite({
    store: { async saveComparatorDesign(row) { saved = row; return { id: "cmp_example" }; } },
    service: unreachable(), orchestrator: null, study, what: example.what, data: example.data, items: null,
  });
  assert.deepEqual(outcome.issues, []);
  assert.equal(outcome.ok, true);
  assert.equal(saved.configuration.provenance.receiptId, receipt.id);
  await writeFile(join(workspaceDir, "figure.png"), Buffer.concat([image, Buffer.from("changed")]));
  await assert.rejects(curves.curveVerifier({ studyId: study.id, principal: study.userId, scenario: example.data.configuration, inputs: [] }),
    { code: "vcr_curve_source_changed" });
});

test("the analysis skill's external-control example is written whole, read by the engine in its own words and shown on the page (A6, A7)", async () => {
  const blocks = taggedBlocks(read("capabilities/vcr-analysis/SKILL.md")).filter((block) => block.tag === "vcr:object:comparator");
  const example = JSON.parse(blocks.find((block) => JSON.parse(block.text).route === "external_control")?.text ?? "null");
  assert.ok(example, "the skill has an external-control example");
  assert.equal(Array.isArray(example.targetTrial), false, "the record is the closed seven components, on the object, not the engine's list in the configuration");
  assert.deepEqual(Object.keys(example.targetTrial), ["eligibility", "strategies", "assignment", "timeZero", "outcome", "contrast", "analysis"]);

  // 1. the real write path takes it whole: no refusal and, the records being complete, no reminder
  /** @type {any} */
  let saved;
  const study = { id: "std_example", userId: "u_example", projectId: "p_example", dataTier: "T2" };
  const outcome = await vcrRuntimeWrite({
    store: { async saveComparatorDesign(/** @type {any} */ row) { saved = row; return { id: "cmp_example" }; }, async one() { return { found: 1 }; } },
    service: unreachable(), orchestrator: null, study, what: "comparator", data: example, items: null,
  });
  assert.deepEqual(outcome.issues, [], "the example is complete: nothing is refused and nothing is left to remind");
  assert.equal(saved.targetTrial.timeZero.status, "approximate");
  assert.equal(saved.configuration.applicability.claim, "superiority");

  // 2. the orchestrator hands the engine its own list, and the records the engine does not read are not refused as unknown fields
  const row = { ...saved, id: "cmp_example", version: 1, route: saved.route, estimand: saved.estimand };
  const plan = /** @type {any} */ (vcrBuildStages({ kind: "comparator", row }, { study: { dataTier: "T2" }, definition: { endpointType: "time_to_event" }, assumptions: [] }));
  assert.equal(plan.ok, true, JSON.stringify(plan.refused));
  assert.deepEqual(plan.stages[0].scenario.targetTrial, [
    { item: "eligibility", emulation: "approximate" }, { item: "strategies", emulation: "exact" }, { item: "assignment", emulation: "approximate" },
    { item: "timeZero", emulation: "approximate" }, { item: "outcome", emulation: "exact" }, { item: "contrast", emulation: "exact" }, { item: "analysis", emulation: "exact" },
  ]);
  assert.equal("applicability" in plan.stages[0].scenario, false, "the applicability record is read by the page and the control plane, not by the engine");

  // 3. the page shows it: every component beside its status, the weak ones as a premise, the applicability first
  const now = new Date("2026-11-01T12:00:00.000Z");
  // a weighted comparison states the estimand it computed; the page words that one (review RF2 P1-8)
  const result = { id: "res_1", version: 1, kind: "comparator", conclusion: "limited", counts: {}, measures: [], diagnostics: { estimand: "ATT" }, createdAt: now.toISOString() };
  const comparator = { ...row, resultId: "res_1", conclusion: "limited", gapList: [], createdAt: now.toISOString() };
  const tab = presentComparatorTab({ now, study: { id: "std_example", intendedUse: "exploratory", dataTier: "T2", steps: {}, abilities: [] }, definition: null, results: [result], allResults: [result],
    stale: [], reviews: [], jobs: [], budget: null, assumptions: [], members: [], exports: [], decisions: [], roles: [], scenarios: [], comparators: [comparator], comparator,
    populations: [], patientSets: [], grid: null, forecasts: [], models: [], executions: new Map(), protocol: null, criteria: [], jobMarks: [], currentNodes: new Set() });
  const rows = Object.fromEntries(tab.estimand.rows.map((entry) => [entry.label, entry.value]));
  assert.equal(rows["随访起点（时间零点）"], "只能近似：两组都从开始治疗之日起算");
  assert.equal(rows["结局"], "可精确复现：总生存期，同一定义");
  assert.equal(tab.estimand.rows.length, 8, "the estimand and the seven components");
  assert.equal(tab.premises[0].key, "applicability");
  assert.match(tab.premises[0].value, /部分适用，要支持优效结论：外部对照来自另一年代的登记库/);
  assert.match(tab.premises.find((entry) => entry.key === "targetTrial").value, /入选标准：只能近似；分配方式：只能近似；随访起点（时间零点）：只能近似/);
});

test("the analysis skill's example scenario is a job the domain accepts, and its objects are the ones the writer takes", () => {
  const blocks = taggedBlocks(read("capabilities/vcr-analysis/SKILL.md"));
  const tags = blocks.map((block) => block.tag);
  assert.deepEqual(["population", "patient_set", "comparator", "trial_scenario", "design_grid"]
    .every((what) => tags.includes(`vcr:object:${what}`)), true, `the skill's examples are tagged by what they write: ${tags.join(", ")}`);
  const analytic = blocks.filter((block) => block.tag === "vcr:design_analytic");
  assert.equal(analytic.length, 1);
  const method = VCR_JOB_METHODS.design_analytic;
  const issues = validateEngineJob({
    jobId: "job_example", studyId: "std_example", kind: "design_analytic", method, methodVersion: VCR_ENGINE_METHODS[method].version,
    protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, scenario: JSON.parse(analytic[0].text), inputs: [], seed: 1, cpuSecondsLimit: 60,
  });
  assert.deepEqual(issues, [], "the skill's own analytic scenario is refused by the engine's schema");
});

test("the longitudinal patient set the analysis skill shows is a scenario the engine's schema accepts", () => {
  const blocks = taggedBlocks(read("capabilities/vcr-analysis/SKILL.md")).filter((block) => block.tag === "vcr:object:patient_set").map((block) => JSON.parse(block.text));
  const longitudinal = blocks.find((block) => Array.isArray(block.scenario?.visits));
  assert.ok(longitudinal, "the skill shows a trajectory example");
  const method = VCR_JOB_METHODS.generate_patients_longitudinal;
  assert.equal(method, "patients.longitudinal");
  const issues = validateEngineJob({
    jobId: "job_example", studyId: "std_example", kind: "generate_patients_longitudinal", method, methodVersion: VCR_ENGINE_METHODS[method].version,
    protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, scenario: longitudinal.scenario, inputs: [], seed: 1, cpuSecondsLimit: 60,
  });
  assert.deepEqual(issues, [], "the skill's own trajectory scenario is refused by the engine's schema");
});

test("the population and the patient set the analysis skill shows are one study: the arms add up to the population", () => {
  const blocks = taggedBlocks(read("capabilities/vcr-analysis/SKILL.md"));
  const population = JSON.parse(blocks.find((block) => block.tag === "vcr:object:population")?.text ?? "{}");
  const patientSet = JSON.parse(blocks.find((block) => block.tag === "vcr:object:patient_set")?.text ?? "{}");
  const arms = Number(patientSet.scenario?.design?.nTreat) + Number(patientSet.scenario?.design?.nControl);
  assert.ok(Number.isFinite(arms) && arms > 0);
  assert.equal(population.definition?.n, arms, "the skill says the two arms must add up to the population; its own examples must");
});

test("a criterion's requirement written in a skill is inside the domain's grammar, and the old ways of writing one are said to be refused", async () => {
  const protocol = read("capabilities/vcr-protocol/SKILL.md");
  assert.match(protocol, /"op": "absent"/);
  for (const skill of ["vcr-protocol", "vcr-matching"]) {
    for (const block of jsonBlocks(read(`capabilities/${skill}/SKILL.md`))) {
      assert.doesNotMatch(block, /"free_text"|"field":/, `${skill}: an example still writes a requirement in the old { field, op, value } shape`);
    }
  }
  // The matching skill stopped teaching the grammar on 2026-11-04: free text is judged by the model, and a structured screen reads the grammar from `contracts`.
  const text = read("capabilities/vcr-protocol/SKILL.md");
  for (const op of ["all", "any", "not", "present", "absent", "compare", "elapsed_since", "language"]) assert.ok(text.includes(`\`${op}\``), `vcr-protocol names the ${op} node`);
  assert.match(read("capabilities/vcr-matching/SKILL.md"), /what `contracts` gives the criteria grammar/);
});

test("no skill speaks in build-plan identifiers, and the pairs of each skill are one text", () => {
  for (const skill of SKILLS) {
    const text = read(`capabilities/${skill}/SKILL.md`);
    assert.doesNotMatch(text, /\bAC-\d+|方案\s*§|平台原则|\b[A-Z]{1,3}-\d{1,2}\b(?=[）)，、])/, `${skill}: a plan or acceptance identifier is in a model's instruction`);
    assert.equal(read(`capability-skills/${skill}/SKILL.md`), text, `${skill}: capabilities/ and capability-skills/ hold different texts`);
  }
});

test("the skills' model-document instructions agree with the platform: the sections a run is told to write are the ones the gateway takes, and the assessment example is a complete record", () => {
  const pack = read("capabilities/vcr-package/SKILL.md");
  // Every section the package skill names for a model document is a prose section of that document, and every prose section is named.
  for (const kind of VCR_MODEL_DOCUMENT_KINDS) {
    const prose = VCR_MODEL_DOCUMENT_SECTIONS[kind].prose;
    const row = pack.split("\n").find((line) => line.startsWith(`| ${kind === "model_analysis_plan" ? "模型分析计划" : "模型分析报告"} |`));
    assert.ok(row, `${kind}: the skill has its row`);
    const named = [...row.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    assert.deepEqual(named.sort(), [...prose].sort(), `${kind}: the skill names exactly the sections the gateway takes`);
    for (const section of named) assert.equal(vcrModelDocumentTakesProse(kind, section), true);
  }
  // The report example the skill shows is for a section a run may write.
  const example = jsonBlocks(pack).map((block) => JSON.parse(concrete(block))).find((call) => call?.data?.kind === "model_analysis_report");
  assert.ok(example, "the skill shows one model-document write");
  assert.equal(vcrModelDocumentTakesProse(example.data.kind, example.data.section), true);
  // The assessment example in the analysis skill leaves nothing for a notice to say: it is the shape a run copies.
  const call = jsonBlocks(read("capabilities/vcr-analysis/SKILL.md")).map((block) => JSON.parse(concrete(block))).find((entry) => entry?.what === "model_assessment");
  assert.ok(call, "the analysis skill shows the assessment write");
  assert.deepEqual(vcrAssessmentIssues(call.data, "planning"), []);
  assert.equal(normalizeVcrAssessment(call.data).risk, "high", "and its ratings give the risk its own justification speaks of");
  assert.ok(!("risk" in call.data), "a run never writes the risk");
});
