import { useState } from "react";
import { ChevronDown, ChevronRight, FileCheck2 } from "lucide-react";
import { contractKindLabel } from "@evimed/domain";
import type { DeliverableNode, RunIssue } from "@/lib/runStream";
import { humanSize } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * One deliverable, its gate verdict and its receipt.
 *
 * Hidden knowledge: why the issues and the receipt share one card. They are the
 * two halves of one sentence — "this was rejected, for these five reasons" and
 * "this was accepted, and here are the exact bytes that were graded" — and a
 * deliverable moves between them repeatedly inside one run. Splitting them into
 * two panels would mean a reader watching a repair has to look in two places to
 * learn whether the third attempt landed.
 *
 * The receipt is shown with its digests. That is not decoration: the control
 * plane refuses a package whose files no longer match the digests they were
 * accepted under, so the digest is what makes "these are the artifacts that
 * were graded" a checkable claim rather than a promise.
 */

/** Plan-item lifecycle (`@evimed/domain`'s `PLAN_ITEM_STATES`) in the reader's words. */
const STATUS_LABEL: Record<string, string> = {
  planned: "已计划",
  queued: "等待依赖",
  delegated: "已委派",
  submitted: "已提交待判",
  accepted: "已通过",
  rejected: "已退回",
  failed: "未完成",
};

const STATUS_TONE: Record<string, string> = {
  accepted: "text-ok",
  rejected: "text-error",
  failed: "text-error",
  submitted: "text-accent",
  delegated: "text-accent",
};

const SEVERITY_LABEL: Record<RunIssue["severity"], string> = {
  required: "必须修正",
  advisory: "建议修正",
  optional: "可选",
};

/** @param status a `PLAN_ITEM_STATES` value @returns the Chinese label, or the raw value */
export function deliverableStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function DeliverableCard({ deliverable }: { deliverable: DeliverableNode }) {
  // Collapsed by default once accepted, open while something is wrong: a
  // reader opening a run mid-repair should not have to click to find out what
  // the gate objected to.
  const [open, setOpen] = useState(deliverable.status === "rejected" || deliverable.status === "failed");
  const required = deliverable.issues.filter((issue) => issue.severity === "required").length;
  const kindLabel = deliverable.contractKind ? contractKindLabel(deliverable.contractKind) : "契约种类未知";
  const detailId = `deliverable-detail-${deliverable.id}`;
  const hasDetail = deliverable.issues.length > 0 || deliverable.receipt != null;

  return (
    <li className="rounded-input border border-border-faint bg-surface-2/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={hasDetail ? detailId : undefined}
        disabled={!hasDetail}
        className="flex w-full items-start gap-2 rounded-input px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
      >
        {hasDetail ? (
          open ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            : <ChevronRight size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        ) : (
          <span className="mt-0.5 w-[13px] shrink-0" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ui-sm text-text">{deliverable.title || deliverable.id}</span>
            <span className="rounded-input bg-surface px-1.5 py-0.5 text-caption text-muted">{kindLabel}</span>
            <span className={cn("text-caption", STATUS_TONE[deliverable.status] ?? "text-muted")}>
              {deliverableStatusLabel(deliverable.status)}
            </span>
            {required > 0 && (
              <span className="rounded-input bg-error/10 px-1.5 py-0.5 text-caption text-error">
                {required} 项必须修正
              </span>
            )}
            {deliverable.receipt && (
              <span className="inline-flex items-center gap-1 text-caption text-ok">
                <FileCheck2 size={11} aria-hidden />
                回执 · 第 {deliverable.receipt.attempt} 次提交
              </span>
            )}
          </span>
        </span>
      </button>

      {open && hasDetail && (
        <div id={detailId} className="space-y-2 border-t border-border-faint px-2.5 py-2">
          {deliverable.issues.length > 0 && (
            <ul className="space-y-1">
              {deliverable.issues.map((issue, index) => (
                <li key={`${issue.code}:${index}`} className="flex gap-1.5 text-caption leading-relaxed text-muted">
                  <span className={cn("shrink-0", issue.severity === "required" ? "text-error" : "text-muted")}>
                    [{SEVERITY_LABEL[issue.severity] ?? issue.severity}]
                  </span>
                  <span className="min-w-0 break-words">
                    {issue.message}
                    {issue.path && <span className="text-muted"> · {issue.path}</span>}
                    {issue.line != null && <span className="text-muted">:{issue.line}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {deliverable.receipt && (
            <div className="space-y-1">
              <p className="text-caption text-muted">
                {/* The receipt is the durable record of what was graded: the run
                  * side writes it, the control plane verifies every digest
                  * before shipping, and a file that no longer matches is
                  * refused. Saying so is what makes the list below mean
                  * something. */}
                已通过契约校验（{deliverable.receipt.acceptedAt || "时间未记录"}），以下文件的内容摘要即当时被判定的版本：
              </p>
              <ul className="space-y-0.5">
                {deliverable.receipt.files.map((file) => (
                  <li key={file.path} className="flex items-baseline gap-2 text-caption">
                    <span className="min-w-0 flex-1 truncate font-mono text-text" title={file.path}>{file.path}</span>
                    <span className="shrink-0 tabular-nums text-muted">{humanSize(file.bytes)}</span>
                    <span className="shrink-0 font-mono text-muted" title={`sha256:${file.sha256}`}>
                      {file.sha256.slice(0, 12)}
                    </span>
                  </li>
                ))}
              </ul>
              {deliverable.receipt.notices.length > 0 && (
                <ul className="space-y-0.5">
                  {deliverable.receipt.notices.map((notice, index) => (
                    <li key={index} className="flex gap-1.5 text-caption leading-relaxed text-muted">
                      <span className="shrink-0">·</span>
                      <span className="min-w-0 break-words">{notice}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
