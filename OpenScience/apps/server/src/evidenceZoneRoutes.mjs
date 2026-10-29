import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * The directory of a deployment without topic zones: no zone in it and no way to make one.
 * @param {string | null} view @param {any} config
 */
function unavailableDirectory(view, config) {
  if (!["recommended", "mine", "community"].includes(view ?? "")) throw new HttpError(400, "evidence_query_invalid", "Invalid evidence query.");
  return { view, total: 0, canCreate: false, userZones: { count: 0, max: Number.isSafeInteger(config?.evidenceUserZonesMax) ? config.evidenceUserZonesMax : 0 }, groups: [], zones: [] };
}

/**
 * `reads` is the topic zones' read side (`evidenceZoneReads.mjs`): the directory views, a topic zone's detail, overview, 「动态」 and
 * cards. `writes` is the write side (`evidenceZoneWrites.mjs`): drafting, previewing, creating, editing, deleting a reader's zone and a
 * reader's word on an item. Without them every route answers as it did before topic zones. A zone is addressed by its id or its slug.
 * @param {{store:any,service:any,frontier:any,config:any,maxJsonBytes:number,reads?:any,writes?:any}} options
 */
export function createEvidenceZoneRoutes({
  store,
  service,
  frontier,
  config,
  maxJsonBytes,
  reads=null,
  writes=null,
}) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (
      url.pathname !== "/api/frontier/zones" &&
      !url.pathname.startsWith("/api/frontier/zones/") &&
      url.pathname !== "/api/frontier/evidence"
    )
      return false;
    if (!config.frontierEnabled || !service || !frontier)
      throw new HttpError(
        404,
        "frontier_not_enabled",
        "The frontier feed is not enabled.",
      );
    const { user } = await store.ensureSessionUser(req, res, {
      allowDevAuth: false,
    });
    await store.assertCsrf(req, url.pathname);
    if (!frontier.allows(user))
      throw new HttpError(
        404,
        "frontier_not_enabled",
        "The frontier feed is not enabled.",
      );
    let parts;
    try {
      parts = url.pathname
        .slice("/api/frontier/".length)
        .split("/")
        .map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "evidence_invalid", "Invalid path.");
    }
    if (
      parts.some((part) => part.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(part))
    )
      throw new HttpError(400, "evidence_invalid", "Invalid path.");
    const method = req.method ?? "GET";
    const reply = (/** @type {any} */ value) => {
      sendJson(
        res,
        200,
        { data: value },
        { "Cache-Control": "private, no-store" },
      );
      return true;
    };
    const body = async () => readJson(req, maxJsonBytes);
    if (parts[0] === "evidence" && parts.length === 1 && method === "GET")
      return reply(await service.list(user, url.searchParams, "*"));
    // The topic zones' writes (owner 2026-10-29): a sentence drafted into a definition, its preview, a reader's zone made, edited and
    // deleted, a reader's word on an item. A body with a `definition` is a topic zone; the old body (a name, a description) still is the
    // old zone. A PATCH on a topic zone is the topic write, whatever it changes; on any other zone it is the old one.
    if (writes && parts[0] === "zones" && parts.length === 2 && method === "POST" && ["draft", "preview"].includes(parts[1]))
      return reply(await writes[parts[1]](user, await body()));
    if (writes && parts[0] === "zones" && parts.length === 5 && parts[2] === "items" && parts[4] === "feedback" && method === "POST")
      return reply(await writes.feedback(user, parts[1], parts[3], await body()));
    if (writes && parts[0] === "zones" && parts.length === 2 && method === "DELETE")
      return reply(await writes.remove(user, parts[1]));
    if (parts[0] === "zones" && parts.length === 1) {
      if (method === "GET") {
        if (url.searchParams.has("view")) {
          // With the topic zones switched off there is no read side, and the directory says so as an empty one that cannot create: the
          // older list below answers a different shape, which the page would read as a directory that may be built on.
          return reply(reads ? await reads.directory(user, url.searchParams) : unavailableDirectory(url.searchParams.get("view"), config));
        }
        return reply(await service.list(user, url.searchParams));
      }
      if (method === "POST") {
        const value = await body();
        if (writes && value && typeof value === "object" && "definition" in value) return reply(await writes.create(user, value));
        return reply(await service.save(user, value));
      }
    }
    // `draft` and `preview` are the writer's words, not zones; any other second part is a zone's id or its slug.
    const zoneId =
      reads && parts.length >= 2 && !["draft", "preview"].includes(parts[1])
        ? await reads.resolveId(user, parts[1])
        : parts[1];
    if (parts.length === 2) {
      if (method === "GET") {
        // A topic zone is answered by the reads (its detail shape); any other zone by the old service.
        const topic = reads ? await reads.detail(user, zoneId) : null;
        return reply(topic ?? (await service.detail(user, zoneId)));
      }
      if (method === "PATCH") {
        const value = await body();
        if (writes && await writes.isTopicZone(user, zoneId)) return reply(await writes.update(user, zoneId, value));
        return reply(await service.save(user, value, zoneId));
      }
    }
    // Who may read a published zone is the owner's own choice, made apart from publishing it.
    if (parts.length === 3 && parts[2] === "visibility" && method === "PUT")
      return reply(await service.setVisibility(user, zoneId, await body()));
    if (parts.length === 3 && parts[2] === "evidence") {
      if (method === "GET")
        return reply(await service.list(user, url.searchParams, zoneId));
      if (method === "POST") {
        const value = await body();
        if (!value?.subtype)
          throw new HttpError(
            400,
            "evidence_invalid",
            "An evidence type is required.",
          );
        return reply(await service.save(user, value, zoneId, null, true));
      }
    }
    if (reads && parts.length === 3 && method === "GET") {
      if (parts[2] === "overview") return reply(await reads.overview(user, zoneId));
      if (parts[2] === "items") return reply(await reads.items(user, zoneId, url.searchParams));
      if (parts[2] === "cards") return reply(await reads.cards(user, zoneId));
    }
    if (
      parts.length === 3 &&
      ["follow", "feedback", "research"].includes(parts[2]) &&
      (method === "POST" || (parts[2] === "follow" && method === "DELETE"))
    ) {
      const acted = await service.act(
        user,
        zoneId,
        parts[2],
        await body(),
        null,
        method === "DELETE",
      );
      // Following a topic zone answers with the zone as its page holds it, not the old card-zone view.
      const topic = parts[2] === "follow" && reads ? await reads.detail(user, zoneId) : null;
      return reply(topic ? { zone: topic.zone } : acted);
    }
    if (parts.length === 4 && parts[2] === "evidence") {
      if (method === "GET")
        return reply(await service.detail(user, zoneId, parts[3]));
      if (method === "PATCH")
        return reply(await service.save(user, await body(), zoneId, parts[3]));
    }
    if (
      parts.length === 5 &&
      parts[2] === "evidence" &&
      ["comments", "review"].includes(parts[4]) &&
      method === "POST"
    )
      return reply(
        await service.act(user, zoneId, parts[4], await body(), parts[3]),
      );
    if (
      parts.length === 6 &&
      parts[2] === "evidence" &&
      parts[4] === "comments" &&
      method === "DELETE"
    )
      return reply(
        await service.removeComment(user, zoneId, parts[3], parts[5]),
      );
    throw new HttpError(404, "not_found", "No such evidence route.");
  };
}
