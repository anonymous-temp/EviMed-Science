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
    // The sources of the calculations among a result's value bindings are checked too: a printed number is only as
    // current as the calculation it is bound to, whose own recorded inputs say what that rests on (N15).
    const sourcesOf = async row => {
      const own = (row.inputs ?? []).filter(input => input.kind === "source");
      const behind = [];
      for (const calculation of (row.bindings?.calculations ?? []).slice(0, 8)) {
        if (calculation.versionId === row.versionId) continue;
        try {
          const found = await results.get(user.id, body.projectId, calculation.versionId);
          behind.push(...(found.inputs ?? []).filter(input => input.kind === "source").map(input => ({ ...input, viaCalculation: found.versionId })));
        } catch (error) { if (![401, 403, 404].includes(error?.status)) throw error; }
      }
      const key = input => JSON.stringify([input.id, input.digest ?? null, input.versionId ?? null]);
      const seen = new Set(own.map(key));
      return [...own, ...behind.filter(input => !seen.has(key(input)) && seen.add(key(input)))];
    };
    const inputs = await sourcesOf(version);
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
      return { source, doi, updateStatus, ...(input.viaCalculation ? { viaCalculation: input.viaCalculation } : {}) };
    };
    for (const input of await sourcesOf(confirmed)) {
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
    const statuses = (await sourcesOf(released)).map(statusEntry);
    sendJson(res, 200, { data: { versionId, digest: version.digest, statuses, impacts: { items: releasedImpacts } } });
    return true;
  };
}
