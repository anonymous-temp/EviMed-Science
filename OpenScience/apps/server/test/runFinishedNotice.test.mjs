// The inbox told the researcher to go and look somewhere else.
//
// Both run-finished bodies were fixed strings — "研究结果已准备好" and "研究运行已
// 结束，请查看运行记录了解状态" — chosen only by `status === "succeeded"`. So a
// package the delivery gate refused, a run a stall timer killed, and a run that
// never started because a spend ceiling refused it all arrived under one
// sentence, and the one fact the control plane held that the reader did not
// (why) was the one thing the notice left out. The card also rendered no
// control, so a notice that named a run could not open it.
import assert from "node:assert/strict";
import test from "node:test";

import { ALL_ERROR_CODES, RUN_OUTCOME_KINDS, errorCodeMessage } from "@evimed/domain";
import { runFinishedInboxItem, runFinishedNotice, shanghaiDay } from "../src/notificationService.mjs";
import { automatedRun } from "../src/server.mjs";

test("a clean delivery says so and nothing more", () => {
  const notice = runFinishedNotice({ status: "succeeded", errorCode: null, verification: null, artifacts: ["report.md"] });

  assert.equal(notice.outcome, "delivered");
  assert.equal(notice.title, "研究已完成");
  assert.match(notice.body, /本次运行产出 1 个文件/);
});

test("a refused package and a platform stop do not share a sentence", () => {
  const gated = runFinishedNotice({ status: "failed", errorCode: "specialist_deliverable_not_accepted" });
  const stopped = runFinishedNotice({ status: "failed", errorCode: "verification_timeout" });

  assert.equal(gated.outcome, "gated");
  assert.equal(stopped.outcome, "stopped");
  assert.notEqual(gated.title, stopped.title);
  assert.notEqual(gated.body, stopped.body);
  // The distinction that matters to the reader: one is a statement about their
  // work, the other is a statement about the platform.
  assert.match(gated.title, /核验/);
  assert.match(stopped.title, /平台终止/);
});

test("an unverified delivery is reported as delivered-but-check-it, not as a failure", () => {
  const notice = runFinishedNotice({
    status: "succeeded",
    errorCode: null,
    verification: "unverified",
    unverifiedArtifacts: ["clinical-evidence-report.md", "citation-ledger.csv"],
    qualityNotices: ["检索日志与实际检索不吻合"],
  });

  assert.equal(notice.outcome, "qualified");
  assert.match(notice.title, /待你复核/);
  assert.match(notice.body, /依据/, "the body names where to check");
  // The files are the researcher's work whatever the verdict; a notice that
  // omits them reads as though the run produced nothing.
  assert.match(notice.body, /本次运行产出 2 个文件/);
  // A notice's own sentence is never the body: it stays on the run.
  assert.doesNotMatch(notice.body, /检索日志与实际检索不吻合/);
});

test("the body is counts and titles, and never a validator's sentence", () => {
  const english = "claims[52].claim numeric fact 6 is not present in its direct support. Quote the passage that states it.";
  const notice = runFinishedNotice({
    status: "succeeded",
    verification: "unverified",
    artifacts: ["deliverables/review/clinical-evidence-report.md"],
    qualityNotices: [
      { code: "clinical_evidence_issue", check: "clinical-safety-rules", severity: "safety", text: "SAFETY — the practical section tells a chest-pain patient to wait" },
      { code: "clinical_evidence_issue", check: "claim-quote-verbatim", severity: "must-fix", text: "MUST FIX — claims[3].supportQuote was not found in its source" },
      { code: "clinical_evidence_issue", check: "claim-quote-verbatim", severity: "must-fix", text: "MUST FIX — claims[9].supportQuote was not found in its source" },
      { code: "clinical_evidence_notice", check: "claim-numeric-support", severity: "advice", text: english },
      "MUST FIX — a legacy sentence from an older ledger",
    ],
  });
  assert.equal(notice.body.split("\n")[0], "已交付。4 项自证未通过，其中 1 项涉及临床安全；引用前请在报告的「依据」里核对带 ⚠ 的结论。");
  assert.match(notice.body, /请先核对：命中临床安全规则，请核对；引文在所引来源中找不到原句（2 项）/);
  assert.doesNotMatch(notice.body, /[a-z]{5,}/, `an English sentence reached the body: ${notice.body}`);
  assert.equal(notice.severity, "safety", "clinical safety is the one class that interrupts");
  assert.deepEqual(notice.counts, { safety: 1, mustFix: 3, advice: 1 });
  assert.equal(runFinishedNotice({ status: "succeeded", verification: null, artifacts: [] }).severity, "info");
  assert.equal(runFinishedNotice({ status: "failed", errorCode: "specialist_deliverable_not_accepted" }).severity, "attention");
});

