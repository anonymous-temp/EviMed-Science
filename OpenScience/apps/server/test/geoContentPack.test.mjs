// The geo-content-pack contract (geo-content 2.0.0), exercised by building one
// changed pack per rule.
//
// There is one implementation of the delivery rules and a run reaches it
// through evimed_submit_deliverable; these tests make sure it says what it
// claims. 2.0.0 changed what the pack is: the capability no longer measures
// (the platform does), so the pack is layered articles indexed by
// articles.json, and only two kinds of finding may be required — the package
// cannot be read (an index that does not parse, an article it names that is not
// there) and the pharmacist-owned clinical safety rules over what a reader is
// shown. Everything else is a notice (principle 4, the 2026-09-17 ruling).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { contractCompanionPaths, runGate } from "@evimed/domain";

const EXPECTED_OUTPUTS = [
  { path: "geo-content.md", required: true },
  { path: "articles.json", required: true },
  { path: "geo-probe-log.jsonl", required: false },
  { path: "revision-notes.md", required: false },
];

const CARD = [
  "# 速效救心丸可以长期服用吗？",
  "",
  "速效救心丸不作为日常保健长期服用；确诊冠心病的人按说明书在医师指导下使用。",
  "说明书【功能主治】为行气活血、祛瘀止痛，用于气滞血瘀所致的胸痹。",
  "不适用于孕妇及对本品过敏者。速效救心丸不能代替急救：胸痛持续时，服药的同时呼叫急救，服药不得延误就医。",
  "",
].join("\n");

function article(over = {}) {
  return {
    id: "a1",
    layer: "card",
    title: "速效救心丸可以长期服用吗？",
    question: "速效救心丸可以长期服用吗？",
    groupKey: "G-long-term",
    claimKeys: ["C-label-indication", "C-label-contraindication"],
    path: "articles/a1.md",
    recordPath: "records/a1.md",
    audience: "patient",
    safety: { status: "clear", findings: [] },
    ...over,
  };
}

function round(over = {}) {
  return {
    question: "速效救心丸可以长期服用吗？",
    provider: "deepseek",
    status: "ok",
    inDenominator: true,
    surface: { mode: "default", session: "new_chat" },
    ...over,
  };
}

/** A pack the contract accepts, so every case below differs in exactly one thing. */
function goodPack() {
  return {
    files: {
      "geo-content.md": "# 第一批稿件\n\n| 稿件 | 层级 | 回答的问题 |\n|---|---|---|\n| 速效救心丸可以长期服用吗？ | 证据卡片 | 可以长期服用吗 |\n",
      "articles.json": JSON.stringify({ articles: [article()], assumptions: [] }),
      "articles/a1.md": CARD,
      "records/a1.md": "# 工作记录\n\n临床路径：稳定 → 紧急；关键句对应主张 C-label-indication。\n",
    },
  };
}

function gate(pack, extra = {}) {
  return runGate({
    contractKind: "geo-content-pack",
    files: new Map(Object.entries(pack.files)),
    expectedOutputs: EXPECTED_OUTPUTS,
    ...extra,
  });
}

/** @param {any} pack @param {(index: any) => void} change */
function editIndex(pack, change) {
  const index = JSON.parse(pack.files["articles.json"]);
  change(index);
  pack.files["articles.json"] = JSON.stringify(index);
}

test("the reference pack is accepted with nothing to say about it", () => {
  // Without this, every case below also passes against a validator that
  // rejects everything.
  const verdict = gate(goodPack());
  assert.equal(verdict.ok, true, `the reference pack was rejected: ${JSON.stringify(verdict.issues)}`);
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.errorCode, null);
  assert.equal(verdict.metrics.geoArticles, 1);
  assert.deepEqual(verdict.metrics.geoArticlesByLayer, { card: 1 });
});

// ------------------------------------------------ the unreadable package

const UNREADABLE = [
  ["the index is missing", (pack) => { delete pack.files["articles.json"]; }, "required_output_missing"],
  ["the reader's index report is missing", (pack) => { delete pack.files["geo-content.md"]; }, "required_output_missing"],
  ["the index does not parse", (pack) => { pack.files["articles.json"] = '{"articles": [ {"id": "a1" '; }, "deliverable_rejected"],
  ["the index has no articles list", (pack) => { pack.files["articles.json"] = JSON.stringify({ items: [] }); }, "deliverable_rejected"],
  ["an article the index names is not in the package", (pack) => { delete pack.files["articles/a1.md"]; }, "required_output_missing"],
  ["an article the index names is empty", (pack) => { pack.files["articles/a1.md"] = "  \n"; }, "required_output_empty"],
  ["an article path would leave the package", (pack) => editIndex(pack, (index) => { index.articles[0].path = "../articles/a1.md"; }), "deliverable_rejected"],
];

