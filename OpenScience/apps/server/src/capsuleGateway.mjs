import { CAPSULE_FACT_KINDS } from "@evimed/domain";
import { HttpError, readJson, sendError, sendJson } from "./security.mjs";

export const CAPSULE_GATEWAY_PATH = "/internal/capsules/v1";

/** The workload credential, never a caller-supplied field, fixes account and project.
 * @param {{ runtimeManager: any, store: any, service: any }} dependencies */
export function createCapsuleGatewayHandler({ runtimeManager, store, service }) {
  const windows = new Map();
  /** @param {any} req @param {any} res @param {(failure:any)=>void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url, "http://evimed.local");
      const action = url.pathname.slice(CAPSULE_GATEWAY_PATH.length + 1);
      if (req.method !== "POST" || url.search || !["recall", "note"].includes(action)) {
        throw new HttpError(404, "not_found", "Capsule operation not found.");
      }
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const identity = await runtimeManager.assertActiveEviMedWorkloadToken(token);
      const user = await store.userById(identity.userId);
      if (!user) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      await store.requireProject(user, identity.projectId);
      if (!service) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const key = JSON.stringify([identity.userId, identity.projectId]);
      const window = windows.get(key) ?? { until: now + 60_000, count: 0 };
      if (!windows.has(key) && windows.size >= 10_000) throw new HttpError(503, "capsule_busy", "Research memory is busy.");
      windows.set(key, window);
      if (++window.count > 120) throw new HttpError(429, "capsule_rate_limited", "Too many memory operations.");
      const body = await readJson(req, 64 * 1024);
      const allowed = action === "recall" ? ["query", "factKinds", "since", "scope"] : ["factKind", "content", "origin"];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((field) => !allowed.includes(field))) {
        throw new HttpError(400, "capsule_payload_invalid", "Unsupported memory fields.");
      }
      // Body streaming may outlive runtime stop, rotation or account removal.
      await runtimeManager.assertActiveEviMedWorkloadToken(token);
      const currentUser = await store.userById(identity.userId);
      if (!currentUser) throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable.");
      await store.requireProject(currentUser, identity.projectId);
      if (action === "recall") {
        if (body.factKinds !== undefined && (!Array.isArray(body.factKinds) || body.factKinds.length > CAPSULE_FACT_KINDS.length || body.factKinds.some((kind) => !CAPSULE_FACT_KINDS.includes(kind)))) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid memory kinds.");
        }
        if (body.since != null && (typeof body.since !== "string" || body.since.length > 40 || !Number.isFinite(Date.parse(body.since)))) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid memory date.");
        }
        if (body.scope !== undefined && !["all", "capsule", "conversation", "agenda"].includes(body.scope)) {
          throw new HttpError(400, "capsule_payload_invalid", "Invalid memory scope.");
        }
        sendJson(res, 200, await service.recall(currentUser.id, {
          ...body, projectId: identity.projectId, accountCreatedAt: currentUser.accountCreatedAt,
        }));
      } else {
        // A model's claim that its input was explicit is not a user's approval.
        const entry = await service.note(user.id, identity.projectId, { factKind: body.factKind, content: body.content, origin: "inferred" });
        sendJson(res, 200, { entry, reviewRequired: true, contextOnly: true });
      }
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "capsule_unavailable", "Research memory is unavailable.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
