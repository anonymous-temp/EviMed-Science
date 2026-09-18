import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CLINICAL_CHECK_TIERS } from "../src/clinicalEvidence.mjs";
import {
  GATE_CHECKS_TITLED_BY_RULE,
  GATE_CHECK_IDS,
  GATE_CHECK_TITLES_ZH,
  GATE_CODE_TITLES_ZH,
  GATE_FALLBACK_TITLES_ZH,
  SOCKET_TOOL_ERROR_CODES,
  describeGateIssue,
  gateIssueRefs,
  summarizeGateNotices,
} from "../index.mjs";

const CJK = /[㐀-鿿]/;

/**
 * @param {string} title
 * @param {string} where
 */
function assertReaderTitle(title, where) {
  assert.ok(typeof title === "string" && CJK.test(title), `${where} has no Chinese title: ${JSON.stringify(title)}`);
  assert.ok([...title].length <= 20, `${where}'s title is longer than twenty characters: ${title}`);
  assert.doesNotMatch(title, /[a-z]{4,}/, `${where}'s title carries an English word: ${title}`);
}

test("every check id the domain can raise has a Chinese title of its own", () => {
  // The walk has to prove it walked: an emptied list would pass forever.
  assert.ok(GATE_CHECK_IDS.length >= 70, `only ${GATE_CHECK_IDS.length} check ids — the registry did not load`);
  for (const id of ["claim-quote-verbatim", "claim-numeric-support", "clinical-safety-rules", "appraisal-certainty-arithmetic", "dataset-number-provenance"]) {
    assert.ok(GATE_CHECK_IDS.includes(id), `${id} is not registered, so this walk no longer covers it`);
  }
  for (const id of GATE_CHECK_IDS) {
    assert.ok(Object.hasOwn(GATE_CHECK_TITLES_ZH, id), `check "${id}" has no title; add one to GATE_CHECK_TITLES_ZH`);
    assertReaderTitle(GATE_CHECK_TITLES_ZH[id], `check "${id}"`);
    const described = describeGateIssue({ code: "whatever_code", check: id, severity: "advisory", message: "an English repair instruction" });
    assert.equal(described.title, GATE_CHECK_TITLES_ZH[id], `a finding of "${id}" is titled by its check`);
  }
  // No title for a check that no longer exists: a renamed check must not leave
  // a dead entry that reads as coverage. One named exception, and only while it
  // lasts: the pharmacist-authored cautions are registered and raised on the
  // medical-assets branch (S5, 2026-09-18), and their title is carried here
  // ahead of that merge so the walk above passes the moment they arrive. Once
  // registered, the id is held to the rule like every other.
  const awaitingRegistration = ["clinical-safety-cautions"].filter((id) => !GATE_CHECK_IDS.includes(id));
  for (const id of Object.keys(GATE_CHECK_TITLES_ZH)) {
    if (awaitingRegistration.includes(id)) continue;
    assert.ok(GATE_CHECK_IDS.includes(id), `GATE_CHECK_TITLES_ZH titles "${id}", which no module raises`);
  }
  assert.ok(Object.hasOwn(GATE_CHECK_TITLES_ZH, "clinical-safety-cautions"), "the cautions' check has a title of its own");
  assertReaderTitle(GATE_CHECK_TITLES_ZH["clinical-safety-cautions"], 'check "clinical-safety-cautions"');
});

