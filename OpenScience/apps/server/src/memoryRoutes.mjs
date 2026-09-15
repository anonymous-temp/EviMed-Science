import {
  HttpError,
  apiBaseFromRequest,
  assertObject,
  assertString,
  readJson,
  sendJson,
} from "./security.mjs";

/**
 * Everything a researcher can do to their own memory, over HTTP.
 *
 * Hidden knowledge: this is the last of the durable product subsystems to get a
 * routes module, and the reason it mattered is not tidiness. Capsules have
 * `capsuleRoutes`, learned methods have `learningRoutes`, sources, autopilot,
 * notifications, usage and plugins each have their own — memory alone was
 * inlined in `createWebApiApp`, which meant the composition root imported the
 * memory store *and* held its request handling, so "turn memory off" had no
 * one thing to turn off and the core could not be read without reading memory.
 * The shape this file restores is the one the platform's own rule states: a
 * feature module is `<x>Service` + `create<X>Routes` + one config toggle,
 * registered by one line in `createWebApiApp`.
 *
 * The toggle is `OPEN_SCIENCE_MEMORY_ENABLED` and it is a real off switch, not
 * a hide: with it off these routes answer 503 by name rather than 404, because
 * a deployment that turned memory off and a deployment where the route moved
 * are different facts and a client should be able to tell them apart. What
 * stays on regardless is the rest of the platform — the run ledger, the kernel
 * wire, the gate — which is what "individually disable-able" is supposed to
 * mean.
 *
 * Three levers already existed underneath it (`memoryExtractionEnabled`,
 * `memoryIndexProvider`, the learning toggle) and none of them was the whole
 * subsystem: extraction off still served records, an index off still recalled
 * by term match. Those stay — they are the finer controls — and this one is the
 * one an operator reaches for.
 *
 * @module memoryRoutes
 */

