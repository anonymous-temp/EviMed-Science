import path from "node:path";
import { createHash } from "node:crypto";
import { LIBRARY_PROJECT_ID, ensureLibraryProject, isInternalProject } from "./internalProjects.mjs";
import { assertOrdinaryProject, libraryRecordProjects } from "./libraryScope.mjs";
import { projectSourceManifestRecord } from "./sourceService.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";

/** Personal intake uses the same immutable writer and its transaction as project intake.
 * @param {{sources:any,library:()=>any,write:(request:any)=>Promise<any>}} dependencies */
export function createPersonalLibraryWriter({ sources, library, write }) {
  return async (request) => {
    if (request.project.id !== LIBRARY_PROJECT_ID || request.register === false) return write(request);
    const service = library();
    if (!service) throw new HttpError(503, "library_unavailable", "The personal library is unavailable.");
    return sources.withRegistrationLocks([`library:${request.user.id}`], async () => {
      const logicalPath = request.meta?.logicalPath ?? request.rel;
      let previous = null;
      let cursor = null;
      // Inherit the current binding's latest intent. A historical tombstone must neither
      // resurrect an unshared document nor overrule a later explicit share.
      do {
        const page = await sources.documents.list(request.user.id, "source", { projectId: LIBRARY_PROJECT_ID, limit: 100, cursor });
        previous = page.items.find(source => {
          const bindings = Object.values(source.payload.publication?.bindings ?? {});
          return bindings.length ? bindings.some(binding => binding.current && binding.logicalPath === logicalPath)
            : source.payload.publication?.current !== false && source.payload.logicalPath === logicalPath;
        }) ?? null;
        cursor = page.nextCursor;
      } while (!previous && cursor);
      const membership = previous ? await sources.documents.get(request.user.id, "preferences", `library:${previous.payload.fingerprint?.sha256}`) : null;
      const share = !previous || Boolean(membership && !membership.deletedAt);
      const registered = await write(request);
      if (!registered?.source) throw new HttpError(503, "source_state_unavailable", "Source intake is unavailable.");
      if (previous && previous.id !== registered.source.id) {
        const replaced = await sources.get(request.user.id, previous.id);
        // A content-addressed source may still serve another current personal filename.
        if (replaced.payload.publication?.current === false) {
          try { await service.removeCurrent(request.user.id, previous.id, { personal: true }); }
          catch (error) { if (error?.code !== "library_item_not_found") throw error; }
        }
      }
      if (share) {
        // A new version applies where the one it replaces did (2026-10-28) — unless the new bytes already have an entry of their
        // own, whose scope is left as someone set it.
        const had = membership && !membership.deletedAt ? libraryRecordProjects(membership.payload) : null;
        const entry = had !== null && registered.source.payload.fingerprint?.sha256
          ? await sources.documents.get(request.user.id, "preferences", `library:${registered.source.payload.fingerprint.sha256}`) : null;
        await service.addCurrent(request.user.id, registered.source.id, { personal: true, ...(had !== null && !entry ? { projects: had } : {}) });
      }
      return registered;
    });
  };
}

/** @param {any} req @param {number} max @param {string[]} fields */
async function inputBody(req, max, fields) {
  const body = await readJson(req, max);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) {
    throw new HttpError(400, "library_payload_invalid", "The library request has unsupported fields.");
  }
  return body;
}

/**
 * Whether two records of one source hold the same chosen version: the same bytes, the same publication version, and a document
 * that is still the current one. The record's `revision` is not that identity: reading a document (parsing, then its
 * understanding) moves the revision for a while after it arrives, while the content is exactly what it was. A replacement and an
 * A-B-A reactivation do change the publication version, which is what a stale selection is refused for.
 * @param {any} left @param {any} right
 */
function sameVersion(left, right) {
  return left.payload.fingerprint?.sha256 === right.payload.fingerprint?.sha256
    && (left.payload.version ?? 1) === (right.payload.version ?? 1)
    && left.payload.publication?.current !== false && right.payload.publication?.current !== false;
}

/**
 * Whether the revision a person chose from still names what the source holds now: it is the current revision, or an earlier one
 * of the same version (only the platform's own reading moved it since).
 * @param {any} sources @param {string} userId @param {any} current the source as it is now @param {unknown} chosen the revision chosen
 */
async function chosenVersionIsCurrent(sources, userId, current, chosen) {
  if (!Number.isSafeInteger(chosen) || /** @type {number} */ (chosen) < 1 || /** @type {number} */ (chosen) > current.revision) return false;
  if (chosen === current.revision) return true;
  const [earlier] = await sources.documents.history(userId, "source", current.id,
    { beforeRevision: /** @type {number} */ (chosen) + 1, limit: 1, fields: { fingerprint: true, version: true, publication: true } });
  return earlier?.revision === chosen && sameVersion(earlier, current);
}

/**
 * Account intake and explicit independent project snapshots.
 * `moduleProject(user, projectId)` says whether an owned project is a 循证 GEO or 虚拟临床研究 project: those are not file
 * destinations, and a copy goes only to an ordinary project (`assertOrdinaryProject`).
 * @param {any} dependencies
 */
