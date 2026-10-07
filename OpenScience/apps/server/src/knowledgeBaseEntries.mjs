/**
 * What a researcher can put into the knowledge base besides a file: a web page
 * (「添加网页链接」) and a note (「新建笔记」).
 *
 * Hidden knowledge: neither is a new kind of source. Each is written as a file
 * under the project's `knowledge-base/` and registered the way an upload is
 * (`writeProjectUpload` in `server.mjs`): the format admission, the project's
 * capacity, the atomic no-follow write, the mirror into a running runtime and
 * the source registration that parses and indexes it. There is no second
 * intake. What is new is only where the bytes come from, and one rule about
 * versions:
 *
 * - **A link is a snapshot.** The page is read by the public-web reader
 *   (`webRead.mjs`: robots.txt honoured, paced per site, rendered in a browser
 *   when it is drawn in script, PDFs through the parser, every hop's address
 *   checked) — reused as it is, not reimplemented — and what it read is kept:
 *   the text as `knowledge-base/links/<slug>.md` with the address and the
 *   fetch time in front of it, and the original HTML beside it where nothing
 *   reads it as a document (`knowledge-base/.evimed-snapshots/`). A PDF or an
 *   office document is kept as itself, and read by the intake like any
 *   upload. Nothing refetches by itself; 「重新读取」 is the researcher's.
 * - **A refresh or a save replaces.** The same address (or the same note)
 *   always writes the same path, so changed bytes are the next version of
 *   one document. The researcher refreshed or edited one thing; the version it
 *   replaces goes, and what rests on it is told (`SourceService.register`'s
 *   replacement hand-off). Identical bytes change nothing but the fetch time.
 *
 * @module knowledgeBaseEntries
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { SOURCE_FOLDERS, sourceOriginOf } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** The longest title a note or a snapshot is filed under. */
const TITLE_MAX_CHARS = 120;
/** The longest address a link may be. */
const URL_MAX_CHARS = 2048;
/** How much of a title becomes part of a file name. */
const SLUG_MAX_CHARS = 48;

/** @param {string} value */
const digest = (value) => createHash("sha256").update(value).digest("hex");

/**
 * A name a file can keep: letters and digits of any script, and `.`, `_`, `-`;
 * everything else becomes one hyphen. Never empty.
 * @param {string} value @param {string} fallback
 */
export function fileSlug(value, fallback) {
  const slug = String(value ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, SLUG_MAX_CHARS);
  return slug || fallback;
}

/**
 * The name a link's snapshot is filed under: the site, the tail of the address and
 * eight hex digits of the address itself. Deterministic, so the same address is the
 * same path — which is what makes a refresh a new version of one document.
 * @param {URL} url
 */
export function linkSlug(url) {
  const normalized = new URL(url.href);
  normalized.hash = "";
  const site = fileSlug(normalized.hostname.replace(/^www\./, ""), "page");
  const tail = fileSlug(normalized.pathname.split("/").filter(Boolean).slice(-2).join("-"), "");
  return [site, tail, digest(normalized.href).slice(0, 8)].filter(Boolean).join("-");
}

/**
 * The text snapshot of a page: its address, when it was read and who it came
 * from in front, then the text the reader took from it.
 * @param {{ url: string, finalUrl: string, title: string, site: string, fetchedAt: string, rendered: boolean, text: string, notice?: string | null }} page
 */
export function snapshotMarkdown(page) {
  return [
    "---",
    `url: ${page.url}`,
    ...(page.finalUrl !== page.url ? [`final_url: ${page.finalUrl}`] : []),
    `title: ${JSON.stringify(page.title)}`,
    `site: ${page.site}`,
    `fetched_at: ${page.fetchedAt}`,
    ...(page.rendered ? ["rendered: true"] : []),
    "---",
    "",
    `# ${page.title}`,
    "",
    page.text.trim(),
    "",
  ].join("\n");
}

/**
 * What a researcher is told when a page cannot be added, as the code the page's
 * sentence (`@evimed/domain`'s error registry) is looked up by. The reader's own
 * codes are written for a run that will try another source; these are for a person
 * who pasted one address.
 * @param {unknown} error @returns {HttpError}
 */
export function linkError(error) {
  const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "";
  if (error instanceof HttpError && code.startsWith("source_")) return error;
  /** @type {[RegExp | string[], number, string][]} */
  const table = [
    [["web_read_url_invalid", "web_read_url_forbidden"], 400, "source_link_invalid"],
    [["web_read_host_forbidden"], 403, "source_link_private"],
    [["web_read_robots_disallowed"], 403, "source_link_blocked"],
    [["web_read_login_required"], 403, "source_link_login_required"],
    [["web_read_not_found"], 404, "source_link_not_found"],
    [["web_read_needs_browser", "web_read_unreadable", "web_read_page_too_complex", "web_read_content_type_unsupported", "web_read_document_parser_unavailable",
      "source_parser_rejected", "source_format_unsupported"], 422, "source_link_unreadable"],
    [["web_read_response_too_large", "web_read_response_invalid", "source_parser_payload_too_large", "file_too_large"], 413, "source_link_too_large"],
    [["web_read_disabled", "web_read_unavailable", "web_read_unconfigured"], 503, "source_link_unavailable"],
    [["web_read_busy", "web_read_runtime_busy", "web_read_host_busy"], 429, "source_link_busy"],
    [["web_read_host_unresolved", "web_read_upstream_error", "web_read_upstream_unavailable", "web_read_too_many_redirects", "web_read_timeout", "web_read_aborted"], 502, "source_link_unreachable"],
  ];
  const found = table.find(([codes]) => /** @type {string[]} */ (codes).includes(code));
  return new HttpError(found ? found[1] : 502, found ? found[2] : "source_link_failed", "The page could not be added.");
}