/**
 * @param {{
 *   config: any,
 *   researchMemory: any,
 *   feedbackEvents: any,
 *   store: any,
 *   context: (req: any, res: any) => Promise<any>,
 *   audit: (ctx: any, action: string, status: string, details?: any) => Promise<void>,
 *   recordFeedback: (ctx: any, operation: () => any) => Promise<void>,
 *   decodeRouteComponent: (value: string, label: string) => string,
 * }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createMemoryRoutes({
  config, researchMemory, feedbackEvents, store, context, audit, recordFeedback, decodeRouteComponent,
}) {
  const enabled = config.memoryEnabled !== false;
  return async function memoryRoutes(req, res) {
    const pathname = new URL(req.url ?? "/", "http://evimed.local").pathname;
    if (pathname !== "/api/memory" && !pathname.startsWith("/api/memory/")) return false;
    if (!enabled) {
      // Named, not hidden. A 404 here would read as "this build does not have
      // memory", which is a different thing from "this deployment turned it
      // off" and leads a caller to the wrong repair.
      throw new HttpError(503, "memory_disabled", "Research memory is disabled in this deployment.");
    }

    if (pathname === "/api/memory/status" && req.method === "GET") {
      await store.ensureUser(req, res);
      sendJson(res, 200, { data: await researchMemory.status() });
      return true;
    }

    if (pathname === "/api/memory/memos" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      const state = url.searchParams.get("state") === "archived" ? "archived" : "normal";
      sendJson(res, 200, { data: await researchMemory.list(ctx.user.id, { state }) });
      return true;
    }

    if (pathname === "/api/memory/memos" && req.method === "POST") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "research memory");
      const unknown = Object.keys(body).filter((field) => field !== "content");
      if (unknown.length > 0) {
        throw new HttpError(400, "memory_payload_invalid", `Unknown memory field(s): ${unknown.sort().join(", ")}.`);
      }
      const content = assertString(body.content, "content", { max: Math.min(config.maxJsonBytes, 100_000) }).trim();
      if (!content) throw new HttpError(400, "memory_content_empty", "Memory content must not be empty.");
      const memo = await researchMemory.create(ctx.user.id, content);
      await audit(ctx, "memory.create", "completed", { target: memo.id });
      sendJson(res, 201, { data: memo });
      return true;
    }

    if (pathname.startsWith("/api/memory/memos/")) {
      const rawMemoId = pathname.slice("/api/memory/memos/".length);
      if (!rawMemoId || rawMemoId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
      const memoId = decodeRouteComponent(rawMemoId, "memo id");
      const ctx = await context(req, res);
      if (req.method === "PATCH") {
        const body = assertObject(await readJson(req, config.maxJsonBytes), "research memory update");
        const unknown = Object.keys(body).filter((field) => !["content", "pinned", "state"].includes(field));
        if (unknown.length > 0) {
          throw new HttpError(400, "memory_payload_invalid", `Unknown memory field(s): ${unknown.sort().join(", ")}.`);
        }
        const update = {};
        if (Object.hasOwn(body, "content")) {
          const content = assertString(body.content, "content", { max: Math.min(config.maxJsonBytes, 100_000) }).trim();
          if (!content) throw new HttpError(400, "memory_content_empty", "Memory content must not be empty.");
          update.content = content;
        }
        if (Object.hasOwn(body, "pinned")) {
          if (typeof body.pinned !== "boolean") throw new HttpError(400, "memory_pinned_invalid", "pinned must be a boolean.");
          update.pinned = body.pinned;
        }
        if (Object.hasOwn(body, "state")) {
          if (!["normal", "archived"].includes(body.state)) {
            throw new HttpError(400, "memory_state_invalid", "state must be normal or archived.");
          }
          update.state = body.state;
        }
        const memo = await researchMemory.update(ctx.user.id, memoId, update);
        await audit(ctx, "memory.update", "completed", { target: memo.id });
        sendJson(res, 200, { data: memo });
        return true;
      }
      if (req.method === "DELETE") {
        await researchMemory.delete(ctx.user.id, memoId);
        await audit(ctx, "memory.delete", "completed", { target: memoId });
        sendJson(res, 200, { data: true });
        return true;
      }
    }

    if (pathname === "/api/memory/records" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      const allowedScopes = new Set(["user", "project", "session", "organization"]);
      const allowedKinds = new Set([
        "profile", "preference", "behavior", "project_fact", "analysis",
        "decision", "correction", "follow_up", "run_summary",
      ]);
      const allowedStatuses = new Set(["active", "pending", "superseded", "archived"]);
      const readFilters = (name, allowed) => url.searchParams.getAll(name)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter((value) => allowed.has(value));
      const records = await researchMemory.listRecords(ctx.user.id, {
        scopes: readFilters("scope", allowedScopes),
        kinds: readFilters("kind", allowedKinds),
        statuses: readFilters("status", allowedStatuses),
        scopeId: url.searchParams.get("scopeId") ?? "",
        query: url.searchParams.get("query") ?? "",
        pageSize: Number(url.searchParams.get("pageSize") ?? 100),
      });
      sendJson(res, 200, { data: records });
      return true;
    }

    if (pathname === "/api/memory/profile" && req.method === "GET") {
      const ctx = await context(req, res);
      sendJson(res, 200, { data: await researchMemory.profile(ctx.user.id, { projectId: ctx.project.id }) });
      return true;
    }

    if (pathname.startsWith("/api/memory/records/")) {
      const rawRecordId = pathname.slice("/api/memory/records/".length);
      if (!rawRecordId || rawRecordId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
      const recordId = decodeRouteComponent(rawRecordId, "structured memory id");
      const ctx = await context(req, res);
      if (req.method === "PATCH") {
        const body = assertObject(await readJson(req, config.maxJsonBytes), "structured memory update");
        const allowed = new Set(["value", "summary", "status", "importance", "sensitive", "expectedVersion"]);
        const unknown = Object.keys(body).filter((field) => !allowed.has(field));
        if (unknown.length > 0) {
          throw new HttpError(400, "memory_payload_invalid", `Unknown memory field(s): ${unknown.sort().join(", ")}.`);
        }
        const existing = await researchMemory.getRecord(ctx.user.id, recordId);
        const expectedVersion = Number(body.expectedVersion);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
          throw new HttpError(400, "memory_version_invalid", "expectedVersion must be a positive integer.");
        }
        if (expectedVersion !== existing.version) {
          throw new HttpError(409, "memory_conflict", "Structured memory changed before this update was applied.");
        }
        const next = { ...existing };
        if (Object.hasOwn(body, "value")) {
          next.value = assertString(body.value, "value", { max: 100_000 }).trim();
          if (!next.value) throw new HttpError(400, "memory_content_empty", "Structured memory value must not be empty.");
        }
        if (Object.hasOwn(body, "summary")) next.summary = assertString(body.summary, "summary", { max: 2_000 }).trim();
        if (Object.hasOwn(body, "status")) {
          if (!["active", "pending", "superseded", "archived"].includes(body.status)) {
            throw new HttpError(400, "memory_status_invalid", "status is invalid.");
          }
          next.status = body.status;
        }
        if (Object.hasOwn(body, "importance")) {
          const importance = Number(body.importance);
          if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
            throw new HttpError(400, "memory_importance_invalid", "importance must be between zero and one.");
          }
          next.importance = importance;
        }
        if (Object.hasOwn(body, "sensitive")) {
          if (typeof body.sensitive !== "boolean") {
            throw new HttpError(400, "memory_sensitive_invalid", "sensitive must be a boolean.");
          }
          next.sensitive = body.sensitive;
        }
        const acceptedInference = existing.status === "pending" && next.status === "active";
        next.origin = acceptedInference ? "explicit" : "manual";
        next.confidence = acceptedInference ? 1 : next.confidence;
        next.lastConfirmedAt = new Date().toISOString();
        const updated = await researchMemory.upsertRecord(ctx.user.id, next, null, {
          expectedVersion,
          reason: acceptedInference ? "user confirmed a pending memory" : "user updated structured memory",
        });
        await audit(ctx, "memory.record.update", "completed", { target: updated.id, version: updated.version });
        // The decision itself, as an event. An audit line records that a
        // request happened; this records what the researcher decided, in a
        // form later steps can count and read.
        await recordFeedback(ctx, () => feedbackEvents?.recordMemoryUpdate(ctx.user.id, {
          before: existing, after: updated, projectId: ctx.project.id,
        }));
        sendJson(res, 200, { data: updated });
        return true;
      }
      if (req.method === "DELETE") {
        // Read before deleting: what was rejected is the whole content of the
        // event, and after the delete there is nothing left to name it by.
        const rejected = await researchMemory.getRecord(ctx.user.id, recordId);
        await researchMemory.deleteRecord(ctx.user.id, recordId);
        await audit(ctx, "memory.record.delete", "completed", { target: recordId });
        await recordFeedback(ctx, () => feedbackEvents?.recordMemoryDeletion(ctx.user.id, {
          record: rejected, projectId: ctx.project.id,
        }));
        sendJson(res, 200, { data: true });
        return true;
      }
    }

    return false;
  };
}
