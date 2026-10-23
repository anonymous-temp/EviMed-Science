import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation } from "react-router";
import { ArrowUpRight, MessageSquareText, MoreHorizontal, RefreshCw, Star } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  fetchFrontierAbstractZh,
  frontierErrorMessage,
  type FrontierBody,
  type FrontierInsight,
  type FrontierInsightRef,
  type FrontierItem,
  type FrontierItemDetail,
  type FrontierMedia,
  type FrontierPlatform,
  type FrontierQuoted,
} from "@/lib/frontierClient";
import { dayKey } from "@/lib/inboxGroups";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { filterChipClasses } from "@/components/ui/FilterChips";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { Outline, type OutlineEntry } from "@/components/ui/Outline";
import { ScoreBars, ScorePill } from "@/components/ui/Score";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { Tooltip } from "@/components/ui/Tooltip";
import { cardFacts } from "./frontierFacts";
import { FrontierLightbox } from "./FrontierLightbox";
import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import {
  CARD_FLAG_KEYS,
  EXTERNAL,
  INLINE_ACTION,
  PLATFORM_LABELS,
  SCORE_LABEL,
  dateClock,
  evidenceTag,
  isSocialItem,
  originalLinkLabel,
  sameAddress,
  scoreBand,
  scoreBreakdown,
  shortDate,
  shortUrl,
  sinceText,
  splitUrls,
} from "./frontierText";

/*
 * The article reader's blocks (owner, 2026-10-22: the reader reads like AIHOT's detail page — AI 导读, 推荐理由 with AI 评分, the full
 * text with its AI translation and a 中文 / 原文 switch, the pictures, the quoted post, 专科 and 标签, 事件后续; later that evening the
 * 导读 set a size above the text as AIHOT sets it, an 「AI 解读」 where the material supports one, and a full text with its sections;
 * 2026-10-23 the right column of actions and notes, a text that reads its addresses, lists and quotes, and a reading size).
 * The shapes follow AIHOT's `routes/item.tsx` and `features/item/*` (MIT). The type is EviMed's: the serif title at 24 / 600, the
 * reading text at 16 below 1280 px and 18 from there (`text-reading` / `-lg`, line height 1.8), the 导读 and a full text's section
 * headings a step above it (18 / 20), the interface at 14 and every block's label at 12, all 400 — a block is named by its colour and
 * its rule, not a weight — and one 600 in the text, the run-in heading of a structured abstract's paragraph (「Background:」), as a
 * journal sets it.
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

/** The name of a block the model wrote (「AI 导读」, 「AI 解读」): in the accent, where every other block names itself in grey. */
const AI_LABEL = "text-caption text-accent";

/**
 * 「AI 导读」: one paragraph, answer first, set a size above the reading text (18 below 1280 px, 20 from there, at 1.8) as AIHOT sets its
 * lead — the first thing read, and plainly not the article.
 */
export function ReaderLead({ text, className }: { text: string; className?: string }) {
  return (
    <Block label="AI 导读" labelClassName={AI_LABEL} className={className}>
      <p className="max-w-measure-body whitespace-pre-line break-words text-reading-lg text-text xl:max-w-read xl:text-reading-xl">{text}</p>
    </Block>
  );
}

const articlePath = (id: string) => `/app/frontier/items/${encodeURIComponent(id)}`;

/** A piece of the 解读's paragraph: its own words, or a report it cites. */
export type InsightPart = string | FrontierInsightRef;

/**
 * The 解读's paragraph as words and citations: `[n]` (ASCII brackets, n from 1) that names one of its refs is that ref; one that names
 * none stays the words it is, so a number the server sent no report for is never a dead link.
 */
