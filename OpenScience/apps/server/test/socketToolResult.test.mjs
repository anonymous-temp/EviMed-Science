import assert from "node:assert/strict";
import test from "node:test";
import { delegatedChildrenOf, socketToolResult } from "../src/dshRuntimeAdapter.mjs";
import { kernelToolText } from "./helpers/kernelToolText.mjs";

// Verbatim from a production transcript, 2026-09-16 (project
// eval-memory-ablation-v7-545d9b64, run run_fb43cb32590bf489f199e9135f98a66e).
const LIVE_OK = 'ok\n{\n  "verdicts": [\n    {\n      "claimId": "CLM-095",\n      "verdict": "stands",\n      "grounds": "placeholder"\n    }\n  ],\n  "blocking": false\n}';
const LIVE_FAILED = "failed: specialist_evidence_traceability_failed\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S01 is not cited by the report.\n- (required) specialist_evidence_traceability_failed Evidence matrix claim CLM-S02 is not cited by the report.";
const LIVE_DELEGATE_HEAD = 'ok\n{\n  "deliverableId": "mimic-sepsis-prognosis-scoping",\n  "childSessionId": "8765be77-2ac4-4655-bd9a-7c16c266a70e",\n  "report": {\n    "deliverableId": "mimic-sepsis-prognosis-scoping",\n    "submitted": true\n  }\n}';

// An accepted submission carrying its review's findings as issue lines after
// the data — production, 2026-09-22 (project review-ai-chronic-home). The data
// block is trimmed to three fields; the two issue lines are verbatim. Read as
// one JSON body, the data became a string and the findings were lost.
const LIVE_OK_WITH_REVIEW = "ok\n{\n  \"deliverableId\": \"ai-chronic-home-pharmacy-review\",\n  \"contractKind\": \"clinical-evidence-report\",\n  \"label\": \"临床证据综述\"\n}\n- (required) review_contradicted 结论 CLM-073 与独立审查者查到的证据相矛盾：同一实体(随机风险差的95%CI)在包内两处不能同真:报告结果节P47写\"风险差 7.3 个百分点(95%CI 2.9 至 11.7…;HR 4.40,95%CI 1.66 至 11.66)\",而报告摘要P9写\"新发心房颤动…9.6%(21例)与 2.3%(5例)\"所省略的同一区间;矩阵CLM-073 supportQuote 与报告P47一致,取 11.7。来源 PMID:41569211(摘要级)逐字为 \"risk difference: 7.3 percentage points; 95% CI: 2.9-11.7 percentage points; P = 0.001; HR: 4.40; 95% CI: 1.66-11.66\",即\"个百分点\"区间的上界是 11.\n- (advisory) review_weakened 结论 CLM-062 证据强度弱于结论写法：报告摘要P11与结论P183 + 矩阵CLM-062(synthesized, confidence=moderate)。其被引来源的原文只支持较窄的结论:PMID:42520248 摘要逐字为 \"No statistically significant pooled effects were observed for glycated hemoglobin, blood pressure, mortality, hospitalization, or readmission…\" 与 \"Certainty was low or very low for all 7 GRADE-assessed outcomes\",即该来源自身对七个结局的确定性均为低或极低,而包内的整体判定写为\"按 GRA";

test("an accepted result keeps the issue lines that follow its data", () => {
  const read = /** @type {any} */ (socketToolResult(LIVE_OK_WITH_REVIEW));
  assert.equal(read.ok, true);
  assert.equal(read.data.deliverableId, "ai-chronic-home-pharmacy-review");
  assert.deepEqual(read.issues.map((/** @type {any} */ issue) => [issue.severity, issue.code]), [["required", "review_contradicted"], ["advisory", "review_weakened"]]);
});

test("a socket tool result is read in the form the kernel actually records", () => {
  assert.deepEqual(socketToolResult(LIVE_OK), { ok: true, data: { verdicts: [{ claimId: "CLM-095", verdict: "stands", grounds: "placeholder" }], blocking: false } });
  assert.equal(socketToolResult(LIVE_DELEGATE_HEAD).data.childSessionId, "8765be77-2ac4-4655-bd9a-7c16c266a70e");
  assert.deepEqual(socketToolResult(LIVE_FAILED), {
    ok: false,
    code: "specialist_evidence_traceability_failed",
    issues: [
      { severity: "required", code: "specialist_evidence_traceability_failed", message: "Evidence matrix claim CLM-S01 is not cited by the report." },
      { severity: "required", code: "specialist_evidence_traceability_failed", message: "Evidence matrix claim CLM-S02 is not cited by the report." },
    ],
  });
});

test("the test helper renders exactly what the live samples hold", () => {
  // If this fails, the helper has drifted from the wire and every fixture
  // built with it proves nothing about a live run.
  assert.equal(kernelToolText({ ok: true, data: JSON.parse(LIVE_OK.slice(3)) }), LIVE_OK);
  assert.equal(kernelToolText({ ok: false, code: "specialist_evidence_traceability_failed", issues: socketToolResult(LIVE_FAILED).issues }), LIVE_FAILED);
});

test("bare {ok} JSON still reads, and anything else is not a socket result", () => {
  assert.deepEqual(socketToolResult('{"ok":true,"data":{"childSessionId":"c1"}}'), { ok: true, data: { childSessionId: "c1" } });
  assert.equal(socketToolResult('{"status":"success","data":{}}'), null, "an MCP result has no ok field");
  assert.equal(socketToolResult("Error: {\"status\":\"error\"}"), null);
  assert.equal(socketToolResult("okay then"), null);
  assert.equal(socketToolResult(undefined), null);
  assert.deepEqual(socketToolResult("ok"), { ok: true, data: null });
});

test("a delegation's receipts name its children: the delegate's own, and every child a collecting call reports", () => {
  // The non-blocking delegate (C6, 2026-09-18) answers before the child works.
  const started = kernelToolText({ ok: true, data: { handle: "h-1", deliverableId: "review", childSessionId: "s-child", status: "started" } });
  assert.deepEqual(delegatedChildrenOf("evimed_delegate", started), [{ childSessionId: "s-child", deliverableId: "review" }]);
  // The blocking delegate this replaced carried the same field; a history
  // written before the change still reads.
  assert.deepEqual(delegatedChildrenOf("evimed_delegate", LIVE_DELEGATE_HEAD), [
    { childSessionId: "8765be77-2ac4-4655-bd9a-7c16c266a70e", deliverableId: "mimic-sepsis-prognosis-scoping" },
  ]);
  const collected = kernelToolText({ ok: true, data: { results: [
    { handle: "h-1", deliverableId: "review", childSessionId: "s-retry", status: "completed", submission: { attempts: 2, verdict: "issues" } },
    { handle: "h-2", deliverableId: "matrix", childSessionId: "s-other", status: "running" },
    { handle: "h-3", deliverableId: "broken", childSessionId: "has spaces", status: "failed" },
    { handle: "h-4", deliverableId: "twice", childSessionId: "s-other", status: "running" },
  ] } });
  assert.deepEqual(delegatedChildrenOf("evimed_await", collected), [
    { childSessionId: "s-retry", deliverableId: "review" },
    { childSessionId: "s-other", deliverableId: "matrix" },
  ], "a malformed id is not a child, and one child is named once");
  assert.deepEqual(delegatedChildrenOf("evimed_delegate", LIVE_FAILED), [], "a refused delegation started nothing");
  assert.deepEqual(delegatedChildrenOf("evimed_plan", started), [], "only the two delegation tools are read");
  assert.deepEqual(delegatedChildrenOf("evimed_await", "not a result"), []);
});