test("a run refused before it started never claims files exist", () => {
  const notice = runFinishedNotice({ status: "failed", errorCode: "credits_exhausted" });

  assert.equal(notice.outcome, "capped");
  assert.doesNotMatch(notice.body, /个文件/);
  assert.equal(notice.body, errorCodeMessage("credits_exhausted"));
});

test("every outcome class has its own title, and the walk proves it walked", () => {
  const titles = new Map();
  for (const kind of RUN_OUTCOME_KINDS) {
    // Reach each class through a code that really has it, so this cannot pass
    // by asserting over a table that no production code maps onto.
    // `unknown` is the one class no registered code can reach — that is the
    // registry being complete, which is a property worth stating rather than
    // working around. It is reachable only by a code from a future build.
    const code = kind === "delivered" ? null
      : kind === "unknown" ? "a_code_this_build_does_not_know"
        : ALL_ERROR_CODES.find((candidate) => runFinishedNotice({ status: "failed", errorCode: candidate }).outcome === kind);
    if (kind !== "delivered" && kind !== "qualified") {
      assert.ok(code, `no error code in the registry classifies as ${kind}`);
    }
    if (kind === "unknown") {
      assert.equal(ALL_ERROR_CODES.filter((candidate) => runFinishedNotice({ status: "failed", errorCode: candidate }).outcome === "unknown").length, 0,
        "a registered code classifies as unknown, which means the registry has a hole");
    }
    const notice = kind === "qualified"
      ? runFinishedNotice({ status: "succeeded", verification: "unverified" })
      : runFinishedNotice({ status: kind === "delivered" ? "succeeded" : "failed", errorCode: code ?? null });
    assert.equal(notice.outcome, kind);
    assert.ok(notice.title.trim(), `${kind} has no title`);
    titles.set(kind, notice.title);
  }
  assert.equal(titles.size, RUN_OUTCOME_KINDS.length);
  // A class that shares another's title is a class the reader cannot tell apart,
  // which is the defect this replaced.
  assert.equal(new Set(titles.values()).size, RUN_OUTCOME_KINDS.length, `two classes share a title: ${JSON.stringify([...titles])}`);
});

test("every code that can end a run produces a body with a real sentence", () => {
  const empty = [];
  for (const code of ALL_ERROR_CODES) {
    const notice = runFinishedNotice({ status: "failed", errorCode: code });
    if (!notice.body.trim() || !/[一-鿿]/.test(notice.body)) empty.push(code);
  }
  assert.deepEqual(empty, [], `codes with no Chinese sentence: ${empty.slice(0, 10).join(", ")}`);
  assert.ok(ALL_ERROR_CODES.length > 250, `the registry walked only ${ALL_ERROR_CODES.length} codes`);
});

/* ------------------------------------------------ grouping and silence (C1) */

const finished = (id, finishedAt, extra = {}) => ({
  id, status: "succeeded", errorCode: null, verification: null, artifacts: ["deliverables/r/report.md"],
  finishedAt, startedAt: finishedAt, question: `问题 ${id}`, ...extra,
});

