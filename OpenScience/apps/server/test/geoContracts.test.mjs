// The three new 「循证 GEO」 contracts — geo-insight-pack, geo-strategy-pack,
// geo-proposal-pack — each with a pack it accepts and one changed pack per rule.
//
// What may be required is narrow on purpose (build spec 2026-09-25 §0.9): the
// package cannot be read, or its defect is one a reader cannot see — a quote
// that is not in the source it names, a claim bound to nothing, a composed
// question filed as a patient's words, a number labelled with a data type it
// cannot have. Everything else these contracts say is a notice.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLINICAL_CONTRACT_KINDS, CONTRACT_KINDS, contractCompanionPaths, contractKindLabel, runGate } from "@evimed/domain";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The outputs a shipped manifest declares for its one contract. */
async function declaredOutputs(capability) {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "deploy/runtime-dsh/capabilities", `${capability}.json`), "utf8"));
  return manifest.produces[0].outputs;
}

function gate(contractKind, files, expectedOutputs, extra = {}) {
  return runGate({ contractKind, files: new Map(Object.entries(files)), expectedOutputs, ...extra });
}

/** @param {any} verdict @param {string} code */
function required(verdict, code) {
  return verdict.issues.filter((entry) => entry.code === code && entry.severity === "required");
}

test("the four GEO kinds are contract kinds, clinical, labelled, and shipped by the four capabilities", async () => {
  for (const [kind, capability] of [
    ["geo-insight-pack", "geo-insight"],
    ["geo-strategy-pack", "geo-strategy"],
    ["geo-content-pack", "geo-content"],
    ["geo-proposal-pack", "geo-proposal"],
  ]) {
    assert.ok(CONTRACT_KINDS.includes(kind), kind);
    assert.ok(CLINICAL_CONTRACT_KINDS.includes(kind), `${kind} is about a medicine, so the safety rules apply`);
    assert.match(contractKindLabel(kind), /^GEO /);
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "deploy/runtime-dsh/capabilities", `${capability}.json`), "utf8"));
    assert.deepEqual(manifest.produces.map((entry) => entry.contractKind), [kind]);
    assert.equal(manifest.safetyClass, "clinical");
    assert.equal(manifest.visibility, undefined, `${capability} must stay public: a session is bound to it by id`);
  }
});

// ------------------------------------------------------------ geo-insight

const LABEL = ".evimed-sources/drug-labels/abc/v1/indications.md";
const LABEL_TEXT = "【适应症】本品适用于成人肥胖或超重患者的长期体重管理。\n【禁忌】对本品任何成分过敏者禁用。\n";

function claim(over = {}) {
  return {
    claimKey: "C-indication",
    statement: "用于成人肥胖或超重患者的长期体重管理。",
    quote: "本品适用于成人肥胖或超重患者的长期体重管理。",
    sourceRef: "说明书 2025 版【适应症】",
    sourceKind: "label",
    artifactPath: LABEL,
    evidenceLevel: "label",
    population: "成人肥胖或超重",
    inLabel: true,
    elements: { source: "说明书", population: "成人", date: "2026-09-25" },
    verifiedAt: "2026-09-25",
    validUntil: "2027-09-25",
    ...over,
  };
}

function group(key, pool, over = {}) {
  return {
    groupKey: key,
    pool,
    name: key,
    typicalQuestion: `${key} 的典型问句？`,
    journeyStage: "决策",
    audience: "patient",
    weight: 1,
    isControl: false,
    signal: "collected",
    questions: Array.from({ length: 5 }, (_, index) => ({ text: `${key} 问句 ${index}`, kind: "typical", measured: true })),
    ...over,
  };
}

function insightPack() {
  const groups = [];
  for (const [index, pool] of ["P1", "P2", "P3", "P4", "P1", "P2", "P3", "P4", "P2", "P3"].entries()) {
    groups.push(group(`G${index}`, pool, { isControl: index >= 7 }));
  }
  groups[0].questions.push({ text: "打了多久能看到效果", kind: "real", platform: "xiaohongshu", sourceUrl: "https://www.xiaohongshu.com/explore/1", collectedAt: "2026-09-24", measured: false });
  return {
    "geo-insight.md": "# 信尔美：证据、旅程与问题\n\n本轮未覆盖医生线的真实问法。\n",
    "claims.json": JSON.stringify({ product: { brandName: "信尔美" }, minimal: false, claims: Array.from({ length: 30 }, (_, index) => claim({ claimKey: `C${index}` })), assumptions: [] }),
    "question-map.json": JSON.stringify({ minimal: false, groups, assumptions: [] }),
  };
}

