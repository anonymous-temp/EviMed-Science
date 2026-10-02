import { doiOf } from "@evimed/domain";
import { HttpError, readJson, sendJson } from "./security.mjs";

/** Refresh only source identities recorded on one immutable result.
 * @param {{store:any,results:any,lookup:any,impacts:any,maxJsonBytes?:number}} dependencies */
export function createResultSourceUpdatesRoutes({ store, results, lookup, impacts, maxJsonBytes = 4096 }) {
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const match = /^\/api\/results\/([^/]+)\/source-updates$/.exec(url.pathname);
    if (!match) return false;
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use the explicit source check action.");
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    const body = await readJson(req, maxJsonBytes);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "projectId")
      || typeof body.projectId !== "string" || !body.projectId || body.projectId.length > 160) {
      throw new HttpError(400, "result_source_updates_payload_invalid", "Select one result in its project.");
    }
    let versionId;
    try { versionId = decodeURIComponent(match[1]); }
    catch { throw new HttpError(400, "result_identifier_invalid", "Invalid result identifier."); }
    if (!/^rv_[a-f0-9]{64}$/.test(versionId)) throw new HttpError(400, "result_identifier_invalid", "Invalid result identifier.");
    await store.requireProject(user, body.projectId);
    if (!results || !impacts) throw new HttpError(503, "result_storage_unavailable", "Result updates are temporarily unavailable.");
    const version = await results.get(user.id, body.projectId, versionId);
    if (version.versionId !== versionId) throw new HttpError(409, "result_version_conflict", "The selected version could not be confirmed.");
    const inputs = (version.inputs ?? []).filter(input => input.kind === "source");
    const dois = [...new Set(inputs.filter(input => !["restricted", "deleted"].includes(input.availability)).map(input => doiOf(input.id)).filter(Boolean))];
    let checked = new Map();
    let unavailableReason = "disabled";
    if (lookup?.lookupStatuses) {
      try { checked = await lookup.lookupStatuses(dois); }
      catch { unavailableReason = "lookup_failed"; }
    }
    // A bounded external read does not extend project authorization.
    const confirmed = await results.get(user.id, body.projectId, versionId);
    if (confirmed.versionId !== versionId || confirmed.digest !== version.digest) {
      throw new HttpError(409, "result_version_conflict", "The selected version changed during its source check.");
    }
    const rows = new Map();
    const statusEntry = input => {
      if (["restricted", "deleted"].includes(input.availability)) {
        // A notice already fetched before revocation is no longer releasable.
        return { source: { id: "unavailable-source" }, doi: null,
          updateStatus: { state: "unavailable", checkedAt: null, reason: input.availability, updates: [] } };
      }
      const source = { id: input.id, ...(input.digest ? { digest: input.digest } : {}), ...(input.versionId ? { versionId: input.versionId } : {}) };
      const doi = doiOf(input.id);
      const updateStatus = !doi ? { state: "unknown", checkedAt: null, reason: "not_identified", updates: [] }
          : checked.get(doi) ?? { state: "unavailable", checkedAt: null, reason: unavailableReason, updates: [] };
      return { source, doi, updateStatus };
    };
    for (const input of (confirmed.inputs ?? []).filter(reference => reference.kind === "source")) {
      if (["restricted", "deleted"].includes(input.availability)) continue;
      const { source, updateStatus } = statusEntry(input);
      const reconciled = await impacts.reconcileSourceUpdate(user.id, { projectId: body.projectId, source, status: updateStatus });
      for (const row of reconciled.items ?? []) rows.set(row.id, row);
    }
    const releasedImpacts = await Promise.all([...rows.keys()].map(id => impacts.get(user.id, body.projectId, id)));
    const released = await results.get(user.id, body.projectId, versionId);
    if (released.versionId !== versionId || released.digest !== version.digest) {
      throw new HttpError(409, "result_version_conflict", "The selected version changed during its source check.");
    }
    const statuses = (released.inputs ?? []).filter(reference => reference.kind === "source").map(statusEntry);
    sendJson(res, 200, { data: { versionId, digest: version.digest, statuses, impacts: { items: releasedImpacts } } });
    return true;
  };
}
