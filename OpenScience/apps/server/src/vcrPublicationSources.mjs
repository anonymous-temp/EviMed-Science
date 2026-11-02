/**
 * What the platform itself read of a publication: the text a literature tool preserved in the project's workspace.
 *
 * A number a paper reports can be bound to the paper by its PMID or DOI, not only to a trial registry's record. The quotation that
 * carries the number is checked against the paper's text as `literature_search` / `open_access_fulltext` preserved it
 * (`.evimed-sources/pubmed/PMID<id>/<version>/abstract.md`, `.evimed-sources/PMC<id>/<version>/fulltext.md`, `.evimed-sources/<doi
 * slug>/<version>/fulltext.md`) — a content-addressed capture the control plane verifies against its manifest before it reads a byte
 * (`sourceCapture`), so a text edited after preservation is not a source. The run names the paper; it never hands over text to be
 * checked against.
 *
 * Hidden knowledge:
 *
 * - **No text read is an answer, not an error.** A paper the run never fetched has no preserved text; the reader says so
 *   (`{ found: false }`) and the evidence item is stored as reported and unchecked (`reported_unverified`), never refused and never
 *   called verified.
 * - **The abstract is not the paper.** A capture says what it is (`contentLevel`), and a quotation that lives in the full text is not
 *   found in an abstract: that is `quote_not_found` for what was read, with the level named, not a claim about the paper.
 * - **A capture is only as trustworthy as the workspace it sits in (a known limit, 2026-11-02).** `sourceCapture` makes the manifest agree
 *   with the bytes, not with the tool that wrote them: a run that can write files can write an `abstract.md` and a `capture.json` that agree
 *   with each other, and a quotation from it reads as `verified`. The one record the run cannot write is the preserving tool's own result in
 *   the kernel transcript (`data.artifactSha256s`, read at the end of a run by `successfulEvidenceSourceArtifacts` for the clinical gate); it
 *   does not exist while the run is still calling this gateway, and a live copy of it would be a store of its own, which this module does not
 *   build. What a forged capture can reach is bounded by what already passes over a `publication_text` item: it is never pooled (it names no
 *   trial), never a baseline (`baseline_source_unit_unverified`), and no tenant boundary is crossed: the only text it can claim to be is a
 *   paper the run itself names, in the run's own project. It can become a single-study card, with the paper's identifier on it.
 * - **A DOI is found by the slug the full-text tool names its directory with, or by the DOI line of a preserved abstract.** Nothing is
 *   fetched here and nothing is searched outside the one project's workspace.
 * - **The full text a PMCID names is the same paper.** `open_access_fulltext` keeps an article under `.evimed-sources/PMC<id>/`, and says
 *   in the capture itself which article it is: the DOI on the markdown's header line, the PMID and the DOI in the XML's `article-id`
 *   elements. A PMID or a DOI is matched to those (the newest 300 such directories, the front matter of one version each, never the
 *   whole file) and the text is then read like every other capture, through its manifest. The full text is what is read first, the
 *   abstract beside it: a sentence is held against the one that holds it.
 *
 * @module vcrPublicationSources
 */

import fs from "node:fs/promises";
import { sourceCapture } from "./resultDeliveryCapture.mjs";
import { openScopedDirectoryNoFollow, openScopedFileNoFollow, resolveScopedPath } from "./security.mjs";

/** A PubMed id, optionally written `PMID: 123`. */
const PMID = /^(?:PMID\s*:?\s*)?(\d{1,9})$/i;
/** A DOI, optionally as `doi:` or as an address. */
const DOI = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s]{1,200})$/i;
/** The versions of one capture directory are 64-hex digests. */
const VERSION = /^[a-f0-9]{64}$/;
const READ_LIMIT = 4 * 1024 * 1024;
/** Version directories tried per paper, newest first. */
const VERSIONS_TRIED = 4;
/** Preserved abstracts looked through for a DOI line. */
const ABSTRACTS_SCANNED = 300;
/** Preserved full texts (`.evimed-sources/PMC<id>`) looked through for a PMID or a DOI, newest first. */
const FULLTEXTS_SCANNED = 300;
/** How much of a capture's own front matter is read to learn which article it is: the header lines of the markdown, the ids of the XML. */
const MARKDOWN_HEAD_BYTES = 2 * 1024;
const XML_HEAD_BYTES = 32 * 1024;

