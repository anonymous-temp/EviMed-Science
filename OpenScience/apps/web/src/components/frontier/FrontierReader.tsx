import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  FRONTIER_SPECIALTIES,
  fetchFrontierAbstractZh,
  frontierErrorMessage,
  type FrontierBody,
  type FrontierItem,
  type FrontierItemDetail,
  type FrontierMedia,
  type FrontierPlatform,
  type FrontierQuoted,
  type FrontierTopic,
} from "@/lib/frontierClient";
import { dayKey } from "@/lib/inboxGroups";
import { Button } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { filterChipClasses } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { cardFacts } from "./frontierFacts";
import { FrontierLightbox } from "./FrontierLightbox";
import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import { CARD_FLAG_KEYS, EXTERNAL, INLINE_ACTION, PLATFORM_LABELS, dateClock, evidenceTag, isSocialItem, shortDate, sinceText } from "./frontierText";

/*
 * The article reader's blocks (owner, 2026-10-22: the reader reads like AIHOT's detail page — AI 导读, 推荐理由 with AI 评分, the full
 * text with its AI translation and a 中文 / 原文 switch, the pictures, the quoted post, 主题 and 标签, 事件后续). The shapes follow
 * AIHOT's `routes/item.tsx` and `features/item/*` (MIT); the type stays EviMed's four pairs — the serif title at 24 / 600, the reading
 * text at 16, the interface at 14 and every block's label at 12, all 400 — so a block is named by its colour and its rule, not a weight.
 *
 * Every block is drawn from what the server sent and only that: a field it could not fill is null and its block is not on the page.
 */

/** The address's site, for the 来源 line (「nejm.org」). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------- moved here */