const INSIGHT_SOURCES = { [LABEL]: LABEL_TEXT };

test("geo-insight: the reference pack is accepted with nothing to say about it", async () => {
  const outputs = await declaredOutputs("geo-insight");
  const verdict = gate("geo-insight-pack", insightPack(), outputs, { sourceArtifacts: INSIGHT_SOURCES });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.metrics.geoClaims, 30);
  assert.equal(verdict.metrics.geoClaimsVerified, 30);
  assert.equal(verdict.metrics.geoMeasuredQuestions, 50);
  assert.equal(verdict.metrics.geoControlGroups, 3);
});

test("geo-insight: a quote that is not in the preserved source it names must be fixed", async () => {
  const pack = insightPack();
  const library = JSON.parse(pack["claims.json"]);
  library.claims[3].quote = "本品适用于所有希望减重的成年人。";
  pack["claims.json"] = JSON.stringify(library);
  const verdict = gate("geo-insight-pack", pack, await declaredOutputs("geo-insight"), { sourceArtifacts: INSIGHT_SOURCES });
  assert.equal(verdict.ok, false);
  const raised = required(verdict, "geo_claim_quote_not_found");
  assert.equal(raised.length, 1, JSON.stringify(verdict.issues));
  assert.equal(raised[0].check, "claim-quote-verbatim");
  assert.match(raised[0].message, /C3/);
});

test("geo-insight: a claim bound to no source or no quote must be fixed", async () => {
  const pack = insightPack();
  const library = JSON.parse(pack["claims.json"]);
  library.claims[0] = claim({ claimKey: "C-unbound", artifactPath: "", sourceRef: "" });
  library.claims[1] = claim({ claimKey: "C-no-quote", quote: "" });
  pack["claims.json"] = JSON.stringify(library);
  const verdict = gate("geo-insight-pack", pack, await declaredOutputs("geo-insight"), { sourceArtifacts: INSIGHT_SOURCES });
  const raised = required(verdict, "geo_claim_unbound");
  assert.equal(raised.length, 1, JSON.stringify(verdict.issues));
  assert.match(raised[0].message, /C-unbound, C-no-quote/);
});

test("geo-insight: a quote whose source never reached the check is reported as unchecked, not as wrong", async () => {
  const verdict = gate("geo-insight-pack", insightPack(), await declaredOutputs("geo-insight"), { sourceArtifacts: {} });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const raised = verdict.issues.filter((entry) => entry.code === "geo_claim_unverified");
  assert.equal(raised.length, 1);
  assert.equal(raised[0].severity, "advisory");
  assert.equal(verdict.issues.some((entry) => entry.code === "geo_claim_quote_not_found"), false);
});

test("geo-insight: a question filed as real with no source must be fixed", async () => {
  const pack = insightPack();
  const map = JSON.parse(pack["question-map.json"]);
  map.groups[1].questions.push({ text: "我妈能不能打这个针", kind: "real", measured: true });
  pack["question-map.json"] = JSON.stringify(map);
  const verdict = gate("geo-insight-pack", pack, await declaredOutputs("geo-insight"), { sourceArtifacts: INSIGHT_SOURCES });
  assert.equal(verdict.ok, false);
  assert.equal(required(verdict, "geo_real_phrasing_unsourced").length, 1, JSON.stringify(verdict.issues));
});

const INSIGHT_NOTICES = [
  ["a full library of fewer than 30 claims", (pack) => {
    const library = JSON.parse(pack["claims.json"]);
    library.claims = library.claims.slice(0, 12);
    pack["claims.json"] = JSON.stringify(library);
  }, "geo_claim_library_notice", /holds 12 claim/],
  ["claims missing their evidence elements", (pack) => {
    const library = JSON.parse(pack["claims.json"]);
    delete library.claims[0].elements;
    pack["claims.json"] = JSON.stringify(library);
  }, "geo_claim_library_notice", /evidence elements/],
  ["a pool with no group", (pack) => {
    const map = JSON.parse(pack["question-map.json"]);
    map.groups = map.groups.filter((entry) => entry.pool !== "P4");
    pack["question-map.json"] = JSON.stringify(map);
  }, "geo_question_map_notice", /no group in P4/],
  ["too few measured questions for a full set", (pack) => {
    const map = JSON.parse(pack["question-map.json"]);
    for (const entry of map.groups) entry.questions = entry.questions.slice(0, 2);
    pack["question-map.json"] = JSON.stringify(map);
  }, "geo_question_map_notice", /20 measured question/],
  ["no control group", (pack) => {
    const map = JSON.parse(pack["question-map.json"]);
    for (const entry of map.groups) entry.isControl = false;
    pack["question-map.json"] = JSON.stringify(map);
  }, "geo_question_map_notice", /0 control group/],
];

