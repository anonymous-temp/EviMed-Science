/**
 * What rests on one knowledge-base document, for the page that shows it (2026-10-12, knowledge base P0: 「相关记忆与做法」):
 * the memories that name it, the learned methods linked to the results that rest on it, and those results.
 *
 * Hidden knowledge:
 *
 * - **Read, never labelled.** The labelling of what rests on a source is `knowledgeChange.mjs`'s, done when the source
 *   changes; this only reads the same links (`KnowledgeChangeService.dependents`) when a researcher opens the document.
 * - **Recorded links only.** A memory is found by its `record_sources` row, a result by the identities its inputs record
 *   (the document's id, or the digest of its exact bytes — how a result that read the file names it), a method by the
 *   result it was linked to. Never by what any of them says.
 * - **The account's own, in this project.** Everything is read under the document's owner and the document's project:
 *   a memory of the account is listed when it is the account's own or scoped to this project, a result only when it is in
 *   this project's ledger. A sensitive memory is never listed (as it is never recalled), and a result whose run the
 *   researcher deleted, or that no run produced, is left out: there is nothing to open.
 * - **A lookup that failed costs its class and nothing else** (principle 19): the others are listed, and the failure is
 *   reported by code, never put on the page.
 *
 * Absent (no database), the answer is empty lists, which the page does not draw.
 *
 * @module sourceDependents
 */

/** The results listed, newest first; one per run and file. */
export const DEPENDENT_RESULTS = 20;
/** The memories listed. */
export const DEPENDENT_MEMORIES = 30;
/** How many citing pages one read lists. */
export const DEPENDENT_PAGES = 50;
/** How many result versions a lookup reads per identity: the store's own page ceiling. */
const SCAN = 100;
const MEMORY_TEXT_CHARS = 120;
const DIGEST = /^[a-f0-9]{64}$/;

/** @param {unknown} value @param {number} max */
function excerpt(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** @param {any} error @returns {string} */
const codeOf = (error) => (typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code) ? error.code : "source_dependents_failed");

/**
 * Whether a result version's recorded inputs name the document: by its id, or by the digest of its exact bytes.
 * @param {any} payload @param {string} sourceId @param {string | null} sha256
 */
function names(payload, sourceId, sha256) {
  return (payload?.inputs ?? []).some((/** @type {any} */ input) => (input?.kind === "source" || input?.kind === "data")
    && input.availability !== "restricted" && (input.id === sourceId || (sha256 !== null && input.digest === sha256)));
}

/**
 * @param {{
 *   knowledge: { dependents: (ownerId: string, projectId: string, ref: { id: string }, versionIds: readonly string[]) => Promise<any> } | null,
 *   documents?: { list: (userId: string, kind: string, options: any) => Promise<{ items: any[] }> } | null,
 *   memory?: { recordSummaries: (userId: string, ids: readonly string[]) => Promise<any[]> } | null,
 *   runs?: ((project: any, runIds: readonly string[]) => Promise<Map<string, { title: string | null, deleted: boolean }>>) | null,
 *   pages?: ((userId: string, projectId: string, sourceId: string) => Promise<any[]>) | null,
 *   report?: (code: string) => void,
 * }} dependencies `runs` says what each run is called in the project's ledger, and whether the researcher deleted it;
 *   `pages` lists the compiled pages and graph files that cite a document (`KnowledgePageService.pagesQuoting`).
 * @returns {(request: { user: { id: string }, project: { id: string }, source: { id: string, payload?: any } }) =>
 *   Promise<{ pages: { sourceId: string | null, tree: string, path: string, title: string }[],
 *     memories: { recordId: string, text: string, scope: string }[], methods: { id: string, title: string }[],
 *     results: { versionId: string, runId: string, path: string, title: string | null, at: string }[] }>}
 */