/** @typedef {{ text: string, sha256: string, path: string, contentLevel: "abstract" | "full_text", sourceRef: string }} Capture */

/**
 * A publication as the run names it, in the one form the platform keeps: `{ kind: "pmid" | "doi", id }`, or null.
 * @param {unknown} value a string (`PMID:123`, `10.1056/…`) or `{ pmid }` / `{ doi }`
 * @returns {{ kind: "pmid" | "doi", id: string } | null}
 */
export function vcrPublicationId(value) {
  const text = typeof value === "string" ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (/** @type {any} */ (value).pmid != null ? `PMID:${/** @type {any} */ (value).pmid}` : /** @type {any} */ (value).doi != null ? String(/** @type {any} */ (value).doi) : "")
      : "";
  const trimmed = text.trim();
  const pmid = PMID.exec(trimmed);
  if (pmid) return { kind: "pmid", id: pmid[1].replace(/^0+(?=\d)/, "") };
  const doi = DOI.exec(trimmed);
  return doi ? { kind: "doi", id: doi[1].replace(/[).,;]+$/, "").toLowerCase() } : null;
}

/**
 * The address a reader can open for a paper: its PubMed page or its DOI. The evidence item's `sourceRef` is this, so the place a number
 * was read is one click from the number; the capture that was held against (its digest) is on the item's locator.
 * @param {{ kind: "pmid" | "doi", id: string }} publication
 */
export function paperAddress(publication) {
  return publication.kind === "pmid" ? `https://pubmed.ncbi.nlm.nih.gov/${publication.id}/` : `https://doi.org/${publication.id}`;
}

/** The directory name the full-text tool gives a DOI (`_doi_slug` in open_access_fulltext.py). @param {string} doi */
export function doiSlug(doi) {
  const slug = doi.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 96);
  return slug || "open-access-article";
}

/**
 * @param {{ resolveProject: (userId: string, projectId: string) => Promise<any> }} dependencies
 */
