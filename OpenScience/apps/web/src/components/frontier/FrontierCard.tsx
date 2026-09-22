import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { BookmarkPlus, ChevronDown, EyeOff, Loader2, Microscope, RefreshCw, ShieldAlert, Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchFrontierAbstractZh, fetchFrontierItem, frontierErrorMessage, type FrontierItem } from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { FrontierChip } from "./FrontierChip";
import {
  CARD_FLAG_KEYS,
  CARD_MAX_TOPICS,
  LEVEL_DIMENSIONS,
  LEVEL_WORDS,
  RESEARCH_INTENTS,
  evidenceBasisSentence,
  flagTone,
  itemWhen,
  researchDraft,
  selectedRuleSentence,
  sourceTypeTone,
  verificationSentence,
  type ResearchIntent,
} from "./frontierText";
import { useOpenedOnce } from "./useOpenedOnce";

/** A quiet text action: the feed has thirty cards, and thirty rows of bordered buttons would be the page. */
const ACTION = "inline-flex items-center gap-1 rounded text-ui text-muted transition-colors duration-fast hover:text-text disabled:cursor-not-allowed disabled:opacity-40";

/** A new tab, and nothing of this page's context handed to the site. */
const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

export interface FrontierCardProps {
  item: FrontierItem;
  /** Say 「精选」 on selected items — in 全部 and in search results, where not every item is. */
  markSelected?: boolean;
  onStar: (item: FrontierItem) => void;
  onHide: (item: FrontierItem) => void;
  /** 「存入知识库」; absent where this server cannot save yet. */
  onSave?: (item: FrontierItem) => void;
  saving?: boolean;
  /** The reader followed a link to the original. */
  onOpened?: (item: FrontierItem) => void;
}

/**
 * One item (plan §4.3): who said it, how hard the evidence is, what it says,
 * why it matters, who else is saying it, and what the reader can do with it.
 *
 * Three variants are the medical difference from a tech feed: a safety alert
 * sits on the danger ground and says 「安全警示」 first; a preprint always says
 * 「未经同行评议」; a company newsroom's topline says 「企业新闻稿 · 数据未发表」.
 * The last two are flags the server attaches, rendered in the caution tone.
 *
 * No score, no like, no count of readers: the four dimensions are behind
 * 「为什么入选」, in 高 / 中 / 低.
 */
