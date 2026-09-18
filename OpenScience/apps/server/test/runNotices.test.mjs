// A run's notices, as a reader receives them (C2): identity, a Chinese title,
// a detail from parameters, and the old sentence only as `text`.
//
// 23 of the 25 production runs on 2026-09-18 predate the structure, so the
// legacy reading is not an edge case: it is most of what a researcher's runs
// page shows.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as domain from "@evimed/domain";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { clinicalSafetyCautionNotice, describedQualityNotices, normalizeQualityNotices, runNotice } from "../src/runNotices.mjs";

test("a sentence from an older ledger is read by the prefix it was written with, and never shown as it was", () => {
  const [safety, mustFix, stall, english, unknown] = describedQualityNotices([
    "SAFETY — The practical section tells a chest-pain patient to wait at home.",
    "MUST FIX — claims[3].supportQuote was not found in its preserved source artifact.",
    "这次运行已有约 15 分钟没有可观测的进展（没有新消息、没有新工具调用、工作区也没有变化）。",
    "The report was replaced with the write tool 2 time(s) while repairing, instead of being patched with edit.",
    "claims[52].claim numeric fact 6 is not present in its direct support.",
  ]);
  assert.equal(safety.severity, "safety");
  assert.equal(safety.title, "涉及临床安全，请核对");
  assert.equal(mustFix.severity, "must-fix");
  assert.equal(mustFix.detail, "证据矩阵第 4 条主张", "the matrix index is a format, and it names the claim");
  assert.equal(stall.code, "run_stall_observed");
  assert.equal(stall.title, "一段时间没有可观测的进展");
  assert.equal(english.code, "run_report_rewritten");
  assert.equal(english.detail, undefined, "an English sentence is never promoted to a detail");
  assert.equal(unknown.code, "legacy_notice");
  assert.equal(unknown.severity, "advice");
  assert.equal(unknown.title, "另有技术提示");
  assert.equal(unknown.text, "claims[52].claim numeric fact 6 is not present in its direct support.", "the sentence is kept, as text, for old readers");
});

test("a stored notice becomes a titled item, and bad shapes are dropped rather than breaking the read", () => {
  const stored = normalizeQualityNotices([
    runNotice("clinical_evidence_issue", "MUST FIX — Report line 12 numeric facts 30 are not present in the cited claim evidence.", {
      severity: "must-fix", check: "report-number-unsupported", file: "deliverables/review/clinical-evidence-report.md",
    }),
    { code: "Not A Code", text: "x" },
    { code: "fine_code" },
    42,
    null,
  ]);
  assert.equal(stored.length, 1);
  const [described] = describedQualityNotices(stored);
  assert.deepEqual(described, {
    code: "clinical_evidence_issue",
    check: "report-number-unsupported",
    severity: "must-fix",
    title: "报告数值未见于所引证据",
    detail: "clinical-evidence-report.md 第 12 行",
    file: "deliverables/review/clinical-evidence-report.md",
    text: "MUST FIX — Report line 12 numeric facts 30 are not present in the cited claim evidence.",
  });
});