test("a day's routine completions in a project are one item that says how many", () => {
  const project = { id: "default" };
  const peers = [
    finished("run-a", "2026-09-18T01:00:00.000Z", { verification: "unverified", title: "二甲双胍与乳酸酸中毒风险",
      qualityNotices: [{ code: "clinical_evidence_issue", check: "claim-quote-verbatim", severity: "must-fix", text: "MUST FIX — x" }] }),
    finished("run-b", "2026-09-18T02:00:00.000Z"),
    // The day before, in China: 23:30 on the 17th.
    finished("run-old", "2026-09-17T15:30:00.000Z"),
    // A safety finding and a failure stand alone; they are not "完成".
    finished("run-safety", "2026-09-18T02:30:00.000Z", { verification: "unverified",
      qualityNotices: [{ code: "clinical_evidence_issue", check: "clinical-safety-rules", severity: "safety", text: "SAFETY — x" }] }),
    { ...finished("run-failed", "2026-09-18T02:40:00.000Z"), status: "failed", errorCode: "verification_timeout" },
    { ...finished("run-live", "2026-09-18T02:50:00.000Z"), status: "running" },
  ];
  const item = runFinishedInboxItem(project, finished("run-c", "2026-09-18T03:00:00.000Z", { title: "阿司匹林一级预防" }), { peers });
  assert.equal(item.groupKey, "run-finished:default:2026-09-18");
  assert.equal(item.title, "9月18日完成 3 项研究");
  assert.equal(item.idempotencyKey, "run-finished:run-c", "each run is its own event inside the group");
  assert.deepEqual(item.source, { type: "run", id: "run-c" }, "the item opens the latest run");
  assert.equal(item.severity, "attention", "one of them is waiting for review");
  assert.equal(item.silent, false);
  const lines = item.body.split("\n");
  assert.equal(lines[0], "其中 1 项待你复核，2 项已完成。");
  assert.equal(lines[1], "待复核的研究共有 1 项自证未通过；引用前请在报告的「依据」里核对带 ⚠ 的结论。");
  assert.deepEqual(lines.slice(2), [
    "· 阿司匹林一级预防：已完成",
    "· 问题 run-b：已完成",
    "· 二甲双胍与乳酸酸中毒风险：待复核，1 项自证未通过",
  ]);
  assert.doesNotMatch(item.body, /MUST FIX|SAFETY|[a-z]{5,}/, "counts and titles only");
});

test("the day is China's, a lone completion keeps its own words, and a long day is summarised", () => {
  const project = { id: "p1" };
  // 00:30 on the 19th in Shanghai is still the 18th in UTC.
  assert.equal(shanghaiDay("2026-09-18T16:30:00.000Z"), "2026-09-19");
  assert.equal(shanghaiDay("2026-09-18T15:59:59.999Z"), "2026-09-18");
  assert.equal(shanghaiDay("not a time"), null);
  const lone = runFinishedInboxItem(project, finished("run-1", "2026-09-18T16:30:00.000Z"), {
    peers: [finished("run-0", "2026-09-18T15:00:00.000Z")],
  });
  assert.equal(lone.groupKey, "run-finished:p1:2026-09-19");
  assert.equal(lone.title, "研究已完成", "a group of one is the run's own notice");
  assert.equal(lone.body, runFinishedNotice(finished("run-1", "2026-09-18T16:30:00.000Z")).body);
  const many = runFinishedInboxItem(project, finished("run-9", "2026-09-18T09:00:00.000Z"), {
    peers: Array.from({ length: 6 }, (_unused, index) => finished(`run-${index}`, `2026-09-18T0${index}:00:00.000Z`)),
  });
  assert.equal(many.title, "9月18日完成 7 项研究");
  assert.equal(many.body.split("\n").at(-1), "另有 4 项，见运行记录。");
  assert.equal(many.severity, "info");
});

test("a safety finding or a failure is never folded, and automated work is recorded silently in its own group", () => {
  const project = { id: "default" };
  const safety = runFinishedInboxItem(project, finished("run-s", "2026-09-18T03:00:00.000Z", { verification: "unverified",
    qualityNotices: [{ code: "clinical_evidence_issue", check: "clinical-safety-rules", severity: "safety", text: "SAFETY — x" }] }),
  { peers: [finished("run-a", "2026-09-18T01:00:00.000Z")] });
  assert.equal(safety.groupKey, undefined);
  assert.equal(safety.severity, "safety");
  assert.equal(safety.title, "研究已交付，待你复核");
  const failed = runFinishedInboxItem(project, { ...finished("run-f", "2026-09-18T03:00:00.000Z"), status: "failed", errorCode: "verification_timeout" });
  assert.equal(failed.groupKey, undefined);
  assert.equal(failed.severity, "attention");
  const quiet = runFinishedInboxItem(project, finished("run-e", "2026-09-18T03:00:00.000Z", { automated: true }), { silent: true });
  assert.equal(quiet.silent, true);
  assert.equal(quiet.groupKey, "run-finished:default:2026-09-18:silent", "machine runs never fold into, or resurface, a person's item");
});

test("a run is automated when a harness said so, or when autopilot started it", () => {
  assert.equal(automatedRun({ automated: true }), true);
  assert.equal(automatedRun({ effectiveRouteReason: "autopilot:literature-sentinel" }), true);
  assert.equal(automatedRun({ dispatchId: `episode-${"a".repeat(32)}-v1` }), true, "an independent verification");
  assert.equal(automatedRun({ effectiveRouteReason: "unrouted:open-domain", dispatchId: "dispatch-1" }), false);
  assert.equal(automatedRun({ automated: "yes" }), false, "only the boolean the dispatch validated counts");
});