export function FrontierCard({ item, markSelected = false, onStar, onHide, onSave, saving = false, onOpened }: FrontierCardProps) {
  const titleId = useId();
  const safety = item.safetyAlert;
  const when = itemWhen(item);
  // A specialty says what the item is about; an item without one (the AI lane,
  // most policy) says its lane instead, as the design's AI card does.
  const topics = (item.specialties.length > 0 ? item.specialties : item.laneLabel ? [{ key: item.lane, label: item.laneLabel }] : [])
    .slice(0, CARD_MAX_TOPICS);
  const flags = item.flags.filter((flag) => CARD_FLAG_KEYS.has(flag.key));
  // 「其他」 is the evidence vocabulary's remainder: on a card it tells a reader nothing.
  const evidence = item.evidenceType && item.evidenceType !== "other" ? item.evidenceTypeLabel : null;
  const pdf = item.openAccess?.pdfUrl && item.openAccess.pdfUrl !== item.url ? item.openAccess.pdfUrl : null;
  const starred = item.state.starred;
  return (
    <article
      aria-labelledby={titleId}
      data-frontier-item={item.id}
      className={cn("rounded-card border p-4", safety ? "border-danger bg-danger-soft" : "border-border bg-surface")}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
        {safety && <FrontierChip tone="danger"><ShieldAlert size={12} aria-hidden="true" />安全警示</FrontierChip>}
        {item.sourceTypeLabel && <FrontierChip tone={sourceTypeTone(item.sourceType)}>{item.sourceTypeLabel}</FrontierChip>}
        <span className="font-medium text-text-2">{item.source.name}</span>
        {when && <><span aria-hidden="true">·</span><time dateTime={item.publishedAt ?? item.timelineAt}>{when}</time></>}
        {evidence && <FrontierChip tone="outline">{evidence}</FrontierChip>}
        {topics.map((topic) => <FrontierChip key={topic.key}>{topic.label}</FrontierChip>)}
        {flags.map((flag) => <FrontierChip key={flag.key} tone={flagTone(flag.key)}>{flag.label}</FrontierChip>)}
        {markSelected && item.selected && <FrontierChip tone="accent">精选</FrontierChip>}
      </div>

      <h3 id={titleId} className="mt-2 text-body font-semibold text-text">{item.title}</h3>
      {/* The Chinese title is for reading, the original for finding (plan §10.3.6). */}
      {item.titleZh && item.titleRaw !== item.titleZh && (
        <p className="mt-0.5 text-caption text-muted" lang={item.lang !== "und" ? item.lang : undefined}>{item.titleRaw}</p>
      )}
      {item.summary && <p className="mt-2 text-ui text-text-2">{item.summary}</p>}
      {item.reason && (
        <p className={cn("mt-3 rounded px-3 py-2 text-ui text-text", safety ? "bg-surface" : "bg-accent-soft")}>
          <span className="mr-2 font-medium text-accent-strong">为什么值得看</span>{item.reason}
        </p>
      )}
      {(item.alsoReportedBy.length > 0 || item.event) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-1 text-caption text-muted">
          {item.alsoReportedBy.length > 0 && <>
            <span>还有谁在说：</span>
            {item.alsoReportedBy.map((mention, index) => (
              <span key={`${mention.sourceId}-${mention.url}`}>
                <a href={mention.url} {...EXTERNAL} className="text-link hover:underline">{mention.sourceName}</a>
                {index < item.alsoReportedBy.length - 1 && <span aria-hidden="true">、</span>}
              </span>
            ))}
          </>}
          {item.event && <>
            {item.alsoReportedBy.length > 0 && <span aria-hidden="true" className="mx-1">·</span>}
            <Link to={`/app/frontier/events/${encodeURIComponent(item.event.id)}`} className="text-link hover:underline">同一事件的全部报道 →</Link>
          </>}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <a href={item.url} {...EXTERNAL} onClick={() => onOpened?.(item)} className="text-ui font-medium text-link hover:underline">
          原文<span aria-hidden="true"> ↗</span>
        </a>
        {pdf && (
          <a href={pdf} {...EXTERNAL} onClick={() => onOpened?.(item)} className="text-ui text-link hover:underline">
            免费全文<span aria-hidden="true"> ↗</span>
          </a>
        )}
        <ResearchMenu item={item} />
        {onSave && (
          <button type="button" className={ACTION} disabled={saving} aria-busy={saving || undefined} onClick={() => onSave(item)}>
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <BookmarkPlus size={14} aria-hidden="true" />}存入知识库
          </button>
        )}
        <button type="button" aria-pressed={starred} className={cn(ACTION, starred && "text-accent")} onClick={() => onStar(item)}>
          <Star size={14} aria-hidden="true" fill={starred ? "currentColor" : "none"} />{starred ? "已收藏" : "收藏"}
        </button>
        <button type="button" className={ACTION} onClick={() => onHide(item)}>
          <EyeOff size={14} aria-hidden="true" />不感兴趣
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-1 border-t border-faint pt-2">
        {abstractOffered(item) && <AbstractDetails itemId={item.id} />}
        <Disclosure className="min-w-0 open:basis-full" summaryClassName="text-caption" summary={item.selected ? "为什么入选" : "评估与核对"}>
          <SelectionDetails item={item} />
        </Disclosure>
      </div>
    </article>
  );
}

/** A literature item that may have an abstract; the no-abstract flag says when it does not. */
function abstractOffered(item: FrontierItem): boolean {
  if (item.flags.some((flag) => flag.key === "no-abstract")) return false;
  return Boolean(item.doi || item.pmid) || item.sourceType === "journal" || item.sourceType === "preprint";
}

/**
 * The four levels, the selection rule and the number check (plan §4.3). Only
 * words: the scores behind the levels are not on the wire.
 */
function SelectionDetails({ item }: { item: FrontierItem }) {
  const levels = LEVEL_DIMENSIONS.flatMap(({ key, label }) => {
    const level = item.levels[key];
    return level ? [{ key, label, level }] : [];
  });
  const rule = item.selected ? selectedRuleSentence(item.selectedRule) : null;
  const basis = evidenceBasisSentence(item.evidenceBasis);
  return (
    <div className="space-y-1.5 text-caption text-muted">
      {levels.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="四个维度">
          {levels.map((entry) => (
            <li key={entry.key}><FrontierChip tone={entry.level === "high" ? "ok" : "neutral"}>{entry.label} {LEVEL_WORDS[entry.level]}</FrontierChip></li>
          ))}
        </ul>
      ) : <p>这一条还没有评估。</p>}
      {rule && <p>{rule}</p>}
      <p>{verificationSentence(item)}</p>
      {basis && <p>{basis}</p>}
    </div>
  );
}

