// What the inbox says when a run finishes (plan 2026-09-23 §5.8).
//
// The title is the research's own name and one status word — 已完成 / 待核对 /
// 未完成 / 已停止 — and the body says the result and where to look. It used to
// say 「研究已交付」 beside 「研究已完成」, a distinction only the delivery gate
// could read, and bodies like 「研究结果已准备好，报告与文件都在这条对话里。本次
// 运行产出 6 个文件，仍在工作区里，可以直接打开。」 — about the workspace, not the
// result. Clinical safety is the one exception: its title states the fact.
//
// Before that, both bodies were fixed strings chosen only by
// `status === "succeeded"`, so a package the gate refused, a run a stall timer
// killed and a run a spend ceiling never started arrived under one sentence;
// the reason is still the body of a run that did not finish.
import assert from "node:assert/strict";
import test from "node:test";

import { ALL_ERROR_CODES, RUN_OUTCOME_KINDS, errorCodeMessage } from "@evimed/domain";
import {
  RUN_NOTICE_STATUS_WORDS, runFinishedInboxItem, runFinishedNotice, runFinishedNotifies, runFinishedReachesInbox, shanghaiDay,
} from "../src/notificationService.mjs";
import { automatedRun } from "../src/server.mjs";

const safetyNotice = { code: "clinical_evidence_issue", check: "clinical-safety-rules", severity: "safety", text: "SAFETY — the practical section tells a chest-pain patient to wait" };
const quoteNotice = (index) => ({ code: "clinical_evidence_issue", check: "claim-quote-verbatim", severity: "must-fix", text: `MUST FIX — claims[${index}].supportQuote was not found in its source` });

test("a clean completion is the research's name and 已完成, and the body says where to look", () => {
  const notice = runFinishedNotice({
    status: "succeeded", errorCode: null, verification: null, title: "中医药治疗儿童疳证的 Meta 分析检索",
    artifacts: Array.from({ length: 6 }, (_, index) => `deliverables/meta/file-${index}.md`),
  });
  assert.equal(notice.outcome, "delivered");
  assert.equal(notice.status, "已完成");
  assert.equal(notice.title, "中医药治疗儿童疳证的 Meta 分析检索 已完成");
  assert.equal(notice.body, "报告和 6 个文件已在对话里");
  assert.equal(notice.severity, "info");
  assert.equal(notice.pending, 0);
  // Nothing about the workspace, the files' custody, or how checks work.
  assert.doesNotMatch(`${notice.title}${notice.body}`, /工作区|交付|已准备好|依据|核对/);
});

test("a run with nothing on disk points at the conversation, and an untitled one says 一项研究", () => {
  const notice = runFinishedNotice({ status: "succeeded", verification: null, artifacts: [] });
  assert.equal(notice.title, "一项研究 已完成");
  assert.equal(notice.body, "结果已在对话里");
  const asked = runFinishedNotice({ status: "succeeded", question: "  二甲双胍与   乳酸酸中毒风险有多大？这是一个很长很长很长的问题  ", artifacts: [] });
  assert.equal(asked.title, "二甲双胍与 乳酸酸中毒风险有多大？这是一个很长… 已完成", "the question, one line, cut at 24 characters");
});

test("what the reader must check is 待核对, counted as the conversation counts it", () => {
  // The run's own claim count: the same number the report's 「依据」 marks ⚠.
  const counted = runFinishedNotice({
    status: "succeeded", verification: "unverified", title: "阿司匹林一级预防",
    artifacts: ["deliverables/r/report.md"], claimSummary: { total: 15, verified: 14, unverified: 1 },
    qualityNotices: [quoteNotice(3), quoteNotice(9)],
  });
  assert.equal(counted.outcome, "qualified");
  assert.equal(counted.status, "待核对");
  assert.equal(counted.title, "阿司匹林一级预防 待核对");
  assert.equal(counted.body, "报告和 1 个文件已在对话里，1 处引用待核对", "the claim count wins over the gate's finding count");
  assert.equal(counted.severity, "attention");
  // A run that counted no claims falls back to the delivery check's must-fix findings.
  const fallback = runFinishedNotice({ status: "succeeded", verification: "unverified", artifacts: [], qualityNotices: [quoteNotice(1), quoteNotice(2)] });
  assert.equal(fallback.pending, 2);
  assert.equal(fallback.body, "结果已在对话里，2 处引用待核对");
  // Delivered with its bookkeeping unproven but nothing marked for the reader:
  // 已完成, and no generic 「引用前请自行核对」 (plan §4, the 186-student RCT).
  const unchecked = runFinishedNotice({ status: "succeeded", verification: "unchecked", artifacts: ["deliverables/r/report.md"],
    claimSummary: { total: 4, verified: 4, unverified: 0 } });
  assert.equal(unchecked.outcome, "qualified");
  assert.equal(unchecked.title, "一项研究 已完成");
  assert.equal(unchecked.body, "报告和 1 个文件已在对话里");
  assert.equal(unchecked.severity, "info");
});

