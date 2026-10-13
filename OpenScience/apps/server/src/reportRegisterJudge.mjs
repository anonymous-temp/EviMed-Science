import path from "node:path";
import { isResearcherOwnedWork } from "@evimed/domain";
import { openScopedFileNoFollow } from "./security.mjs";
import { maxQualityNotices, runNotice } from "./runNotices.mjs";

/**
 * Prose lines of one run's reports the register judge reads before it stops
 * (`OPEN_SCIENCE_JEV_REGISTER_MAX_LINES`). Each line is its own sequential Jev
 * request, so this is the bound on what one run can cost and take, not a
 * typical size: the 42 delivered packages in the repository's eval results hold
 * a median of 198 prose lines, a p95 of 392 and at most 637, so a report is read
 * whole and a pasted log or table of thousands of lines is not read to its end.
 */
export const REGISTER_JUDGE_MAX_LINES = 600;

// Frozen pre-Jev comparator. It records drift only and never controls a finding.
// Exported for the judge-site benefit evaluation (`evals/judge-sites`), which scores it as the incumbent beside J4.
export const legacyRegisterPattern = /(?:clinical-evidence-synthesis|\bmcp__evimed__[a-z_]+\b|\bevimed_[a-z_]+\b|EviMed.{0,24}(?:引擎|网关|工具)|证据追溯契约|\.evimed-sources\/|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单抓取|工具调用|(?<!加)工件|访问层级|(?<![基日样标根成])本环境|本轮检索|检索环境|(?:未触及|未读取|未检索).{0,16}(?:完整|全文|文件|页面))/i;

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

/**
 * Whether a run's reports are read at all. The notice is for a researcher who is
 * handed the report, so it is not raised for work no researcher reads: the
 * platform's own projects and capabilities (`internalProject`,
 * `internalCapability`, which the caller knows and this module does not) and the
 * runs the platform starts to measure or teach itself, which the domain names
 * once as "not researcher-owned work" (an evaluation harness's `automated` run,
 * the learning loop's, 「循证进化」's). Managed GEO and proactive research stay in
 * scope, because a researcher reads their reports. No VCR material is ever sent.
 * @param {any} run @param {{ internalProject: boolean, internalCapability: boolean }} scope
 */
function registerJudgeReads(run, { internalProject, internalCapability }) {
  if (String(run.effectiveAgentId ?? run.agentId ?? "").startsWith("vcr-")) return false;
  // An ordinary conversation's files (a README, a letter, a script) are not report prose: the register this judge holds
  // lines to is a report's, and nobody asked it to read what the person wrote for themselves.
  if (Array.isArray(run.outputFiles)) return false;
  return !internalProject && !internalCapability && isResearcherOwnedWork(run);
}

/** Advisory work begins only after a terminal ledger write. It cannot change
 * delivery, file bytes, or verification. No VCR material is sent to this service.
 *
 * Bounded three ways, each counted on the service so the bound is visible rather
 * than silent (`judgeService.skipped`): a run outside the judge's scope is not
 * read (`run_out_of_scope`); at most `maxLines` lines are judged across the
 * run's files, in order (`lines_over_cap`); and judging stops once as many lines
 * are flagged as a run's ledger can hold notices, since later ones would be cut
 * (`lines_after_notice_limit`). What is flagged is appended in one write, so a
 * report with many findings rewrites the run ledger once, not once per line.
 * @param {{project:any,run:any,judgeService:any,onNotices:(notices:any[])=>Promise<any>,
 *   maxLines?:number,internalProject?:boolean,internalCapability?:boolean}} input */
export async function reviewDeliveredRegister({ project, run, judgeService, onNotices, maxLines = REGISTER_JUDGE_MAX_LINES, internalProject = false, internalCapability = false }) {
  if (!judgeService) return;
  if (!registerJudgeReads(run, { internalProject, internalCapability })) {
    judgeService.skipped?.("J4", "run_out_of_scope", 1);
    return;
  }
  const files = [...new Set([...(run.artifacts ?? []), ...(run.unverifiedArtifacts ?? [])])]
    .filter(file => file.endsWith(".md") && path.basename(file) !== "revision-notes.md");
  let budget = Number.isFinite(Number(maxLines)) ? Math.max(0, Math.trunc(Number(maxLines))) : REGISTER_JUDGE_MAX_LINES;
  let overCap = 0;
  let afterLimit = 0;
  /** @type {any[]} */
  const notices = [];
  try {
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
      const lines = reportProseLines(text);
      for (const [index, item] of lines.entries()) {
        if (notices.length >= maxQualityNotices) { afterLimit += lines.length - index; break; }
        if (budget <= 0) { overCap += lines.length - index; break; }
        budget -= 1;
        let decision;
        try {
          decision = await judgeService.judge("J4", { line: item.text }, {
            userId: project.userId, projectId: project.id, runId: run.id,
            regexBaseline: { leakage: legacyRegisterPattern.test(item.text) },
          });
        } catch { continue; }
        // The service cannot judge at all, or the account cannot pay: every later line would meet the same refusal.
        if (["judge_disabled", "judge_unconfigured", "judge_uncalibrated", "judge_calibration_mismatch", "judge_budget_exceeded"].includes(decision.code)) return;
        if (decision.outcome !== "settled" || decision.value?.leakage !== true) continue;
        const detail = `报告第 ${item.line} 行可能夹带执行过程表述：${item.text.slice(0, 180)}`;
        notices.push(runNotice("runtime_leakage", detail, {
          check: "runtime-leakage", severity: "advice", file, line: item.line, detail,
        }));
      }
    }
  } finally {
    if (overCap) judgeService.skipped?.("J4", "lines_over_cap", overCap);
    if (afterLimit) judgeService.skipped?.("J4", "lines_after_notice_limit", afterLimit);
    if (notices.length) await onNotices(notices);
  }
}