/** 「中文摘要」: read the first time it is opened, never before. */
function AbstractDetails({ itemId }: { itemId: string }) {
  const [ref, opened] = useOpenedOnce();
  return (
    <div ref={ref} className="contents">
      <Disclosure className="min-w-0 open:basis-full" summaryClassName="text-caption" summary="中文摘要">
        {opened ? <AbstractBody itemId={itemId} /> : null}
      </Disclosure>
    </div>
  );
}

type AbstractState =
  | { kind: "loading" }
  | { kind: "ready"; text: string; note: string | null }
  | { kind: "none" }
  | { kind: "error"; message: string };

/**
 * The shared Chinese abstract, written once on first request and then read by
 * everyone (plan §10.3.6). Where it cannot be written — the budget, a failed
 * number check, or a server that does not offer it yet — the original
 * abstract is shown under a sentence that says so, rather than nothing.
 */
function AbstractBody({ itemId }: { itemId: string }) {
  const [state, setState] = useState<AbstractState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    const read = async (): Promise<{ text: string; note: string | null } | null> => {
      const answer = await fetchFrontierAbstractZh(itemId);
      if (answer?.abstractZh) return { text: answer.abstractZh, note: answer.note };
      if (answer?.abstract) return { text: answer.abstract, note: answer.note ?? "中文摘要这次没有生成，下面是原文摘要。" };
      if (answer) return null;
      // No route to write one yet: an abstract already written is still on the item.
      const detail = await fetchFrontierItem(itemId);
      if (detail.abstractZh) return { text: detail.abstractZh, note: null };
      return detail.abstract ? { text: detail.abstract, note: "中文摘要还在准备，下面是原文摘要。" } : null;
    };
    read().then(
      (found) => { if (active) setState(found ? { kind: "ready", ...found } : { kind: "none" }); },
      (error: unknown) => { if (active) setState({ kind: "error", message: frontierErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [itemId, attempt]);

  if (state.kind === "loading") {
    return <p role="status" className="flex items-center gap-1.5 text-caption text-muted"><Loader2 size={12} className="animate-spin" aria-hidden="true" />正在读取摘要…</p>;
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-muted">
        <span>{state.message}</span>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={12} aria-hidden="true" />重试</Button>
      </div>
    );
  }
  if (state.kind === "none") return <p className="text-caption text-muted">这一条没有可显示的摘要，点「原文」阅读。</p>;
  return (
    <div className="space-y-1">
      {state.note && <p className="text-caption text-muted">{state.note}</p>}
      <p className="whitespace-pre-line text-ui text-text-2">{state.text}</p>
    </div>
  );
}

/**
 * 「深入研究」: three prepared questions and a free one (plan §4.7). Choosing
 * one opens a new conversation with the draft in the composer — the same
 * `runtimeUiIntent` a tool's example question travels in — and nothing is
 * sent: the reader reads the draft and presses send. The router decides
 * whether a research tool takes it, as for anything typed there.
 */
export function ResearchMenu({ item }: { item: FrontierItem }) {
  const navigate = useNavigate();
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node | null)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [open]);

  const choose = (intent: ResearchIntent) => {
    setOpen(false);
    navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(researchDraft(item, intent)) } });
  };

  // Arrow keys move between the four choices, as in any menu.
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(ACTION, "font-medium text-text")}
      >
        <Microscope size={14} aria-hidden="true" />深入研究<ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving focus lives on the menu items, not the container (WAI menu pattern).
        <div id={menuId} role="menu" aria-label="深入研究" onKeyDown={onMenuKey}
          className="absolute left-0 z-30 mt-1 min-w-56 rounded-card border border-border bg-surface p-1 shadow-pop">
          {RESEARCH_INTENTS.map((intent) => (
            <button key={intent.key} type="button" role="menuitem" onClick={() => choose(intent.key)}
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-ui text-text hover:bg-surface-2 focus-visible:bg-surface-2">
              {intent.label}
            </button>
          ))}
          <p className="px-2 pb-1 pt-1.5 text-caption text-muted">会带着这条动态打开新对话，发送前你可以改。</p>
        </div>
      )}
    </div>
  );
}
