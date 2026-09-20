import { recallAcrossMemory } from "./memoryRecall.mjs";
import { MEMORY_KINDS, conversationTitlesIn } from "./researchMemory.mjs";
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
 *   memorySubstrate?: any,
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
  config, researchMemory, memorySubstrate = null, feedbackEvents, store, context, audit, recordFeedback, decodeRouteComponent,
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

    // The researcher's own switches (2026-09-16 review, M4④). Pausing deletes
    // nothing: learning paused means no run writes a memory, recall paused
    // means no run is handed one, and a paused project is both, for that
    // project only.
    if (pathname === "/api/memory/settings" && req.method === "GET") {
      const ctx = await context(req, res);
      sendJson(res, 200, { data: await researchMemory.settings(ctx.user.id) });
      return true;
    }

    if (pathname === "/api/memory/settings" && req.method === "PUT") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory settings");
      const unknown = Object.keys(body).filter((field) => !["learningPaused", "recallPaused", "pausedProjects"].includes(field));
      if (unknown.length > 0) {
        throw new HttpError(400, "memory_settings_invalid", `Unknown memory setting(s): ${unknown.sort().join(", ")}.`);
      }
      const settings = await researchMemory.updateSettings(ctx.user.id, body);
      await audit(ctx, "memory.settings.update", "completed", {
        learningPaused: settings.learningPaused, recallPaused: settings.recallPaused, pausedProjects: settings.pausedProjects.length,
      });
      sendJson(res, 200, { data: settings });
      return true;
    }

    // Everything the account remembers, deleted. The switches are left as they
    // are: a reset is a clean slate, not a change of mind about learning.
    if (pathname === "/api/memory/reset" && req.method === "POST") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory reset");
      if (body.confirm !== "reset") {
        throw new HttpError(400, "memory_reset_confirmation_required", "Resetting memory requires confirm: \"reset\".");
      }
      // The derived index first, and awaited, for the reason project deletion
      // gives: a recall index that still answers with deleted memories is a
      // copy of deleted data, so its failure fails the reset while the records
      // are still there to retry with. Once more after the rows are gone, for
      // an index job that re-published one in between.
      if (memorySubstrate) await memorySubstrate.forgetUser(ctx.user.id);
      const removed = await researchMemory.purgeUserMemory(ctx.user.id);
      if (memorySubstrate) await memorySubstrate.forgetUser(ctx.user.id).catch(() => false);
      await audit(ctx, "memory.reset", "completed", removed);
      sendJson(res, 200, { data: removed });
      return true;
    }

    // 「你写下的笔记」 and its three routes — GET/POST /api/memory/memos and
    // PATCH/DELETE on one of them — were deleted on 2026-09-20 with the table
    // behind them. A composer for what the extractor already writes is work
    // asked of the researcher for nothing; what they want remembered they say
    // in a conversation.

    if (pathname === "/api/memory/records" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      const allowedScopes = new Set(["user", "project", "session", "organization"]);
      // The whole stored vocabulary, not what extraction may write:
      // `analysis` rows written before 2026-09-20 still exist and a reader has
      // to be able to ask for them.
      const allowedKinds = new Set(MEMORY_KINDS);
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

    // 「刚记住了 …」: what changed by itself since a moment, for the capsule
    // page after a visit and for the conversation it came from. Each item
    // carries the version its one-click undo needs.
    if (pathname === "/api/memory/changes" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      sendJson(res, 200, { data: await researchMemory.recentChanges(ctx.user.id, {
        since: url.searchParams.get("since") ?? "",
        sessionId: url.searchParams.get("sessionId"),
        limit: Number(url.searchParams.get("limit") ?? 20),
      }) });
      return true;
    }

    if (pathname === "/api/memory/profile" && req.method === "GET") {
      const ctx = await context(req, res);
      const profile = await researchMemory.profile(ctx.user.id, { projectId: ctx.project.id });
      const ids = profile.records.map((/** @type {any} */ record) => record.id);
      sendJson(res, 200, { data: {
        ...profile,
        // What each memory came out of, and how often it has been used: the
        // two things every row on the page says, resolved here rather than by
        // the page, which would otherwise need the whole account to say them.
        conversations: conversationTitlesIn(profile.records),
        usage: typeof researchMemory.recordUsage === "function"
          ? await researchMemory.recordUsage(ctx.user.id, ids).catch(() => ({}))
          : {},
      } });
      return true;
    }

    /**
     * The memory page's search box.
     *
     * Keyword and semantic, unioned server-side. The page's box used to be a
     * `toLowerCase().includes` over the notes already loaded, so a researcher
     * searching 「阿司匹林」 found it only if the row happened to be on screen.
     * Keyword comes from the store, over everything the account holds
     * including what recall never serves — an archived memory and a 「做过的
     * 研究」 summary both have to be findable. Semantic comes from the recall
     * index through the same port every recall uses, and only nominates: each
     * hit is resolved back to the stored record, so a stale index cannot show
     * stale text and cannot show a memory the reader is not entitled to.
     *
     * The keyword half is authoritative. An index that is down, off or
     * unconfigured costs the search its semantic half and nothing else.
     */
    if (pathname === "/api/memory/search" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      const query = (url.searchParams.get("q") ?? "").trim();
      const found = await researchMemory.searchRecords(ctx.user.id, { query, projectId: ctx.project.id });
      const items = [...found.items];
      const seen = new Set(items.map((/** @type {any} */ record) => record.id));
      let semantic = 0;
      // `conversation` scope: the research-memory records, which is what this
      // page lists. A capsule entry is a different row with a different editor
      // and reaches the page through its own read.
      if (query && memorySubstrate) {
        const recalled = await recallAcrossMemory({ capsules: null, memorySubstrate }, ctx.user, {
          query, projectId: ctx.project.id, limit: 25, scope: "conversation", countUsage: false,
        }).catch(() => null);
        for (const item of recalled?.items ?? []) {
          const id = /^record:(.+)$/.exec(String(item.id ?? ""))?.[1];
          if (!id || seen.has(id)) continue;
          const record = await researchMemory.getRecord(ctx.user.id, id).catch(() => null);
          if (!record) continue;
          seen.add(id);
          items.push(record);
          semantic += 1;
        }
      }
      sendJson(res, 200, { data: {
        items,
        query,
        semantic,
        conversations: { ...found.titles, ...conversationTitlesIn(items) },
        usage: typeof researchMemory.recordUsage === "function"
          ? await researchMemory.recordUsage(ctx.user.id, items.map((/** @type {any} */ record) => record.id)).catch(() => ({}))
          : {},
      } });
      return true;
    }

    // One click undoes the last change to a memory (owner ruling 2026-09-19:
    // nothing asks first, so everything can be taken back). A write that
    // created the memory is undone by removing it; that removal is recorded
    // as the researcher rejecting it, which is what keeps the next run's
    // inference from writing it straight back.
    if (pathname.startsWith("/api/memory/records/") && pathname.endsWith("/undo") && req.method === "POST") {
      const rawRecordId = pathname.slice("/api/memory/records/".length, -"/undo".length);
      if (!rawRecordId || rawRecordId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
      const recordId = decodeRouteComponent(rawRecordId, "structured memory id");
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory undo");
      if (Object.keys(body).some((field) => field !== "expectedVersion")) {
        throw new HttpError(400, "memory_payload_invalid", "Only expectedVersion is accepted.");
      }
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new HttpError(400, "memory_version_invalid", "expectedVersion must be a positive integer.");
      }
      const result = await researchMemory.undo(ctx.user.id, recordId, { expectedVersion });
      await audit(ctx, "memory.record.undo", "completed", { target: recordId, undone: result.undone });
      await recordFeedback(ctx, () => (result.undone === "removed"
        ? feedbackEvents?.recordMemoryDeletion(ctx.user.id, { record: result.previous, projectId: ctx.project.id, reason: "undone" })
        : feedbackEvents?.recordMemoryUpdate(ctx.user.id, { before: result.previous, after: result.record, projectId: ctx.project.id })));
      sendJson(res, 200, { data: { undone: result.undone, record: result.record, restored: result.restored } });
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