for (const [name, mutate, code] of UNREADABLE) {
  test(`must be fixed: ${name}`, () => {
    const pack = goodPack();
    mutate(pack);
    const verdict = gate(pack);
    assert.equal(verdict.ok, false, "this pack cannot be read, and the run must be told");
    assert.equal(verdict.errorCode, "deliverable_rejected");
    assert.ok(verdict.issues.some((entry) => entry.code === code && entry.severity === "required"), JSON.stringify(verdict.issues));
  });
}

// --------------------------------------------------- notices, never more

const NOTICES = [
  ["an unknown layer", (pack) => editIndex(pack, (index) => { index.articles[0].layer = "blog"; }), /layer "blog"/],
  ["an article that answers no question", (pack) => editIndex(pack, (index) => { index.articles[0].question = ""; }), /answers no question/],
  ["an article bound to no claim", (pack) => editIndex(pack, (index) => { index.articles[0].claimKeys = []; }), /binds no claim/],
  ["no safety status", (pack) => editIndex(pack, (index) => { delete index.articles[0].safety; }), /safety status/],
  ["a work record named and absent", (pack) => { delete pack.files["records/a1.md"]; }, /work record/],
  ["a Q&A outside 300–600 characters", (pack) => editIndex(pack, (index) => { index.articles[0].layer = "qa"; }), /characters, where a 问答/],
];

for (const [name, mutate, message] of NOTICES) {
  test(`reported, not required: ${name}`, () => {
    const pack = goodPack();
    mutate(pack);
    const verdict = gate(pack);
    assert.equal(verdict.ok, true, `a notice must not become a rejection: ${JSON.stringify(verdict.issues)}`);
    const raised = verdict.issues.filter((entry) => entry.code === "geo_article_notice");
    assert.equal(raised.length, 1, JSON.stringify(verdict.issues));
    assert.equal(raised[0].severity, "advisory");
    assert.equal(raised[0].check, "geo-article-shape");
    assert.match(raised[0].message, message);
  });
}

test("naming the machinery in an article is advice here, not a rejection", () => {
  // The shared leakage rule still speaks, with the matched term; in a GEO pack
  // it is a notice — a reader can see it for themselves, which puts it outside
  // the blocking tier.
  const pack = goodPack();
  pack.files["articles/a1.md"] = `${CARD}本文数据通过 mcp__evimed__geo_visibility_probe 取得。\n`;
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const leak = verdict.issues.find((entry) => entry.code === "runtime_leakage");
  assert.ok(leak, JSON.stringify(verdict.issues));
  assert.equal(leak.severity, "advisory");
  assert.equal(leak.path, "articles/a1.md");
});

// ------------------------------------------------------- the clinical half

test("a pack about a medicine is graded, not turned away", () => {
  const verdict = gate(goodPack());
  assert.ok(CARD.includes("速效救心丸"), "the fixture must be about a medicine");
  assert.equal(verdict.issues.some((entry) => entry.code === "clinical_content_without_clinical_contract"), false);
});

