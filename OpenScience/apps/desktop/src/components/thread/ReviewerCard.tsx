import { useState } from "react";
import { ChevronDown, ShieldCheck, X } from "lucide-react";
import type { FindingLevel, ReviewCheck, ReviewerBlock } from "@ai4s/shared";
import { cn } from "@/lib/cn";

const BADGE: Record<FindingLevel, { label: string; className: string }> = {
  warn: { label: "提示", className: "bg-warn/15 text-warn ring-warn/30" },
  ok: { label: "通过", className: "bg-ok/15 text-ok ring-ok/30" },
  error: { label: "错误", className: "bg-error/15 text-error ring-error/30" },
};

const CHECK_TAG: Record<ReviewCheck, string> = {
  citation: "引用",
  number: "数字",
  figure: "图表与代码",
  domain: "专业领域",
  integrity: "完整性",
};

/** Structured reviewer findings. Dismissal is a session-local reading aid —
 *  the underlying review text stays in the conversation. */
export function ReviewerCard({ block }: { block: ReviewerBlock }) {
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const visible = block.findings
    .map((f, i) => [f, i] as const)
    .filter(([, i]) => !dismissed.has(i));
  return (
    <div className="rounded-card border border-border bg-surface shadow-card">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ShieldCheck size={16} className="text-muted" />
        <span className="text-sm font-medium text-text">结果核查</span>
        <span className="text-sm text-muted">
          · {visible.length} 项发现
          {dismissed.size > 0 && ` · 已忽略 ${dismissed.size} 项`}
        </span>
        <ChevronDown
          size={16}
          className={cn("ml-auto text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-3 px-4 pb-4">
          {visible.map(([f, i]) => {
            const badge = BADGE[f.level];
            return (
              <div key={i} className="group space-y-1.5">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs font-medium ring-1",
                      badge.className,
                    )}
                  >
                    {badge.label}
                  </span>
                  {(f.tag || f.check) && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted ring-1 ring-border">
                      {f.tag ?? (f.check ? CHECK_TAG[f.check] : "")}
                    </span>
                  )}
                  <span className="text-sm font-medium text-text">{f.title}</span>
                  <button
                    className="ml-auto shrink-0 text-muted opacity-0 hover:text-text group-hover:opacity-100"
                    aria-label={`忽略发现：${f.title}`}
                    title="忽略此项"
                    onClick={() => setDismissed(new Set([...dismissed, i]))}
                  >
                    <X size={14} />
                  </button>
                </div>
                {f.evidence && (
                  <p className="whitespace-pre-wrap font-mono text-ui-sm leading-relaxed text-muted">
                    {f.evidence}
                  </p>
                )}
              </div>
            );
          })}
          {visible.length === 0 && block.findings.length > 0 && (
            <p className="text-sm text-muted">所有发现均已忽略。</p>
          )}
          {block.note && <p className="text-sm text-muted">{block.note}</p>}
        </div>
      )}
    </div>
  );
}
