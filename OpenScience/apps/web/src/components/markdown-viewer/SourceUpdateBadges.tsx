import { FileWarning } from "lucide-react";
import { SOURCE_UPDATE_LABELS_ZH, SOURCE_UPDATE_WEIGHT } from "@evimed/domain";
import type { SourceUpdate, SourceUpdateStatus } from "@/lib/claimCitations";
import { cn } from "@/lib/cn";
import { Tag } from "@/components/ui/Tag";

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
export function SourceUpdateBadges({ updates, updateStatus, className }: {
  updates: readonly SourceUpdate[] | null | undefined;
  updateStatus?: SourceUpdateStatus;
  className?: string;
}) {
  const shown = (updates ?? []).filter((update) => update.kind in SOURCE_UPDATE_LABELS_ZH);
  if (shown.length === 0 && !updateStatus) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {updateStatus && (
        <Tag tone={updateStatus.state === "unavailable" || updateStatus.state === "changed" ? "warn" : "neutral"}
          title={updateStatus.checkedAt ? `查询于 ${new Date(updateStatus.checkedAt).toLocaleString("zh-CN")}` : "尚无可用的查询时间"}>
          {({ no_update: "未发现更新", changed: "文献有更新", unknown: "更新状态未知", unavailable: "更新查询不可用" })[updateStatus.state]}
        </Tag>
      )}
      {shown.map((update, index) => {
        const label = SOURCE_UPDATE_LABELS_ZH[update.kind as keyof typeof SOURCE_UPDATE_LABELS_ZH];
        const withdrawn = SOURCE_UPDATE_WEIGHT[update.kind as keyof typeof SOURCE_UPDATE_WEIGHT] === "withdrawn";
        // A Latin name takes a typed space on both sides (spec §5.5).
        const recorder = update.source === "retraction-watch" ? "据 Retraction Watch 记录" : update.source === "publisher" ? "据出版方记录" : null;
        const text = `${label}${update.date ? ` · ${update.date}` : ""}`;
        const title = `该文献${label}${update.date ? `（${update.date}）` : ""}${recorder ? `，${recorder}` : ""}。`;
        // A retraction is a safety tag; a correction or an expression of concern the amber one. The tag is a label and is not
        // clickable: the notice it names is a link of its own beside it, whose name is the whole sentence.
        return (
          <span key={`${update.kind}:${update.noticeDoi ?? ""}:${index}`} className="inline-flex items-center gap-1">
            <Tag tone={withdrawn ? "safety" : "warn"} title={title} className="gap-0.5">
              <FileWarning size={16} aria-hidden="true" />{text}
            </Tag>
            {update.noticeDoi && (
              <a href={`https://doi.org/${update.noticeDoi}`} target="_blank" rel="noreferrer" aria-label={`${title}查看声明`}
                className="text-meta text-link hover:underline">查看声明</a>
            )}
          </span>
        );
      })}
    </span>
  );
}
