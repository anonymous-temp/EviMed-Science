/**
 * The web pages a run read, for its record (contract X5 `pagesRead`) — what
 * the 「已阅读的网页」 cards in the run view and the 「依据」 popover show.
 *
 * Tied to the run the way preserved sources are: through the run's own
 * transcripts, root and delegated children, read once at the end of the run
 * (server.mjs's terminal hook). Each completed `web_read` result carries the
 * gateway's receipt — where the bytes came from, when, whether a browser drew
 * them, their sha256 — and the snapshot the MCP preserved. The 官方来源 label
 * is not taken from the result: it is recomputed here from the page's own
 * address, so a result cannot label itself.
 *
 * Bounded on purpose. The run ledger is one file per project with a 1 MiB
 * ceiling it has already hit once, and this list rides every run's row: a run
 * keeps its first MAX_PAGES_READ pages and records how many it read in all.
 * The transcript still holds every one of them.
 *
 * @module webReadPages
 */

import { mcpToolBaseName } from "@evimed/domain";
import { completedToolCalls } from "./toolExecutionEdges.mjs";
import { isOfficialWebSource } from "./webReadOfficial.mjs";

/** Pages one run's record keeps. About 400 bytes each; see the module note. */
export const MAX_PAGES_READ = 24;
const MAX_URL_CHARS = 1024;
const MAX_TITLE_CHARS = 120;

/**
 * @typedef {object} PageRead
 * @property {string} url
 * @property {string} finalUrl
 * @property {string} title
 * @property {string} site
 * @property {string} fetchedAt
 * @property {boolean} official
 * @property {boolean} rendered
 * @property {string} [snapshotPath]
 * @property {string} sha256
 */

/** @param {unknown} value @returns {string | null} */
function webUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A preserved snapshot's path, workspace-relative and inside `.evimed-sources/web-pages/`. */
function snapshotPath(value) {
  if (typeof value !== "string" || value.length > 512 || value.includes("\\")) return null;
  if (!value.startsWith(".evimed-sources/web-pages/")) return null;
  return value.split("/").some((part) => part === "" || part === "." || part === "..") ? null : value;
}

/**
 * One entry, or null when anything a card needs is missing or malformed.
 * The same normalizer reads what a run reported and what the ledger stored,
 * so a row written by any build folds to the same shape.
 * @param {any} value @returns {PageRead | null}
 */
export function normalizePageRead(value) {
  if (!value || typeof value !== "object") return null;
  const finalUrl = webUrl(value.finalUrl) ?? webUrl(value.url);
  const url = webUrl(value.url) ?? finalUrl;
  if (!finalUrl || !url) return null;
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
  const fetchedAt = typeof value.fetchedAt === "string" && Number.isFinite(Date.parse(value.fetchedAt))
    ? new Date(value.fetchedAt).toISOString()
    : null;
  if (!fetchedAt) return null;
  const site = new URL(finalUrl).hostname;
  const title = String(value.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS) || site;
  const snapshot = snapshotPath(value.snapshotPath ?? value.markdownPath);
  return {
    url,
    finalUrl,
    title,
    site,
    fetchedAt,
    official: isOfficialWebSource(finalUrl),
    rendered: value.rendered === true,
    ...(snapshot ? { snapshotPath: snapshot } : {}),
    sha256: value.sha256,
  };
}

/**
 * A stored or reported list, normalized and capped; undefined when the value
 * is not a list at all (so a row without the field folds to "not recorded").
 * @param {unknown} value @returns {PageRead[] | undefined}
 */
export function normalizePagesRead(value) {
  if (!Array.isArray(value)) return undefined;
  /** @type {PageRead[]} */
  const pages = [];
  for (const item of value) {
    if (pages.length >= MAX_PAGES_READ) break;
    const page = normalizePageRead(item);
    if (page) pages.push(page);
  }
  return pages;
}

/** An MCP tool's output as the transcript holds it: bare JSON text, or already an object. */
function parsedResult(output) {
  if (output && typeof output === "object") return output;
  if (typeof output !== "string") return null;
  const text = output.trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The pages a finished run read, first read first, one entry per snapshot.
 * @param {readonly any[]} sessions `collectRunTranscripts`' sessions, children included
 * @returns {{ pages: PageRead[], total: number }}
 */
export function pagesReadFromSessions(sessions) {
  /** @type {Map<string, PageRead>} */
  const pages = new Map();
  for (const session of sessions ?? []) {
    for (const call of completedToolCalls(session)) {
      if (mcpToolBaseName(call.tool) !== "web_read") continue;
      const result = parsedResult(call.output);
      if (result?.status !== "success" && result?.status !== "warning") continue;
      const page = normalizePageRead(result.data);
      if (!page) continue;
      const key = `${page.sha256}\u0000${page.finalUrl}`;
      if (!pages.has(key)) pages.set(key, page);
    }
  }
  const all = [...pages.values()];
  return { pages: all.slice(0, MAX_PAGES_READ), total: all.length };
}