export function insightParts(text: string, refs: readonly FrontierInsightRef[]): InsightPart[] {
  const byNumber = new Map(refs.map((ref) => [ref.n, ref]));
  const parts: InsightPart[] = [];
  let rest = 0;
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const ref = byNumber.get(Number(match[1]));
    if (!ref) continue;
    if (match.index > rest) parts.push(text.slice(rest, match.index));
    parts.push(ref);
    rest = match.index + match[0].length;
  }
  if (rest < text.length) parts.push(text.slice(rest));
  return parts;
}

/**
 * 「AI 解读」: what the item means, in one paragraph, for an item whose material supports it — most have none and the block is not
 * there. A report it relies on is a small superscript link to its own article, named by its title for a screen reader; under the
 * paragraph the reports it cites, one row each — title, who published it, how long ago — each opening its article, whose way back
 * returns here.
 */
export function ReaderInsight({ insight, item, className }: { insight: FrontierInsight; item: FrontierItemDetail; className?: string }) {
  const origin = useFrontierOrigin();
  const location = useLocation();
  const state = { ...origin, evidenceFrom: { to: `${location.pathname}${location.search}`, label: item.title } };
  const parts = insightParts(insight.text, insight.refs);
  const cited = insight.refs.filter((ref) => parts.includes(ref));
  return (
    <Block label="AI 解读" labelClassName={AI_LABEL} className={className}>
      <p className="max-w-measure-body whitespace-pre-line break-words text-reading text-text xl:max-w-read xl:text-reading-lg">
        {parts.map((part, index) => (typeof part === "string" ? part : (
          <sup key={index}>
            {/* One line of 12 px text with the page's corner: the look of the quoted post's 「原文」, so a citation is not a kind of
              * control of its own beside the reader's others (the release walk counts them; a post with all its blocks has 9). */}
            <Link to={articlePath(part.publicId)} state={state} aria-label={part.title}
              className="inline-block rounded px-px leading-none tabular-nums text-link hover:underline">[{part.n}]</Link>
          </sup>
        )))}
      </p>
      {cited.length > 0 && (
        <List label="解读引用的报道" className="mt-3 max-w-measure-body">
          {cited.map((ref) => (
            <ListRow
              key={ref.n}
              to={articlePath(ref.publicId)}
              state={state}
              title={ref.title}
              leading={<span className="w-5 text-caption tabular-nums text-text-3">{ref.n}</span>}
              meta={[ref.source, sinceText(ref.at)].filter(Boolean).join(" · ") || undefined}
            />
          ))}
        </List>
      )}
    </Block>
  );
}

/** A long text shows this much until the reader asks for the rest: a page of six windows needs contents, and plain text has none. */
const FOLD_AT = 3_000;
const FOLDED_LENGTH = 1_800;

/**
 * One block of a text as the reader sets it: a section heading of a full text; a paragraph — an abstract's with its own heading run in
 * at its start (`runIn`, 「Background:」 / 「背景：」); a list (its lines all start 「1.」「1、」「•」「-」); a quotation (it starts 「> 」);
 * or a source line — an address on a paragraph of its own and the short lines that name it, drawn as one small line.
 */
export type ReaderParagraph =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; runIn: string | null; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "source"; words: string[]; url: string };

/** A full text's section heading: a paragraph of its own written `## Heading` (rt-contract); nothing else starts so. */
const SECTION = /^##[ \t]+(\S.*)$/;
/**
 * A structured abstract's paragraph, `Heading: text` (rt-contract): at most forty characters before the first colon, an ASCII colon
 * followed by a space (so a link or a clock is not one) or a full-width one, and text after it. A heading is a name, so what holds a
 * sentence's end (「HR 0.82 (95% CI:」) is not one.
 */
const RUN_IN = /^([^:：\n]{1,40}?)(:[ \t]+|：[ \t]*)(?=\S)/u;
const SENTENCE_END = /[.。!?！？;；]/;
/** A list's line: a number and 「.」 or 「、」 (not a decimal), or a bullet — and its words after. */
const LIST_LINE = /^\s*(?:(\d{1,3})(?:[.．](?!\d)|[、)）])\s*|[•·▪●◦]\s*|[-*]\s+)(\S.*)$/u;
/** A paragraph that is nothing but an address. */
const ONLY_URL = /^https?:\/\/\S+$/;
/** A line short enough to be a source's name or its lead-in (「（美国FDA网站）」「原文链接：」): a position-and-length rule, not a word list. */
const SOURCE_WORDS_MAX = 30;
const ANY_SENTENCE_END = /[。！？.!?]/;

