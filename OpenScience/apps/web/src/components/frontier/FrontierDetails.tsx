import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchFrontierAbstractZh, fetchFrontierItem, frontierErrorMessage, type FrontierItem } from "@/lib/frontierClient";
import { dayKey } from "@/lib/inboxGroups";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { cardFacts } from "./frontierFacts";
import { EXTERNAL, INLINE_ACTION, dateClock, shortDate } from "./frontierText";

/**
 * 「⋯ › 详情」: what the card left out so that it could be a card — the
 * original title, the journal, the authors, the impact factor, the free full
 * text — and the abstract, read the first time it is asked for (plan 2026-09-23
 * §6.3: 期刊/作者/影响因子那一行移到「⋯」里的详情).
 */
export function FrontierDetails({ item, onClose, onOpened }: { item: FrontierItem; onClose: () => void; onOpened?: (item: FrontierItem) => void }) {
  const facts = cardFacts(item);
  const pdf = item.openAccess?.pdfUrl && item.openAccess.pdfUrl !== item.url ? item.openAccess.pdfUrl : null;
  const published = publishedLabel(item);
  const rows: Array<[string, string, string | undefined]> = [
    ["来源", item.source.name, undefined],
    ...(published ? [["发布", published, undefined] as [string, string, undefined]] : []),
    ...(item.titleZh && item.titleRaw !== item.titleZh ? [["原标题", item.titleRaw, item.lang !== "und" ? item.lang : undefined] as [string, string, string | undefined]] : []),
    ...facts.map((fact) => [fact.label, fact.text, undefined] as [string, string, undefined]),
  ];
  return (
    <Drawer title={item.title} onClose={onClose}>
      <div className="space-y-6">
        {item.summary && <p className="max-w-measure text-ui text-text">{item.summary}</p>}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
          {rows.map(([label, value, lang]) => (
            <div key={label} className="contents">
              <dt className="text-text-3">{label}</dt>
              <dd className="min-w-0 break-words text-text" lang={lang}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="-ml-1.5 flex flex-wrap items-center gap-2">
          <a href={item.url} {...EXTERNAL} onClick={() => onOpened?.(item)} className={cn(INLINE_ACTION, "px-1.5 text-accent")}>
            原文<span aria-hidden="true"> ↗</span>
          </a>
          {pdf && (
            <a href={pdf} {...EXTERNAL} onClick={() => onOpened?.(item)} className={cn(INLINE_ACTION, "px-1.5 text-accent")}>
              免费全文<span aria-hidden="true"> ↗</span>
            </a>
          )}
        </div>
        {abstractOffered(item) && <AbstractSection itemId={item.id} />}
      </div>
    </Drawer>
  );
}

/** When it was published: the moment where the source gave one, the day where it gave only the day. */
function publishedLabel(item: Pick<FrontierItem, "publishedAt" | "datePrecision">): string | null {
  if (!item.publishedAt) return null;
  if (item.datePrecision === "instant") return dateClock(item.publishedAt);
  const key = dayKey(item.publishedAt);
  return key ? shortDate(key) : null;
}

/** A literature item that may have an abstract; the no-abstract flag says when it does not. */
function abstractOffered(item: FrontierItem): boolean {
  if (item.flags.some((flag) => flag.key === "no-abstract")) return false;
  return Boolean(item.doi || item.pmid) || item.sourceType === "journal" || item.sourceType === "preprint";
}

type AbstractState =
  | { kind: "loading" }
  | { kind: "ready"; text: string; chinese: boolean }
  | { kind: "none" }
  | { kind: "error"; message: string };

/**
 * The shared Chinese abstract, written once on first request and then read by
 * everyone (plan §10.3.6). Where it cannot be written — the budget, a failed
 * number check, or a server that does not offer it yet — the original
 * abstract is shown under its own name, 「原文摘要」, rather than nothing.
 */
function AbstractSection({ itemId }: { itemId: string }) {
  const [state, setState] = useState<AbstractState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    const read = async (): Promise<{ text: string; chinese: boolean } | null> => {
      const answer = await fetchFrontierAbstractZh(itemId);
      if (answer?.abstractZh) return { text: answer.abstractZh, chinese: true };
      if (answer?.abstract) return { text: answer.abstract, chinese: false };
      if (answer) return null;
      // No route to write one yet: an abstract already written is still on the item.
      const detail = await fetchFrontierItem(itemId);
      if (detail.abstractZh) return { text: detail.abstractZh, chinese: true };
      return detail.abstract ? { text: detail.abstract, chinese: false } : null;
    };
    read().then(
      (found) => { if (active) setState(found ? { kind: "ready", ...found } : { kind: "none" }); },
      (error: unknown) => { if (active) setState({ kind: "error", message: frontierErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [itemId, attempt]);

  const heading = state.kind === "ready" && !state.chinese ? "原文摘要" : "中文摘要";
  return (
    <section aria-labelledby={`abstract-${itemId}`} className="space-y-2">
      <h3 id={`abstract-${itemId}`} className="text-ui font-semibold text-text">{heading}</h3>
      {state.kind === "loading" && (
        <div className="animate-pulse space-y-2" aria-hidden="true">
          <div className="h-3.5 w-full rounded bg-surface-2" />
          <div className="h-3.5 w-11/12 rounded bg-surface-2" />
          <div className="h-3.5 w-2/3 rounded bg-surface-2" />
        </div>
      )}
      {state.kind === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-text-2">
          <span>{state.message}</span>
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" />重试</Button>
        </div>
      )}
      {state.kind === "none" && <p className="text-ui text-text-3">无摘要</p>}
      {state.kind === "ready" && <p className="max-w-measure whitespace-pre-line text-ui text-text-2">{state.text}</p>}
    </section>
  );
}
