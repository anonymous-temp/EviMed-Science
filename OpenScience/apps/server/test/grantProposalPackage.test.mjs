// The grant capability existed as a curated skill and nothing else: no manifest,
// so the orchestrator could not delegate to it, and no contract, so whatever it
// wrote was graded by nobody.
//
// The contract grades the two things a reviewer cannot recover for themselves.
// A proposal built against requirements the funder never stated is the common
// failure, and it is invisible in the prose — a fabricated rule reads exactly
// like a real one. What separates them is whether the run can show the words it
// read the rule out of.
import assert from "node:assert/strict";
import test from "node:test";

import { runGate } from "@evimed/domain";

const EXPECTED = [
  "call-requirements.json", "specific-aims.md", "proposal-outline.md",
  "milestones.csv", "grant-audit.md", "citation-ledger.csv", "delivery-summary.md",
].map((path) => ({ path, required: true }));

function goodPack() {
  const requirements = {
    requirements: [
      { id: "R-01", kind: "review-criterion", requires: "创新性单独评分，占 30%",
        sourceQuote: "评审指标：科学价值 30%、创新性 30%、可行性 25%、团队 15%" },
      { id: "R-02", kind: "page-limit", requires: "正文不超过 8 页",
        sourceQuote: "申请书正文部分不超过 8 页（A4，五号宋体）" },
    ],
  };
  return {
    files: {
      "call-requirements.json": JSON.stringify(requirements),
      "specific-aims.md": "# 具体目标\n\n目标一：建立可复算的用药安全信号基线。\n",
      "proposal-outline.md": "# 研究方案\n\n人群、数据、方法与样本量依据见下。\n",
      "milestones.csv": "milestone,date,outcome,owner\n基线数据集冻结,2027-03-31,冻结版本号与记录数,课题组\n中期分析完成,2027-09-30,信号清单与置信区间,统计岗\n",
      "grant-audit.md": "# 评审要点自查\n\n- R-01 创新性：见《研究方案》第二节。\n- R-02 页数：正文 7 页，符合。\n",
      "citation-ledger.csv": "id,title,url\nPMID:18254051,Cochrane review,https://pubmed.ncbi.nlm.nih.gov/18254051/\n",
      "delivery-summary.md": "# 交付说明\n\n本次交付具体目标、方案、里程碑与自查各一份。\n",
    },
  };
}

const gate = (pack) => runGate({
  contractKind: "grant-proposal-package",
  files: new Map(Object.entries(pack.files)),
  expectedOutputs: EXPECTED,
});

test("the reference package is accepted with nothing to say about it", () => {
  const verdict = gate(goodPack());
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.metrics.grantRequirements, 2);
  assert.equal(verdict.metrics.grantMilestones, 2);
});

test("a milestone with no date is rejected, because it is a plan item", () => {
  const pack = goodPack();
  pack.files["milestones.csv"] = "milestone,date,outcome,owner\n中期分析完成,,信号清单,统计岗\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((entry) => /no date/.test(entry.message)));
});

test("a milestones table missing a declared column is rejected", () => {
  const pack = goodPack();
  pack.files["milestones.csv"] = "milestone,date,owner\n冻结,2027-03-31,课题组\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((entry) => /no "outcome" column/.test(entry.message)));
});

test("a requirement with no quote is reported — a fabricated rule has no words to show", () => {
  // The whole point of the field. A rule invented or carried over from another
  // call reads exactly like a real one in prose; what it cannot do is produce
  // the sentence it came from.
  const pack = goodPack();
  const parsed = JSON.parse(pack.files["call-requirements.json"]);
  delete parsed.requirements[0].sourceQuote;
  pack.files["call-requirements.json"] = JSON.stringify(parsed);
  const verdict = gate(pack);
  assert.equal(verdict.ok, true, "new checks ship as notices");
  const raised = verdict.issues.filter((entry) => entry.code === "grant_requirement_unquoted");
  assert.equal(raised.length, 1);
  assert.equal(raised[0].severity, "advisory");
  assert.match(raised[0].message, /1 of 2/);
});

test("a requirement the audit skipped is reported by id", () => {
  // An audit covering the three easy criteria reads exactly like one covering
  // all nine, so coverage is checked by id rather than by reading the prose.
  const pack = goodPack();
  pack.files["grant-audit.md"] = "# 评审要点自查\n\n- R-01 创新性：见《研究方案》第二节。\n";
  const verdict = gate(pack);
  assert.equal(verdict.ok, true);
  const raised = verdict.issues.filter((entry) => entry.code === "grant_requirement_unaudited");
  assert.equal(raised.length, 1);
  assert.match(raised[0].message, /R-02/);
});

test("a package with no requirements list raises neither notice, and still blocks on the file", () => {
  // Absence must not read as compliance: with no requirements there is nothing
  // to quote or audit, so the notices stay silent — and the missing required
  // file is what actually stops delivery.
  const pack = goodPack();
  delete pack.files["call-requirements.json"];
  const verdict = gate(pack);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some((entry) => entry.code === "required_output_missing"));
  assert.equal(verdict.issues.some((entry) => entry.code.startsWith("grant_requirement_")), false);
});

test("runtime leakage in proposal prose is blocked, and revision notes are exempt", () => {
  const leaking = goodPack();
  leaking.files["proposal-outline.md"] = "# 研究方案\n\n本轮通过 evimed_literature_search 检索得到。\n";
  assert.equal(gate(leaking).ok, false);

  const noted = goodPack();
  noted.files["revision-notes.md"] = "本轮改动：改用 evimed_literature_search 重检了一遍。\n";
  assert.deepEqual(gate(noted).issues, []);
});
