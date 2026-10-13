import { knowledgePageTypeLabel } from "@evimed/domain";
import { formatDay } from "@/lib/format";
import type {
  KnowledgePage, KnowledgePageLink, KnowledgeStaleReason, KnowledgeStatus, KnowledgeTreeRow,
} from "@/lib/sourceClient";

/**
 * What the knowledge pages say, decided before any component draws it: the compile's state in a sentence, the compiled
 * files grouped by what they are, a page's body cut into the stretches that are the compiler's and the ones that are the
 * person's. Plain functions of the routes' answers, so the words are tested without a browser.
 */

/** What a changed document did to a page, in the words the memory drawer already uses for a source that moved. */
export const STALE_LABEL: Readonly<Record<KnowledgeStaleReason, string>> = { changed: "来源已更改", retracted: "来源已撤回", removed: "来源已删除" };

export interface StatusLine {
  /** The sentence the header shows. */
  text: string;
  /** A round is under way or waiting: the header is asked again until it ends. */
  busy: boolean;
  /** 「重新整理」 is offered. */
  canCompile: boolean;
  /** Whether something is wrong enough to be said in the warning tone. */
  attention: boolean;
}

/** The step of a round, in the words of what is being made. */
function stageWords(stage: KnowledgeStatus["stage"]): string {
  if (!stage) return "";
  if (stage.step === "finish") return "正在收尾";
  if (stage.step === "kg-start" || stage.step === "kg" || stage.tree === "kg") return "正在整理知识图谱";
  return "正在整理页面";
}

/**
 * The compile's state in plain words (no engine names, no limits as numbers): 整理中, 已整理 · 上次整理于 …, 资料不足,
 * 页数已到上限, 知识引擎暂不可用. Null where there is nothing to say — compiling is off, or a project with nothing in it.
 */
export function statusLine(status: KnowledgeStatus | null, now: Date = new Date()): StatusLine | null {
  if (!status || !status.enabled || status.state === "disabled") return null;
  const counts = [status.pages > 0 ? `${status.pages} 页` : "", status.typedPages.kg > 0 ? `${status.typedPages.kg} 个实体` : ""].filter(Boolean).join("，");
  switch (status.state) {
    case "compiling": {
      const words = stageWords(status.stage) || "正在整理";
      return { text: `整理中 · ${words}${counts ? ` · 已有 ${counts}` : ""}`, busy: true, canCompile: false, attention: false };
    }
    case "queued":
      return { text: `资料有更新，稍后会自动整理${counts ? ` · 已有 ${counts}` : ""}`, busy: true, canCompile: false, attention: false };
    case "compiled": {
      const when = status.compiledAt ? ` · 上次整理于 ${formatDay(status.compiledAt, now)}` : "";
      return { text: `已整理${when}${counts ? ` · ${counts}` : ""}`, busy: false, canCompile: true, attention: false };
    }
    case "below_threshold": {
      if (status.readable === 0 && status.pages === 0) return null;
      // The control plane's own sentence is the one a caller of the compile route reads too; this is the same words for one that has none.
      const missing = Math.max(1, status.minSources - status.readable);
      return { text: status.message || `资料还不够：再加 ${missing} 份就会开始整理`, busy: false, canCompile: false, attention: false };
    }
    case "idle":
      return { text: "资料已就绪，随时可以整理成知识页", busy: false, canCompile: true, attention: false };
    case "page_limit":
      return { text: `页数已到上限，不再整理新的内容；已有的${counts ? ` ${counts}` : "页面"}仍可阅读`, busy: false, canCompile: false, attention: true };
    case "engine_unavailable":
      return { text: `知识引擎暂不可用，已有的页面仍可阅读，恢复后会继续整理`, busy: false, canCompile: true, attention: true };
    case "failed":
      return { text: `上次整理没有完成${counts ? ` · 已有 ${counts}` : ""}，可以重新整理`, busy: false, canCompile: true, attention: true };
    default:
      return null;
  }
}

/** The page types in the order the tree lists them: what is read about first, the index last of the pages. */
const TYPE_ORDER: readonly string[] = ["concept", "entity", "method", "comparison", "analysis", "summary", "index"];

export interface TreeGroup {
  /** `wiki:concept`, `kg:entity` */
  id: string;
  tree: "wiki" | "kg";
  type: string;
  label: string;
  rows: KnowledgeTreeRow[];
}

