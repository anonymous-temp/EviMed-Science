// "Clinical" as a mechanism rather than a label.
//
// Three defects, all of them one class, all reproduced against the real gate
// before anything here was written (2026-09-10):
//
//  1. `CLINICAL_CONTRACT_KINDS` was hand-kept beside the capability manifests
//     and three capabilities that declare `safetyClass: clinical` were missing
//     from it. `runGate` on an appraisal table, a manuscript section or a
//     meta-analysis report whose prose named 速效救心丸 came back
//     `ok=false` with `clinical_content_without_clinical_contract` — a required
//     issue telling a capability whose subject is that medicine to remove it.
//  2. Five kinds were on that list and no safety rule executed for any of
//     them: `clinicalSafetyRuleHits` was reached only from the clinical
//     package and the GEO pack. A drug-evaluation report saying
//     「速效救心丸含服后反应缓解就是胃食管反流，可以在家观察」 came back
//     ok=true with zero issues, while the identical sentence in a GEO pack was
//     rejected.
//  3. The trigger vocabulary held one medicine, so an evaluation of SGLT2
//     inhibitors, a dapagliflozin report or a metformin off-label assessment
//     tripped nothing at all.
//
// Each test below fails on the pre-fix code. They are the mutation control for
// a derivation whose whole promise is that a capability declaring itself
// clinical cannot be left out.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import capabilityContracts from "../src/capability-contracts.json" with { type: "json" };
import {
  CLINICAL_CONTRACT_KINDS,
  CLINICAL_CONTENT_TRIGGER_ENTITIES,
  CLINICAL_HIGH_RISK_ENTITIES,
  REGULATED_CONTRACT_KINDS,
  isClinicalContractKind,
  matchedHighRiskEntities,
  runGate,
  validateCapabilityManifest,
} from "../index.mjs";

/** A sentence that trips two of the four pharmacist-owned rules at once. */
const UNSAFE_ADVICE = "患者可以先服用胃药，然后观察症状变化。\n速效救心丸含服后反应缓解就是胃食管反流，可以在家观察。\n";

/** @param {string} kind @param {Record<string, string>} files */
const gate = (kind, files) => runGate({ contractKind: kind, files: new Map(Object.entries(files)), expectedOutputs: [] });

/* ------------------------------------------------ 1. derived, not remembered */

