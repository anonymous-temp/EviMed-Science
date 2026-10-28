import { LIBRARY_PROJECT_ID, ensureLibraryProject } from "./internalProjects.mjs";
import { libraryRecordProjects } from "./libraryScope.mjs";
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
 * Account intake: an upload, a link or a note into the personal library. Which projects a document then applies to is the
 * document's own choice (`PUT /api/library/:sourceId`, `libraryService.setProjects`); there is no route that copies one into a project.
 * @param {any} dependencies
 */
export function createPersonalLibraryRoutes({ store, sources, knowledge, write, maxJsonBytes, maxFileBytes }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const intake = /^\/api\/library\/(uploads|links|notes)$/.exec(url.pathname);
    if (req.method !== "POST" || !intake) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!sources || !knowledge) throw new HttpError(503, "library_unavailable", "Source intake is unavailable.");
    const kind = intake[1];
    const input = await inputBody(req, kind === "uploads" ? Math.max(maxJsonBytes, Math.ceil(maxFileBytes * 1.4) + 4096) : maxJsonBytes,
      kind === "uploads" ? ["filename", "data", "encoding"] : kind === "links" ? ["url"] : ["title", "body"]);
    const project = await ensureLibraryProject(store, user);
    let registered;
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
    const { job: _job, ...reply } = registered;
    sendJson(res, 201, { data: { ...reply, source: projectSourceManifestRecord(reply.source) } });
    return true;
  };
}