/** A row of the tree that is a page to read: the graph's `relations.jsonl` is the graph's data, drawn in 图谱. */
export function isReadableRow(row: Pick<KnowledgeTreeRow, "type">): boolean {
  return row.type !== "relations";
}

/**
 * The compiled files grouped by what they are — the pages by their type, then the graph's entities — each group sorted by
 * title, the query narrowing the rows by title and path (a search over the tree in hand, no request).
 */
export function groupRows(rows: readonly KnowledgeTreeRow[], query = ""): TreeGroup[] {
  const needle = query.trim().toLowerCase();
  const kept = rows.filter((row) => isReadableRow(row) && (!needle || `${row.title} ${row.path}`.toLowerCase().includes(needle)));
  const groups = new Map<string, TreeGroup>();
  for (const row of kept) {
    const id = `${row.tree}:${row.type}`;
    const group = groups.get(id) ?? { id, tree: row.tree, type: row.type, label: row.tree === "kg" ? (row.type === "index" ? "图谱目录" : "图谱实体") : knowledgePageTypeLabel(row.type), rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  const rank = (group: TreeGroup) => (group.tree === "kg" ? 100 : TYPE_ORDER.indexOf(group.type) === -1 ? TYPE_ORDER.length : TYPE_ORDER.indexOf(group.type));
  return [...groups.values()]
    .map((group) => ({ ...group, rows: [...group.rows].sort((left, right) => left.title.localeCompare(right.title, "zh-Hans-CN")) }))
    .sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id));
}

/** The reasons present in a list of stale sources, once each, in a fixed order; a reason this page does not know reads as a change. */
export function staleReasons(stale: ReadonlyArray<{ reason: KnowledgeStaleReason }>): KnowledgeStaleReason[] {
  const named = (reason: string): KnowledgeStaleReason => (reason in STALE_LABEL ? (reason as KnowledgeStaleReason) : "changed");
  const present = new Set(stale.map((entry) => named(entry.reason)));
  return (["retracted", "changed", "removed"] as const).filter((reason) => present.has(reason));
}

export interface PageSegment {
  /** Markdown, with the links the page knows replaced by `#kb-<n>` addresses (n is the link's place in `links`). */
  markdown: string;
  /** A stretch the person wrote, kept through every recompile. */
  mine: boolean;
}

/** The address a link of the page is given in the Markdown handed to the renderer; the renderer reads the number back. */
export function linkAddress(position: number): string {
  return `#kb-${position}`;
}
const ADDRESS = /^#kb-(\d+)$/u;
export function linkPosition(href: string | undefined): number | null {
  const match = href ? ADDRESS.exec(href) : null;
  return match ? Number(match[1]) : null;
}

/** The text between a Markdown link's brackets as it was written (its emphasis stays), else the plain text escaped. */
function bracketText(written: string, plain: string): string {
  const close = written.indexOf("](");
  return written.startsWith("[") && close > 1 ? written.slice(1, close) : plain.replace(/[\\[\]]/gu, "\\$&");
}

/** A `viking://` address is the engine's own and is never shown; one left in the text after the links were replaced goes. */
export function withoutEngineAddresses(markdown: string): string {
  return markdown.replace(/viking:\/\/[^\s)\]"'<>]+/gu, "");
}

/**
 * The body cut where the person's own blocks stand, each stretch with the links replaced. The links come as the control
 * plane found them (offsets into `body`); one whose offsets do not hold a Markdown link is left as written, and
 * `withoutEngineAddresses` takes the engine's address out of what is left.
 */