export function createVcrPublicationSources({ resolveProject }) {
  /** The version directories of a capture root, newest first; none when the root is not there. @param {any} project @param {string} root */
  async function versions(project, root) {
    let opened;
    try { opened = await openScopedDirectoryNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, root)); }
    catch { return []; }
    try {
      const entries = (await fs.readdir(opened.path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && VERSION.test(entry.name));
      const dated = await Promise.all(entries.map(async (entry) => ({ name: entry.name, at: (await fs.stat(`${opened.path}/${entry.name}`).catch(() => null))?.mtimeMs ?? 0 })));
      return dated.sort((a, b) => b.at - a.at).map((entry) => entry.name);
    } finally { await opened.handle.close().catch(() => {}); }
  }

  /** The first verified capture among a root's versions: its text, digest and place. @param {any} project @param {string} root @param {string[]} names */
  async function readFirst(project, root, names) {
    for (const version of (await versions(project, root)).slice(0, VERSIONS_TRIED)) {
      for (const name of names) {
        try {
          const captured = await sourceCapture(project, `${root}/${version}/${name}`, READ_LIMIT);
          return { text: new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes), sha256: captured.expectedDigest, path: `${root}/${version}/${name}`, name };
        } catch { /* a capture that does not verify is not a source; try the next */ }
      }
    }
    return null;
  }

  /** The front matter of one capture file, as text: its first bytes, never the whole file. @param {any} project @param {string} relativePath @param {number} bytes */
  async function head(project, relativePath, bytes) {
    let opened;
    try {
      opened = await openScopedFileNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, relativePath));
      const buffer = Buffer.alloc(Math.min(bytes, opened.stat.size));
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch { return ""; } finally { await opened?.handle.close().catch(() => {}); }
  }

  /**
   * The full text of a paper, found by the identifiers its capture carries: the DOI on the markdown's header line (as printed, so compared
   * without case) and the PMID and DOI of the XML's `article-id` elements. The directories are `.evimed-sources/PMC<id>`, newest first,
   * and a match is read through its manifest like any capture.
   * @param {any} project @param {{ pmid: string | null, doi: string | null }} wanted
   */
  async function fullTextOf(project, wanted) {
    if (!wanted.pmid && !wanted.doi) return null;
    const slugged = wanted.doi ? await readFirst(project, `.evimed-sources/${doiSlug(wanted.doi)}`, ["fulltext.md"]) : null;
    if (slugged) return slugged;
    let opened;
    try { opened = await openScopedDirectoryNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, ".evimed-sources")); }
    catch { return null; }
    let directories = [];
    try {
      const entries = (await fs.readdir(opened.path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^PMC\d{1,12}$/.test(entry.name));
      const dated = await Promise.all(entries.map(async (entry) => ({ name: entry.name, at: (await fs.stat(`${opened.path}/${entry.name}`).catch(() => null))?.mtimeMs ?? 0 })));
      directories = dated.sort((a, b) => b.at - a.at).slice(0, FULLTEXTS_SCANNED);
    } finally { await opened.handle.close().catch(() => {}); }
    for (const directory of directories) {
      const root = `.evimed-sources/${directory.name}`;
      const [newest] = await versions(project, root);
      if (!newest) continue;
      const markdown = await head(project, `${root}/${newest}/fulltext.md`, MARKDOWN_HEAD_BYTES);
      let same = Boolean(wanted.doi) && (/^- DOI: (\S+)\s*$/im.exec(markdown)?.[1] ?? "").toLowerCase() === wanted.doi;
      if (!same) {
        const xml = await head(project, `${root}/${newest}/fulltext.xml`, XML_HEAD_BYTES);
        const ids = new Map([...xml.matchAll(/<article-id[^>]*\bpub-id-type="(pmid|doi)"[^>]*>\s*([^<\s]+)\s*</gi)].map((match) => [match[1].toLowerCase(), match[2].toLowerCase()]));
        same = (Boolean(wanted.pmid) && ids.get("pmid") === wanted.pmid) || (Boolean(wanted.doi) && ids.get("doi") === wanted.doi);
      }
      if (same) {
        const found = await readFirst(project, root, ["fulltext.md"]);
        if (found) return found;
      }
    }
    return null;
  }

  return {
    /**
     * The captures of the paper the platform has read, the whole article before the abstract. The first is the answer; the others are
     * what else was read of the same paper, for a caller that holds a sentence against the one that has it.
     * @param {{ userId: string, projectId: string, publication: { kind: "pmid" | "doi", id: string } }} input
     * @returns {Promise<{ found: false } | (Capture & { found: true, others?: Capture[] })>}
     */
    async read({ userId, projectId, publication }) {
      const project = await resolveProject(userId, projectId);
      if (!project?.workspaceDir) return { found: false };
      /** @type {Capture[]} */
      const captures = [];
      const sourceRef = paperAddress(publication);
      /** @param {{ text: string, sha256: string, path: string } | null} found @param {"abstract" | "full_text"} contentLevel */
      const keep = (found, contentLevel) => { if (found) captures.push({ text: found.text, sha256: found.sha256, path: found.path, contentLevel, sourceRef }); };
      if (publication.kind === "pmid") {
        const abstract = await readFirst(project, `.evimed-sources/pubmed/PMID${publication.id}`, ["abstract.md"]);
        const doi = abstract ? /^- DOI: (\S+)\s*$/im.exec(abstract.text)?.[1]?.toLowerCase() ?? null : null;
        keep(await fullTextOf(project, { pmid: publication.id, doi }), "full_text");
        keep(abstract, "abstract");
      } else {
        keep(await fullTextOf(project, { pmid: null, doi: publication.id }), "full_text");
        // An abstract that carries the DOI on its header line.
        let opened = null;
        try { opened = await openScopedDirectoryNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, ".evimed-sources/pubmed")); }
        catch { /* no abstract was ever preserved here */ }
        let directories = [];
        if (opened) {
          try { directories = (await fs.readdir(opened.path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^PMID\d{1,9}$/.test(entry.name)).slice(0, ABSTRACTS_SCANNED); }
          finally { await opened.handle.close().catch(() => {}); }
        }
        const doiLine = new RegExp(`^- DOI: ${publication.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
        for (const directory of directories) {
          const abstract = await readFirst(project, `.evimed-sources/pubmed/${directory.name}`, ["abstract.md"]);
          if (abstract && doiLine.test(abstract.text)) { keep(abstract, "abstract"); break; }
        }
      }
      const [first, ...others] = captures;
      return first ? { found: true, ...first, ...(others.length ? { others } : {}) } : { found: false };
    },
  };
}
