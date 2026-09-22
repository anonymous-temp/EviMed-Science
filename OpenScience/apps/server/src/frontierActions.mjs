/**
 * The two things a reader can ask the feed to do for them that write something
 * (「前沿动态」, plan §4.7, §7.5, §10.3.6): save an item into the current
 * project's knowledge base, and write an item's Chinese abstract.
 *
 * Hidden knowledge:
 *
 * - **存入知识库 goes through the upload's own path.** The file is written by
 *   the same helper `/api/files/upload` uses (`server.mjs`,
 *   `writeProjectUpload`): the knowledge base's format admission, the
 *   project's capacity, an atomic no-follow write, the mirror into a running
 *   runtime, and the source registration that parses and indexes it. So a
 *   saved item is a source like any upload — parsed, indexed, searchable by
 *   `kb_search` — and this module adds no connector type (a deviation from the
 *   plan's `web` connector, recorded in the build spec D.5).
 * - **An open-access PDF, or an honest record.** An item whose enrichment
 *   names an open-access PDF (Unpaywall, through the plugin) is saved as that
 *   PDF, fetched through the platform's pinned web transport — every hop's
 *   address checked and the socket pinned to it (`webReadNetwork.mjs`), at
 *   most five redirects, the body bounded by the upload limit, the bytes
 *   required to be a PDF. Anything else — no open access, or a PDF that could
 *   not be had — is saved as a short Markdown record (title, authors, source,
 *   DOI and link, the Chinese summary, the abstract) and the answer says which
 *   was saved and why (plan §4.7: 「并如实告知」).
 * - **中文摘要 is the read path's one model call** (plan §10.5.1), made the
 *   first time any reader opens it and then shared by every reader
 *   (`item_texts.abstract_zh`). It is gated by the module's daily budget,
 *   checked like every piece of prose the editor writes — every number must
 *   be in the original — and one reader's request is the only one in flight
 *   for an item. A reader may cause at most thirty new ones an hour, because
 *   the budget is the pipeline's too. When it cannot be written (no model,
 *   the budget spent, the reader's hour used, the check failed twice) the
 *   original abstract is returned with a sentence that says why, never
 *   nothing and never a softened translation.
 *
 * @module frontierActions
 */

import { FRONTIER_SOURCE_TYPE_LABELS_ZH } from "@evimed/domain";
import { isChineseProse } from "./frontierEditor.mjs";
import { FrontierGlossaryStore } from "./frontierGlossary.mjs";
import { bumpFrontierVersion, FRONTIER_META_KEYS, migrateFrontier } from "./frontierPersistence.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { HttpError } from "./security.mjs";
import { webReadUserAgent } from "./webRead.mjs";
import { headerValue, nodeWebTransport, validatedWebUrl } from "./webReadNetwork.mjs";