test("a clinical safety finding is the one title that states the fact", () => {
  const notice = runFinishedNotice({
    status: "succeeded", verification: "unverified", title: "胸痛患者的院前处理",
    artifacts: ["deliverables/review/clinical-evidence-report.md"],
    qualityNotices: [safetyNotice, quoteNotice(3), quoteNotice(9),
      { code: "clinical_evidence_notice", check: "claim-numeric-support", severity: "advice", text: "claims[52].claim numeric fact 6 is not present in its direct support." },
      "MUST FIX — a legacy sentence from an older ledger"],
  });
  assert.equal(notice.title, "胸痛患者的院前处理：有 1 处用药安全提示");
  assert.equal(notice.status, "有 1 处用药安全提示");
  assert.equal(notice.severity, "safety", "clinical safety is the one class that interrupts");
  assert.deepEqual(notice.counts, { safety: 1, mustFix: 3, advice: 1 });
  assert.equal(notice.body, "报告和 1 个文件已在对话里，3 处引用待核对");
  // Counts and titles only: no finding's own sentence, and no English.
  assert.doesNotMatch(`${notice.title}${notice.body}`, /MUST FIX|SAFETY|[a-z]{5,}/);
});

test("a run that did not finish says so in one word, and why in the body", () => {
  const gated = runFinishedNotice({ status: "failed", errorCode: "specialist_deliverable_not_accepted", title: "利伐沙班剂量" });
  const stopped = runFinishedNotice({ status: "failed", errorCode: "runtime_monitor_timeout", title: "利伐沙班剂量" });
  const capped = runFinishedNotice({ status: "failed", errorCode: "credits_exhausted", title: "利伐沙班剂量" });
  assert.equal(gated.title, "利伐沙班剂量 未完成");
  // The platform ended it: never a statement about the work.
  assert.equal(stopped.title, "利伐沙班剂量 已停止");
  assert.equal(capped.title, "利伐沙班剂量 未完成");
  assert.equal(gated.body, errorCodeMessage("specialist_deliverable_not_accepted"));
  assert.equal(stopped.body, errorCodeMessage("runtime_monitor_timeout"));
  assert.notEqual(gated.body, stopped.body, "a refused package and a platform stop do not share a sentence");
  assert.equal(capped.body, errorCodeMessage("credits_exhausted"));
  assert.doesNotMatch(capped.body, /个文件/, "a run refused before it started never claims files exist");
  for (const notice of [gated, stopped, capped]) assert.equal(notice.severity, "attention");
  // A platform cancel without a code is a stop, not a completion.
  assert.equal(runFinishedNotice({ status: "canceled", canceledBy: "platform" }).status, "已停止");
  assert.equal(runFinishedNotice({ status: "failed" }).status, "未完成");
});

test("a missing credential names the source and where to add it", () => {
  const notice = runFinishedNotice({ status: "failed", errorCode: "runtime_tool_error", missingCredential: "opengwas", title: "孟德尔随机化分析", qualityNotices: [], artifacts: [] });
  assert.equal(notice.title, "孟德尔随机化分析 未完成");
  assert.equal(notice.body, "缺少 OpenGWAS 的访问凭据。可在「设置 → 数据源」填入后重新发起。");
  assert.equal(notice.severity, "attention");
});