/** Explain only observed field failures; old records keep their cause unknown. */
export function frontierFallbackReason(item: FrontierItem): string | null {
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

/** The free full text, when it is not the page the title already opens. */
export function freeFullText(item: Pick<FrontierItem, "openAccess" | "url">): string | null {
  return item.openAccess?.pdfUrl && item.openAccess.pdfUrl !== item.url ? item.openAccess.pdfUrl : null;
}

/** When it was published: the moment where the source gave one, the day where it gave only the day. */
export function publishedLabel(item: Pick<FrontierItem, "publishedAt" | "datePrecision">): string | null {
  if (!item.publishedAt) return null;
  if (item.datePrecision === "instant") return dateClock(item.publishedAt);
  const key = dayKey(item.publishedAt);
  return key ? shortDate(key) : null;
}

/** A literature item that may have an abstract; the no-abstract flag says when it does not. */
export function abstractOffered(item: FrontierItem): boolean {
  if (item.flags.some((flag) => flag.key === "no-abstract")) return false;
  return Boolean(item.doi || item.pmid) || item.sourceType === "journal" || item.sourceType === "preprint";
}

/* ---------------------------------------------------------------- language */

export type ReaderLanguage = "zh" | "original";
const LANGUAGE_KEY = "evimed:frontier-reader-language";

/** 中文 or 原文, as the reader last chose it in this session (AIHOT keeps it in the address; here one choice holds for every article). */
export function useReaderLanguage(): [ReaderLanguage, (language: ReaderLanguage) => void] {
  const [language, setLanguage] = useState<ReaderLanguage>(() => {
    try { return sessionStorage.getItem(LANGUAGE_KEY) === "original" ? "original" : "zh"; } catch { return "zh"; }
  });
  const choose = useCallback((next: ReaderLanguage) => {
    setLanguage(next);
    try { sessionStorage.setItem(LANGUAGE_KEY, next); } catch { /* a session that cannot store keeps the choice for this page */ }
  }, []);
  return [language, choose];
}

/* ------------------------------------------------------------------ blocks */

/** A block's name: 12 / 400 in the secondary grey (the lead's in the accent), as every block of the reader names itself. */
const LABEL = "text-caption text-text-3";

function Block({ label, labelClassName, aside, ruled = false, className, children }: {
  label: ReactNode;
  labelClassName?: string;
  aside?: ReactNode;
  /** A hairline above it, where the block starts a new part of the page. */
  ruled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn(ruled && "border-t border-border pt-4", className)}>
      <div className="mb-3 flex min-h-sm flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id={id} className={labelClassName ?? LABEL}>{label}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * The line over the text: who said it — the account for a post, the institution for anything else, with an article's own author —
 * its handle, the platform, when, and how long ago; then what the item is (a safety alert, EviMed's own, its evidence type, a
 * retraction or a preprint), as the card says it.
 */
export function ReaderByline({ item, className }: { item: FrontierItem; className?: string }) {
  const social = isSocialItem(item);
  const name = social && item.author ? item.author.name : item.source.name;
  const byline = !social && item.author && item.author.name !== item.source.name ? item.author.name : null;
  const handle = social ? item.author?.handle ?? null : null;
  const platform = item.platform ? PLATFORM_LABELS[item.platform] : null;
  const at = item.publishedAt ?? item.timelineAt;
  const when = item.publishedAt ? publishedLabel(item) : `收录于 ${dateClock(item.timelineAt)}`;
  const since = sinceText(at);
  const evidence = evidenceTag(item);
  const flags = item.flags.filter((flag) => CARD_FLAG_KEYS.has(flag.key));
  const parts = [
    <span key="name" className="text-text">{name}</span>,
    ...(byline ? [<span key="byline">{byline}</span>] : []),
    ...(handle ? [<span key="handle">@{handle}</span>] : []),
    ...(platform ? [<span key="platform">{platform}</span>] : []),
    ...(when ? [<time key="when" dateTime={at} className="tabular-nums">{when}</time>] : []),
    ...(since ? [<span key="since">{since}</span>] : []),
    ...flags.filter((flag) => flag.key !== "retracted").map((flag) => <span key={flag.key}>{flag.label}</span>),
  ];
  return (
    <div className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui text-text-3", className)}>
      {item.safetyAlert && <Tag tone="safety">安全警示</Tag>}
      {flags.filter((flag) => flag.key === "retracted").map((flag) => <Tag key={flag.key} tone="safety">{flag.label}</Tag>)}
      {parts.map((part, index) => (
        <span key={part.key} className="inline-flex items-center gap-x-1.5">
          {index > 0 && <span aria-hidden="true">·</span>}
          {part}
        </span>
      ))}
      {item.source.platformProduced && <Tag>EviMed 出品</Tag>}
      {evidence && <Tag>{evidence}</Tag>}
    </div>
  );
}

/** 「AI 导读」: the two or three sentences that answer first, set as the reading text. */
export function ReaderLead({ text, className }: { text: string; className?: string }) {
  return (
    <Block label="AI 导读" labelClassName="text-caption text-accent" className={className}>
      <p className="max-w-measure-body whitespace-pre-line text-body text-text">{text}</p>
    </Block>
  );
}

/** A long text shows this much until the reader asks for the rest: a page of six windows needs contents, and plain text has none. */
const FOLD_AT = 3_000;
const FOLDED_LENGTH = 1_800;

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

/**
 * The text itself — the article or the post (`正文`), or a paper's abstract (`摘要`) — in Chinese or in the original. Where there is a
 * translation and an original the block's row has 中文 · 原文 and names what is on screen (「正文 · AI 翻译」, 「正文 · 原文」); a
 * translation the server says is partial says so once, with the way to the whole original. A text over three thousand characters
 * opens at its first paragraphs, and 「展开全文」 shows the rest in place.
 */
export function ReaderText({ kind, text, lang, language, onLanguage, className }: {
  kind: "正文" | "摘要";
  text: FrontierBody;
  /** The original's language (`lang` on its paragraphs); `und` is not said. */
  lang: string;
  language: ReaderLanguage;
  onLanguage: (language: ReaderLanguage) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const switchable = Boolean(text.zh && text.original && text.zhKind === "translation");
  const showing: ReaderLanguage = !text.zh ? "original" : !text.original ? "zh" : switchable ? language : "zh";
  const shown = (showing === "zh" ? text.zh : text.original) ?? "";
  const translated = showing === "zh" && text.zhKind === "translation";
  const originalIsChinese = /^zh/i.test(lang);
  const label = translated ? `${kind} · AI 翻译` : showing === "original" && !originalIsChinese && text.zhKind !== "original-zh" ? `${kind} · 原文` : kind;
  const all = paragraphs(shown);
  let visible = all;
  if (!open && shown.length > FOLD_AT) {
    let length = 0;
    visible = all.filter((part) => { const keep = length < FOLDED_LENGTH; length += part.length; return keep; });
  }
  const textLang = showing === "original" && lang !== "und" ? lang : undefined;
  return (
    <Block
      ruled
      label={label}
      className={className}
      aside={switchable ? (
        <Toolbar label="语言" filters={[{
          kind: "chips", label: `${kind}语言`, pinned: true, value: showing,
          options: [{ value: "zh", label: "中文" }, { value: "original", label: "原文" }],
          onChange: (next) => onLanguage(next === "original" ? "original" : "zh"),
        }]} />
      ) : undefined}
    >
      {translated && !text.complete && text.original && (
        <Note className="mb-4" action={<Button variant="text" size="sm" onClick={() => onLanguage("original")}>看原文</Button>}>译文尚不完整</Note>
      )}
      <div data-prose="" lang={textLang} className="max-w-measure-body space-y-4 text-body text-text">
        {visible.map((part, index) => <p key={index} className="whitespace-pre-line break-words">{part}</p>)}
      </div>
      {visible.length < all.length && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => setOpen(true)}>展开全文</Button>
      )}
    </Block>
  );
}

type AbstractState = { kind: "loading" } | { kind: "ready"; zh: string | null; original: string | null } | { kind: "error"; message: string };

/**
 * A paper's abstract where the item has no full text: the shared Chinese abstract — written once, on the first request, and then read by
 * everyone (plan §10.3.6) — beside the original. Where the Chinese cannot be written (the budget, a failed number check, a server
 * that does not offer it) the original stands alone under its own name; where there is no abstract at all there is no block.
 */
export function ReaderAbstract({ item, language, onLanguage, className }: {
  item: FrontierItemDetail;
  language: ReaderLanguage;
  onLanguage: (language: ReaderLanguage) => void;
  className?: string;
}) {
  const ask = !item.abstractZh && abstractOffered(item);
  const [state, setState] = useState<AbstractState>(() => (ask ? { kind: "loading" } : { kind: "ready", zh: item.abstractZh, original: item.abstract }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ask) return undefined;
    let active = true;
    setState({ kind: "loading" });
    fetchFrontierAbstractZh(item.id).then(
      (answer) => { if (active) setState({ kind: "ready", zh: answer?.abstractZh ?? null, original: answer?.abstract ?? item.abstract }); },
      (error: unknown) => { if (active) setState({ kind: "error", message: frontierErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [ask, item.id, item.abstract, attempt]);

  if (state.kind === "loading") {
    return (
      <Block ruled label="摘要" className={className}>
        <div className="animate-pulse space-y-2" aria-hidden="true">
          <div className="h-3.5 w-full rounded bg-surface-2" />
          <div className="h-3.5 w-11/12 rounded bg-surface-2" />
          <div className="h-3.5 w-2/3 rounded bg-surface-2" />
        </div>
      </Block>
    );
  }
  if (state.kind === "error") {
    return (
      <Block ruled label="摘要" className={className}>
        <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-text-2">
          <span>{state.message}</span>
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" />重试</Button>
        </div>
      </Block>
    );
  }
  if (!state.zh && !state.original) return null;
  const chinese = /^zh/i.test(item.lang);
  const text: FrontierBody = chinese && !state.zh
    ? { zh: state.original, original: null, zhKind: "original-zh", complete: true }
    : { zh: state.zh, original: state.original, zhKind: state.zh ? (chinese ? "original-zh" : "translation") : null, complete: true };
  return <ReaderText kind="摘要" text={text} lang={item.lang} language={language} onLanguage={onLanguage} className={className} />;
}

/**
 * The item's pictures: up to four tiles — the fourth says how many more there are — each opening the viewer, which steps through all of
 * them. A picture this deployment can no longer serve leaves the grid rather than standing as a broken box.
 */
export function ReaderMedia({ media, className }: { media: readonly FrontierMedia[]; className?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const shown = media.filter((picture) => !failed.includes(picture.id));
  if (shown.length === 0) return null;
  const tiles = shown.slice(0, 4);
  const hidden = shown.length - tiles.length;
  const single = tiles.length === 1;
  return (
    <div className={className}>
      <div className={cn("grid gap-2", single ? "max-w-md grid-cols-1" : tiles.length === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2")}>
        {tiles.map((picture, index) => (
          <button
            key={picture.id}
            type="button"
            onClick={() => setOpen(index)}
            aria-label={picture.alt ? `查看大图：${picture.alt}` : `查看大图，第 ${index + 1} 张`}
            className={cn("group relative block cursor-zoom-in overflow-hidden rounded-card bg-surface-2", !single && "aspect-[16/10]")}
          >
            <img
              src={picture.url}
              alt={picture.alt ?? ""}
              width={picture.width ?? undefined}
              height={picture.height ?? undefined}
              loading="lazy"
              decoding="async"
              onError={() => setFailed((current) => (current.includes(picture.id) ? current : [...current, picture.id]))}
              className={cn("block w-full object-cover", single ? "max-h-96" : "h-full")}
              style={single && picture.width && picture.height ? { aspectRatio: `${picture.width} / ${picture.height}` } : undefined}
            />
            {index === tiles.length - 1 && hidden > 0 && (
              <span className="absolute bottom-2 right-2 rounded bg-surface px-2 text-ui tabular-nums text-text">+{hidden}</span>
            )}
          </button>
        ))}
      </div>
      <FrontierLightbox media={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </div>
  );
}

/**
 * The post this one quotes (an X quote, the source a WeChat repost names), as X shows it under the post (AIHOT `QuotedPost`, MIT): who
 * wrote it, what they said — in Chinese with the original a press away, or the original while the reader reads the original — and the
 * way to it.
 */
export function ReaderQuote({ quoted, platform, language, className }: {
  quoted: FrontierQuoted;
  platform: FrontierPlatform | null;
  language: ReaderLanguage;
  className?: string;
}) {
  const zh = language === "original" ? null : quoted.translation;
  return (
    <figure className={cn("rounded-card border border-border px-4 py-3.5", className)}>
      <figcaption className="flex flex-wrap items-baseline gap-x-1.5 text-ui text-text-3">
        <span>引用</span>
        <span className="text-text">{quoted.author.name}</span>
        {quoted.author.handle && <span>@{quoted.author.handle}</span>}
      </figcaption>
      <blockquote className="mt-2 whitespace-pre-line break-words text-body text-text-2">{zh ?? quoted.text}</blockquote>
      {zh && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-caption text-text-3 hover:text-text">原文</summary>
          <p className="mt-1.5 whitespace-pre-line break-words text-ui text-text-3">{quoted.text}</p>
        </details>
      )}
      {quoted.url && (
        <a href={quoted.url} {...EXTERNAL} className={cn(INLINE_ACTION, "-ml-1.5 mt-2 px-1.5 text-link")}>
          {platform === "x" ? "在 X 查看被引用的帖子" : "查看引用的原文"}<span aria-hidden="true"> ↗</span>
        </a>
      )}
    </figure>
  );
}

/**
 * Where it came from: 「来源：NEJM · nejm.org」 with the free full text and the other institutions that reported it; then what the card
 * left out of a paper — its journal, authors, impact factor, the trial — as one list of facts.
 */
export function ReaderSource({ item, reports, className }: {
  item: FrontierItemDetail;
  /** The other institutions' reports, as the item's actions list them (`useItemActions`). */
  reports: MenuEntry[];
  className?: string;
}) {
  const name = isSocialItem(item) && item.author ? item.author.name : item.source.name;
  const host = hostOf(item.url);
  const pdf = freeFullText(item);
  const facts = cardFacts(item);
  const also = item.alsoReportedCount;
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui text-text-3">
        <span>来源：<a href={item.url} {...EXTERNAL} className="rounded text-text-2 hover:text-accent hover:underline">{name}</a></span>
        {host && <span>· {host}</span>}
        {pdf && (
          <a href={pdf} {...EXTERNAL} className={cn(INLINE_ACTION, "ml-2 px-1.5 text-link")}>
            免费全文<span aria-hidden="true"> ↗</span>
          </a>
        )}
        {also > 0 && (
          <Menu label={`另有 ${also} 家报道`} align="start" items={reports}>
            <button type="button" className={cn(INLINE_ACTION, "ml-1 px-1.5 hover:text-text")}>另有 {also} 家报道 ›</button>
          </Menu>
        )}
      </div>
      {facts.length > 0 && <FactList className="mt-3 max-w-measure-body" rows={facts.map((fact) => ({ label: fact.label, value: fact.text }))} />}
    </div>
  );
}

const articlePath = (id: string) => `/app/frontier/items/${encodeURIComponent(id)}`;

/**
 * 「事件后续 · N」: the other developments of the occurrence this item reports — another report of it (「同事件」) or what happened next
 * (「后续」) — newest first, each opening its own article, with the way to the whole event. Not on the page when there are none.
 */
export function ReaderFollowups({ item, className }: { item: FrontierItemDetail; className?: string }) {
  const origin = useFrontierOrigin();
  const location = useLocation();
  const followups = item.followups;
  if (!followups || followups.rows.length === 0) return null;
  const here = { to: `${location.pathname}${location.search}`, label: item.title };
  return (
    <Block
      ruled
      className={className}
      label={<>事件后续 <span className="tabular-nums">· {followups.rows.length}{followups.more ? "+" : ""}</span></>}
      aside={(
        <Link to={`/app/frontier/events/${encodeURIComponent(followups.eventId)}`} state={origin} onClick={rememberFrontierPosition}
          className={cn(INLINE_ACTION, "-mr-1.5 px-1.5 text-link")}>
          查看事件全部 ›
        </Link>
      )}
    >
      <List divided label="事件后续">
        {followups.rows.map((row) => {
          const since = sinceText(row.at);
          return (
            <ListRow
              key={row.itemId}
              to={articlePath(row.itemId)}
              state={{ ...origin, evidenceFrom: here }}
              title={row.title}
              leading={<span className="w-12"><Tag>{row.relation === "follows" ? "后续" : "同事件"}</Tag></span>}
              meta={[row.sourceName, since].filter(Boolean).join(" · ") || undefined}
            />
          );
        })}
      </List>
    </Block>
  );
}

/** 「同一件事，精选收录的是《…》」: this item reports an occurrence whose selected report is another one. */
export function ReaderSameEvent({ item, className }: { item: FrontierItemDetail; className?: string }) {
  const origin = useFrontierOrigin();
  const location = useLocation();
  if (!item.sameEvent) return null;
  return (
    <p className={cn("text-ui text-text-3", className)}>
      同一件事，精选收录的是
      <Link to={articlePath(item.sameEvent.itemId)} state={{ ...origin, evidenceFrom: { to: `${location.pathname}${location.search}`, label: item.title } }}
        className="rounded text-text-2 hover:text-accent hover:underline">《{item.sameEvent.title}》</Link>
    </p>
  );
}

/** A topic the feed can be narrowed to: a specialty it filters by. Any other topic is a label (DESIGN.md rule 5). */
const SPECIALTY_KEYS: ReadonlySet<string> = new Set(FRONTIER_SPECIALTIES.map((specialty) => specialty.key));

/** The topics an older server did not send: the item's specialties. */
function topicsOf(item: FrontierItemDetail): FrontierTopic[] {
  return item.topics ?? item.specialties.map((specialty) => ({ slug: specialty.key, name: specialty.label, group: "specialty" as const }));
}

/** The #tags an older server did not send: what the item is, and the diseases and drugs it names. */
function tagsOf(item: FrontierItemDetail): string[] {
  if (item.tags) return item.tags;
  const evidence = evidenceTag(item);
  return [...new Set([...(evidence ? [evidence] : []), ...item.entities.diseases, ...item.entities.drugs])].slice(0, 8);
}

/** 推荐理由 is drawn: the item has a reason or a score, and it is not the other report of an occurrence selected through another one. */
const hasVerdict = (item: FrontierItemDetail) => !item.sameEvent && Boolean(item.reason || item.score !== null);

/** Whether the right column has anything to show: a page without it keeps its text column, and no empty column is drawn. */
export function hasReaderNotes(item: FrontierItemDetail): boolean {
  return hasVerdict(item) || topicsOf(item).length > 0 || tagsOf(item).length > 0;
}

function RailBlock({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-border pt-3.5">
      <h2 id={id} className={LABEL}>{label}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/**
 * The reader's right column (folded under the text on a phone): 推荐理由 — 「精选」, 「AI 评分 N」 and the sentence of what a clinician
 * or a researcher can do with it — then 主题 and 标签. An item whose occurrence was selected through another report has no 推荐理由:
 * the line over its text sends the reader to that one.
 */
export function ReaderNotes({ item }: { item: FrontierItemDetail }) {
  const verdict = hasVerdict(item);
  const topics = topicsOf(item);
  const tags = tagsOf(item);
  if (!hasReaderNotes(item)) return null;
  return (
    <div className="flex flex-col gap-8">
      {verdict && (
        <RailBlock label={item.reason ? "推荐理由" : "AI 评分"}>
          <div className="flex flex-wrap items-center gap-2">
            {item.selected && (
              <Tag><span aria-hidden="true" className="mr-1 h-1.5 w-1.5 rounded-full bg-accent" />精选</Tag>
            )}
            {item.score !== null && <Tag className="tabular-nums">AI 评分 {item.score}</Tag>}
          </div>
          {item.reason && <p className="mt-3 text-ui text-text-2">{item.reason}</p>}
        </RailBlock>
      )}
      {topics.length > 0 && (
        <RailBlock label="主题">
          <ul className="flex flex-wrap gap-1.5">
            {topics.map((topic) => (
              <li key={topic.slug}>
                {topic.group === "specialty" && SPECIALTY_KEYS.has(topic.slug) ? (
                  <Link to={`/app/frontier?view=all&specialty=${encodeURIComponent(topic.slug)}`} className={filterChipClasses({ selected: true })}>{topic.name}</Link>
                ) : <Tag>{topic.name}</Tag>}
              </li>
            ))}
          </ul>
        </RailBlock>
      )}
      {tags.length > 0 && (
        <RailBlock label="标签">
          <ul className="flex flex-wrap gap-1.5">
            {tags.map((tag) => <li key={tag}><Tag>#{tag}</Tag></li>)}
          </ul>
        </RailBlock>
      )}
    </div>
  );
}
