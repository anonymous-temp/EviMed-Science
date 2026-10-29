import { MEMORY_KINDS } from "./memoryKinds.mjs";
import { recordResetRemoved } from "./memoryMetrics.mjs";
import { timeZoneOrDefault } from "./memoryTimeline.mjs";
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
 * Finer controls exist underneath it (`memoryIndexProvider`, which ranks the
 * capsule's facts, and the learning toggle) and none of them is the whole
 * subsystem: an index off still recalled by term match. Those stay — they are
 * the finer controls — and this one is the one an operator reaches for.
 *
 * @module memoryRoutes
 */

/**
 * An account's memory is served by `nativeMemory` (`nativeMemoryStore.mjs`, OpenViking's own files): a record is a memory file (a
 * line, for the profile document) with `nativeType`, `uri` and `contentHash`, and `version` a compare-and-swap token derived from
 * the text. `POST /api/memory/remember` (the page's 「记住这一条」) is pending until the engine has written it, and `pending` rides on
 * the profile. The legacy engine that kept the same page's records in PostgreSQL (settling a disagreement, a pending state, a
 * summary and an importance) was deleted on 2026-10-25; a deployment without the engine answers 503 `memory_engine_unavailable`,
 * and the switches of `/api/memory/settings` still work, since they are PostgreSQL's.
 *
 * @param {{
 *   config: any,
 *   memorySettings: any,
 *   nativeMemory?: import("./nativeMemoryStore.mjs").NativeMemoryStore | null,
 *   nativeMemoryImport?: import("./nativeMemoryImport.mjs").NativeMemoryImport | null,
 *   resetProduct?: ((userId: string) => Promise<{ methods: number, entries: number, jobs: number, feedback: number }>) | null,
 *   releasePausedRuntimes?: ((userId: string) => Promise<unknown>) | null,
 *   projectWork?: ((user: any, project: any, options: { timeZone: string }) => Promise<{ capabilities: any[], works: any[] }>) | null,
 *   store: any,
 *   context: (req: any, res: any) => Promise<any>,
 *   audit: (ctx: any, action: string, status: string, details?: any) => Promise<void>,
 *   decodeRouteComponent: (value: string, label: string) => string,
 * }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createMemoryRoutes({
  config, memorySettings, nativeMemory = null, nativeMemoryImport = null, resetProduct = null, releasePausedRuntimes = null, projectWork = null,
  store, context, audit, decodeRouteComponent,
}) {
  const enabled = config.memoryEnabled !== false;

  /**
   * The memory engine's store, or a refusal by name: a deployment that cannot reach the engine has no memory to serve, and says
   * so (503) — it never serves something else as the account's memory.
   * @returns {import("./nativeMemoryStore.mjs").NativeMemoryStore}
   */
  function engine() {
    if (!nativeMemory?.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
    return nativeMemory;
  }

  return async function memoryRoutes(req, res) {
    const pathname = new URL(req.url ?? "/", "http://evimed.local").pathname;
    if (pathname !== "/api/memory" && !pathname.startsWith("/api/memory/")) return false;
    if (!enabled) {
      // Named, not hidden. A 404 here would read as "this build does not have
      // memory", which is a different thing from "this deployment turned it
      // off" and leads a caller to the wrong repair.
      throw new HttpError(503, "memory_disabled", "Research memory is disabled in this deployment.");
    }

    // The researcher's own switches (2026-09-16 review, M4④). Pausing deletes
    // nothing: learning paused means no run writes a memory, recall paused
    // means no run is handed one, and a paused project is both, for that
    // project only. They are PostgreSQL's, so they answer without the engine.
    if (pathname === "/api/memory/settings" && req.method === "GET") {
      const ctx = await context(req, res);
      sendJson(res, 200, { data: await memorySettings.settings(ctx.user.id) });
      return true;
    }

    if (pathname === "/api/memory/settings" && req.method === "PUT") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory settings");
      const unknown = Object.keys(body).filter((field) => !["learningPaused", "recallPaused", "pausedProjects"].includes(field));
      if (unknown.length > 0) {
        throw new HttpError(400, "memory_settings_invalid", `Unknown memory setting(s): ${unknown.sort().join(", ")}.`);
      }
      const settings = await memorySettings.updateSettings(ctx.user.id, body);
      await audit(ctx, "memory.settings.update", "completed", {
        learningPaused: settings.learningPaused, recallPaused: settings.recallPaused, pausedProjects: settings.pausedProjects.length,
      });
      // The account's pause is the engine's own policy too: what reached it before the pause is archived and not extracted. The
      // gateway already stops forwarding; an engine that cannot be told now is told by the next change of the switch, and the
      // switch has taken effect either way (the gateway reads it per request). A project's pause reaches the engine too: a shared
      // GEO project's namespace reads it (`NativeMemoryStore.setLearning` configures every registered context).
      if ((typeof body.learningPaused === "boolean" || Array.isArray(body.pausedProjects)) && nativeMemory?.configured) {
        await nativeMemory.setLearning(ctx.user.id, !settings.learningPaused)
          .catch((/** @type {any} */ error) => audit(ctx, "memory.settings.engine", "failed", { code: String(error?.code ?? "memory_engine_unavailable") }));
      }
      // A pause for recall turned on under a runtime that is already up: the methods it mounted at launch are read from
      // it, so the idle ones are let go and the next launch mounts none (`RuntimeManager.releasePausedMethodRuntimes`).
      // Not waited on, and never a reason the switch did not take.
      if (releasePausedRuntimes && (body.recallPaused === true || (Array.isArray(body.pausedProjects) && body.pausedProjects.length > 0))) {
        void Promise.resolve(releasePausedRuntimes(ctx.user.id)).catch(() => {});
      }
      sendJson(res, 200, { data: settings });
      return true;
    }

    // Everything the account remembers, deleted: the memories, the methods
    // the platform learned, and the notes of its own capsules — each
    // kind the memory page shows, which is what the confirmation says
    // (`resetLearnedMemory`). The switches are left as they are: a reset is a
    // clean slate, not a change of mind about learning.
    if (pathname === "/api/memory/reset" && req.method === "POST") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory reset");
      if (body.confirm !== "reset") {
        throw new HttpError(400, "memory_reset_confirmation_required", "Resetting memory requires confirm: \"reset\".");
      }
      // The instant first, before anything is deleted: from it on, a conversation that was already over is not
      // learned from again (`endedBeforeReset`), whatever the deletions below leave of it. Run again after a failure it
      // is taken again, which can only move it later.
      await memorySettings.noteReset(ctx.user.id);
      const purged = await memorySettings.purgeUserMemory(ctx.user.id);
      // A reset that fails halfway answers with the failure and is run again: both halves are idempotent. The engine's memory files
      // and sessions go too, and the overlay's record of them.
      const native = nativeMemory?.configured ? { native: await nativeMemory.reset(ctx.user.id) } : {};
      const removed = { ...purged, ...(resetProduct ? await resetProduct(ctx.user.id) : {}), ...native };
      recordResetRemoved({ jobs: removed.jobs, feedback: removed.feedback });
      await audit(ctx, "memory.reset", "completed", removed);
      sendJson(res, 200, { data: removed });
      return true;
    }

    // 「记住这一条」 from the page: the person's words go to the engine as a conversation of one message, and appear when it has
    // written them (about twelve seconds); the answer is what the page shows as pending until then.
    if (pathname === "/api/memory/remember" && req.method === "POST") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory to remember");
      const unknown = Object.keys(body).filter((field) => field !== "text" && field !== "projectId");
      if (unknown.length > 0) throw new HttpError(400, "memory_payload_invalid", `Unknown field(s): ${unknown.sort().join(", ")}.`);
      const memory = engine();
      const text = assertString(body.text, "text", { max: 2_000 });
      const project = body.projectId == null || body.projectId === "" ? null
        : await store.requireProject(ctx.user, assertString(body.projectId, "projectId", { max: 64 }));
      const projectId = project?.id ?? null;
      const remembered = await memory.remember(ctx.user.id, { text, projectId, projectName: project?.name ?? null });
      await audit(ctx, "memory.remember", "completed", { project: projectId ?? "" });
      sendJson(res, 200, { data: remembered });
      return true;
    }

    // 「从其他 AI 导入」 (`nativeMemoryImport.mjs`): the pasted text is read into statements the person reviews, and what they keep is written
    // by the engine under its own templates. `POST /api/memory/import {text}` answers `{ id, statements, leftOut }`; `POST
    // /api/memory/import/:id/confirm {ids?}` saves the ticked ones (every statement the offer ticked when `ids` is absent).
    if (pathname === "/api/memory/import" && req.method === "POST") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory import");
      const unknown = Object.keys(body).filter((field) => field !== "text");
      if (unknown.length > 0) throw new HttpError(400, "memory_payload_invalid", `Unknown field(s): ${unknown.sort().join(", ")}.`);
      engine();
      if (!nativeMemoryImport) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
      const offered = await nativeMemoryImport.offer(ctx.user.id, { text: assertString(body.text, "text", { max: 8_000 }) });
      await audit(ctx, "memory.import.offer", "completed", { statements: offered.statements.length, leftOut: offered.leftOut });
      sendJson(res, 200, { data: offered });
      return true;
    }
    const importConfirm = /^\/api\/memory\/import\/([^/]+)\/confirm$/.exec(pathname);
    if (importConfirm && req.method === "POST") {
      const ctx = await context(req, res);
      const body = assertObject(await readJson(req, config.maxJsonBytes), "memory import");
      const unknown = Object.keys(body).filter((field) => field !== "ids");
      if (unknown.length > 0) throw new HttpError(400, "memory_payload_invalid", `Unknown field(s): ${unknown.sort().join(", ")}.`);
      if (body.ids !== undefined && !(Array.isArray(body.ids) && body.ids.length <= 50 && body.ids.every((id) => typeof id === "string" && id.length <= 20))) {
        throw new HttpError(400, "memory_payload_invalid", "ids is a list of the statements to save.");
      }
      engine();
      if (!nativeMemoryImport) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
      const saved = await nativeMemoryImport.save(ctx.user.id, decodeRouteComponent(importConfirm[1], "import id"), { ids: body.ids ?? null });
      await audit(ctx, "memory.import.save", "completed", { saved: saved.saved });
      sendJson(res, 200, { data: saved });
      return true;
    }

    if (pathname === "/api/memory/records" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      const allowedScopes = new Set(["user", "project", "session", "organization"]);
      const allowedKinds = new Set(MEMORY_KINDS);
      const allowedStatuses = new Set(["active", "pending", "superseded", "archived"]);
      const readFilters = (name, allowed) => url.searchParams.getAll(name)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter((value) => allowed.has(value));
      const filters = {
        scopes: readFilters("scope", allowedScopes),
        kinds: readFilters("kind", allowedKinds),
        statuses: readFilters("status", allowedStatuses),
        scopeId: url.searchParams.get("scopeId") ?? "",
        query: url.searchParams.get("query") ?? "",
        pageSize: Number(url.searchParams.get("pageSize") ?? 100),
      };
      sendJson(res, 200, { data: await engine().listRecords(ctx.user.id, filters) });
      return true;
    }

    // 「刚记住了 …」: what changed by itself since a moment, for the capsule
    // page after a visit and for the conversation it came from. Each item
    // carries the version its one-click undo needs.
    if (pathname === "/api/memory/changes" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      sendJson(res, 200, { data: await engine().changes(ctx.user.id, {
        since: url.searchParams.get("since") ?? null, sessionId: url.searchParams.get("sessionId"), limit: Number(url.searchParams.get("limit") ?? 20),
      }) });
      return true;
    }

    if (pathname === "/api/memory/profile" && req.method === "GET") {
      const ctx = await context(req, res);
      sendJson(res, 200, { data: await engine().profile(ctx.user.id, {
        holder: { id: String(ctx.user.id), name: String(ctx.user.name ?? ctx.user.id) },
      }) });
      return true;
    }

    /**
     * One project, read from above (2026-10-12): the card its facts were written under, what was done in it and what it delivered.
     *
     * The project is the account's own or it is a 404 — the memories are read only after that is settled, and the run ledger
     * is the project's own. The card is the project's own project-context memory, read by its sections; the rest is the ledger's
     * (`projectOverview.mjs`); a ledger that cannot be read leaves its two lists empty and the card stands (principle 19). `paused`
     * is this project's switch (`pausedProjects`), so the page can say so without asking the settings route a second time.
     */
    const overview = /^\/api\/memory\/projects\/([^/]+)\/overview$/.exec(pathname);
    if (overview && req.method === "GET") {
      const ctx = await context(req, res);
      const projectId = decodeRouteComponent(overview[1], "project id");
      const project = await store.requireProject(ctx.user, projectId);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      const timeZone = timeZoneOrDefault(url.searchParams.get("timeZone"));
      const memory = engine();
      const [settings, work] = await Promise.all([
        typeof memorySettings.settings === "function" ? memorySettings.settings(ctx.user.id).catch(() => null) : null,
        projectWork ? Promise.resolve(projectWork(ctx.user, project, { timeZone })).catch(() => null) : null,
      ]);
      sendJson(res, 200, { data: {
        projectId: project.id,
        paused: Array.isArray(settings?.pausedProjects) && settings.pausedProjects.includes(project.id),
        card: await memory.projectCard(ctx.user.id, project.id),
        capabilities: work?.capabilities ?? [],
        works: work?.works ?? [],
        timeZone,
      } });
      return true;
    }

    /**
     * The sources a memory rests on: the knowledge-base documents and published works it names, each with the state it is in
     * now. The memory drawer reads this when it opens, so the profile does not carry it for every row.
     */
    const sourcesOf = /^\/api\/memory\/records\/([^/]+)\/sources$/.exec(pathname);
    if (sourcesOf && req.method === "GET") {
      const ctx = await context(req, res);
      const recordId = decodeRouteComponent(sourcesOf[1], "structured memory id");
      sendJson(res, 200, { data: await engine().sourceLinks(ctx.user.id, recordId) });
      return true;
    }

    /**
     * The memory page's search box: the words over every memory's text, unioned with the engine's own semantic search, each hit
     * read back from the files so a stale index cannot show stale text (`NativeMemoryStore.search`).
     */
    if (pathname === "/api/memory/search" && req.method === "GET") {
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      const query = (url.searchParams.get("q") ?? "").trim();
      sendJson(res, 200, { data: await engine().search(ctx.user.id, query) });
      return true;
    }

    // One click undoes the last change to a memory (owner ruling 2026-09-19:
    // nothing asks first, so everything can be taken back). An addition is
    // undone by removing it, and that removal puts its lines on the rejection
    // list, which is what keeps the next extraction from writing it straight back.
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
      const undone = await engine().undo(ctx.user.id, recordId, { expectedVersion });
      await audit(ctx, "memory.record.undo", "completed", { target: recordId, undone: undone.undone });
      sendJson(res, 200, { data: undone });
      return true;
    }

    if (pathname.startsWith("/api/memory/records/")) {
      const rawRecordId = pathname.slice("/api/memory/records/".length);
      if (!rawRecordId || rawRecordId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
      const recordId = decodeRouteComponent(rawRecordId, "structured memory id");
      const ctx = await context(req, res);
      if (req.method === "PATCH" || req.method === "DELETE") {
        const memory = engine();
        if (req.method === "DELETE") {
          await memory.remove(ctx.user.id, recordId, { keepText: false, actor: "user" });
          await audit(ctx, "memory.record.delete", "completed", { target: recordId });
          sendJson(res, 200, { data: true });
          return true;
        }
        const body = assertObject(await readJson(req, config.maxJsonBytes), "structured memory update");
        const unknown = Object.keys(body).filter((field) => !["value", "status", "sensitive", "expectedVersion"].includes(field));
        // A summary and an importance have no place in a memory file: refused by name rather than dropped.
        if (unknown.length > 0) throw new HttpError(400, unknown.every((field) => field === "summary" || field === "importance") ? "memory_engine_unsupported" : "memory_payload_invalid",
          `Unsupported memory field(s): ${unknown.sort().join(", ")}.`);
        const expectedVersion = Number(body.expectedVersion);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new HttpError(400, "memory_version_invalid", "expectedVersion must be a positive integer.");
        const updated = await memory.update(ctx.user.id, recordId, {
          ...(Object.hasOwn(body, "value") ? { value: assertString(body.value, "value", { max: 100_000 }) } : {}),
          ...(Object.hasOwn(body, "sensitive") ? { sensitive: body.sensitive } : {}),
          ...(Object.hasOwn(body, "status") ? { status: String(body.status) } : {}),
          expectedVersion,
        });
        await audit(ctx, "memory.record.update", "completed", { target: recordId, status: updated.status });
        sendJson(res, 200, { data: updated });
        return true;
      }
    }

    return false;
  };
}