test("every outcome class ends its title with one of the four words, and the walk proves it walked", () => {
  const words = new Map();
  for (const kind of RUN_OUTCOME_KINDS) {
    // Reach each class through a code that really has it, so this cannot pass
    // by asserting over a table that no production code maps onto. `unknown`
    // is reachable only by a code from a future build.
    const code = kind === "delivered" || kind === "qualified" ? null
      : kind === "unknown" ? "a_code_this_build_does_not_know"
        : ALL_ERROR_CODES.find((candidate) => runFinishedNotice({ status: "failed", errorCode: candidate }).outcome === kind);
    if (kind !== "delivered" && kind !== "qualified") assert.ok(code, `no error code in the registry classifies as ${kind}`);
    const notice = kind === "qualified"
      ? runFinishedNotice({ status: "succeeded", verification: "unverified", qualityNotices: [quoteNotice(1)] })
      : runFinishedNotice({ status: kind === "delivered" ? "succeeded" : "failed", errorCode: code ?? null });
    assert.equal(notice.outcome, kind);
    assert.ok(RUN_NOTICE_STATUS_WORDS.includes(notice.status), `${kind} ended with ${notice.status}`);
    assert.equal(notice.title, `一项研究 ${notice.status}`);
    words.set(kind, notice.status);
  }
  assert.equal(words.size, RUN_OUTCOME_KINDS.length);
  assert.deepEqual([...new Set(words.values())].sort(), [...RUN_NOTICE_STATUS_WORDS].sort(), "every word is used, and no other");
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

test("the notice counts what was delivered apart from what the run wrote for itself", () => {
  // The aspirin run of 2026-09-19: five deliverable files, one revision note,
  // 24 scratch scripts. 「产出 30 个文件」 counted the scripts as products.
  const artifacts = Array.from({ length: 30 }, (_, index) => `file-${index}`);
  const notice = runFinishedNotice({
    status: "succeeded", errorCode: null, verification: null, artifacts,
    artifactCounts: { deliverable: 5, revisionNotes: 1, work: 24, superseded: 0 },
  });
  assert.equal(notice.body, "报告和 6 个文件已在对话里");
  const scratchOnly = runFinishedNotice({ status: "succeeded", verification: null, artifacts: ["work/a.py"],
    artifactCounts: { deliverable: 0, revisionNotes: 0, work: 1, superseded: 0 } });
  assert.equal(scratchOnly.body, "结果已在对话里", "scratch is not a product the reader is sent to");
});

/* ---------------------------------------------------------------- grouping */

const finished = (id, finishedAt, extra = {}) => ({
  id, status: "succeeded", errorCode: null, verification: null, artifacts: ["deliverables/r/report.md"],
  finishedAt, startedAt: finishedAt, question: `问题 ${id}`, ...extra,
});

test("a day's completions in a project are one item: how many, how many to check, then their names", () => {
  const project = { id: "default" };
  const peers = [
    finished("run-a", "2026-09-18T01:00:00.000Z", { verification: "unverified", title: "二甲双胍与乳酸酸中毒风险",
      claimSummary: { total: 9, verified: 8, unverified: 1 }, qualityNotices: [quoteNotice(1)] }),
    finished("run-b", "2026-09-18T02:00:00.000Z"),
    // The day before, in China: 23:30 on the 17th.
    finished("run-old", "2026-09-17T15:30:00.000Z"),
    // A safety finding and a failure stand alone; they are not "完成".
    finished("run-safety", "2026-09-18T02:30:00.000Z", { verification: "unverified", qualityNotices: [safetyNotice] }),
    { ...finished("run-failed", "2026-09-18T02:40:00.000Z"), status: "failed", errorCode: "runtime_monitor_timeout" },
    { ...finished("run-live", "2026-09-18T02:50:00.000Z"), status: "running" },
  ];
  const item = runFinishedInboxItem(project, finished("run-c", "2026-09-18T03:00:00.000Z", { title: "阿司匹林一级预防" }), { peers });
  assert.equal(item.groupKey, "run-finished:default:2026-09-18");
  assert.equal(item.title, "3 项研究已完成，其中 1 项有 1 处引用待核对");
  // The names only, the one with something to check first.
  assert.equal(item.body, "二甲双胍与乳酸酸中毒风险、阿司匹林一级预防、问题 run-b");
  assert.equal(item.idempotencyKey, "run-finished:run-c", "each run is its own event inside the group");
  assert.deepEqual(item.source, { type: "run", id: "run-c" }, "the item opens the latest run");
  assert.deepEqual(item.actions, [{ id: "open", label: "打开对话", style: "primary" }], "one label for opening a conversation");
  assert.equal(item.severity, "attention", "one of them has something to check");
  assert.equal("silent" in item, false, "nothing is recorded quietly any more");
  assert.doesNotMatch(`${item.title}${item.body}`, /已交付|结论要核对|MUST FIX|[a-z]{5,}/);
});

test("the day is China's, a lone completion keeps its own words, and a long day names three", () => {
  const project = { id: "p1" };
  // 00:30 on the 19th in Shanghai is still the 18th in UTC.
  assert.equal(shanghaiDay("2026-09-18T16:30:00.000Z"), "2026-09-19");
  assert.equal(shanghaiDay("2026-09-18T15:59:59.999Z"), "2026-09-18");
  assert.equal(shanghaiDay("not a time"), null);
  const lone = runFinishedInboxItem(project, finished("run-1", "2026-09-18T16:30:00.000Z"), {
    peers: [finished("run-0", "2026-09-18T15:00:00.000Z")],
  });
  assert.equal(lone.groupKey, "run-finished:p1:2026-09-19");
  assert.equal(lone.title, "问题 run-1 已完成", "a group of one is the run's own notice");
  assert.equal(lone.body, "报告和 1 个文件已在对话里");
  assert.equal(lone.severity, "info");
  const many = runFinishedInboxItem(project, finished("run-9", "2026-09-18T09:00:00.000Z"), {
    peers: Array.from({ length: 6 }, (_unused, index) => finished(`run-${index}`, `2026-09-18T0${index}:00:00.000Z`)),
  });
  assert.equal(many.title, "7 项研究已完成");
  assert.equal(many.body, "问题 run-9、问题 run-5、问题 run-4 等 7 项");
  assert.equal(many.severity, "info");
});

test("a safety finding or a run that did not finish is never folded", () => {
  const project = { id: "default" };
  const safety = runFinishedInboxItem(project, finished("run-s", "2026-09-18T03:00:00.000Z", { verification: "unverified", title: "胸痛院前处理",
    qualityNotices: [safetyNotice] }), { peers: [finished("run-a", "2026-09-18T01:00:00.000Z")] });
  assert.equal(safety.groupKey, undefined);
  assert.equal(safety.severity, "safety");
  assert.equal(safety.title, "胸痛院前处理：有 1 处用药安全提示");
  const failed = runFinishedInboxItem(project, { ...finished("run-f", "2026-09-18T03:00:00.000Z"), status: "failed", errorCode: "runtime_monitor_timeout" });
  assert.equal(failed.groupKey, undefined);
  assert.equal(failed.severity, "attention");
  assert.equal(failed.title, "问题 run-f 已停止");
});

/* ------------------------------------------------------ who reaches the inbox */

test("only a person's own research reaches the inbox; evaluations and background work leave nothing", () => {
  const run = finished("run-1", "2026-09-18T03:00:00.000Z", { durationMs: 30 * 60_000 });
  assert.equal(runFinishedReachesInbox(run), true);
  // Not even a quiet record: the 「自动运行 N 条（评测与主动科研，不计入未读）」
  // fold is gone with them (plan 2026-09-23 §5.8).
  assert.equal(runFinishedReachesInbox(run, { automated: true }), false, "an evaluation harness said so at dispatch");
  assert.equal(runFinishedReachesInbox(run, { evaluation: true }), false, "an evaluation cell's runtime");
  assert.equal(runFinishedReachesInbox(run, { internalProject: true }), false, "a lesson or a document being read");
  assert.equal(runFinishedReachesInbox(run, { autopilotOwned: true }), false, "an autopilot episode reports through its digest");
  // And the person's own rules still apply on top.
  assert.equal(runFinishedReachesInbox({ ...run, status: "canceled", canceledBy: "user" }), false);
  assert.equal(runFinishedReachesInbox({ ...run, dispatchStatus: "rejected" }), false);
  assert.equal(runFinishedReachesInbox({ ...run, status: "canceled", canceledBy: "platform", errorCode: "runtime_canceled" }), true);
  assert.equal(runFinishedNotifies({ ...run, durationMs: 3_000, artifacts: [] }), false, "a turn the reader watched finish");
});

test("a run is automated when a harness said so, or when autopilot started it", () => {
  assert.equal(automatedRun({ automated: true }), true);
  assert.equal(automatedRun({ effectiveRouteReason: "autopilot:literature-sentinel" }), true);
  assert.equal(automatedRun({ dispatchId: `episode-${"a".repeat(32)}-v1` }), true, "an independent verification");
  assert.equal(automatedRun({ effectiveRouteReason: "unrouted:open-domain", dispatchId: "dispatch-1" }), false);
  assert.equal(automatedRun({ automated: "yes" }), false, "only the boolean the dispatch validated counts");
});
