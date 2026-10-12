/**
 * A project's knowledge base as an Obsidian vault (2026-10-12, knowledge base P0): one Markdown note per document, an
 * `index.md` that links them all, and — where the project has them — its knowledge pages, in one zip.
 *
 * What a note holds is what the platform already holds about the document, written out and not computed again: the
 * front matter is the metadata the parser read (title, authors, year, DOI, where it was published); the body is the
 * understanding's summary and its claims, each with the verbatim quotation it rests on, byte for byte as the document
 * says it. A note the researcher wrote is their own text. A knowledge page is the page as it is. Links are `[[...]]`
 * with the vault-relative path, so a note's name can repeat (the second is numbered) and every link still lands, and
 * each note points back to the index and to the notes that share one of its keywords — a vault whose graph is not a
 * row of strangers.
 *
 * Hidden knowledge:
 *
 * - **Read, never changed.** Nothing about the library is written, labelled or counted by an export.
 * - **A document is exported when it can be read.** One still being read, or that could not be, has nothing to say yet; it
 *   is not in the index either, so the index never names a note that is not there.
 * - **The size limit is the archive limit** (`maxArchiveEntries`, `maxArchiveBytes`) the project and account exports obey, and
 *   it refuses the same way (413 `archive_too_large`) — a vault with the last third of the library missing is not an export.
 * - **No knowledge pages is not an error.** The `knowledge-base/wiki/` folder holds them where the deployment compiles
 *   them; without it the vault is the documents.
 * - **Failure keeps the partial result.** An understanding that cannot be read costs that note its body, not the vault.
 *
 * @module knowledgeVaultExport
 */
import { zipSync } from "fflate";
import { HttpError } from "./security.mjs";
import { sourceDisplayOf } from "./sourceDisplay.mjs";
import { publicationYear } from "./sourceMetadata.mjs";
import { sourceReadable } from "./sourceService.mjs";

/** Where the compiled pages live, relative to the project's base folder. */
const WIKI_FOLDER = "knowledge-base/wiki/";
const PAGE = 100;
const NOTE_NAME_CHARS = 80;
/** A note's `## 相关` lists at most this many of the notes that share a keyword with it. */
const RELATED = 5;
/** Notes read at once; each is two small reads. */
const CONCURRENCY = 6;
const encoder = new TextEncoder();

/** @param {unknown} value @returns {string} */
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * A name a note can have in a vault and be linked by: none of the characters Obsidian refuses in a link or a file.
 * @param {unknown} title @param {string} fallback
 */
export function noteName(title, fallback) {
  const printable = [...clean(title)].map((char) => (char.charCodeAt(0) < 32 ? " " : char)).join("");
  const name = printable.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+/, "").slice(0, NOTE_NAME_CHARS).trim();
  return name || fallback;
}

/** A YAML double-quoted scalar: JSON's string syntax is YAML's. @param {unknown} value */
const quoted = (value) => JSON.stringify(String(value));

/**
 * The front matter of a note: only the fields the document has.
 * @param {Array<[string, string | number | string[] | null | undefined]>} fields
 */
