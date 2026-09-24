import { FileWarning } from "lucide-react";
import { SOURCE_UPDATE_LABELS_ZH, SOURCE_UPDATE_WEIGHT } from "@evimed/domain";
import type { SourceUpdate } from "@/lib/claimCitations";
import { cn } from "@/lib/cn";

/**
 * Retraction and correction notices on a cited work (plan §3.9), read from
 * Crossref — which carries the Retraction Watch database — when the report's
 * 「依据」 were checked. A notice, never a verdict: the quotation may still be
 * found in the source, and whether the claim still stands is for the reader.
 *
 * Tone follows weight, said with an icon and words as every status is: a work
 * that no longer stands as published (retracted, withdrawn, removed) in the
 * danger colour — citing one in a clinical review is exactly what a reader
 * must not miss; an expression of concern or a correction in amber, "check the
 * notice". Each links the notice itself.
 */
export function SourceUpdateBadges({ updates, className }: {
  updates: readonly SourceUpdate[] | null | undefined;
  className?: string;
}) {
  const shown = (updates ?? []).filter((update) => update.kind in SOURCE_UPDATE_LABELS_ZH);
  if (shown.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((update, index) => {
        const label = SOURCE_UPDATE_LABELS_ZH[update.kind as keyof typeof SOURCE_UPDATE_LABELS_ZH];
        const withdrawn = SOURCE_UPDATE_WEIGHT[update.kind as keyof typeof SOURCE_UPDATE_WEIGHT] === "withdrawn";
        const recorder = update.source === "retraction-watch" ? "Retraction Watch" : update.source === "publisher" ? "出版方" : null;
        const text = `${label}${update.date ? ` · ${update.date}` : ""}`;
        const title = `该文献${label}${update.date ? `（${update.date}）` : ""}${recorder ? `，据${recorder}记录` : ""}；来自 Crossref，仅供参考。`;
        const chip = cn(
          "inline-flex items-center gap-0.5 rounded-full border px-1.5 text-caption",
          withdrawn ? "border-danger bg-danger-soft text-danger-strong" : "border-warn bg-warn-soft text-warn-strong",
        );
        return update.noticeDoi ? (
          <a
            key={`${update.kind}:${update.noticeDoi}:${index}`}
            href={`https://doi.org/${update.noticeDoi}`}
            target="_blank"
            rel="noreferrer"
            title={title}
            aria-label={`${title}查看声明`}
            className={cn(chip, "hover:underline")}
          >
            <FileWarning size={16} aria-hidden="true" />{text}
          </a>
        ) : (
          <span key={`${update.kind}:${index}`} title={title} className={chip}>
            <FileWarning size={16} aria-hidden="true" />{text}
          </span>
        );
      })}
    </span>
  );
}
