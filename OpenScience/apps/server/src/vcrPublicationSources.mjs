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
 * - **A DOI is found by the slug the full-text tool names its directory with, or by the DOI line of a preserved abstract.** Nothing is
 *   fetched here and nothing is searched outside the one project's workspace.
 *
 * @module vcrPublicationSources
 */

import fs from "node:fs/promises";
import { sourceCapture } from "./resultDeliveryCapture.mjs";
import { openScopedDirectoryNoFollow, resolveScopedPath } from "./security.mjs";

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

  return {
    /**
     * @param {{ userId: string, projectId: string, publication: { kind: "pmid" | "doi", id: string } }} input
     * @returns {Promise<{ found: false } | { found: true, text: string, sourceRef: string, sha256: string, path: string, contentLevel: "abstract" | "full_text" }>}
     */
    async read({ userId, projectId, publication }) {
      const project = await resolveProject(userId, projectId);
      if (!project?.workspaceDir) return { found: false };
      if (publication.kind === "pmid") {
        const root = `.evimed-sources/pubmed/PMID${publication.id}`;
        const abstract = await readFirst(project, root, ["abstract.md"]);
        return abstract ? { found: true, text: abstract.text, sha256: abstract.sha256, path: abstract.path, contentLevel: "abstract",
          sourceRef: paperAddress(publication) } : { found: false };
      }
      const full = await readFirst(project, `.evimed-sources/${doiSlug(publication.id)}`, ["fulltext.md"]);
      if (full) return { found: true, text: full.text, sha256: full.sha256, path: full.path, contentLevel: "full_text", sourceRef: paperAddress(publication) };
      // An abstract that carries the DOI on its header line.
      let opened;
      try { opened = await openScopedDirectoryNoFollow(project.workspaceDir, resolveScopedPath(project.workspaceDir, ".evimed-sources/pubmed")); }
      catch { return { found: false }; }
      let directories = [];
      try { directories = (await fs.readdir(opened.path, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^PMID\d{1,9}$/.test(entry.name)).slice(0, ABSTRACTS_SCANNED); }
      finally { await opened.handle.close().catch(() => {}); }
      for (const directory of directories) {
        const abstract = await readFirst(project, `.evimed-sources/pubmed/${directory.name}`, ["abstract.md"]);
        if (abstract && new RegExp(`^- DOI: ${publication.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(abstract.text)) {
          return { found: true, text: abstract.text, sha256: abstract.sha256, path: abstract.path, contentLevel: "abstract",
            sourceRef: paperAddress(publication) };
        }
      }
      return { found: false };
    },
  };
}
