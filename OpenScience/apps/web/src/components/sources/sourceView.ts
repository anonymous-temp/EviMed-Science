import { BookOpen, FileText, Globe, Image as ImageIcon, Sheet, StickyNote, type LucideIcon } from "lucide-react";
import { SOURCE_KINDS, SOURCE_ORIGINS, sourceDocTypeLabel } from "@evimed/domain";
import { formatDay, humanSize } from "@/lib/format";
import type { SourceKind, SourceRecord } from "@/lib/sourceClient";

/** Whether the assistant can use a document now: the server's `readable`, true as soon as the text is read,
 *  whatever the pipeline still does with it after that. A record from before the field existed answers by its status. */
export function isUsable(source: SourceRecord): boolean {
  return source.readable ?? (source.payload.status === "complete" || source.payload.status === "needs_attention");
}

/** Whether a document cannot be used yet because it is still being read. */
export function isReading(source: SourceRecord): boolean {
  return !isUsable(source) && (source.payload.status === "queued" || source.payload.status === "parsing");
}

/**
 * A document's state in the words a row says it, or "" when there is nothing to say: a usable document shows its
 * type and date and no internal state (2026-09-24: no 「分析中」 or 「理解中」; the understanding that runs after the
 * reading is not the researcher's concern).
 */
export function stateLabel(source: SourceRecord): string {
  const status = source.payload.status;
  if (status === "needs_attention") return "部分无法读取";
  if (isUsable(source)) return "";
  if (status === "queued" || status === "parsing") return "正在读取";
  if (status === "failed") return "没能读取";
  if (status === "missing") return "原件已移除";
  if (status === "canceled") return "已取消";
  return "";
}

/** The states from which a document can be read again. */
export const RETRYABLE = ["failed", "needs_attention", "complete", "canceled"];

/** The chips' names, from the one vocabulary the server counts with. */
export const KIND_LABEL: Readonly<Record<string, string>> = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind.id, kind.label]));
export const ORIGIN_LABEL: Readonly<Record<string, string>> = Object.fromEntries(SOURCE_ORIGINS.map((origin) => [origin.id, origin.label]));

const KIND_ICON: Record<SourceKind, LucideIcon> = {
  literature: BookOpen, table: Sheet, document: FileText, page: Globe, note: StickyNote, image: ImageIcon,
};
export function kindIcon(kind: string): LucideIcon {
  return KIND_ICON[kind as SourceKind] ?? FileText;
}

/**
 * Where a document's original is read from: its own file, or — for a document that lives in the cloud drive, whose
 * original is not in the project — the text that was read from it.
 */
export function originalPathOf(source: SourceRecord): string | null {
  if (source.display.origin === "drive") return source.payload.outputs?.artifactPath ?? null;
  return source.payload.paths[0] ?? null;
}

/** A note the researcher wrote here: its original is its editor, and saving it makes the next version. */
export function isEditableNote(source: SourceRecord): boolean {
  return source.display.kind === "note" && source.display.origin === "note";
}

/** A document's file name, never its id. */
export function fileNameOf(source: SourceRecord): string {
  const file = source.payload.paths[0] ?? source.id;
  return file.slice(file.lastIndexOf("/") + 1) || source.id;
}

/**
 * 「在对话中使用」: the question left in the composer, unsent. It names the document by its title and its file name and
 * nothing else — no id, no path — and the model finds the document by what it is called (design reference §6.4, §18.4).
 */
export function conversationDraft(source: SourceRecord): string {
  const title = source.display.title;
  const name = fileNameOf(source);
  return `请阅读知识库里的这份资料，并据此回答我的问题，引用时标出处。\n\n资料：${title}${name !== title ? `（${name}）` : ""}\n\n我的问题：`;
}

/**
 * The line under a row's title: what it is, how long, where it came from. 「指南 · 18 页 · 上传」,
 * 「网页 · nmpa.gov.cn · 链接」, 「数据表 · 对话产出 · 所有项目可用」. Pages when the parse found them, else the size.
 */
export function metaLine(source: SourceRecord, { showShared = true }: { showShared?: boolean } = {}): string {
  const { display } = source;
  const length = display.pages ? `${display.pages} 页` : display.site ? "" : humanSize(display.size);
  return [
    display.typeShort,
    display.site ?? "",
    length,
    ORIGIN_LABEL[display.origin] ?? "上传",
    showShared && display.shared ? "所有项目可用" : "",
  ].filter(Boolean).join(" · ");
}

/**
 * The grey line after a document page's title: what it is, how big, how long, where it came from and the day it
 * arrived — 「指南 · 3.1 MB · 38 页 · 上传 · 10月5日」. A saved page names its site; a document the account made
 * available to every project says so.
 */
export function readerMeta(source: SourceRecord): string {
  const { display } = source;
  return [
    display.typeShort,
    display.site ?? "",
    humanSize(display.size),
    display.pages ? `${display.pages} 页` : "",
    ORIGIN_LABEL[display.origin] ?? "上传",
    display.shared ? "所有项目可用" : "",
    formatDay(source.createdAt),
  ].filter(Boolean).join(" · ");
}

/** The type's full name, for a place with room (a menu), from the vocabulary. */
export const typeName = (docType: string) => sourceDocTypeLabel(docType);

/**
 * A line of text cut at the words of a search, so the match can be shown: the parts in order, each flagged where it is one
 * of the words (any case; a word is looked for as typed). Nothing in the text is changed, and a search with no words, or a
 * line with none of them, is one plain part.
 */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].sort((left, right) => right.length - left.length).slice(0, 6);
  if (!text || words.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).filter((part) => part !== "").map((part) => ({ text: part, match: words.includes(part.toLowerCase()) }));
}
