import type { WebStructuredMemory } from "@/lib/apiClient";
import { memoryExcerpt, readableMemory } from "@/lib/memoryText";

/**
 * Memories an account's memory keeps as files (the second engine, 2026-10-13), read the way the page reads every memory.
 *
 * They come in the same shape as the others, so the page lists, searches, edits and forgets them with the same code; what
 * differs is only what one memory *is*. A line of the profile document is a sentence, exactly like a structured memory. Any other
 * file is a topic with several statements under it — 回答结构: 先结论后依据 · 表格不超过五列 — so its row names the topic and
 * says the statements under it, and its drawer shows the whole text and edits the whole text. The file's name and address are
 * never shown (owner ruling 2026-10-10: no back-office labels); the topic is the name read in words.
 */

/** A memory kept as a file: a topic with statements under it. */
export function isFileMemory(record: Pick<WebStructuredMemory, "engine" | "document">): boolean {
  return record.engine === "native" && !record.document;
}

/** A line of the profile document: one sentence about the person, whose document the drawer also shows. */
export function isProfileLine(record: Pick<WebStructuredMemory, "engine" | "document">): boolean {
  return record.engine === "native" && Boolean(record.document);
}

/** What a file is about, in words: the engine names a file after its topic (`meta_analysis_method`), which reads as `meta analysis method`. */
export function fileTopic(record: Pick<WebStructuredMemory, "summary" | "value">): string {
  const named = record.summary.replace(/_+/g, " ").trim();
  return named || memoryExcerpt(record.value, 40);
}

/** The statements of a file, one per line, without the bullet or heading mark the file is dressed in. */
export function fileStatements(value: string): string[] {
  const lines = readableMemory(value).replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const statements = lines.filter((line) => !/^#{1,6}\s/.test(line));
  return (statements.length > 0 ? statements : lines).map((line) => line.replace(/^(?:#{1,6}|[-*+]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

/** The statements of a file in a breath: each without its closing stop, joined with 「；」. */
export function breath(value: string): string {
  return fileStatements(value).map((line) => line.replace(/[。.；;]+$/u, "")).join("；");
}

/** The quiet line under a file's topic: what it says, in a breath. */
export function fileSummary(record: Pick<WebStructuredMemory, "value">): string {
  return memoryExcerpt(breath(record.value), 160);
}

/** The text a memory's drawer opens with and its edit starts from: a file's own text, else the sentence. */
export function memoryText(record: WebStructuredMemory): string {
  return isFileMemory(record) ? record.value : record.summary || record.value;
}
