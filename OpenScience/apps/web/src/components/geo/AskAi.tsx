import { useState } from "react";
import { MessageSquare } from "lucide-react";
import type { GeoCell } from "@/lib/geoClient";
import { cn } from "@/lib/cn";
import { geoCellPhrase } from "./GeoCellText";
import type { GeoUnit } from "./geoText";
import { useOpenGeoConversation, type GeoConversationTarget } from "./useOpenGeoConversation";

/**
 * The draft 「问 AI」 puts in the composer for a number: what it is, its
 * value with the sample it rests on, and when it was measured — so the
 * conversation starts from the same fact the reader was looking at.
 *
 * 「玛仕度肽注射液 · 豆包 · 品牌提及率：18%，310 次里 56 次（9月22日测量）。这个数说明了什么，接下来该做什么？」
 */
export function geoNumberDraft({
  product,
  scope,
  name,
  cell,
  unit = "percent",
  date,
}: {
  product?: string | null;
  /** Where the number is from, in the reader's words: 「豆包」「通用名与品类类」. */
  scope?: string | null;
  /** The metric's name: 「品牌提及率」. */
  name: string;
  cell: GeoCell | null | undefined;
  unit?: GeoUnit;
  /** When it was measured, already in the reader's words: 「9月22日」. */
  date?: string | null;
}): string {
  const subject = [product, scope, name].filter((part): part is string => !!part).join(" · ");
  const when = date ? `（${date}测量）` : "";
  return `${subject}：${geoCellPhrase(cell, unit)}${when}。这个数说明了什么，接下来该做什么？`;
}

/**
 * 「问 AI」 beside a number or an answer: opens the project's conversation with
 * a draft that carries the fact — never sends it.
 *
 * Pass `draft` for a finished sentence (an answer, an error), or the number's
 * parts (`name`, `cell`, `date` …) and the draft is written by
 * `geoNumberDraft`.
 */
export function AskAi({
  project,
  draft,
  product,
  scope,
  name,
  cell,
  unit,
  date,
  label = "问 AI",
  className,
}: {
  project: GeoConversationTarget;
  draft?: string;
  product?: string | null;
  scope?: string | null;
  name?: string;
  cell?: GeoCell | null;
  unit?: GeoUnit;
  date?: string | null;
  label?: string;
  className?: string;
}) {
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  const text = draft ?? geoNumberDraft({ product, scope, name: name ?? "", cell, unit, date });
  return (
    <button
      type="button"
      data-geo-ask-ai=""
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        setBusy(true);
        void open(project, text).catch(() => undefined).finally(() => setBusy(false));
      }}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-caption text-accent outline-none transition-colors duration-fast hover:bg-surface-2 disabled:opacity-40",
        className,
      )}
    >
      <MessageSquare aria-hidden="true" className="h-4 w-4" />
      {label}
    </button>
  );
}