export function createSourceDependents({ knowledge, documents = null, memory = null, runs = null, pages = null, report = () => {} }) {
  /** @param {string} userId @param {string} projectId @param {string} sourceId @param {string | null} sha256 */
  async function resultsNaming(userId, projectId, sourceId, sha256) {
    if (!documents) return [];
    /** @type {Map<string, any>} */
    const found = new Map();
    for (const filter of [{ inputs: [{ id: sourceId }] }, ...(sha256 ? [{ inputs: [{ digest: sha256 }] }] : [])]) {
      let page;
      try { page = await documents.list(userId, "result-version", { projectId, limit: SCAN, filter: { recordType: "result-version", ...filter } }); }
      catch (error) { report(codeOf(error)); continue; }
      for (const row of page.items) {
        const payload = row.payload;
        if (typeof payload?.versionId === "string" && typeof payload?.path === "string" && typeof payload?.producer?.runId === "string"
          && names(payload, sourceId, sha256)) found.set(payload.versionId, payload);
      }
    }
    return [...found.values()].sort((left, right) => String(right.capturedAt ?? "").localeCompare(String(left.capturedAt ?? "")));
  }

  return async ({ user, project, source }) => {
    const sha256 = typeof source.payload?.fingerprint?.sha256 === "string" && DIGEST.test(source.payload.fingerprint.sha256) ? source.payload.fingerprint.sha256 : null;
    const versions = await resultsNaming(user.id, project.id, source.id, sha256);
    const read = knowledge
      ? await knowledge.dependents(user.id, project.id, { id: source.id }, versions.map((version) => version.versionId))
      : { memories: { unknown: "unavailable" }, methods: { unknown: "unavailable" } };

    // The results: one line per run and file, named by the conversation they came out of, without the ones nobody can open.
    const ledger = runs && versions.length > 0
      ? await runs(project, [...new Set(versions.map((version) => version.producer.runId))]).catch((error) => { report(codeOf(error)); return new Map(); })
      : new Map();
    const seen = new Set();
    /** @type {{ versionId: string, runId: string, path: string, title: string | null, at: string }[]} */
    const results = [];
    for (const version of versions) {
      const runId = version.producer.runId;
      const run = ledger.get(runId);
      const key = `${runId}\0${version.path}`;
      if (run?.deleted || seen.has(key)) continue;
      seen.add(key);
      results.push({ versionId: version.versionId, runId, path: version.path, title: run?.title ?? null, at: version.capturedAt });
      if (results.length >= DEPENDENT_RESULTS) break;
    }

    // The memories: what each says, newest first. The same records the memory page lists, so a row here opens its drawer there.
    /** @type {{ recordId: string, text: string, scope: string }[]} */
    let memories = [];
    const dependents = read.memories?.items ?? [];
    if (dependents.length > 0 && memory) {
      try {
        const scopes = new Map(dependents.map((/** @type {any} */ row) => [row.recordId, row.scope]));
        const records = await memory.recordSummaries(user.id, dependents.map((/** @type {any} */ row) => row.recordId));
        memories = records
          .filter((record) => record.sensitive !== true && scopes.has(record.id))
          .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
          .map((record) => ({ recordId: String(record.id), text: excerpt(record.summary || record.value, MEMORY_TEXT_CHARS), scope: String(scopes.get(record.id)) }))
          .filter((record) => record.text)
          .slice(0, DEPENDENT_MEMORIES);
      } catch (error) { report(codeOf(error)); }
    }

    // The compiled pages and graph files that cite it, by the document id the mirror recorded for each of their links.
    /** @type {{ sourceId: string | null, tree: string, path: string, title: string }[]} */
    let citing = [];
    if (pages) {
      try {
        citing = (await pages(user.id, project.id, source.id)).slice(0, DEPENDENT_PAGES)
          .map((/** @type {any} */ page) => ({ sourceId: page.sourceId ?? null, tree: String(page.tree), path: String(page.path), title: String(page.title ?? page.path) }));
      } catch (error) { report(codeOf(error)); }
    }

    return {
      pages: citing,
      memories,
      methods: (read.methods?.items ?? []).map((/** @type {any} */ method) => ({ id: String(method.id), title: String(method.title ?? "") })).filter((/** @type {any} */ method) => method.title),
      results,
    };
  };
}