test("every code a contract module raises without a check, and every run-side refusal, has a title", async () => {
  /** Codes read out of the raising calls, both call shapes the modules use. */
  const raised = new Set();
  let walked = 0;
  for (const name of ["contractRegistry.mjs", "manuscriptContract.mjs", "researchTopicContract.mjs"]) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.ok(source.length > 0, `${name} is empty — the walk read nothing`);
    for (const match of source.matchAll(/\b(?:issue|notice|advisory)\(\s*['"]([a-z][a-z0-9_]+)['"]/g)) {
      walked += 1;
      raised.add(match[1]);
    }
    for (const match of source.matchAll(/code: ['"]([a-z][a-z0-9_]+)['"]/g)) {
      walked += 1;
      raised.add(match[1]);
    }
  }
  assert.ok(walked >= 30 && raised.size >= 25, `only ${raised.size} codes found in ${walked} raising calls — the scan did not read the modules`);
  for (const code of ["manuscript_claim_unresolved", "deliverable_rejected", "geo_probe_host_in_prose", "topic_portfolio_invalid"]) {
    assert.ok(raised.has(code), `the scan no longer sees "${code}"`);
  }
  for (const code of raised) {
    assert.ok(Object.hasOwn(GATE_CODE_TITLES_ZH, code), `"${code}" is raised and has no title in GATE_CODE_TITLES_ZH`);
    assertReaderTitle(GATE_CODE_TITLES_ZH[code], `code "${code}"`);
  }
  for (const code of SOCKET_TOOL_ERROR_CODES) {
    assert.ok(Object.hasOwn(GATE_CODE_TITLES_ZH, code), `run-side refusal "${code}" has no title`);
  }
  for (const [code, title] of Object.entries(GATE_CODE_TITLES_ZH)) assertReaderTitle(title, `code "${code}"`);
  for (const [severity, title] of Object.entries(GATE_FALLBACK_TITLES_ZH)) assertReaderTitle(title, `the ${severity} fallback`);
});

test("a finding is described by its identity and parameters, never by its sentence", () => {
  const numeric = describeGateIssue({
    code: "clinical_evidence_notice",
    check: "claim-numeric-support",
    severity: "advisory",
    message: "claims[52].claim numeric fact 6 is not present in its direct support. Quote the passage that states it.",
  });
  assert.deepEqual(numeric, {
    code: "clinical_evidence_notice",
    check: "claim-numeric-support",
    severity: "advice",
    title: "数值未出现在引文中",
    detail: "证据矩阵第 53 条主张",
  });

  const quote = describeGateIssue({ code: "specialist_evidence_traceability_failed", check: "claim-quote-verbatim", severity: "required", claimId: "CLM-007", file: "deliverables/review/clinical-evidence-report.md", line: 41, text: "MUST FIX — …" });
  assert.equal(quote.severity, "must-fix");
  assert.equal(quote.title, "引文在所引来源中找不到原句");
  assert.equal(quote.detail, "主张 CLM-007，clinical-evidence-report.md 第 41 行");

  // A safety-tier check is safety for the reader, whatever the run was told.
  for (const [check, tier] of Object.entries(CLINICAL_CHECK_TIERS)) {
    if (tier !== "safety") continue;
    assert.equal(describeGateIssue({ code: "x", check, severity: "advisory" }).severity, "safety", check);
  }

  // Unknown identity: the fallback by severity, and the English text is not
  // promoted to a detail.
  const unknown = describeGateIssue({ code: "legacy_notice", severity: "advice", detail: "The report was replaced with the write tool 2 time(s)" });
  assert.equal(unknown.title, "另有技术提示");
  assert.equal(unknown.detail, undefined, "an English sentence is never shown as a detail");
  // The platform's own Chinese sentence is.
  assert.equal(describeGateIssue({ code: "memory_pending", detail: "记忆已记录但暂缓生效 2 条。" }).detail, "记忆已记录但暂缓生效 2 条。");
});

test("identifiers are read from a finding's text as formats only", () => {
  assert.deepEqual(gateIssueRefs("claims[0].supportQuote is missing"), { claimIndex: 0 });
  assert.deepEqual(gateIssueRefs("Report claim reference CLM-012 does not resolve"), { claimId: "CLM-012" });
  assert.deepEqual(gateIssueRefs("Report line 17 numeric facts 3 have no reference"), { line: 17 });
  assert.deepEqual(gateIssueRefs("报告正文第 8 行以条款级方式引用"), { line: 8 });
  assert.deepEqual(gateIssueRefs("no identifiers at all"), {});
});

test("a summary is counts and titles, most urgent first", () => {
  const notices = [
    describeGateIssue({ code: "a", check: "claim-numeric-support", severity: "advisory" }),
    describeGateIssue({ code: "a", check: "claim-numeric-support", severity: "advisory" }),
    describeGateIssue({ code: "b", check: "claim-quote-verbatim", severity: "required" }),
    describeGateIssue({ code: "c", check: "clinical-safety-rules", severity: "required" }),
  ];
  const summary = summarizeGateNotices(notices);
  assert.equal(summary.safety, 1);
  assert.equal(summary.mustFix, 1);
  assert.equal(summary.advice, 2);
  assert.deepEqual(summary.groups.map((group) => [group.severity, group.title, group.count]), [
    ["safety", "命中临床安全规则，请核对", 1],
    ["must-fix", "引文在所引来源中找不到原句", 1],
    ["advice", "数值未出现在引文中", 2],
  ]);
});

test("the codes delegation that does not wait and the claim tools refuse with are titled too", () => {
  // Raised by the socket (2026-09-18); listed here by name because this
  // branch's registry does not carry them yet, and a refusal without a title
  // reaches a reader as 「另有技术提示」.
  for (const code of [
    "claim_matrix_unsupported", "claim_invalid", "matrix_unreadable", "report_missing",
    "deliverable_already_accepted", "deliverable_already_delegated", "deliverable_failed",
    "delegation_concurrency_limit", "delegation_handle_unknown", "children_running",
    "plan_invalid", "capability_unknown", "contract_kind_unknown", "subagent_cancelled",
  ]) {
    assert.ok(Object.hasOwn(GATE_CODE_TITLES_ZH, code), `"${code}" has no title`);
    assert.notEqual(describeGateIssue({ code, severity: "required" }).title, GATE_FALLBACK_TITLES_ZH["must-fix"], code);
  }
});

test("a pharmacist-authored caution is a safety notice titled by its own rule", () => {
  assert.deepEqual([...GATE_CHECKS_TITLED_BY_RULE], ["clinical-safety-cautions"]);
  // As the domain's validator raises it: advisory to the run, a rule id, an
  // English message — and a SAFETY notice to the reader, titled by the check
  // when no rule title came with it.
  const bare = describeGateIssue({ code: "clinical_safety_caution", check: "clinical-safety-cautions", severity: "advisory", message: "The report discusses aspirin for primary prevention but never mentions bleeding." });
  assert.equal(bare.severity, "safety");
  assert.equal(bare.title, GATE_CHECK_TITLES_ZH["clinical-safety-cautions"]);
  assert.equal(bare.detail, undefined, "an English message is never the detail");
  // With the rule's own title — which carries a colon of its own, and English
  // drug names, and is longer than a table title may be.
  const titled = describeGateIssue({
    code: "clinical_safety_caution", check: "clinical-safety-cautions", severity: "safety",
    title: "强效 CYP3A4 抑制剂合用辛伐/洛伐他汀：横纹肌溶解", detail: "报告讨论辛伐他汀与克拉霉素同用，但没有提到横纹肌溶解。",
  });
  assert.equal(titled.title, "强效 CYP3A4 抑制剂合用辛伐/洛伐他汀：横纹肌溶解");
  assert.equal(titled.detail, "报告讨论辛伐他汀与克拉霉素同用，但没有提到横纹肌溶解。");
  // A title is honoured only where the rule is the title: anywhere else, and
  // for anything that is not one line of Chinese, the table decides.
  assert.equal(describeGateIssue({ code: "x", check: "claim-quote-verbatim", title: "随便写的标题" }).title, GATE_CHECK_TITLES_ZH["claim-quote-verbatim"]);
  assert.equal(describeGateIssue({ code: "x", check: "clinical-safety-cautions", title: "Bleeding risk" }).title, GATE_CHECK_TITLES_ZH["clinical-safety-cautions"]);
  assert.equal(describeGateIssue({ code: "x", check: "clinical-safety-cautions", title: "第一行\n第二行" }).title, GATE_CHECK_TITLES_ZH["clinical-safety-cautions"]);
  assert.equal(describeGateIssue({ code: "clinical_safety_caution", severity: "advisory" }).title, GATE_CODE_TITLES_ZH.clinical_safety_caution);
});
