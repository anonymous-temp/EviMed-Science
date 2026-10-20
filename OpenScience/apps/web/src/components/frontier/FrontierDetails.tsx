import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchFrontierAbstractZh, fetchFrontierItem, frontierErrorMessage, type FrontierItem, type FrontierItemDetail } from "@/lib/frontierClient";
import { dayKey } from "@/lib/inboxGroups";
import { Note } from "@/components/ui/Note";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { cardFacts } from "./frontierFacts";
import { CARD_FLAG_KEYS, EXTERNAL, INLINE_ACTION, dateClock, evidenceTag, shortDate } from "./frontierText";

/**
 * 「⋯ › 详情」: what the card left out so that it could be a card — the
 * original title, the journal, the authors, the impact factor, the free full
 * text — and the abstract, read the first time it is asked for (plan 2026-09-23
 * §6.3: 期刊/作者/影响因子那一行移到「⋯」里的详情). The first row says what the
 * item is the way its card does — 「预印本 · 未经同行评议」 — so the two agree; an
 * abstract that does not exist is not a heading with 「无摘要」 under it, it is
 * nothing.
 */
export function FrontierDetails({ item, onClose, onOpened }: { item: FrontierItem; onClose: () => void; onOpened?: (item: FrontierItem) => void }) {
  return <Drawer title={item.title} onClose={onClose}><FrontierArticleContent item={item} onOpened={onOpened} /></Drawer>;
}

export function FrontierArticleContent({ item, onOpened }: { item: FrontierItem | FrontierItemDetail; onOpened?: (item: FrontierItem) => void }) {
  const fallback = frontierFallbackReason(item);
  const facts = cardFacts(item);
  const pdf = freeFullText(item);
  const published = publishedLabel(item);
  const nature = [evidenceTag(item), ...item.flags.filter((flag) => CARD_FLAG_KEYS.has(flag.key)).map((flag) => flag.label)].filter(Boolean).join(" · ");
  const rows: Array<[string, string, string | undefined]> = [
    ...(nature ? [["性质", nature, undefined] as [string, string, undefined]] : []),
    ["来源", item.source.platformProduced ? `${item.source.name}（EviMed 出品）` : item.source.name, undefined],
    ...(published ? [["发布", published, undefined] as [string, string, undefined]] : []),
    ...(item.titleZh && item.titleRaw !== item.titleZh ? [["原标题", item.titleRaw, item.lang !== "und" ? item.lang : undefined] as [string, string, string | undefined]] : []),
    ...facts.map((fact) => [fact.label, fact.text, undefined] as [string, string, undefined]),
  ];
  return (
      <div className="space-y-6">
        {fallback && <Note action={<a href={item.url} {...EXTERNAL} className="text-link hover:underline">阅读来源</a>}>{fallback}</Note>}
        {item.summary && <section className="space-y-2"><h2 className="text-ui font-semibold text-text">AI 导读</h2><p className="max-w-measure whitespace-pre-line text-body leading-7 text-text">{item.summary}</p></section>}
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
        {"abstractZh" in item && item.abstractZh ? <StoredAbstract text={item.abstractZh} chinese /> : abstractOffered(item) ? <AbstractSection itemId={item.id} /> : "abstract" in item && item.abstract ? <StoredAbstract text={item.abstract} /> : null}
      </div>
  );
}

/** Explain only observed field failures; old records keep their cause unknown. */
function frontierFallbackReason(item: FrontierItem): string | null {
  if (item.titleZh && item.summary) return null;
  const diagnostics = item.editorDiagnostics;
  if (!diagnostics) return item.verification === "title-only" ? (item.titleZh ? "中文导读暂缺，可阅读来源了解详情。" : "目前保留来源标题，中文导读暂缺，可阅读来源了解详情。") : null;
  const title = diagnostics.fields.title_zh;
  const summary = diagnostics.fields.summary_zh;
  const messages: string[] = [];
  if (!item.titleZh && title.some((code) => ["empty", "length", "link", "language", "number", "answer_invalid"].includes(code))) {
    messages.push(title.includes("number") ? "中文标题中的数字未能与来源对应，保留原标题。" : "中文标题未能完整表达来源内容，保留原标题。");
  }
  if (!item.summary) {
    if (summary.includes("source_missing")) messages.push("来源暂未提供可用于导读的摘要或正文，可阅读来源了解详情。");
    else if (summary.includes("number")) messages.push("导读中的数字未能与来源对应，暂不展示中文导读。");
    else if (summary.some((code) => ["empty", "length", "link", "language", "answer_invalid", "withheld"].includes(code))) messages.push("中文导读尚未完成内容核对，可阅读来源了解详情。");
    else if (["pending", "deferred", "stale"].includes(diagnostics.outcome)) messages.push("中文内容暂未完成，先保留来源内容供阅读。");
  }
  return messages.join(" ") || null;
}

function StoredAbstract({ text, chinese = false }: { text: string; chinese?: boolean }) {
  return <section className="space-y-2"><h2 className="text-ui font-semibold text-text">{chinese ? "中文摘要" : "原文摘要"}</h2><p className="max-w-measure whitespace-pre-line text-body leading-7 text-text-2">{text}</p></section>;
}

/** The free full text, when it is not the page the title already opens. */
function freeFullText(item: Pick<FrontierItem, "openAccess" | "url">): string | null {
  return item.openAccess?.pdfUrl && item.openAccess.pdfUrl !== item.url ? item.openAccess.pdfUrl : null;
}

/**
 * Whether 「详情」 holds something the card does not: an abstract that may exist, the facts the card left out, the original
 * title behind a translated one, or a free full text. What the card already says (what the item is, who published it, when)
 * does not count: a button that opens a drawer repeating the card promises more than it gives.
 */
export function frontierDetailsOffered(item: FrontierItem): boolean {
  return abstractOffered(item)
    || cardFacts(item).length > 0
    || Boolean(item.titleZh && item.titleRaw !== item.titleZh)
    || freeFullText(item) !== null;
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

  // An abstract that does not exist is not a section.
  if (state.kind === "none") return null;
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
      {state.kind === "ready" && <p className="max-w-measure whitespace-pre-line text-ui text-text-2">{state.text}</p>}
    </section>
  );
}
