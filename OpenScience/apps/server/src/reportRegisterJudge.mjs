import path from "node:path";
import { openScopedFileNoFollow } from "./security.mjs";
import { runNotice } from "./runNotices.mjs";

// Frozen pre-Jev comparator. It records drift only and never controls a finding.
const legacyRegisterPattern = /(?:clinical-evidence-synthesis|\bmcp__evimed__[a-z_]+\b|\bevimed_[a-z_]+\b|EviMed.{0,24}(?:引擎|网关|工具)|证据追溯契约|\.evimed-sources\/|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单抓取|工具调用|(?<!加)工件|访问层级|(?<![基日样标根成])本环境|本轮检索|检索环境|(?:未触及|未读取|未检索).{0,16}(?:完整|全文|文件|页面))/i;

/** Delivered Markdown prose only; code blocks and revision notes are not prose.
 * @param {string} text */
export function reportProseLines(text) {
  const lines = [];
  let fence = "";
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const delimiter = raw.trim().match(/^(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1][0];
      else if (fence === delimiter[1][0]) fence = "";
      continue;
    }
    if (fence || !raw.trim()) continue;
    lines.push({ line: index + 1, text: raw.trim() });
  }
  return lines;
}

/** Advisory work begins only after a terminal ledger write. It cannot change
 * delivery, file bytes, or verification. No VCR material is sent to this service.
 * @param {{project:any,run:any,judgeService:any,onNotices:(notices:any[])=>Promise<any>}} input */
export async function reviewDeliveredRegister({ project, run, judgeService, onNotices }) {
  if (!judgeService || String(run.effectiveAgentId ?? run.agentId ?? "").startsWith("vcr-")) return;
  const files = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])])]
    .filter(file => file.endsWith(".md") && path.basename(file) !== "revision-notes.md");
  for (const file of files) {
    let opened;
    let text;
    try {
      opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, file));
      // The existing run-ledger text-file bound; never follow a symlink or read
      // another workspace while collecting evidence for an optional notice.
      if (!opened.stat.isFile() || opened.stat.size > 8 * 1024 * 1024) continue;
      text = await opened.handle.readFile("utf8");
    } catch { continue; }
    finally { await opened?.handle.close().catch(() => {}); }
    for (const item of reportProseLines(text)) {
      let decision;
      try {
        decision = await judgeService.judge("J4", { line: item.text }, {
          userId: project.userId, projectId: project.id, runId: run.id,
          regexBaseline: { leakage: legacyRegisterPattern.test(item.text) },
        });
      } catch { continue; }
      if (["judge_disabled", "judge_unconfigured", "judge_uncalibrated", "judge_calibration_mismatch"].includes(decision.code)) return;
      if (decision.outcome !== "settled" || decision.value?.leakage !== true) continue;
      const detail = `报告第 ${item.line} 行可能夹带执行过程表述：${item.text.slice(0, 180)}`;
      await onNotices([runNotice("runtime_leakage", detail, {
        check: "runtime-leakage", severity: "advice", file, line: item.line, detail,
      })]);
    }
  }
}