/** Lines that are all of one list — all numbered or all bulleted — as that list; null otherwise. */
function listOf(lines: readonly string[]): ReaderParagraph | null {
  const listed = lines.map((line) => LIST_LINE.exec(line));
  if (lines.length === 0 || !listed.every(Boolean)) return null;
  const ordered = listed.every((match) => match![1] !== undefined);
  if (!ordered && !listed.every((match) => match![1] === undefined)) return null;
  return { kind: "list", ordered, start: ordered ? Number(listed[0]![1]) : 1, items: listed.map((match) => match![2].trim()) };
}

/** One paragraph, as its own shape: a quotation, a list (or the line that leads into one, then the list), or words. */
function paragraphOf(part: string, abstract: boolean): ReaderParagraph[] {
  const lines = part.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.every((line) => /^>\s?/.test(line))) {
    return [{ kind: "quote", text: lines.map((line) => line.replace(/^>\s?/, "")).join("\n") }];
  }
  const list = listOf(lines);
  if (list) return [list];
  // 「本次发布实现了：」 and two or more items under it: the line, then the list.
  const after = lines.length >= 3 ? listOf(lines.slice(1)) : null;
  if (after && !LIST_LINE.test(lines[0])) return [{ kind: "paragraph", runIn: null, text: lines[0] }, after];
  const runIn = abstract ? RUN_IN.exec(part) : null;
  if (runIn && !SENTENCE_END.test(runIn[1])) {
    const heading = runIn[1].trim();
    return [{ kind: "paragraph", runIn: `${heading}${runIn[2].trim()}`, text: `${runIn[2].startsWith(":") ? " " : ""}${part.slice(runIn[0].length)}` }];
  }
  return [{ kind: "paragraph", runIn: null, text: part }];
}

/** A short paragraph that may name the address after it: plain words, at most 30 characters, no sentence's end, no address. */
function namesSource(block: ReaderParagraph | undefined): block is { kind: "paragraph"; runIn: null; text: string } {
  return block?.kind === "paragraph" && block.runIn === null && block.text.length <= SOURCE_WORDS_MAX
    && !ANY_SENTENCE_END.test(block.text) && !/https?:\/\//.test(block.text);
}

/**
 * The text's blocks, split at blank lines; with `abstract`, each paragraph's run-in heading found. An address on a paragraph of its
 * own takes up to two short paragraphs right before it into one source line; where it is the item's own address (`ownUrl`) the line
 * is dropped, because the end of the article has it.
 */
export function readerParagraphs(text: string, { abstract = false, ownUrl }: { abstract?: boolean; ownUrl?: string } = {}): ReaderParagraph[] {
  const blocks = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).flatMap((part): ReaderParagraph[] => {
    const [first, ...lines] = part.split("\n");
    const section = SECTION.exec(first.trim());
    if (section) {
      // A heading the text runs straight on from keeps its text as the paragraph under it.
      const after = lines.join("\n").trim();
      return [{ kind: "heading", text: section[1].trim() }, ...(after ? readerParagraphs(after, { abstract, ownUrl }) : [])];
    }
    return paragraphOf(part, abstract);
  });
  const out: ReaderParagraph[] = [];
  for (const block of blocks) {
    const address = block.kind === "paragraph" && block.runIn === null && ONLY_URL.test(block.text.trim()) ? splitUrls(block.text.trim()) : null;
    const url = address && address.length === 1 && typeof address[0] !== "string" ? address[0].url : null;
    if (!url) { out.push(block); continue; }
    const words: string[] = [];
    while (words.length < 2 && namesSource(out[out.length - 1])) words.unshift((out.pop() as { text: string }).text.trim());
    if (ownUrl && sameAddress(url, ownUrl)) continue;
    out.push({ kind: "source", words, url });
  }
  return out;
}