const PUBLIC_ID = /^[a-z0-9]{12,32}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Redirect hops one PDF download follows (the web reader's own bound). */
export const FRONTIER_PDF_MAX_REDIRECTS = 5;
/** The most a PDF download may take. */
export const FRONTIER_PDF_TIMEOUT_MS = 30_000;
/** A PDF is never larger than this, whatever the upload limit says. */
const PDF_MAX_BYTES = 50 * 1024 * 1024;
/** The folder saved items go to, under the project's knowledge base. */
export const FRONTIER_LIBRARY_FOLDER = "knowledge-base/frontier";
/**
 * New Chinese abstracts one reader may cause in an hour. They are paid from
 * the module's daily budget, which the pipeline's editing also draws on: one
 * reader opening abstract after abstract must not spend the day's editing. A
 * cached abstract costs nothing and is never counted; the cap is per process
 * and counted (`abstractsLimited`).
 */
export const FRONTIER_ABSTRACT_READER_HOURLY = 30;

/** What the reader is told when there is no Chinese abstract to show. */
export const FRONTIER_ABSTRACT_NOTES = Object.freeze({
  unavailable: "中文摘要暂时不可用，下面是原文摘要。",
  exhausted: "今天的中文摘要额度已用完，下面是原文摘要。",
  dropped: "中文摘要这次没有通过数字核对，下面是原文摘要。",
  limited: "这一小时你请求的新中文摘要较多，稍后再试；下面是原文摘要。",
  failed: "中文摘要这次没有生成，下面是原文摘要。",
  none: "这一条没有原文摘要。",
});

// ───────────────────────── pure (unit-tested) ─────────────────────────

/**
 * The file name a saved item gets: the day it was published, a short slug of
 * its title (letters and digits of any script), and a piece of its id, so two
 * items never collide and saving one again overwrites its own file.
 * @param {{ publicId: string, title: string, day: string }} input
 */
export function frontierLibrarySlug({ publicId, title, day }) {
  const words = [...String(title ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")]
    .slice(0, 40).join("").replace(/-+$/g, "");
  return `${day}-${words || "item"}-${String(publicId).slice(0, 6)}`;
}

/**
 * The Markdown record a non-open-access item is saved as: what a reader needs
 * to cite it and find it again, and the summary the feed wrote about it.
 * @param {{ item: any, savedAt: Date, day: string, reason?: string | null }} input
 */
export function frontierLibraryRecord({ item, savedAt, day, reason = null }) {
  const title = String(item.title_zh || item.title_raw).replace(/\s+/g, " ").trim();
  const sourceType = /** @type {Record<string, string>} */ (FRONTIER_SOURCE_TYPE_LABELS_ZH)[item.source_type] ?? null;
  const lines = [`# ${title}`, ""];
  if (item.title_zh && item.title_zh !== item.title_raw) lines.push(`原标题：${String(item.title_raw).replace(/\s+/g, " ").trim()}`);
  lines.push(`来源：${item.source_name}${sourceType ? `（${sourceType}）` : ""}`);
  if (item.authors_short) lines.push(`作者：${item.authors_short}`);
  if (item.journal) lines.push(`期刊：${item.journal}`);
  if (item.published_at && item.date_precision !== "inferred") lines.push(`发布日期：${day}`);
  if (item.doi) lines.push(`DOI：${item.doi}`);
  if (item.pmid) lines.push(`PMID：${item.pmid}`);
  if (Array.isArray(item.registry_ids) && item.registry_ids.length) lines.push(`注册号：${item.registry_ids.join("、")}`);
  lines.push(`原文链接：${item.canonical_url}`);
  lines.push(`开放获取：${item.open_access && item.open_access !== "closed" ? item.open_access : "无开放获取全文，这里只存题录和链接"}`);
  if (item.summary_zh) lines.push("", "## 导读", "", String(item.summary_zh));
  if (item.reason_zh) lines.push("", "## 为什么值得看", "", String(item.reason_zh));
  if (item.abstract_raw) lines.push("", "## 原文摘要", "", String(item.abstract_raw).trim());
  lines.push("", "---", "",
    `由 EviMed「前沿动态」于 ${savedAt.toISOString().slice(0, 10)} 存入。${reason ? `${reason}` : ""}导读由模型根据原文写成，数字已逐字核对；引用前请阅读原文。`, "");
  return lines.join("\n");
}

/**
 * Download an open-access PDF through the pinned transport: every hop
 * validated (public http(s), default port), redirects followed by hand, the
 * body bounded, the bytes required to begin as a PDF.
 * @param {{ url: string, transport: import("./webReadNetwork.mjs").WebTransport, userAgent: string, maxBytes: number, timeoutMs?: number }} input
 * @returns {Promise<{ bytes: Buffer, finalUrl: string }>}
 */
export async function fetchOpenAccessPdf({ url, transport, userAgent, maxBytes, timeoutMs = FRONTIER_PDF_TIMEOUT_MS }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = validatedWebUrl(url);
  for (let hop = 0; hop <= FRONTIER_PDF_MAX_REDIRECTS; hop += 1) {
    const response = await transport({ url: current, headers: { "user-agent": userAgent, accept: "application/pdf, */*;q=0.5" }, signal, maxBytes });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = headerValue(response.headers, "location");
      if (!location || hop === FRONTIER_PDF_MAX_REDIRECTS) break;
      current = validatedWebUrl(new URL(location, current).toString());
      continue;
    }
    if (response.status !== 200) {
      throw new HttpError(502, "frontier_library_pdf_unavailable", `The open-access PDF answered HTTP ${response.status}.`);
    }
    if (!response.body.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
      throw new HttpError(502, "frontier_library_pdf_invalid", "The open-access link did not return a PDF.");
    }
    return { bytes: response.body, finalUrl: current.toString() };
  }
  throw new HttpError(502, "frontier_library_pdf_redirects", "The open-access PDF redirected too many times.");
}

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_action_failed";
}

// ───────────────────────── the actions ─────────────────────────

export class FrontierActions {
  /**
   * @param {{ database: any, editor?: any, library?: { project: (user: any, projectId: string) => Promise<any>,
   *             save: (input: { user: any, project: any, rel: string, buffer: Buffer }) => Promise<any> } | null,
   *           config?: Record<string, any>, budget?: (() => Promise<{ state: string }>) | null, glossary?: any,
   *           pdfTransport?: import("./webReadNetwork.mjs").WebTransport, now?: () => Date, dimension?: number }} options
   *   `library` resolves a reader's project and writes a file the way an upload
   *   does (server.mjs); without it there is no 存入知识库.
   */
  constructor({ database, editor = null, library = null, config = {}, budget = null, glossary = null, pdfTransport = nodeWebTransport(),
    now = () => new Date(), dimension = 1024 }) {
    if (!database) throw new TypeError("The frontier actions need the product database.");
    this.database = database;
    this.editor = editor;
    this.library = library;
    this.config = config ?? {};
    this.budgetReader = budget;
    this.glossaryStore = glossary && typeof glossary.current === "function" ? glossary : new FrontierGlossaryStore({ database });
    this.pdfTransport = pdfTransport;
    this.now = now;
    this.dimension = Number(this.config.kbEmbeddingDimension) || dimension;
    this.userAgent = webReadUserAgent(this.config);
    /** @type {Map<string, Promise<any>>} one abstract call per item at a time */
    this.inflight = new Map();
    /** @type {Map<string, number[]>} reader → when each of their new abstracts was asked for, this hour */
    this.readerCalls = new Map();
    /** Observable counters (principle 15). */
    this.counters = { savedPdf: 0, savedRecord: 0, pdfFailures: 0, abstractsWritten: 0, abstractsCached: 0, abstractsRefused: 0, abstractsDropped: 0,
      abstractsLimited: 0 };
    /** @type {string | null} */
    this.lastError = null;
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /** What `/status` says the page may offer. */
  capabilities() {
    return {
      saveToLibrary: Boolean(this.library),
      abstractZh: this.config.deepseekProviderEnabled === true && Boolean(this.config.deepseekApiKey),
    };
  }

  /** One published item of an enabled source, with its texts, or a 404. @param {string} publicId */
  async #item(publicId) {
    if (!PUBLIC_ID.test(String(publicId ?? ""))) throw new HttpError(404, "frontier_item_not_found", "No such item.");
    await this.ready();
    const row = (await this.database.query(`SELECT i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.reason_zh, i.lang, i.doi, i.pmid,
        i.registry_ids, i.canonical_url, i.published_at, i.timeline_at, i.date_precision, i.source_type, s.name AS source_name,
        t.item_id AS text_id, t.abstract_raw, t.abstract_zh, t.journal, t.authors_short, t.open_access, t.enrichment->>'oa_pdf_url' AS oa_pdf_url
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE i.public_id = $1 AND i.state = 'published' AND s.enabled`, [publicId])).rows?.[0];
    if (!row) throw new HttpError(404, "frontier_item_not_found", "No such item.");
    return row;
  }

  /**
   * 「存入知识库」: the open-access PDF, or a Markdown record, into
   * `knowledge-base/frontier/` of the reader's project.
   * @param {{ id: string }} user @param {string} publicId @param {{ projectId?: unknown }} body
   * @returns {Promise<{ saved: { kind: "pdf" | "md", path: string, note: string | null } }>}
   */
  async saveToLibrary(user, publicId, { projectId }) {
    if (!this.library) throw new HttpError(404, "not_found", "Frontier route not found.");
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
      throw new HttpError(400, "frontier_library_project_invalid", "Name the project to save into.");
    }
    // The platform's own background projects are nobody's library.
    if (isInternalProject(projectId)) throw new HttpError(404, "project_not_found", "Project not found.");
    const item = await this.#item(publicId);
    const project = await this.library.project(user, projectId);
    const published = item.published_at && item.date_precision !== "inferred" ? item.published_at : item.timeline_at;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: String(this.config.frontierTimeZone || "Asia/Shanghai"), year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(published));
    const slug = frontierLibrarySlug({ publicId: item.public_id, title: item.title_raw, day });
    /** @type {string | null} */
    let note = null;
    const pdfUrl = typeof item.oa_pdf_url === "string" && /^https?:\/\//i.test(item.oa_pdf_url) ? item.oa_pdf_url : null;
    if (pdfUrl) {
      /** @type {Buffer | null} */
      let bytes = null;
      try {
        const maxBytes = Math.min(PDF_MAX_BYTES, Math.max(1024, Number(this.config.maxFileBytes) || PDF_MAX_BYTES));
        bytes = (await fetchOpenAccessPdf({ url: pdfUrl, transport: this.pdfTransport, userAgent: this.userAgent, maxBytes })).bytes;
      } catch (error) {
        // The file could not be had; the record is still worth saving, and the
        // answer says the full text was not.
        this.counters.pdfFailures += 1;
        this.lastError = codeOf(error);
        note = "开放获取全文暂时下载不了，先存了题录和链接。";
      }
      if (bytes) {
        // A refusal of the write itself (the project is full) is the reader's
        // to see, not a download problem to paper over with a record.
        const rel = `${FRONTIER_LIBRARY_FOLDER}/${slug}.pdf`;
        await this.library.save({ user, project, rel, buffer: bytes });
        this.counters.savedPdf += 1;
        return { saved: { kind: "pdf", path: rel, note: null } };
      }
    }
    const rel = `${FRONTIER_LIBRARY_FOLDER}/${slug}.md`;
    const record = frontierLibraryRecord({ item, savedAt: this.now(), day, reason: note ? "开放获取全文这次没有下载成功。" : null });
    await this.library.save({ user, project, rel, buffer: Buffer.from(record, "utf8") });
    this.counters.savedRecord += 1;
    return { saved: { kind: "md", path: rel, note } };
  }

  /**
   * 「中文摘要」: the shared Chinese abstract, written now if nobody has asked
   * for it yet; the original with a sentence when it cannot be.
   * @param {{ id: string }} user @param {string} publicId
   * @returns {Promise<{ abstractZh: string | null, abstract: string | null, note: string | null }>}
   */
  async abstractZh(user, publicId) {
    const item = await this.#item(publicId);
    const abstract = typeof item.abstract_raw === "string" && item.abstract_raw.trim() ? item.abstract_raw.trim() : null;
    if (item.abstract_zh) {
      this.counters.abstractsCached += 1;
      return { abstractZh: item.abstract_zh, abstract, note: null };
    }
    if (!abstract) return { abstractZh: null, abstract: null, note: FRONTIER_ABSTRACT_NOTES.none };
    // A Chinese source's abstract is already the Chinese abstract.
    if (isChineseProse(abstract)) return { abstractZh: abstract, abstract, note: null };
    if (!this.editor?.available || !item.text_id) {
      this.counters.abstractsRefused += 1;
      return { abstractZh: null, abstract, note: FRONTIER_ABSTRACT_NOTES.unavailable };
    }
    if (this.budgetReader) {
      let state = "exhausted";
      try { state = (await this.budgetReader()).state; } catch { state = "exhausted"; }
      if (state === "exhausted") {
        this.counters.abstractsRefused += 1;
        return { abstractZh: null, abstract, note: FRONTIER_ABSTRACT_NOTES.exhausted };
      }
    }
    // One call per item however many readers open it at once.
    const pending = this.inflight.get(item.public_id);
    if (pending) return pending;
    if (!this.#admitReader(String(user?.id ?? ""))) {
      this.counters.abstractsLimited += 1;
      return { abstractZh: null, abstract, note: FRONTIER_ABSTRACT_NOTES.limited };
    }
    const work = this.#writeAbstract(item, abstract).finally(() => this.inflight.delete(item.public_id));
    this.inflight.set(item.public_id, work);
    return work;
  }

  /** Whether this reader may cause one more new abstract this hour; counts it when so. @param {string} userId */
  #admitReader(userId) {
    const now = this.now().getTime();
    const recent = (this.readerCalls.get(userId) ?? []).filter((at) => now - at < 3_600_000);
    if (recent.length >= FRONTIER_ABSTRACT_READER_HOURLY) {
      this.readerCalls.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.readerCalls.set(userId, recent);
    if (this.readerCalls.size > 10_000) this.readerCalls.clear();
    return true;
  }

  /** @param {any} item @param {string} abstract */
  async #writeAbstract(item, abstract) {
    const glossary = await this.glossaryStore.current();
    const result = await this.editor.writeAbstractZh({ titleRaw: item.title_raw, abstract, glossary: glossary.match(`${item.title_raw}\n${abstract}`) });
    if (!["passed", "repaired"].includes(result.verification) || !result.abstractZh) {
      this.counters.abstractsDropped += 1;
      this.lastError = result.error ?? "frontier_abstract_dropped";
      const note = result.verification === "dropped" ? FRONTIER_ABSTRACT_NOTES.dropped
        : result.error === "usage_budget_exceeded" ? FRONTIER_ABSTRACT_NOTES.exhausted : FRONTIER_ABSTRACT_NOTES.failed;
      return { abstractZh: null, abstract, note };
    }
    const stored = await this.database.transaction(async (/** @type {any} */ client) => {
      const updated = await client.query(`UPDATE evimed_frontier.item_texts SET abstract_zh = $2, abstract_zh_at = $3
        WHERE item_id = $1 AND abstract_zh IS NULL RETURNING abstract_zh`, [item.id, result.abstractZh, this.now()]);
      // The item's own answer carries it, under the content version's tag.
      if (updated.rowCount) await bumpFrontierVersion(client, FRONTIER_META_KEYS.contentVersion);
      return updated.rows?.[0]?.abstract_zh
        ?? (await client.query("SELECT abstract_zh FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id])).rows?.[0]?.abstract_zh
        ?? result.abstractZh;
    });
    this.counters.abstractsWritten += 1;
    return { abstractZh: stored, abstract, note: null };
  }

  status() {
    return { capabilities: this.capabilities(), lastError: this.lastError, counters: { ...this.counters } };
  }
}
