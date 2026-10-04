// The runtime's door to what a project's datasets mean (`dataset_semantics`, plan 2026-10-02 §11.3 N03).
//
// The same shape as every internal gateway (layer 3): one path, one handler, one
// allowlist of operations and fields, and the runtime's own gateway token as the only
// credential. The token — never anything the run says — names the account and the
// project, so a run can only ever read or write the datasets of the project it runs in.
//
//   POST /internal/semantics/v1/read       { datasetId? }                      -> a project's datasets, or one in full
//   POST /internal/semantics/v1/write      { patch }                           -> facts and source versions, merged by basis
//   POST /internal/semantics/v1/report     { datasetId, report, denominators } -> the last check's findings and counts
//   POST /internal/semantics/v1/transform  { datasetId, transformation }       -> new / same / changed, with what changed
//
// Hidden knowledge:
//
// - The runtime states `via: conversation` for everything it writes; it cannot say it is the
//   page. A researcher's own confirmation from the files page is a different route with the
//   browser session behind it (`dataSemanticsRoutes.mjs`), so the two are told apart by who
//   could have made the call and not by what the call claims.
// - Nothing here gates anything. A refused item comes back in `issues` and everything else is
//   written; a module that is off answers `semantics_disabled`, which the tool turns into a
//   warning the run reads and goes on from — the analysis then proceeds from the files, as it
//   did before the tool existed.
// - Rate: a run asks a handful of times; the ceiling is for a loop, not a researcher.

import { HttpError, readJson, sendError, sendJson } from "./security.mjs";

export const DATA_SEMANTICS_GATEWAY_PATH = "/internal/semantics/v1";
const OPERATIONS = Object.freeze({
  read: ["datasetId"],
  write: ["patch"],
  report: ["datasetId", "report", "denominators"],
  transform: ["datasetId", "transformation"],
});
/** A write carries up to twenty tables' column profiles; the asset a ledger document holds is smaller than this. */
const MAX_BODY_BYTES = 1024 * 1024;
const WINDOW_LIMIT = 120;

/**
 * @param {{ config: any, runtimeManager: any, store: any, service: any }} dependencies
 */
export function createDataSemanticsGateway({ config, runtimeManager, store, service }) {
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
  /** @param {any} req @param {any} res @param {(failure: { code: string, status: number }) => void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url ?? "/", "http://evimed.local");
      const operation = url.pathname.startsWith(`${DATA_SEMANTICS_GATEWAY_PATH}/`) ? url.pathname.slice(DATA_SEMANTICS_GATEWAY_PATH.length + 1) : "";
      if (req.method !== "POST" || !Object.hasOwn(OPERATIONS, operation) || url.search) throw new HttpError(404, "not_found", "Not found.");
      const header = String(req.headers?.authorization ?? "").trim();
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token) throw new HttpError(401, "semantics_gateway_token_missing", "Data-semantics authentication failed.");
      let identity;
      try { identity = runtimeManager.assertActiveModelGatewayToken(token); } catch {
        throw new HttpError(401, "semantics_gateway_token_invalid", "Data-semantics authentication failed.");
      }
      if (!config.dataSemanticsEnabled || !service) {
        throw new HttpError(503, "semantics_disabled", "Recorded data meaning is switched off for this deployment; the analysis goes on from the files.");
      }
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const key = `${identity.userId}\u0000${identity.projectId}`;
      const window = windows.get(key) ?? { until: now + 60_000, count: 0 };
      windows.set(key, window);
      if (++window.count > WINDOW_LIMIT) throw new HttpError(429, "semantics_rate_limited", "Too many data-semantics calls in a minute.");
      const user = await store.userById(identity.userId);
      if (!user) throw new HttpError(401, "semantics_gateway_token_invalid", "Data-semantics authentication failed.");
      const project = await store.requireProject(user, identity.projectId);
      const input = await readJson(req, MAX_BODY_BYTES).catch((error) => {
        throw error instanceof HttpError && error.status === 413 ? new HttpError(413, "semantics_request_too_large", "The request was too large.") : new HttpError(400, "semantics_request_invalid", "The request was not a JSON object.");
      });
      const allowed = /** @type {readonly string[]} */ (OPERATIONS[/** @type {keyof typeof OPERATIONS} */ (operation)]);
      if (Object.keys(input).some((field) => !allowed.includes(field))) throw new HttpError(400, "semantics_request_invalid", `${operation} takes: ${allowed.join(", ")}.`);
      let data;
      if (operation === "read") {
        if (input.datasetId == null) data = { datasets: await service.list(user.id, project.id) };
        else {
          const found = await service.get(user.id, project.id, input.datasetId);
          if (!found) throw new HttpError(404, "semantics_asset_not_found", "No recorded meaning for that dataset.");
          data = { dataset: found };
        }
      } else if (operation === "write") {
        if (input.patch == null || typeof input.patch !== "object" || Array.isArray(input.patch)) throw new HttpError(400, "semantics_request_invalid", "write takes a patch object.");
        data = await service.write(user.id, project.id, input.patch, { via: "conversation" });
      } else if (operation === "report") {
        data = await service.recordCheck(user.id, project.id, input.datasetId, input.report, input.denominators ?? {});
      } else {
        data = await service.recordTransformation(user.id, project.id, input.datasetId, input.transformation);
      }
      sendJson(res, 200, { data });
    } catch (error) {
      const known = error instanceof HttpError;
      const safe = known ? error : new HttpError(503, "semantics_unavailable", "Recorded data meaning is unavailable; the analysis goes on from the files.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