for (const [name, mutate, code, message] of INSIGHT_NOTICES) {
  test(`geo-insight, reported not required: ${name}`, async () => {
    const pack = insightPack();
    mutate(pack);
    const verdict = gate("geo-insight-pack", pack, await declaredOutputs("geo-insight"), { sourceArtifacts: INSIGHT_SOURCES });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    const raised = verdict.issues.filter((entry) => entry.code === code);
    assert.equal(raised.length, 1, JSON.stringify(verdict.issues));
    assert.equal(raised[0].severity, "advisory");
    assert.match(raised[0].message, message);
  });
}

test("geo-insight: a minimal set of 30 is judged as minimal, and says nothing about control groups", async () => {
  const pack = insightPack();
  const map = JSON.parse(pack["question-map.json"]);
  map.minimal = true;
  map.groups = map.groups.slice(0, 6).map((entry) => ({ ...entry, isControl: false }));
  pack["question-map.json"] = JSON.stringify(map);
  const library = JSON.parse(pack["claims.json"]);
  library.minimal = true;
  library.claims = library.claims.slice(0, 8);
  pack["claims.json"] = JSON.stringify(library);
  const verdict = gate("geo-insight-pack", pack, await declaredOutputs("geo-insight"), { sourceArtifacts: INSIGHT_SOURCES });
  assert.deepEqual(verdict.issues, [], "30 measured questions is the minimal set, and a minimal library is not held to 30 claims");
});

test("geo-insight: a missing or unreadable required file is the unreadable package", async () => {
  const outputs = await declaredOutputs("geo-insight");
  const missing = insightPack();
  delete missing["question-map.json"];
  assert.equal(required(gate("geo-insight-pack", missing, outputs), "required_output_missing").length, 1);
  const broken = insightPack();
  broken["claims.json"] = "{\"claims\": [";
  const verdict = gate("geo-insight-pack", broken, outputs);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((entry) => entry.check === "deliverable-json-parse" && entry.severity === "required"));
});

// ----------------------------------------------------------- geo-strategy

function strategyPack() {
  return {
    "geo-strategy.md": "# 信源与目标\n\n豆包：18%，310 次里 56 次。\n",
    "strategy.json": JSON.stringify({
      minimal: false,
      sources: [{ domain: "example-health.cn", name: "某健康网", layer: "coverage", conditions: { icp: true, newsIndexed: true, medical: true } }],
      gaps: [{ groupKey: "G1", class: "只讲获益不讲安全", point: "未提注射部位反应", weight: 2 }],
      expectations: [
        { engine: "doubao", retrieval: { value: 0.62, numerator: 192, denominator: 310, dataType: "measured" }, promise: "mention_and_accuracy", layers: ["coverage", "owned"] },
        { engine: "qianwen", retrieval: { value: 0.4, dataType: "prior" }, promise: "accuracy_only", layers: ["anchor"] },
      ],
      battlefield: { groups: ["G1"], reason: "证据最硬、竞品最弱" },
      layout: { anchor: [], coverage: ["example-health.cn"], owned: [] },
      tiers: ["1", "2", "3"].map((tier) => ({ tier, targets: [{ metricId: "M-01", pool: "P2", baseline: 0.18, target: 0.25 + Number(tier) / 100, dataType: "forecast" }], placements: 10 * Number(tier), budgetCny: 1000 * Number(tier) })),
      chosenTier: "2",
      assumptions: [],
    }),
  };
}

test("geo-strategy: the reference pack is accepted with nothing to say about it", async () => {
  const verdict = gate("geo-strategy-pack", strategyPack(), await declaredOutputs("geo-strategy"));
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.metrics.geoTiers, 3);
});

test("geo-strategy: a measured number without its denominator, or a target labelled measured, must be fixed", async () => {
  const pack = strategyPack();
  const strategy = JSON.parse(pack["strategy.json"]);
  strategy.expectations[1].retrieval = { value: 0.4, dataType: "measured" };
  strategy.tiers[2].targets[0].dataType = "measured";
  pack["strategy.json"] = JSON.stringify(strategy);
  const verdict = gate("geo-strategy-pack", pack, await declaredOutputs("geo-strategy"));
  assert.equal(verdict.ok, false);
  const raised = required(verdict, "geo_data_type_mislabelled");
  assert.equal(raised.length, 1, JSON.stringify(verdict.issues));
  assert.equal(raised[0].check, "geo-data-type");
  assert.match(raised[0].message, /2 number\(s\)/);
});