export function frontMatter(fields) {
  const lines = [];
  for (const [key, value] of fields) {
    if (Array.isArray(value)) { if (value.length > 0) lines.push(`${key}: [${value.map(quoted).join(", ")}]`); }
    else if (typeof value === "number") lines.push(`${key}: ${value}`);
    else if (clean(value)) lines.push(`${key}: ${quoted(clean(value))}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

/** A quotation as a blockquote under its claim: every line the document's own, prefixed and nothing else changed. @param {string} quote */
const blockquote = (quote) => quote.split("\n").map((line) => `   > ${line}`).join("\n");

/**
 * The summary and the claims of an understanding, with the quotations they rest on.
 * @param {any} understanding the current understanding's output
 */
export function understandingBody(understanding) {
  const parts = [];
  const summary = String(understanding?.summary ?? "").trim();
  if (summary) parts.push(`## 摘要\n\n${summary}\n`);
  const claims = (understanding?.claims ?? []).filter((/** @type {any} */ claim) => clean(claim?.statement));
  if (claims.length > 0) {
    parts.push(`## 论断\n\n${claims.map((/** @type {any} */ claim, /** @type {number} */ index) => {
      const quotes = (claim.evidence ?? []).map((/** @type {any} */ anchor) => String(anchor?.quote ?? "")).filter((/** @type {string} */ quote) => quote.trim());
      return [`${index + 1}. ${clean(claim.statement)}`, ...quotes.map(blockquote)].join("\n");
    }).join("\n\n")}\n`);
  }
  return parts.join("\n");
}

/** The title a Markdown page gives itself: its front matter's `title`, else its first heading. @param {string} text @param {string} fallback */
export function pageTitle(text, fallback) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const titled = front ? /^title:\s*(.+)$/m.exec(front[1]) : null;
  if (titled) {
    const value = titled[1].trim();
    try { const parsed = value.startsWith('"') ? JSON.parse(value) : value.replace(/^'(.*)'$/, "$1"); if (clean(parsed)) return clean(parsed); }
    catch { /* an unquoted value is read as written */ }
  }
  const heading = /^#\s+(.+)$/m.exec(front ? text.slice(front[0].length) : text);
  return heading ? clean(heading[1]) : fallback;
}

/** Run `work` over `items`, `CONCURRENCY` at a time, keeping their order. @template T @template R @param {T[]} items @param {(item: T) => Promise<R>} work */
async function inBatches(items, work) {
  /** @type {R[]} */
  const out = [];
  for (let start = 0; start < items.length; start += CONCURRENCY) out.push(...await Promise.all(items.slice(start, start + CONCURRENCY).map(work)));
  return out;
}

export class KnowledgeVaultExport {
  /**
   * `sources` lists a project's documents (`SourceService.list`), `documents` reads the understanding each one is
   * current at, and `readText` reads a file of the project's base folder — a note's text, a knowledge page — as text, or
   * null where it cannot be read. `maxEntries` and `maxBytes` are the archive limits.
   * @param {{ sources: { list: (userId: string, options: any) => Promise<{ items: any[], nextCursor?: string | null }> },
   *   documents: { get: (userId: string, kind: string, id: string) => Promise<any> },
   *   readText?: ((project: any, relativePath: string) => Promise<string | null>) | null,
   *   maxEntries?: number, maxBytes?: number, report?: (code: string) => void }} dependencies
   */
  constructor({ sources, documents, readText = null, maxEntries = 10_000, maxBytes = 1024 * 1024 * 1024, report = () => {} }) {
    this.sources = sources; this.documents = documents; this.readText = readText;
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.report = report;
  }

  /** @param {string} userId @param {string} projectId @returns {Promise<any[]>} the project's documents, newest first, all of them */
  async #listAll(userId, projectId) {
    /** @type {any[]} */
    const items = [];
    let cursor = null;
    do {
      const page = await this.sources.list(userId, { projectId, limit: PAGE, cursor });
      items.push(...page.items);
      cursor = page.nextCursor ?? null;
      if (items.length > this.maxEntries) break;
    } while (cursor);
    return items;
  }

  /** The current understanding of a document, or null where it has none or cannot be read. @param {string} userId @param {any} source */
  async #understanding(userId, source) {
    const id = source.payload?.currentUnderstandingId;
    if (!id) return null;
    try {
      const row = await this.documents.get(userId, "knowledge", id);
      return row?.projectId === source.projectId && row.payload?.sourceId === source.id && row.payload?.generation === source.payload.generation
        ? row.payload.output ?? null : null;
    } catch (error) { this.report(typeof error?.code === "string" ? error.code : "knowledge_vault_understanding_failed"); return null; }
  }

  /**
   * @param {string} userId @param {{ id: string, name?: string }} project
   * @returns {Promise<{ bytes: Uint8Array, filename: string, mimeType: string, notes: number, pages: number }>}
   */
  async export(userId, project) {
    const listed = (await this.#listAll(userId, project.id)).filter((source) => sourceReadable(source.payload));
    const path0 = (/** @type {any} */ source) => String(source.payload?.paths?.[0] ?? "");
    const pages = listed.filter((source) => path0(source).startsWith(WIKI_FOLDER));
    const documents = listed.filter((source) => !path0(source).startsWith(WIKI_FOLDER));
    if (documents.length + pages.length + 1 > this.maxEntries) throw this.#tooLarge("entries");

    /** Names are taken in listing order; a repeat is numbered, and the number is in every link to it. @type {Set<string>} */
    const taken = new Set();
    /** @param {string} folder @param {string} name */
    const claim = (folder, name) => {
      let candidate = name;
      for (let n = 2; taken.has(`${folder}/${candidate}`.toLowerCase()); n += 1) candidate = `${name} (${n})`;
      taken.add(`${folder}/${candidate}`.toLowerCase());
      return candidate;
    };

    const read = await inBatches(documents, async (source) => {
      const metadata = source.payload?.metadata ?? {};
      const display = sourceDisplayOf(source);
      const note = display.origin === "note";
      const title = clean(display.title) || "资料";
      const authored = note && this.readText ? await this.readText(project, path0(source)).catch((/** @type {any} */ error) => { this.report(typeof error?.code === "string" ? error.code : "knowledge_vault_read_failed"); return null; }) : null;
      return { source, metadata, display, title, authored, understanding: authored === null ? await this.#understanding(userId, source) : null };
    });
    const entries = read.map((item) => ({ ...item, name: claim("sources", noteName(item.title, "资料")) }));
    const wikiEntries = (await inBatches(pages, async (source) => {
      const text = this.readText ? await this.readText(project, path0(source)).catch(() => null) : null;
      return text === null ? null : { source, text };
    })).filter((item) => item !== null).map((item) => {
      const relative = path0(item.source).slice(WIKI_FOLDER.length).replace(/\.md$/i, "");
      const name = relative.split("/").map((segment) => noteName(segment, "页")).join("/");
      return { ...item, name: claim("wiki", name), title: pageTitle(item.text, name.split("/").pop() ?? name) };
    });

    // Notes that share a keyword point at each other.
    /** @type {Map<string, number[]>} */
    const byKeyword = new Map();
    entries.forEach((entry, index) => {
      for (const word of new Set((entry.metadata.keywords ?? []).map((/** @type {string} */ keyword) => clean(keyword).toLowerCase()).filter(Boolean))) {
        byKeyword.set(word, [...(byKeyword.get(word) ?? []), index]);
      }
    });
    /** @param {number} index */
    const relatedTo = (index) => {
      /** @type {Map<number, number>} */
      const shared = new Map();
      for (const holders of byKeyword.values()) if (holders.includes(index)) for (const other of holders) if (other !== index) shared.set(other, (shared.get(other) ?? 0) + 1);
      return [...shared.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]).slice(0, RELATED).map(([other]) => other);
    };

    const home = noteName(project.name, "知识库");
    const root = `${home}/`;
    /** @type {Record<string, Uint8Array>} */
    const files = {};
    let total = 0;
    /** @param {string} relative @param {string} text */
    const add = (relative, text) => {
      const bytes = encoder.encode(text);
      total += bytes.length;
      if (total > this.maxBytes) throw this.#tooLarge("bytes");
      files[`${root}${relative}`] = bytes;
    };
    const link = (/** @type {string} */ folder, /** @type {string} */ name, /** @type {string} */ shown) => `[[${folder}/${name}|${shown.replace(/[\]|]/g, " ")}]]`;

    entries.forEach((entry, index) => {
      const { metadata, source, display, authored, understanding } = entry;
      const authors = (metadata.authors ?? []).map(clean).filter(Boolean);
      const front = frontMatter([
        ["title", entry.title], ["authors", authors], ["year", publicationYear(metadata.publicationDate)], ["doi", metadata.doi],
        ["source", metadata.source || source.payload?.link?.site || null], ["url", source.payload?.link?.url || null],
        ["type", display.typeLabel], ["keywords", (metadata.keywords ?? []).map(clean).filter(Boolean)],
      ]);
      const body = (authored !== null ? authored : understandingBody(understanding)).trim();
      const related = relatedTo(index);
      add(`sources/${entry.name}.md`, [
        front.trimEnd(),
        // A note the researcher wrote begins with its own title.
        authored !== null && /^#\s/.test(body) ? "" : `# ${entry.title}`,
        body,
        related.length > 0 ? `## 相关\n\n${related.map((other) => `- ${link("sources", entries[other].name, entries[other].title)}`).join("\n")}` : "",
        "---\n[[index|知识库索引]]",
      ].filter(Boolean).join("\n\n") + "\n");
    });
    for (const page of wikiEntries) add(`wiki/${page.name}.md`, page.text);

    const meta = (/** @type {typeof entries[number]} */ entry) => {
      const authors = (entry.metadata.authors ?? []).map(clean).filter(Boolean);
      return [authors.length > 0 ? `${authors.slice(0, 2).join("、")}${authors.length > 2 ? " 等" : ""}` : "", publicationYear(entry.metadata.publicationDate) ?? ""].filter(Boolean).join(" · ");
    };
    add("index.md", [frontMatter([["title", clean(project.name) || "知识库"]]),
      `# ${clean(project.name) || "知识库"}`, "",
      entries.length > 0 ? `## 资料\n\n${entries.map((entry) => `- ${link("sources", entry.name, entry.title)}${meta(entry) ? ` — ${meta(entry)}` : ""}`).join("\n")}\n` : "",
      wikiEntries.length > 0 ? `## 知识页\n\n${wikiEntries.map((page) => `- ${link("wiki", page.name, page.title)}`).join("\n")}\n` : ""].join("\n"));

    if (Object.keys(files).length > this.maxEntries) throw this.#tooLarge("entries");
    return { bytes: zipSync(files, { level: 6 }), filename: "evimed-knowledge-base.zip", mimeType: "application/zip", notes: entries.length, pages: wikiEntries.length };
  }

  /** @param {"entries" | "bytes"} what */
  #tooLarge(what) {
    return new HttpError(413, "archive_too_large", what === "entries"
      ? `The knowledge base export exceeded ${Math.floor(this.maxEntries)} entries.` : `The knowledge base export exceeded ${Math.floor(this.maxBytes)} bytes.`);
  }
}