/** How long a block reads, for the fold. */
function blockLength(block: ReaderParagraph): number {
  if (block.kind === "list") return block.items.join("").length;
  if (block.kind === "source") return block.url.length;
  return block.text.length;
}

/** An address in the text: its site and the start of its path, the whole address its tooltip, opening in a new tab. */
function TextLink({ url }: { url: string }) {
  return (
    <Tooltip content={url}>
      <a href={url} {...EXTERNAL} className="rounded text-accent [overflow-wrap:anywhere] hover:underline">
        {shortUrl(url)}<span aria-hidden="true"> ↗</span>
      </a>
    </Tooltip>
  );
}

/** Words with their addresses as links. */
function Linked({ text }: { text: string }) {
  return <>{splitUrls(text).map((piece, index) => (typeof piece === "string" ? piece : <TextLink key={index} url={piece.url} />))}</>;
}

/** The ids a text's section headings take, in order: the contents (`readerOutline`) and the text agree on them. */
const sectionId = (prefix: string, index: number) => `${prefix}-sec-${index + 1}`;

/** What a text shows in a language: the Chinese, the original, or whichever there is. */
export function shownText(text: FrontierBody, language: ReaderLanguage): { showing: ReaderLanguage; text: string; switchable: boolean } {
  const switchable = Boolean(text.zh && text.original && text.zhKind === "translation");
  const showing: ReaderLanguage = !text.zh ? "original" : !text.original ? "zh" : switchable ? language : "zh";
  return { showing, switchable, text: (showing === "zh" ? text.zh : text.original) ?? "" };
}

/** A text's contents: its section headings, with the ids the text gives them (`ReaderText` with the same `idPrefix`). */
export function readerOutline(text: FrontierBody, language: ReaderLanguage, idPrefix: string): OutlineEntry[] {
  return readerParagraphs(shownText(text, language).text).filter((block): block is { kind: "heading"; text: string } => block.kind === "heading")
    .map((block, index) => ({ id: sectionId(idPrefix, index), text: block.text, level: 2 }));
}

/**
 * The text itself — the article or the post (`正文`), or a paper's abstract (`摘要`) — in Chinese or in the original. Where there is a
 * translation and an original the block's row has 中文 · 原文 and names what is on screen (「正文 · AI 翻译」, 「正文 · 原文」); a
 * translation the server says is partial says so once, with the way to the whole original. A full text's `## ` paragraphs are its
 * section headings, in either language; an abstract's paragraph that starts with its own heading has it set in 600; lists and quotations
 * are set as such, and a bare address is a short link. A text over three thousand characters opens at its first paragraphs, and
 * 「展开全文」 shows the rest in place (`open` / `onOpen` when the page's contents must open it).
 */