test("an old ledger with string notices and a new one with structured notices read the same way", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-notices-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", userId: "u", rootDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: root };
  await mkdir(project.metaDir, { recursive: true });
  const started = (id) => ({
    event: "started", id, dispatchId: null, dispatchStatus: "accepted", kernelRequestIds: [], sessionId: `ses_${id}`,
    mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null,
    effectiveAgentId: null, effectiveAgentVersion: null, effectiveRuntimeAgent: null, effectiveRouteReason: null,
    model: "deepseek/deepseek-flash", question: null, createdAt: "2026-09-01T00:00:00.000Z", startedAt: "2026-09-01T00:00:00.000Z", baselineCursor: null,
  });
  const finished = (id, qualityNotices) => ({
    event: "finished", id, status: "succeeded", errorCode: null, artifacts: [], unverifiedArtifacts: [], verification: "unverified",
    qualityNotices, finishedAt: "2026-09-01T00:10:00.000Z", durationMs: 600000,
  });
  const lines = [
    started("run_old"),
    finished("run_old", ["MUST FIX — claims[0].supportQuote was not found in its preserved source artifact."]),
    started("run_new"),
    finished("run_new", [{ code: "clinical_evidence_issue", check: "claim-quote-verbatim", severity: "must-fix", text: "MUST FIX — claims[0].supportQuote was not found in its preserved source artifact." }]),
    { event: "notice", id: "run_new", at: "2026-09-01T00:11:00.000Z", qualityNotices: [{ code: "memory_pending", severity: "advice", text: "记忆已记录但暂缓生效 1 条。", detail: "记忆已记录但暂缓生效 1 条。" }] },
  ];
  await writeFile(path.join(project.metaDir, "runs.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const store = new AgentRunStore({ get: async () => null }, { model: "deepseek/deepseek-flash" });
  const runs = await store.list(project);
  const old = runs.find((run) => run.id === "run_old");
  const fresh = runs.find((run) => run.id === "run_new");
  assert.equal(old.qualityNotices[0].severity, "must-fix");
  assert.equal(old.qualityNotices[0].title, "有一处依据需要核对", "an old sentence without its check gets the severity's title");
  assert.equal(fresh.qualityNotices[0].title, "引文在所引来源中找不到原句", "a new one is titled by its check");
  assert.equal(fresh.qualityNotices[0].detail, "证据矩阵第 1 条主张");
  assert.equal(fresh.qualityNotices[1].code, "memory_pending");
  assert.equal(fresh.qualityNotices[1].detail, "记忆已记录但暂缓生效 1 条。");
  for (const notice of [...old.qualityNotices, ...fresh.qualityNotices]) {
    assert.ok(["safety", "must-fix", "advice"].includes(notice.severity));
    assert.ok(/[㐀-鿿]/.test(notice.title), `a notice without a Chinese title: ${JSON.stringify(notice)}`);
    assert.equal(typeof notice.text, "string");
  }
});

test("the run side's degraded lines are titled by the template they were written with", async () => {
  const { runSideDegradedNotice } = await import("../src/runNotices.mjs");
  const cases = [
    ["root research-tool narrowing failed: tools.restrict is not a function", "run_root_tools_unnarrowed", "根任务未能收窄研究工具"],
    ["root research-tool narrowing found no research tools registered at session start", "run_root_tools_unnarrowed", "根任务未能收窄研究工具"],
    ["root claim-tool narrowing failed: boom", "run_root_claim_tools_unnarrowed", "根任务未能收窄主张工具"],
    ["method section clinical-evidence-synthesis/appraisal not registered: duplicate", "run_method_sections_unregistered", "方法说明未注册，改读技能文件"],
    ["method sections for d1 were not registered; the child can read them from the skill files", "run_method_sections_unregistered", "方法说明未注册，改读技能文件"],
    ["child guidance not installed: agent/pre-step unavailable", "run_child_guidance_missing", "子任务指引没有装上"],
    ["request size 2400000 bytes passed the compaction byte limit 2000000; compacted to 1200000 bytes before the model gateway could refuse it", "run_compaction_forced", "请求过大，已先压缩上下文"],
    ["request size 2400000 bytes passed the compaction byte limit 2000000 and nothing could be compacted", "run_compaction_nothing", "请求过大，没有可压缩的内容"],
    ["request size 2400000 bytes passed the compaction byte limit 2000000; the forced compaction failed: timeout", "run_compaction_failed", "请求过大，强制压缩失败"],
    ["turn ended with children still running: h-1, h-2", "run_children_outlived_turn", "一轮结束时仍有子任务在运行"],
  ];
  for (const [line, code, title] of cases) {
    const [described] = describedQualityNotices([runSideDegradedNotice(line)]);
    assert.equal(described.code, code, line);
    assert.equal(described.title, title, line);
    assert.equal(described.detail, undefined, "an English line is never shown as the detail");
    assert.equal(described.text, line);
  }
  const concurrent = describedQualityNotices([runSideDegradedNotice("deliverables/d1/report.md 被两个子代理先后写入（child-a 之后是 child-b）：后写的覆盖了先写的")])[0];
  assert.equal(concurrent.code, "run_concurrent_write");
  assert.match(concurrent.detail, /被两个子代理先后写入/, "a line written in Chinese is its own detail");
  assert.equal(runSideDegradedNotice("something the table does not know").code, "run_side_degraded");
});

test("a pharmacist-authored caution reaches the reader titled by its rule, as a SAFETY notice", () => {
  // The structured shape: what the completion verdict pushes for a rule hit.
  const hit = {
    ruleId: "aspirin-primary-prevention-bleeding",
    titleZh: "阿司匹林一级预防：出血风险",
    messageZh: "报告讨论阿司匹林用于一级预防，但通篇没有提到出血风险。请写明它增加的出血风险。",
  };
  const [described] = describedQualityNotices([clinicalSafetyCautionNotice(hit)]);
  assert.deepEqual(described, {
    code: "clinical_safety_caution",
    check: "clinical-safety-cautions",
    severity: "safety",
    title: "阿司匹林一级预防：出血风险",
    detail: "报告讨论阿司匹林用于一级预防，但通篇没有提到出血风险。请写明它增加的出血风险。",
    rule: "aspirin-primary-prevention-bleeding",
    text: "SAFETY — 阿司匹林一级预防：出血风险：报告讨论阿司匹林用于一级预防，但通篇没有提到出血风险。请写明它增加的出血风险。",
  });
  // The ledger round trip keeps the rule's title: it is stored, not looked up.
  assert.deepEqual(describedQualityNotices(JSON.parse(JSON.stringify(normalizeQualityNotices([clinicalSafetyCautionNotice(hit)])))), [described]);

  // The flattened sentence. Most rule titles carry a colon of their own, so it
  // is never split at the first one: with the rule table in this build the
  // title is recognised whole; without it the reader still gets the whole
  // Chinese sentence under the safety title, and never a half-title.
  const rules = /** @type {any} */ (domain).CLINICAL_SAFETY_CAUTION_RULES;
  const [flat] = describedQualityNotices([`SAFETY — ${hit.titleZh}：${hit.messageZh}`]);
  assert.equal(flat.severity, "safety");
  assert.notEqual(flat.title, "阿司匹林一级预防", "split at the first colon — the title would lose half of itself");
  if (Array.isArray(rules) && rules.length) {
    for (const rule of rules) {
      const [read] = describedQualityNotices([`SAFETY — ${rule.titleZh}：${rule.messageZh}`]);
      assert.equal(read.code, "clinical_safety_caution", rule.id);
      assert.equal(read.check, "clinical-safety-cautions", rule.id);
      assert.equal(read.title, rule.titleZh, rule.id);
      assert.equal(read.rule, rule.id);
      assert.ok(rule.messageZh.startsWith(String(read.detail).slice(0, 20)), rule.id);
    }
    // As the domain's validator raises it: a rule id and an English message.
    const [issued] = describedQualityNotices([{ code: "clinical_safety_caution", check: "clinical-safety-cautions", severity: "advisory", rule: rules[0].id, message: "English repair text." }]);
    assert.equal(issued.title, rules[0].titleZh);
    assert.equal(issued.severity, "safety");
  } else {
    assert.equal(flat.title, "涉及临床安全，请核对");
    assert.equal(flat.detail, `${hit.titleZh}：${hit.messageZh}`);
  }
  // A validator's English SAFETY sentence is still never shown as the detail.
  const [english] = describedQualityNotices(["SAFETY — The practical section tells a chest-pain patient to wait at home."]);
  assert.equal(english.detail, undefined);
});
