import path from "node:path";
import { sourceDocTypeLabel, sourceDocTypeShort, sourceFileFormat, sourceKindOf, sourceOriginOf } from "@evimed/domain";

/** How much of a summary's first sentence a row keeps. */
const GIST_MAX_CHARS = 90;

/**
 * 「讲了什么」: the first sentence of the understanding's summary, for a row.
 *
 * A display excerpt, not a reading of the document: the summary is what the
 * understanding wrote for the researcher, and a row shows where it first stops.
 * A sentence is cut at the first Chinese or English terminator (or the first
 * line break), and one longer than a line is cut with an ellipsis.
 * @param {unknown} summary @returns {string | null}
 */
export function sourceGist(summary) {
  const lines = String(summary ?? "").trim().split(/\n+/);
  const text = (lines[0] ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const end = text.search(/[。！？!?]|\.(?:\s|$)/);
  const sentence = end === -1 ? text : text.slice(0, end + 1);
  return sentence.length > GIST_MAX_CHARS ? `${sentence.slice(0, GIST_MAX_CHARS - 1)}…` : sentence;
}

/**
 * What a source row says about its document, computed once on the server so the
 * page shows it and computes nothing: the title (what the document is called —
 * a note's or page's own title, else the title the parser read, else the file's
 * name), one line of what it says, its type and the chip it is counted under,
 * where it came from, and the facts a meta line carries (pages, size, the site
 * of a link).
 *
 * The one line is the understanding's, and only once it exists: until then the
 * parser's opening lines are the document's own text, not a summary of it.
 * @param {{ id: string, payload: any }} source
 * @param {{ shared?: boolean | null }} [options] whether the document is in the account library, when the caller knows
 */
export function sourceDisplayOf(source, { shared = null } = {}) {
  const payload = source.payload ?? {};
  const file = String(payload.paths?.[0] ?? source.id);
  const name = path.posix.basename(file);
  const metadataTitle = typeof payload.metadata?.title === "string" ? payload.metadata.title.trim() : "";
  const ownTitle = typeof payload.title === "string" ? payload.title.trim() : "";
  const docType = typeof payload.docType === "string" ? payload.docType : "other";
  const origin = sourceOriginOf({ connectorType: payload.connector?.type, path: file });
  const understood = payload.currentUnderstandingId ? payload.outputs?.summary : null;
  const pages = payload.analysis?.pageCount;
  const size = payload.fingerprint?.size;
  return {
    title: ownTitle || metadataTitle || name,
    gist: sourceGist(understood),
    docType,
    typeLabel: sourceDocTypeLabel(docType),
    typeShort: sourceDocTypeShort(docType),
    kind: sourceKindOf(docType),
    origin,
    format: sourceFileFormat(name) || null,
    pages: Number.isSafeInteger(pages) && pages > 0 ? pages : null,
    size: Number.isSafeInteger(size) && size >= 0 ? size : null,
    site: typeof payload.link?.site === "string" ? payload.link.site : null,
    url: typeof payload.link?.url === "string" ? payload.link.url : null,
    shared: shared === null ? null : Boolean(shared),
  };
}