export function ReaderText({ kind, text, lang, language, onLanguage, ownUrl, idPrefix, open: openProp, onOpen, className }: {
  kind: "正文" | "摘要";
  text: FrontierBody;
  /** The original's language (`lang` on its paragraphs); `und` is not said. */
  lang: string;
  language: ReaderLanguage;
  onLanguage: (language: ReaderLanguage) => void;
  /** The item's own address: a paragraph that is only it is not drawn. */
  ownUrl?: string;
  /** The ids its section headings take (`readerOutline`). */
  idPrefix?: string;
  open?: boolean;
  onOpen?: () => void;
  className?: string;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const { showing, switchable, text: shown } = shownText(text, language);
  const translated = showing === "zh" && text.zhKind === "translation";
  const originalIsChinese = /^zh/i.test(lang);
  const label = translated ? `${kind} · AI 翻译` : showing === "original" && !originalIsChinese && text.zhKind !== "original-zh" ? `${kind} · 原文` : kind;
  const all = readerParagraphs(shown, { abstract: kind === "摘要", ownUrl });
  let visible = all;
  if (!open && shown.length > FOLD_AT) {
    let length = 0;
    visible = all.filter((part) => { const keep = length < FOLDED_LENGTH; length += blockLength(part); return keep; });
    // A section is folded whole: its heading is never the last line before 展开全文.
    while (visible.length > 1 && visible[visible.length - 1].kind === "heading") visible = visible.slice(0, -1);
  }
  const textLang = showing === "original" && lang !== "und" ? lang : undefined;
  let headings = 0;
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
      <div data-prose="" lang={textLang} className="max-w-measure-body space-y-5 text-reading text-text xl:max-w-read xl:text-reading-lg">
        {visible.map((part, index) => {
          if (part.kind === "heading") {
            const id = idPrefix ? sectionId(idPrefix, headings) : undefined;
            headings += 1;
            return <h3 key={index} id={id} className="break-words pt-4 text-section text-text first:pt-0 xl:text-heading">{part.text}</h3>;
          }
          if (part.kind === "list") {
            const items = part.items.map((item, at) => <li key={at} className="break-words pl-1"><Linked text={item} /></li>);
            return part.ordered
              ? <ol key={index} start={part.start} className="list-decimal space-y-1.5 pl-6">{items}</ol>
              : <ul key={index} className="list-disc space-y-1.5 pl-6">{items}</ul>;
          }
          if (part.kind === "quote") {
            return <blockquote key={index} className="whitespace-pre-line break-words border-l-2 border-border pl-4 text-text-2"><Linked text={part.text} /></blockquote>;
          }
          if (part.kind === "source") {
            return (
              <p key={index} className="break-words text-caption text-text-3">
                {part.words.map((words) => `${words} `).join("")}<TextLink url={part.url} />
              </p>
            );
          }
          return <p key={index} className="whitespace-pre-line break-words">{part.runIn && <span className="font-semibold">{part.runIn}</span>}<Linked text={part.text} /></p>;
        })}
      </div>
      {visible.length < all.length && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => { setOpenState(true); onOpen?.(); }}>展开全文</Button>
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
    ? { zh: state.original, original: null, zhKind: "original-zh", complete: true, source: "abstract" }
    : { zh: state.zh, original: state.original, zhKind: state.zh ? (chinese ? "original-zh" : "translation") : null, complete: true, source: "abstract" };
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
      <blockquote className="mt-2 whitespace-pre-line break-words text-ui text-text-2">{zh ?? quoted.text}</blockquote>
      {zh && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none rounded text-caption text-text-3 hover:text-text">原文</summary>
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
 * Where it came from, at the end of the article: 「来源：NEJM · nejm.org · 打开原文 ↗」 with the free full text and the other institutions
 * that reported it; then what the card left out of a paper — its journal, authors, impact factor, the trial — as one list of facts.
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
        <span>来源：<span className="text-text-2">{name}</span></span>
        {host && <span>· {host}</span>}
        <a href={item.url} {...EXTERNAL} className={cn(INLINE_ACTION, "ml-2 px-1.5 text-link")}>
          {originalLinkLabel(item)}<span aria-hidden="true"> ↗</span>
        </a>
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

/** 推荐理由 is drawn: the item has a reason or a score, and it is not the other report of an occurrence selected through another one. */
const hasVerdict = (item: FrontierItemDetail) => !item.sameEvent && Boolean(item.reason || item.score !== null);

function RailBlock({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-border pt-3.5">
      <h2 id={id} className={LABEL}>{label}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** The one chip of the right column: every 专科 and 标签 is this, and every one is a link to the feed narrowed to it. */
const RAIL_CHIP = filterChipClasses({ selected: true });

/** Where a chip of the right column leads: 全部, narrowed to a specialty or a tag. */
const feedBy = (name: "specialty" | "tag", value: string) => `/app/frontier?view=all&${name}=${encodeURIComponent(value)}`;

/**
 * The reader's notes, in the right column on a wide screen and under the text on a narrower one: 推荐理由 — 「精选」, the 「AI 评分」 pill,
 * its four parts as bars and the sentence of what a clinician or a researcher can do with it — then 专科 and 标签, each a link to the
 * feed narrowed to it, and 本文目录 where the text has three sections or more. An item whose occurrence was selected through another
 * report has no 推荐理由: the line over its text sends the reader to that one.
 */
export function ReaderNotes({ item, outline }: { item: FrontierItemDetail; outline?: ReactNode }) {
  const verdict = hasVerdict(item);
  const band = scoreBand(item);
  const parts = scoreBreakdown(item);
  return (
    <div className="flex flex-col gap-8">
      {verdict && (
        <RailBlock label={item.reason ? "推荐理由" : SCORE_LABEL}>
          <div className="flex flex-wrap items-center gap-2">
            {item.selected && (
              <Tag><span aria-hidden="true" className="mr-1 h-1.5 w-1.5 rounded-full bg-accent" />精选</Tag>
            )}
            {band && item.score !== null && <ScorePill label={SCORE_LABEL} value={item.score} tier={band} />}
          </div>
          {parts.length > 0 && <ScoreBars parts={parts} className="mt-3" />}
          {item.reason && <p className="mt-3 text-ui text-text-2">{item.reason}</p>}
        </RailBlock>
      )}
      {item.specialties.length > 0 && (
        <RailBlock label="专科">
          <ul className="flex flex-wrap gap-1.5">
            {item.specialties.map((specialty) => (
              <li key={specialty.key}><Link to={feedBy("specialty", specialty.key)} className={RAIL_CHIP}>{specialty.label}</Link></li>
            ))}
          </ul>
        </RailBlock>
      )}
      {item.tags.length > 0 && (
        <RailBlock label="标签">
          <ul className="flex flex-wrap gap-1.5">
            {item.tags.map((tag) => <li key={tag.slug}><Link to={feedBy("tag", tag.slug)} className={RAIL_CHIP}>#{tag.name}</Link></li>)}
          </ul>
        </RailBlock>
      )}
      {outline && <RailBlock label="本文目录">{outline}</RailBlock>}
    </div>
  );
}

/**
 * The right column's head (owner, 2026-10-23: 「查看原文又跑到右上角去了」): the way to the original as one full-width button — 「打开原文 ↗」,
 * a post's 「在 X 查看原帖 ↗」 — with ☆ and ⋯ beside it, and 「深入研究」 under it. Its top is the back row's.
 */
export function ReaderActions({ item, more, onStar, onResearch }: {
  item: FrontierItem;
  more: MenuEntry[];
  onStar: () => void;
  onResearch: () => void;
}) {
  const starred = item.state.starred;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <a href={item.url} {...EXTERNAL} className={buttonClasses({ variant: "secondary", className: "min-w-0 flex-1" })}>
          <span className="truncate">{originalLinkLabel(item)}</span><ArrowUpRight size={16} aria-hidden="true" />
        </a>
        <IconButton icon={Star} label="收藏" aria-pressed={starred} className={starred ? "text-accent [&_svg]:fill-current" : undefined} onClick={onStar} />
        <Menu label="更多操作" items={more}><IconButton icon={MoreHorizontal} label="更多操作" /></Menu>
      </div>
      <Button variant="secondary" className="w-full" onClick={onResearch}>深入研究</Button>
    </div>
  );
}

/** True while the page's own ground scrolls down through the text (not near its top or its end): the phone's bar steps aside. */
function useReadingDown(anchor: RefObject<HTMLElement | null>): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const scroller = anchor.current?.closest<HTMLElement>(".overflow-y-auto");
    if (!scroller) return undefined;
    let last = scroller.scrollTop;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = scroller.scrollTop;
      const end = scroller.scrollHeight - scroller.clientHeight;
      if (y < 80 || y > end - 120) { setDown(false); last = y; }
      else if (Math.abs(y - last) > 6) { setDown(y > last); last = y; }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); scroller.removeEventListener("scroll", onScroll); };
  }, [anchor]);
  return down;
}

const BAR_TOOL = "flex flex-col items-center justify-center gap-0.5 rounded text-caption text-text-2 outline-none transition-colors duration-fast hover:text-text";

/**
 * Below 1024 px the article's own bar at the window's bottom (AIHOT `ReaderTools`, MIT): 收藏, 深入研究, the way to the original and ⋯.
 * It steps aside while the reader scrolls down through the text and comes back on the way up and at either end.
 */
export function ReaderBar({ item, more, onStar, onResearch }: {
  item: FrontierItem;
  more: MenuEntry[];
  onStar: () => void;
  onResearch: () => void;
}) {
  const bar = useRef<HTMLElement>(null);
  const hidden = useReadingDown(bar);
  const starred = item.state.starred;
  return (
    <nav
      ref={bar}
      aria-label="阅读工具"
      className={cn(
        "fixed inset-x-0 bottom-0 z-sticky border-t border-border bg-surface pb-[max(0.25rem,env(safe-area-inset-bottom))] transition-transform duration-base ease-standard",
        hidden && "translate-y-full",
      )}
    >
      <div className="mx-auto grid h-14 max-w-read grid-cols-4 px-2">
        <button type="button" aria-pressed={starred} onClick={onStar} className={cn(BAR_TOOL, starred && "text-accent [&_svg]:fill-current")}>
          <Star size={20} aria-hidden="true" />{starred ? "已收藏" : "收藏"}
        </button>
        <button type="button" onClick={onResearch} className={BAR_TOOL}>
          <MessageSquareText size={20} aria-hidden="true" />深入研究
        </button>
        <a href={item.url} {...EXTERNAL} className={BAR_TOOL}>
          <ArrowUpRight size={20} aria-hidden="true" />{isSocialItem(item) ? "查看原帖" : "打开原文"}
        </a>
        <Menu label="更多操作" items={more}>
          <button type="button" className={BAR_TOOL}><MoreHorizontal size={20} aria-hidden="true" />更多</button>
        </Menu>
      </div>
    </nav>
  );
}

/**
 * 本文目录: the text's section headings, the one being read marked, each a press away (the page's own ground scrolls to it, under
 * nothing). A heading still in the folded part of a long text opens the text first.
 */
export function ReaderOutline({ entries, layout, onReveal }: {
  entries: readonly OutlineEntry[];
  layout: "inline" | "folded";
  /** Opens the folded rest of the text, where the heading asked for is not drawn yet. */
  onReveal: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const ids = entries.map((entry) => entry.id).join(" ");
  useEffect(() => {
    if (!ids || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((seen) => {
      const visible = seen.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "0px 0px -70% 0px" });
    for (const id of ids.split(" ")) {
      const heading = document.getElementById(id);
      if (heading) observer.observe(heading);
    }
    return () => observer.disconnect();
  }, [ids, pending]);
  const go = useCallback((id: string) => {
    const heading = document.getElementById(id);
    if (!heading) return false;
    const scroller = heading.closest<HTMLElement>(".overflow-y-auto");
    if (scroller && typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top: heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16 });
    }
    setActive(id);
    return true;
  }, []);
  // The heading asked for while folded is drawn in the same commit as the opened text: go to it then.
  useEffect(() => {
    if (pending && go(pending)) setPending(null);
  }, [pending, go]);
  const select = (id: string) => {
    if (go(id)) return;
    setPending(id);
    onReveal();
  };
  return <Outline entries={entries} active={active} onSelect={select} layout={layout} label={layout === "folded" ? "目录" : "本文目录"} />;
}