/**
 * What a snapshot says of the page, without the front matter that says when it was read: the part two reads of an
 * unchanged page share.
 * @param {string} markdown
 */
function snapshotBody(markdown) {
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + 5).trim();
}

/** The folder and format a snapshot's original bytes are kept under. @param {string} slug @param {string} extension */
const originalPath = (slug, extension) => `${SOURCE_FOLDERS.snapshots}/${slug}.${extension}`;

/**
 * @param {{
 *   sources: any,
 *   write: (request: { user: any, project: any, rel: string, buffer: Buffer, meta?: Record<string, any>, register?: boolean }) => Promise<any>,
 *   readWeb: (url: string, options: { signal?: AbortSignal, runtime?: { userId: string, projectId: string }, onBytes?: (kept: any) => void }) => Promise<any>,
 *   readFile: (project: any, rel: string) => Promise<Buffer>,
 *   readTimeoutMs?: number,
 *   now?: () => Date,
 * }} dependencies
 */
export function createKnowledgeBaseEntries({ sources, write, readWeb, readFile, readTimeoutMs = 150_000, now = () => new Date() }) {
  /**
   * Retire the older versions of a document that was just written again: the live
   * sources of the same family other than the one that now stands. The replacement
   * hand-off has already told what rests on them.
   * @param {any} user @param {any} current
   */
  async function retireOlderVersions(user, current) {
    const familyId = current.payload?.familyId;
    if (typeof familyId !== "string") return;
    const family = await sources.documents.list(user.id, "source", { projectId: current.projectId, filter: { familyId }, limit: 100 });
    for (const older of family.items) {
      if (older.id === current.id) continue;
      await sources.remove(user.id, older.id, { expectedRevision: older.revision, accountCreatedAt: user.accountCreatedAt });
    }
  }

  /**
   * Read the address and write what it read as a snapshot of the project.
   * @param {{ user: any, project: any, url: string }} request
   */
  async function snapshot({ user, project, url: raw }) {
    const requested = typeof raw === "string" ? raw.trim() : "";
    if (!requested || requested.length > URL_MAX_CHARS) throw new HttpError(400, "source_link_invalid", "The link is not a web address.");
    let address;
    try { address = new URL(requested); } catch { throw new HttpError(400, "source_link_invalid", "The link is not a web address."); }
    if (address.protocol !== "http:" && address.protocol !== "https:") throw new HttpError(400, "source_link_invalid", "Only http and https pages can be added.");
    // A fragment names a place in the page, not another page.
    address.hash = "";
    /** @type {any} */
    let kept = null;
    let page;
    try {
      page = await readWeb(address.href, { signal: AbortSignal.timeout(readTimeoutMs), runtime: { userId: user.id, projectId: project.id }, onBytes: (value) => { kept = value; } });
    } catch (error) { throw linkError(error); }
    const receipt = page?.receipt ?? {};
    const slug = linkSlug(address);
    const site = String(receipt.site || address.hostname);
    const link = { url: address.href, finalUrl: String(receipt.finalUrl || address.href), site, fetchedAt: String(receipt.fetchedAt || now().toISOString()), rendered: receipt.rendered === true, original: /** @type {string | null} */ (null) };
    const title = String(receipt.title || site).trim().slice(0, TITLE_MAX_CHARS) || site;
    // A PDF or an office document is the document itself: kept as it was served and read by the intake like an upload.
    if (receipt.contentType === "document" && kept?.bytes) {
      const rel = `${SOURCE_FOLDERS.links}/${slug}.${kept.extension}`;
      return { rel, registered: await writeEntry(user, project, rel, kept.bytes, { title, link }) };
    }
    const text = String(page?.text ?? "").trim();
    if (!text) throw new HttpError(422, "source_link_unreadable", "The page has no text to read.");
    if (kept?.bytes && kept.extension === "html") {
      const original = originalPath(slug, "html");
      await write({ user, project, rel: original, buffer: kept.bytes, register: false });
      link.original = original;
    }
    const rel = `${SOURCE_FOLDERS.links}/${slug}.md`;
    const markdown = snapshotMarkdown({ ...link, title, text, notice: page?.notice ?? null });
    // The page read again and found as it was: the snapshot says only when it was read. (The front matter carries the
    // time, so the bytes would differ on every read and each one would be a new version of an unchanged page.)
    const standing = await standingSnapshot(user, project, rel, markdown);
    if (standing) return { rel, registered: { source: await sources.refreshFacts(user.id, standing, { title, link }), duplicate: true, job: null } };
    return { rel, registered: await writeEntry(user, project, rel, Buffer.from(markdown, "utf8"), { title, link }) };
  }

  /**
   * The live source standing at `rel` when the file there already holds this page's text, else null.
   * @param {any} user @param {any} project @param {string} rel @param {string} markdown
   */
  async function standingSnapshot(user, project, rel, markdown) {
    const found = await sources.documents.list(user.id, "source", { projectId: project.id, filter: { paths: [rel] }, limit: 1 });
    const standing = found.items[0];
    if (!standing) return null;
    try {
      const previous = (await readFile(project, rel)).toString("utf8");
      return snapshotBody(previous) === snapshotBody(markdown) ? standing : null;
    } catch { return null; }
  }

  /** @param {any} user @param {any} project @param {string} rel @param {Buffer} buffer @param {Record<string, any>} meta */
  async function writeEntry(user, project, rel, buffer, meta) {
    const registered = await write({ user, project, rel, buffer, meta });
    if (!registered?.source) throw new HttpError(503, "source_state_unavailable", "Source intake is not available.");
    if (!registered.duplicate) await retireOlderVersions(user, registered.source);
    return registered;
  }

  /** @param {unknown} value */
  function noteTitle(value) {
    const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!title || title.length > TITLE_MAX_CHARS) throw new HttpError(400, "source_note_invalid", "A note needs a title of up to 120 characters.");
    return title;
  }

  /** @param {unknown} value */
  function noteBody(value) {
    if (value != null && typeof value !== "string") throw new HttpError(400, "source_note_invalid", "The note's text is invalid.");
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  /** @param {string} title @param {string} body */
  const noteMarkdown = (title, body) => `# ${title}\n\n${body.trim()}\n`;

  return {
    /**
     * 「添加网页链接」: read the page and keep a snapshot of it.
     * @param {{ user: any, project: any, url: unknown }} request
     */
    async addLink({ user, project, url }) {
      const { registered } = await snapshot({ user, project, url: String(url ?? "") });
      return { ...registered, changed: !registered.duplicate };
    },

    /**
     * 「重新读取」 on a link: read the address again. The same bytes only say when they were read; different bytes are
     * the document's next version (`changed`), and the document that was there goes.
     * @param {{ user: any, project: any, source: any }} request
     */
    async refetchLink({ user, project, source }) {
      const url = source.payload?.link?.url;
      if (typeof url !== "string") throw new HttpError(409, "source_link_required", "This document is not a saved web page.");
      const { registered } = await snapshot({ user, project, url });
      return { ...registered, changed: !registered.duplicate };
    },

    /**
     * 「新建笔记」: a Markdown document the researcher writes.
     * @param {{ user: any, project: any, title: unknown, body: unknown }} request
     */
    async addNote({ user, project, title, body }) {
      const heading = noteTitle(title);
      const text = noteBody(body);
      // A note's name carries a few digits of when it was made, so two notes with one title are two notes.
      const stamp = digest(`${user.id}\0${project.id}\0${heading}\0${now().toISOString()}\0${Math.random()}`).slice(0, 6);
      const rel = `${SOURCE_FOLDERS.notes}/${fileSlug(heading, "note")}-${stamp}.md`;
      return writeEntry(user, project, rel, Buffer.from(noteMarkdown(heading, text), "utf8"), { title: heading });
    },

    /**
     * What a note's editor opens with: its title and the text under it.
     * @param {{ project: any, source: any }} request
     */
    async readNote({ project, source }) {
      const rel = requireNote(source);
      const content = (await readFile(project, rel)).toString("utf8");
      const title = typeof source.payload?.title === "string" && source.payload.title ? source.payload.title : path.posix.basename(rel, ".md");
      const heading = `# ${title}\n`;
      const body = content.startsWith(heading) ? content.slice(heading.length).replace(/^\n+/, "") : content;
      return { title, body: body.replace(/\n+$/, "") };
    },

    /**
     * 「保存」 in a note's editor: written to the same path, so changed text is the note's next version.
     * @param {{ user: any, project: any, source: any, title: unknown, body: unknown }} request
     */
    async saveNote({ user, project, source, title, body }) {
      const rel = requireNote(source);
      const heading = noteTitle(title);
      const registered = await writeEntry(user, project, rel, Buffer.from(noteMarkdown(heading, noteBody(body)), "utf8"), { title: heading });
      return { ...registered, changed: !registered.duplicate };
    },
  };
}

/** The path of a note, or the refusal that this document is not one. @param {any} source */
function requireNote(source) {
  const rel = source?.payload?.paths?.[0];
  if (typeof rel !== "string" || sourceOriginOf({ connectorType: source.payload.connector?.type, path: rel }) !== "note") {
    throw new HttpError(409, "source_note_required", "This document is not a note.");
  }
  return rel;
}