export function createPersonalLibraryRoutes({ store, sources, knowledge, write, readFile, maxJsonBytes, maxFileBytes, internalProject = (_user, id) => isInternalProject(id), moduleProject = async () => false }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const intake = /^\/api\/library\/(uploads|links|notes)$/.exec(url.pathname);
    const copy = /^\/api\/library\/(src_[a-f0-9]{32})\/projects$/.exec(url.pathname);
    if (req.method !== "POST" || (!intake && !copy)) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!sources || !knowledge) throw new HttpError(503, "library_unavailable", "Source intake is unavailable.");
    let registered;
    if (copy) {
      const input = await inputBody(req, maxJsonBytes, ["projectId", "expectedRevision"]);
      // The one rule for where a document may be sent (`assertOrdinaryProject`), shared with the list of projects a document applies to.
      // An archived project is still a place to copy to, as it was before the rule was shared; its refusal keeps this route's own code.
      const project = await assertOrdinaryProject({ store, internalProject, moduleProject }, user, input.projectId,
        { code: "library_payload_invalid", allowArchived: true });
      const source = await sources.get(user.id, copy[1]);
      if (!await chosenVersionIsCurrent(sources, user.id, source, input.expectedRevision)) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before copying.");
      if (source.payload.publication?.current === false || internalProject(user, source.projectId) && source.projectId !== LIBRARY_PROJECT_ID) {
        throw new HttpError(409, "library_source_invalid", "The source is not a current document.");
      }
      const originProject = await store.requireProject(user, source.projectId);
      const original = source.payload.paths?.[0];
      if (typeof original !== "string" || !original.startsWith("knowledge-base/") || /^knowledge-base\/(wiki|kg)\//.test(original)) {
        throw new HttpError(409, "library_source_invalid", "The source has no eligible immutable original.");
      }
      /** @type {Buffer} */
      let bytes;
      try { bytes = await readFile(originProject, original); }
      catch (error) {
        // The original was removed from the project's folder after it was registered: a named refusal, not a server error.
        if (["ENOENT", "ENOTDIR"].includes(/** @type {any} */ (error)?.code)) throw new HttpError(404, "library_original_missing", "The preserved original is missing.");
        throw error;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== source.payload.fingerprint?.sha256) throw new HttpError(409, "library_source_invalid", "The preserved source changed.");
      // A snapshot is named by the version it froze, so copying the same version twice finds the first copy.
      const version = source.payload.version ?? 1;
      const rel = `knowledge-base/imports/${source.id}/v${version}-${sha256}/${path.posix.basename(source.payload.logicalPath ?? original)}`;
      registered = await sources.withRegistrationLocks([`library-copy-owner:${user.id}`, `source:${user.id}:${source.id}`, `library-copy:${user.id}:${project.id}:${source.id}:v${version}:${sha256}`], async () => {
        await sources.lockSourceMutation(user.id, source.id);
        const current = await sources.get(user.id, source.id);
        if (!sameVersion(current, source)) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before copying.");
        // The document already belongs to this project; no second publication is needed.
        if (project.id === source.projectId) return { source: current, duplicate: true };
        const result = await write({ user, project, rel, buffer: bytes, meta: { title: source.payload.title, logicalPath: rel } });
        const provenance = { sourceId: source.id, projectId: source.projectId, revision: source.revision,
          version: source.payload.version ?? 1, generation: source.payload.generation ?? 1, sha256, path: original };
        if (!result.source.payload.copiedFrom) result.source = await sources.documents.put(user.id, "source", result.source.id,
          { ...result.source.payload, copiedFrom: provenance }, { projectId: project.id, expectedRevision: result.source.revision });
        return result;
      });
    } else {
      const kind = intake[1];
      const input = await inputBody(req, kind === "uploads" ? Math.max(maxJsonBytes, Math.ceil(maxFileBytes * 1.4) + 4096) : maxJsonBytes,
        kind === "uploads" ? ["filename", "data", "encoding"] : kind === "links" ? ["url"] : ["title", "body"]);
      const project = await ensureLibraryProject(store, user);
      if (kind === "links") registered = await knowledge.addLink({ user, project, url: input.url });
      else if (kind === "notes") registered = await knowledge.addNote({ user, project, title: input.title, body: input.body });
      else {
        if (typeof input.filename !== "string" || !input.filename || input.filename.length > 240 || (/[\\/]/.test(input.filename) || [...input.filename].some(char => char.charCodeAt(0) < 32))
          || input.filename === "." || input.filename === ".." || typeof input.data !== "string" || ![undefined, "utf8", "base64"].includes(input.encoding)) {
          throw new HttpError(400, "library_payload_invalid", "Provide a filename and file data.");
        }
        if (input.encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new HttpError(400, "library_payload_invalid", "Invalid file encoding.");
        const buffer = Buffer.from(input.data, input.encoding === "base64" ? "base64" : "utf8");
        if (buffer.length > maxFileBytes) throw new HttpError(413, "file_too_large", "File is too large.");
        registered = await write({ user, project, rel: `knowledge-base/uploads/${input.filename}`, buffer });
      }
    }
    const { job: _job, ...reply } = registered;
    sendJson(res, 201, { data: { ...reply, source: projectSourceManifestRecord(reply.source) } });
    return true;
  };
}