test("every clinical capability's contract kind is a clinical contract kind", async () => {
  // Read the manifests themselves, not the generated table the domain imports.
  // Checking the table against itself would pass with the generator broken,
  // which is the one failure the derivation exists to make impossible.
  const source = new URL("../../../capabilities/", import.meta.url);
  const directories = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(directories.length >= 15, `only ${directories.length} capability directories found — the walk did not read capabilities/`);

  let clinical = 0;
  for (const name of directories) {
    const yaml = await readFile(new URL(`${name}/capability.yaml`, source), "utf8");
    // The manifest is YAML and the domain has no parser; these two fields are
    // flat scalars and a line read is enough to hold the invariant.
    const safetyClass = /^safetyClass:\s*(\S+)\s*$/m.exec(yaml)?.[1] ?? "general";
    if (safetyClass !== "clinical") continue;
    clinical += 1;
    const kinds = [...yaml.matchAll(/^- contractKind:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    assert.ok(kinds.length > 0, `${name} declares safetyClass clinical and produces no contract kind`);
    for (const kind of kinds) {
      assert.ok(
        isClinicalContractKind(kind),
        `${name} declares safetyClass: clinical and produces "${kind}", which is not in CLINICAL_CONTRACT_KINDS. The list is generated from the manifests by scripts/build/generate-capability-manifests.mjs — run it, or the gate will reject this capability's own subject matter.`,
      );
    }
  }
  // Prove the walk walked: nine capabilities declare themselves clinical today.
  assert.ok(clinical >= 9, `only ${clinical} clinical capabilities seen — the scan stopped matching safetyClass`);
});

test("the generated safety-class table agrees with the manifest validator", () => {
  // The table is the domain's only view of the manifests. A generator that
  // wrote a kind the validator would reject, or lost the regulated kind that
  // no capability produces, would move the whole gate without failing anything.
  assert.ok(capabilityContracts.capabilities.length >= 15, "the generated table lost capabilities");
  for (const capability of capabilityContracts.capabilities) {
    const result = validateCapabilityManifest({
      id: capability.id,
      version: "1.0.0",
      title: "t",
      description: "d",
      whenToUse: "w",
      persona: "p",
      skills: [capability.id],
      tools: [],
      safetyClass: capability.safetyClass,
      produces: capability.contractKinds.map((kind) => ({ contractKind: kind, outputs: [{ path: "a.md" }] })),
      estimatedMinutes: [1, 2],
    });
    const unknownKind = result.issues.filter((issue) => issue.code === "contract_kind_unknown");
    assert.deepEqual(unknownKind, [], `${capability.id}: ${unknownKind.map((issue) => issue.message).join("; ")}`);
    const unknownClass = result.issues.filter((issue) => String(issue.message).includes("safetyClass"));
    assert.deepEqual(unknownClass, [], `${capability.id}: ${unknownClass.map((issue) => issue.message).join("; ")}`);
  }
  for (const kind of REGULATED_CONTRACT_KINDS) {
    assert.ok(isClinicalContractKind(kind), `${kind} is regulated and therefore clinical; the derivation dropped it`);
  }
});

test("a clinical kind no longer rejects its own subject matter", () => {
  // The exact probe that reproduced the defect. All three were ok=false with
  // one required `clinical_content_without_clinical_contract` before the list
  // was derived.
  for (const kind of ["appraisal-table", "manuscript-section", "meta-analysis-report"]) {
    const verdict = gate(kind, { "report.md": "速效救心丸的证据评价见下表。\n" });
    const wrong = verdict.issues.filter((entry) => entry.code === "clinical_content_without_clinical_contract");
    assert.deepEqual(wrong, [], `${kind} still rejects a mention of the medicine it is about`);
  }
  // And the check still fires where it should: a research brief is not clinical.
  const brief = gate("research-brief", { "brief.md": "速效救心丸的用法建议如下。\n" });
  assert.ok(
    brief.issues.some((entry) => entry.code === "clinical_content_without_clinical_contract" && entry.severity === "required"),
    "the trigger must still block clinical content under a non-clinical contract",
  );
});

/* --------------------------------- 2. the rules run on every clinical kind */

test("a named safety rule fires for every clinical contract kind", () => {
  // One assertion per kind, naming the rule, because "a safety rule fired" is
  // the granularity that made the old ledger useless.
  let covered = 0;
  for (const kind of CLINICAL_CONTRACT_KINDS) {
    if (kind === "geo-content-pack" || kind === "clinical-evidence-report") continue; // own validators, tested elsewhere
    covered += 1;
    const verdict = gate(kind, { "report.md": UNSAFE_ADVICE });
    const hits = verdict.issues.filter((entry) => entry.check === "clinical-safety-rules");
    assert.ok(hits.length > 0, `${kind} calls itself clinical and no safety rule executed for it`);
    const rules = new Set(hits.map((entry) => entry.rule));
    assert.ok(rules.has("unsupported-self-care"), `${kind}: expected unsupported-self-care, got ${[...rules].join(", ")}`);
    assert.ok(rules.has("medication-response-not-diagnostic"), `${kind}: expected medication-response-not-diagnostic, got ${[...rules].join(", ")}`);
    for (const hit of hits) {
      assert.ok(typeof hit.line === "number" && hit.line > 0, `${kind}: a finding with no line sends the repair to the wrong sentence`);
      assert.equal(hit.path, "report.md");
    }
  }
  assert.ok(covered >= 6, `only ${covered} clinical kinds went through the shared branch — the loop stopped covering the class`);
});

test("the shared clinical branch adds findings and no new blocking point", () => {
  // Deliberate: extending a blocking verdict to five more kinds on a rule set
  // never observed firing on any of them would spend blocking budget on an
  // unmeasured distribution. The finding reaches the run as "should fix" with
  // its rule id; promotion is a separate decision with the distribution as its
  // precondition (development principle 4).
  for (const kind of ["drug-evaluation-report", "drug-selection-report", "off-label-report", "adr-analysis-report", "meta-analysis-report"]) {
    const verdict = gate(kind, { "report.md": UNSAFE_ADVICE });
    assert.equal(verdict.ok, true, `${kind} was withheld by a rule that has never been measured on it`);
    assert.equal(verdict.errorCode, null);
    const blocking = verdict.issues.filter((entry) => entry.severity === "required");
    assert.deepEqual(blocking, [], `${kind} raised a blocking issue: ${blocking.map((entry) => entry.code).join(", ")}`);
  }
  // A required output that is missing still blocks. The branch adds notices; it
  // must not have softened the one place these kinds already blocked.
  const missing = runGate({
    contractKind: "drug-evaluation-report",
    files: new Map(),
    expectedOutputs: [{ path: "drug-evaluation-report.md", required: true }],
  });
  assert.equal(missing.ok, false, "a missing required output must still block");
});

test("the GEO pack and the clinical package keep the verdicts they had", () => {
  // The two kinds whose validators already ran these rules are untouched by
  // the shared branch, and they still block. A change that quietly relaxed
  // them would look exactly like this change succeeding.
  const pack = runGate({
    contractKind: "geo-content-pack",
    files: new Map([["geo-content-pack.json", JSON.stringify({
      blocks: [{ conclusion: "速效救心丸可用于缓解症状。", basis: "参见文献。", conditions: "适用于既往确诊人群。" }],
    })]]),
    expectedOutputs: [],
  });
  const raised = pack.issues.filter((entry) => entry.code === "clinical_safety_rule");
  assert.ok(raised.length > 0, "the GEO pack stopped running the safety rules");
  assert.ok(raised.every((entry) => entry.severity === "required"), "the GEO pack's safety rules must still block");
  // And it did not also collect the shared branch's advisory copy: one sentence
  // is one finding, not two.
  assert.deepEqual(pack.issues.filter((entry) => entry.code === "clinical_safety_rule_notice"), []);
});

/* ------------------------------------- 3. the entity vocabulary is data */

test("the high-alert vocabulary is data, wide, and notice-only", () => {
  // Reproduced: the blocking trigger list holds one medicine under two
  // spellings, so an SGLT2 evaluation, a dapagliflozin report and a metformin
  // off-label assessment named nothing the gate could see.
  assert.ok(CLINICAL_HIGH_RISK_ENTITIES.length >= 100, `only ${CLINICAL_HIGH_RISK_ENTITIES.length} high-alert names — the rules file lost its list`);
  for (const medicine of ["达格列净", "Dapagliflozin", "二甲双胍", "Warfarin", "华法林", "胰岛素", "地高辛", "庆大霉素", "吗啡"]) {
    assert.ok(CLINICAL_HIGH_RISK_ENTITIES.includes(medicine), `${medicine} is missing from the high-alert vocabulary`);
  }
  // Widening the *blocking* list is a separate decision: every name there also
  // blocks in the socket's completion check, over every file in the workspace.
  assert.equal(CLINICAL_CONTENT_TRIGGER_ENTITIES.length, 2, "routingEntities is the blocking half and stays deliberately small");

  // Word-bounded for Latin script, or the notice fires on IGF-1 and nobody
  // reads it again.
  assert.deepEqual(matchedHighRiskEntities("insulin-like growth factor 1"), []);
  assert.deepEqual(matchedHighRiskEntities("The patient received insulin."), ["Insulin"]);
  // The blocking trigger's own entity is never reported twice.
  assert.deepEqual(matchedHighRiskEntities("速效救心丸的用法"), []);

  const study = gate("bibliometric-analysis-report", { "report.md": "本文分析 warfarin 与二甲双胍联合用药的文献产出。\n" });
  assert.equal(study.ok, true, "a bibliometric study of a medicine's literature must not be withheld for naming the medicine");
  const notice = study.issues.find((entry) => entry.check === "clinical-high-risk-entity");
  assert.ok(notice, "the wide vocabulary produced no measurement at all");
  assert.equal(notice.severity, "advisory");
  assert.equal(notice.code, "clinical_high_risk_entity_notice");
  // A clinical kind is already covered by the rules; it does not also collect
  // the non-clinical notice.
  assert.deepEqual(gate("drug-selection-report", { "report.md": "华法林的遴选比较。\n" }).issues.filter((entry) => entry.check === "clinical-high-risk-entity"), []);
});