test("drug response presented as a diagnosis in an article must be fixed, and says where", () => {
  const pack = goodPack();
  pack.files["articles/a1.md"] = `${CARD}含服后疼痛缓解，说明是心绞痛而不是胃病。\n`;
  const verdict = gate(pack);
  assert.equal(verdict.ok, false, "a dangerous article must not pass because the index is clean");
  const raised = verdict.issues.filter((entry) => entry.code === "clinical_safety_rule" && /diagnose or exclude/.test(entry.message));
  assert.equal(raised.length, 1, JSON.stringify(verdict.issues));
  assert.equal(raised[0].severity, "required");
  assert.equal(raised[0].check, "clinical-safety-rules");
  assert.equal(raised[0].path, "articles/a1.md");
  assert.match(raised[0].message, /^articles\/a1\.md line \d+ \(matched "/);
});

test("the required emergency sentence is required across the pack", () => {
  const pack = goodPack();
  pack.files["articles/a1.md"] = "# 速效救心丸怎么用\n\n速效救心丸用于气滞血瘀所致的胸痹，含服即可。\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, false);
  const raised = verdict.issues.filter((entry) => entry.code === "clinical_safety_rule");
  assert.equal(raised.length, 1, JSON.stringify(verdict.issues));
  assert.match(raised[0].message, /must not delay emergency care/);
});

test("a second article in another layer is read too, and one safe sentence anywhere satisfies the pack-wide rule", () => {
  const pack = goodPack();
  editIndex(pack, (index) => { index.articles.push(article({ id: "a2", layer: "popular", path: "articles/a2.md", recordPath: "records/a2.md" })); });
  pack.files["articles/a2.md"] = "# 心绞痛发作时怎么办\n\n速效救心丸用于气滞血瘀所致的胸痹。\n";
  pack.files["records/a2.md"] = "# 工作记录\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.deepEqual(verdict.metrics.geoArticlesByLayer, { card: 1, popular: 1 });
});

test("a work record is backstage: its sentences are not graded as an article's", () => {
  const pack = goodPack();
  pack.files["records/a1.md"] = "# 工作记录\n\n原稿写的是「含服后疼痛缓解，说明是心绞痛而不是胃病」，医学审核删去。\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
});

test("an article marked open is still delivered with its finding for a person to look at", () => {
  // The human stop: a finding the run cannot resolve is marked, not blurred.
  const pack = goodPack();
  editIndex(pack, (index) => { index.articles[0].safety = { status: "open", findings: ["含服后缓解的描述需药师确认"] }; });
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.equal(verdict.metrics.geoArticlesSafetyOpen, 1);
});

// ------------------------------------------- measurement is the platform's

test("a pack with no probe ledger is not a finding any more", () => {
  const verdict = gate(goodPack());
  assert.equal(verdict.issues.some((entry) => entry.code === "geo_measurement_absent"), false);
  assert.equal(verdict.metrics.geoProbeRounds, 0);
});

test("an ad-hoc probe ledger is still read honestly, as notices", () => {
  const pack = goodPack();
  pack.files["geo-probe-log.jsonl"] = [
    JSON.stringify(round()),
    JSON.stringify(round({ provider: "kimi", status: "busy", inDenominator: true })),
    JSON.stringify(round({ provider: "doubao", surface: { mode: "deep" } })),
    '{"question": broken',
  ].join("\n");
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const codes = verdict.issues.map((entry) => entry.code).sort();
  assert.deepEqual(codes, ["geo_failed_round_counted", "geo_probe_log_unreadable", "geo_surface_undeclared"]);
  assert.ok(verdict.issues.every((entry) => entry.severity === "advisory"));
  assert.equal(verdict.metrics.geoProbeRounds, 3);
  assert.deepEqual(verdict.metrics.geoPlatformsMeasured, ["deepseek", "doubao", "kimi"]);
});

test("the probe host in an article is noticed, and revision notes are exempt", () => {
  const leaking = goodPack();
  leaking.files["articles/a1.md"] = `${CARD}测量来自 43.248.117.249:9999。\n`;
  const verdict = gate(leaking);
  assert.equal(verdict.ok, true, "a new check ships as a notice");
  const raised = verdict.issues.filter((entry) => entry.code === "geo_probe_host_in_prose");
  assert.equal(raised.length, 1);
  assert.equal(raised[0].path, "articles/a1.md");

  const noted = goodPack();
  noted.files["revision-notes.md"] = "本轮改动：把 43.248.117.249:9999 换成内网地址后重测。\n";
  assert.deepEqual(gate(noted).issues, []);
});

// -------------------------------------------------- how the articles arrive

test("the gate is told which article files to read, and only paths inside the package", () => {
  const files = new Map([["articles.json", JSON.stringify({ articles: [
    article(),
    article({ id: "a2", path: "articles/a2.md", recordPath: "records/a2.md" }),
    article({ id: "evil", path: "../../.evimed-run/state.json", recordPath: "/etc/passwd" }),
    article({ id: "hidden", path: ".evimed-sources/x.md", recordPath: "records/.x.md" }),
  ] })]]);
  assert.deepEqual(contractCompanionPaths("geo-content-pack", files), ["articles/a1.md", "records/a1.md", "articles/a2.md", "records/a2.md"]);
  assert.deepEqual(contractCompanionPaths("geo-content-pack", new Map([["articles.json", "{not json"]])), []);
  assert.deepEqual(contractCompanionPaths("clinical-evidence-report", files), [], "a kind with no index names nothing");
});

test("the capability ships no second implementation of these rules", async () => {
  // The clinical run-side preflight was deleted rather than pinned, because a
  // mirror drifts and it drifted three times.
  const skill = await readFile(new URL("../../../capabilities/geo-content/SKILL.md", import.meta.url), "utf8");
  assert.ok(!/preflight\.py/.test(skill), "the skill must send the run to evimed_submit_deliverable, not to a local checker");
  assert.match(skill, /evimed_submit_deliverable/);
  assert.match(skill, /one implementation/);
  assert.match(skill, /never batch-probe/i, "measurement is the platform's, and the skill says so");
});
