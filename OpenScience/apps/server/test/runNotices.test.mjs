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

import { AgentRunStore } from "../src/agentRuns.mjs";
import { describedQualityNotices, normalizeQualityNotices, runNotice } from "../src/runNotices.mjs";

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