export function pageSegments(page: Pick<KnowledgePage, "body" | "links" | "userBlocks">): PageSegment[] {
  const body = page.body;
  const cuts: Array<{ start: number; end: number }> = [];
  for (const block of page.userBlocks) {
    const text = block.text.trim();
    if (!text) continue;
    const start = body.indexOf(text);
    if (start < 0) continue;
    const end = start + text.length;
    // A block counts as the person's only as a whole paragraph (or paragraphs): it begins and ends on a line.
    const begins = start === 0 || body[start - 1] === "\n";
    const ends = end === body.length || body[end] === "\n";
    if (begins && ends && !cuts.some((cut) => start < cut.end && end > cut.start)) cuts.push({ start, end });
  }
  cuts.sort((left, right) => left.start - right.start);

  const replace = (from: number, to: number): string => {
    const inside = page.links
      .map((link, position) => ({ link, position }))
      .filter(({ link }) => link.index >= from && link.end <= to && link.end > link.index && body[link.index] === "[" && body[link.end - 1] === ")")
      .sort((left, right) => left.link.index - right.link.index);
    let out = "";
    let at = from;
    for (const { link, position } of inside) {
      if (link.index < at) continue;
      out += body.slice(at, link.index) + `[${bracketText(body.slice(link.index, link.end), link.text)}](${linkAddress(position)})`;
      at = link.end;
    }
    return withoutEngineAddresses(out + body.slice(at, to));
  };

  const segments: PageSegment[] = [];
  let at = 0;
  for (const cut of cuts) {
    if (cut.start > at) segments.push({ markdown: replace(at, cut.start), mine: false });
    segments.push({ markdown: replace(cut.start, cut.end), mine: true });
    at = cut.end;
  }
  if (at < body.length || segments.length === 0) segments.push({ markdown: replace(at, body.length), mine: false });
  return segments.filter((segment) => segment.markdown.trim() !== "");
}

/** The page's own heading: the first Markdown heading is the document's title, which the reader's header already shows. */
export function withoutLeadingTitle(markdown: string, title: string): string {
  const match = /^\s*#[ \t]+(.+?)[ \t]*\r?\n/u.exec(markdown);
  return match && match[1]!.trim() === title.trim() ? markdown.slice(match[0].length) : markdown;
}

export function linkIsSource(link: KnowledgePageLink | undefined): link is Extract<KnowledgePageLink, { kind: "source" }> {
  return link?.kind === "source";
}

/** The Markdown the front matter is cut from, to show a page that could not be drawn as it is written. */
export function rawMarkdown(page: Pick<KnowledgePage, "markdown">): string {
  return withoutEngineAddresses(page.markdown);
}

/** What the composer is left holding when a page or a mark of the graph is taken into a conversation. */
export function knowledgeConversationDraft(title: string, noun: "页" | "实体" = "页"): string {
  return noun === "页"
    ? `请阅读知识库里的这一页和它引用的资料，并据此回答我的问题，引用时标出处。\n\n页面：${title}\n\n我的问题：`
    : `请阅读知识库里关于这个实体的文件和它引用的资料，并据此回答我的问题，引用时标出处。\n\n实体：${title}\n\n我的问题：`;
}

/** The most documents one conversation takes along (the runtime's own bound on `references`). */
export const MAX_REFERENCES = 50;

/**
 * The documents a conversation starts with: the file itself, then the documents it cites that can still be read, once
 * each, at most `MAX_REFERENCES`.
 */
export function conversationReferences(
  primary: { id: string; title: string } | null,
  cited: ReadonlyArray<{ sourceId: string; title: string | null; available?: boolean }>,
): Array<{ id: string; title: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string }> = [];
  const add = (id: string, title: string | null) => {
    if (seen.has(id) || out.length >= MAX_REFERENCES) return;
    seen.add(id);
    out.push({ id, title: title ?? "资料" });
  };
  if (primary) add(primary.id, primary.title);
  for (const entry of cited) if (entry.available !== false) add(entry.sourceId, entry.title);
  return out;
}

/** The engine's own directory in front of a page's links to documents: `viking://user/<id>/resources/p/<project>/` before `sources/…`. */
const ENGINE_PREFIX = /viking:\/\/[^\s)"'<>\]]*?\/(?=(?:sources|library)\/)/gu;

/**
 * A page's text as the editor shows it: the engine's address in front of each link to a document left off, so a link reads
 * `(sources/src_….md "…")`, and `restore` puts it back on what was written. A page whose links name more than one engine
 * directory is shown as it is (the restore would not know which belongs where).
 */
export function maskEngineAddresses(markdown: string): { text: string; restore: (edited: string) => string } {
  const prefixes = [...new Set(markdown.match(ENGINE_PREFIX) ?? [])];
  if (prefixes.length !== 1) return { text: markdown, restore: (edited) => edited };
  const prefix = prefixes[0]!;
  return {
    text: markdown.replaceAll(prefix, ""),
    restore: (edited) => edited.replace(/\]\((?=(?:sources|library)\/)/gu, `](${prefix}`),
  };
}
