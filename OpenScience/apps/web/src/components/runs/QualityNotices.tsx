import { useMemo, type ReactNode } from "react";
import { AlertCircle, ScrollText, ShieldAlert } from "lucide-react";
import { Disclosure } from "@/components/ui/Disclosure";
import { cn } from "@/lib/cn";
import {
  noticeCountsLine,
  summarizeQualityNotices,
  type NoticeGroup,
  type NoticeLine,
} from "@/lib/qualityNotices";
import { useOperator } from "@/lib/useOperator";

/** How many lines a must-fix group shows before the rest fold away. */
const MUST_FIX_LINES = 4;

/**
 * What the quality check found in one delivered piece of work, at three
 * clearly different weights.
 *
 * - SAFETY: the danger colour, a shield, a border, and never folded — the one
 *   class a clinical reader must not be able to miss (appendix C: 「SAFETY 类
 *   发现永远不参与聚合折叠」).
 * - 必须修改: amber, what a reader cannot see for themselves; listed.
 * - 提示: quiet and folded. Since the 2026-09-17 ruling most findings are
 *   advice, and when twenty of them looked like the three that mattered, the
 *   three were lost.
 *
 * Nothing here prints an English validator sentence. Old records' sentences
 * are counted under a Chinese label or folded into 「另有 N 条技术提示」, and
 * their raw text is reachable only behind an operator-only disclosure.
 */
export function QualityNotices({
  notices,
  verification,
  hasArtifacts,
  renderLineAction,
  className,
}: {
  notices: ReadonlyArray<unknown> | null | undefined;
  verification: "unverified" | "unchecked" | null | undefined;
  hasArtifacts: boolean;
  /** Where a finding names a claim or a file, the caller can offer a way to it. */
  renderLineAction?: (line: NoticeLine) => ReactNode;
  className?: string;
}) {
  const operator = useOperator();
  const summary = useMemo(() => summarizeQualityNotices(notices), [notices]);
  if (verification == null && summary.counts.total === 0) return null;

  const headline = verification === "unverified"
    ? "已交付，但有结论没能逐字核对"
    // Not the same statement, and it used to render as the absence of any
    // statement: a layer of the gate did not run, so nothing below says that
    // layer found the package sound.
    : verification === "unchecked"
      ? "已交付，但有一层没有检查过"
      : "核对提示";
  const guidance = verification === "unverified"
    ? hasArtifacts
      ? "产物可以照常下载和阅读；以下是这次分析没能逐字核对的部分，引用前请自行核对。打开报告，句末的「依据」逐条标出哪些引文已在保存的原文中核对过、哪些没有。"
      : "本次没有文件产出；以下是这次分析没能逐字核对的部分，引用前请自行核对。"
    : verification === "unchecked"
      ? `${hasArtifacts ? "产物可以照常下载和阅读；" : ""}这次有一层检查没有执行，没有发现问题不等于检查过。`
      : null;
  const technical = [...summary.safety, ...summary.mustFix, ...summary.advice].flatMap((group) => group.technical);
  const counts = noticeCountsLine(summary);

  return (
    <section aria-label="核对结果" className={cn("space-y-3", className)}>
      <header className="flex items-start gap-2">
        <ScrollText size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <div className="min-w-0">
          <h4 className="text-ui font-semibold text-text">{headline}</h4>
          {counts && <p className="text-caption text-muted">{counts}</p>}
        </div>
      </header>
      {guidance && <p className="text-ui text-muted">{guidance}</p>}

      {summary.counts.safety > 0 && (
        <div role="group" aria-label="临床安全" className="rounded-input border border-danger bg-danger-soft p-3">
          <p className="flex items-center gap-1.5 text-ui font-semibold text-danger-strong">
            <ShieldAlert size={16} aria-hidden="true" />
            临床安全 · {summary.counts.safety} 项
          </p>
          <GroupList groups={summary.safety} tone="safety" renderLineAction={renderLineAction} />
        </div>
      )}

      {summary.counts.mustFix > 0 && (
        <div role="group" aria-label="必须修改" className="rounded-input border border-strong bg-warn-soft p-3">
          <p className="flex items-center gap-1.5 text-ui font-semibold text-warn-strong">
            <AlertCircle size={16} aria-hidden="true" />
            必须修改 · {summary.counts.mustFix} 项
            <span className="font-normal text-muted">读者无法自己看出的问题</span>
          </p>
          <GroupList groups={summary.mustFix} tone="must-fix" renderLineAction={renderLineAction} />
        </div>
      )}

      {summary.counts.advice > 0 && (
        <Disclosure summary={<>提示 {summary.counts.advice} 项 · 不影响交付，引用前可参考</>}>
          <GroupList groups={summary.advice} tone="advice" renderLineAction={renderLineAction} />
        </Disclosure>
      )}

      {summary.technicalCount > 0 && !operator && (
        <p className="text-caption text-muted">另有 {summary.technicalCount} 条技术提示，是写给运行自身的修复说明。</p>
      )}
      {technical.length > 0 && operator && (
        <Disclosure summary={<>技术原文 {technical.length} 条（仅运维账号可见）</>} summaryClassName="text-caption">
          <ul className="space-y-1 font-mono text-caption text-muted">
            {technical.map((text, index) => <li key={index} className="break-words">{text}</li>)}
          </ul>
        </Disclosure>
      )}
    </section>
  );
}

function GroupList({
  groups,
  tone,
  renderLineAction,
}: {
  groups: NoticeGroup[];
  tone: "safety" | "must-fix" | "advice";
  renderLineAction?: (line: NoticeLine) => ReactNode;
}) {
  const visible = groups.filter((group) => !group.unlabelled);
  if (visible.length === 0) return null;
  return (
    <ul className="mt-2 space-y-2">
      {visible.map((group) => {
        const shown = tone === "must-fix" ? group.lines.slice(0, MUST_FIX_LINES) : group.lines;
        const rest = group.lines.length - shown.length;
        return (
          <li key={group.key}>
            <p className={cn("text-ui", tone === "advice" ? "text-text" : "font-semibold text-text")}>
              {group.label}
              {group.count > 1 && <span className="ml-1.5 font-normal tabular-nums text-muted">{group.count} 项</span>}
            </p>
            {shown.length > 0 && (
              <ul className={cn("mt-0.5 space-y-0.5 text-ui", tone === "advice" ? "text-muted" : "text-text")}>
                {shown.map((line, index) => (
                  <li key={index} className="flex gap-1.5">
                    <span className="shrink-0 text-muted" aria-hidden="true">·</span>
                    <span className="min-w-0 break-words">{line.text}</span>
                    {renderLineAction?.(line)}
                  </li>
                ))}
              </ul>
            )}
            {rest > 0 && (
              <Disclosure summary={<>还有 {rest} 条</>} summaryClassName="text-caption" className="mt-0.5">
                <ul className="space-y-0.5 text-ui text-text">
                  {group.lines.slice(MUST_FIX_LINES).map((line, index) => (
                    <li key={index} className="flex gap-1.5">
                      <span className="shrink-0 text-muted" aria-hidden="true">·</span>
                      <span className="min-w-0 break-words">{line.text}</span>
                      {renderLineAction?.(line)}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </li>
        );
      })}
    </ul>
  );
}
