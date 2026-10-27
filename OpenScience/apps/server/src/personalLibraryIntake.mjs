import path from "node:path";
import { createHash } from "node:crypto";
import { LIBRARY_PROJECT_ID, assertClientProject, ensureLibraryProject, isInternalProject } from "./internalProjects.mjs";
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
      if (share) await service.addCurrent(request.user.id, registered.source.id, { personal: true });
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

/** Account intake and explicit independent project snapshots. @param {any} dependencies */
export function createPersonalLibraryRoutes({ store, sources, knowledge, write, readFile, maxJsonBytes, maxFileBytes, internalProject = (_user, id) => isInternalProject(id) }) {
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
      if (typeof input.projectId !== "string" || internalProject(user, input.projectId)) throw new HttpError(400, "library_payload_invalid", "Choose an ordinary project.");
      assertClientProject(input.projectId);
      const project = await store.requireProject(user, input.projectId);
      const source = await sources.get(user.id, copy[1]);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== source.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before copying.");
      if (source.payload.publication?.current === false || internalProject(user, source.projectId) && source.projectId !== LIBRARY_PROJECT_ID) {
        throw new HttpError(409, "library_source_invalid", "The source is not a current document.");
      }
      const originProject = await store.requireProject(user, source.projectId);
      const original = source.payload.paths?.[0];
      if (typeof original !== "string" || !original.startsWith("knowledge-base/") || /^knowledge-base\/(wiki|kg)\//.test(original)) {
        throw new HttpError(409, "library_source_invalid", "The source has no eligible immutable original.");
      }
      const bytes = await readFile(originProject, original);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== source.payload.fingerprint?.sha256) throw new HttpError(409, "library_source_invalid", "The preserved source changed.");
      const rel = `knowledge-base/imports/${source.id}/${source.revision}-${sha256}/${path.posix.basename(source.payload.logicalPath ?? original)}`;
      registered = await sources.withRegistrationLocks([`library-copy-owner:${user.id}`, `source:${user.id}:${source.id}`, `library-copy:${user.id}:${project.id}:${source.id}:${source.revision}:${sha256}`], async () => {
        await sources.lockSourceMutation(user.id, source.id);
        const current = await sources.get(user.id, source.id);
        if (current.revision !== source.revision || current.payload.publication?.current === false) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before copying.");
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