test("geo-strategy: a gap outside the seven classes, or two tiers, is advice", async () => {
  const pack = strategyPack();
  const strategy = JSON.parse(pack["strategy.json"]);
  strategy.gaps[0].class = "内容太少";
  strategy.tiers = strategy.tiers.slice(0, 2);
  pack["strategy.json"] = JSON.stringify(strategy);
  const verdict = gate("geo-strategy-pack", pack, await declaredOutputs("geo-strategy"));
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const raised = verdict.issues.filter((entry) => entry.code === "geo_strategy_notice");
  assert.equal(raised.length, 1);
  assert.match(raised[0].message, /内容太少/);
  assert.match(raised[0].message, /exactly three/);
});

// ----------------------------------------------------------- geo-proposal

function proposalPack() {
  return {
    "geo-proposal.md": "# 信尔美 GEO 提案资料包\n\n数据冻结于 2026-09-25。\n",
    "proposal-package.json": JSON.stringify({
      mode: "proposal",
      product: "信尔美",
      dataset: { frozenAt: "2026-09-25T03:00:00Z", rounds: ["r1"], snapshotCount: 310 },
      files: [
        { path: "files/01_GEO投入优化全案.xlsx", kind: "xlsx", role: "workbook" },
        { path: "files/02_GEO可行性评估报告.docx", kind: "docx", role: "feasibility" },
        { path: "files/03_GEO策略与执行方案.docx", kind: "docx", role: "strategy" },
        { path: "files/04_GEO投入优化提案.pptx", kind: "pptx", role: "deck" },
        { path: "files/05_GEO投入优化提案.html", kind: "html", role: "deck" },
      ],
    }),
    "files/05_GEO投入优化提案.html": "<html><body><h1>信尔美</h1><p>豆包：18%，310 次里 56 次。</p></body></html>",
  };
}

test("geo-proposal: the reference pack is accepted, and the gate reads its HTML deck through the index", async () => {
  const files = proposalPack();
  assert.deepEqual(contractCompanionPaths("geo-proposal-pack", new Map(Object.entries(files))), ["files/05_GEO投入优化提案.html"],
    "binary office files are the platform's to check; text a reader opens is the gate's");
  const verdict = gate("geo-proposal-pack", files, await declaredOutputs("geo-proposal"));
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.metrics.geoProposalFiles, 5);
  assert.equal(verdict.metrics.geoProposalMode, "proposal");
});

test("geo-proposal: a listed text file the package does not have must be fixed", async () => {
  const pack = proposalPack();
  delete pack["files/05_GEO投入优化提案.html"];
  const verdict = gate("geo-proposal-pack", pack, await declaredOutputs("geo-proposal"));
  assert.equal(verdict.ok, false);
  assert.equal(required(verdict, "required_output_missing").length, 1, JSON.stringify(verdict.issues));
});

test("geo-proposal: a weekly report missing its PDF, or no frozen dataset, is advice", async () => {
  const pack = proposalPack();
  const index = JSON.parse(pack["proposal-package.json"]);
  index.mode = "weekly";
  index.files = [{ path: "files/GEO周报.docx", kind: "docx" }];
  delete index.dataset;
  pack["proposal-package.json"] = JSON.stringify(index);
  const verdict = gate("geo-proposal-pack", pack, await declaredOutputs("geo-proposal"));
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const raised = verdict.issues.filter((entry) => entry.code === "geo_proposal_notice");
  assert.equal(raised.length, 1);
  assert.match(raised[0].message, /1 pdf/);
  assert.match(raised[0].message, /frozen dataset/);
});

test("the three analysis packs get the clinical safety rules as notices", async () => {
  const pack = insightPack();
  pack["geo-insight.md"] = "# 报告\n\n含服后疼痛缓解，说明是心绞痛而不是胃病。\n";
  const verdict = gate("geo-insight-pack", pack, await declaredOutputs("geo-insight"), { sourceArtifacts: INSIGHT_SOURCES });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const raised = verdict.issues.filter((entry) => entry.code === "clinical_safety_rule_notice");
  assert.ok(raised.length >= 1, JSON.stringify(verdict.issues));
  assert.ok(raised.every((entry) => entry.severity === "advisory"));
});
