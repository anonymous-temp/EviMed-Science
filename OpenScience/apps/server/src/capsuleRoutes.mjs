import { HttpError, readJson, sendJson } from "./security.mjs";
import { withoutSharerAccount } from "./capsuleSharerAccount.mjs";
import { CAPSULE_TRANSFER_MAX_BYTES } from "./capsuleTransferService.mjs";
import { DOCUMENT_MEMORY_LAYER } from "./derivedMemory.mjs";
import { recordShareTrial } from "./capsuleShareMetrics.mjs";
import { productId } from "./productPersistence.mjs";

/** @param {any} req @param {number} limit @param {string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "capsule_payload_invalid", "The capsule request has unsupported fields.");
  }
  return value;
}

/** @param {URL} url */
function pageOptions(url) {
  return { limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor"), deleted: url.searchParams.get("deleted") === "true" };
}

/** Typed user endpoints; no generic product document write API is exposed.
 *
 * Every action on a pack — export, revoke, import (or an upgrade in place),
 * enable, disable, a trial — writes an audit row (build spec §12; 2026-09-26
 * audit, M-6: none of them did). Counts and ids only, never an entry's text.
 *
 * Sharing inside the platform (plan §7, 2026-10-05) is five more families of route, all behind the same sign-in: a delivery to
 * named accounts and what became of it (`/:id/deliveries`), the recipient's side of one (`/deliveries/:id`), a share link and its
 * redemption (`/:id/links`, `/shared/:token`), a take-down (`/:id/exports/:snapshotId/takedown`, and the operator's
 * `/takedowns`), and the method pack in the Agent Skills format (`/:id/methods/export`). Another account's capsule, snapshot,
 * delivery or link is never readable through any of them: each reads by the signed-in account's own id.
 * @param {{ store: any, service: any, transferService?: any, maxJsonBytes: number,
 *   trials?: { mark: (userId: string, projectId: string, sessionId: string, capsuleId: string) => Promise<unknown> } | null,
 *   sharing?: import('./capsuleSharing.mjs').CapsuleSharing | null, links?: import('./capsuleShareLinks.mjs').CapsuleShareLinks | null,
 *   subscriptions?: import('./evidenceZoneSubscription.mjs').EvidenceZoneSubscriptions | null, isOperator?: (user: any) => boolean,
 *   shareEnabled?: boolean, frontier?: { allows: (user: any) => boolean } | null,
 *   audit?: (user: any, action: string, details: Record<string, unknown>) => Promise<void> }} dependencies */
export function createCapsuleRoutes({ store, service, transferService = null, maxJsonBytes, trials = null, sharing = null, links = null, subscriptions = null, isOperator = () => false, shareEnabled = false, frontier = null, audit = async () => {} }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/capsules" && !url.pathname.startsWith("/api/capsules/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "product_state_unavailable", "Research memory storage is temporarily unavailable.");
    let parts;
    try { parts = url.pathname.slice("/api/capsules".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "capsule_path_invalid", "Invalid capsule path."); }
    const method = req.method ?? "GET";
    // The sharer's account id stays inside the platform (`capsuleSharerAccount.mjs`): a recipient is told the display name.
    const reply = (value, status = 200) => { sendJson(res, status, { data: withoutSharerAccount(value) }); return true; };
    const project = async (id) => {
      if (id != null) await store.requireProject(user, id);
      return id ?? null;
    };
    // The project the researcher is in: what a model call made on their
    // behalf here (the capsule scan) is metered to.
    const current = async () => (typeof store.selectedProject === "function" ? (await store.selectedProject(req, user))?.id ?? null : null);

    if (parts.length === 0) {
      if (method === "GET") return reply(await service.list(user.id, pageOptions(url)));
      if (method === "POST") return reply(await service.create(user.id, await bodyOf(req, maxJsonBytes, ["title", "description"])), 201);
    }
    if (parts.length === 1 && parts[0] === "recall" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["query", "projectId", "limit"]);
      body.projectId = await project(body.projectId);
      return reply(await service.recall(user.id, { ...body, accountCreatedAt: user.accountCreatedAt }));
    }
    // 「收到的胶囊」: every pack someone shared, trusted whole (plan §3.3 #4).
    if (parts.length === 1 && parts[0] === "received" && method === "GET") {
      return reply(await service.received(user.id, { projectId: await current() }));
    }
    // 「我的记忆胶囊」: read as one, and made on first use.
    if (parts.length === 1 && parts[0] === "mine") {
      if (method === "GET") return reply(await service.mine(user.id));
      if (method === "POST") return reply(await service.ownCapsule(user.id, { create: true }));
    }
    if (parts.length === 1 && parts[0] === "active" && method === "GET") {
      return reply(await service.active(user.id, await project(url.searchParams.get("projectId"))));
    }
    // ------------------------------------------------------------------ sharing inside the platform
    const shares = () => {
      if (!shareEnabled) throw new HttpError(404, "capsule_share_not_enabled", "Capsule sharing is not enabled.");
      if (!sharing || !transferService) throw new HttpError(503, "product_state_unavailable", "Capsule sharing is temporarily unavailable.");
      return { sharing, transferService, links };
    };
    const shareContext = async () => ({ accountCreatedAt: user.accountCreatedAt, projectId: await current() });
    // A project's subscription to an evidence zone, a reference capsule of that one project (F18). Off, it is not a route: the
    // module's own "not enabled" answer, and nothing read.
    if (parts[0] === "subscriptions" && parts.length === 1) {
      if (!subscriptions || !subscriptions.enabled) throw new HttpError(404, "evidence_zone_subscription_not_enabled", "Evidence-zone subscription is not enabled.");
      // The frontier's own door: an account outside its audience reads the answer a path that never existed gets.
      if (!frontier || !frontier.allows(user)) throw new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
      if (method === "GET") {
        const projectId = await project(url.searchParams.get("projectId"));
        if (!projectId) throw new HttpError(400, "capsule_payload_invalid", "A subscription belongs to a project.");
        const zoneId = url.searchParams.get("zoneId");
        return reply(zoneId ? await subscriptions.status(user.id, projectId, zoneId) : await subscriptions.list(user.id, projectId));
      }
      if (method === "POST" || method === "DELETE") {
        const body = await bodyOf(req, maxJsonBytes, ["projectId", "zoneId"]);
        const projectId = await project(typeof body.projectId === "string" ? body.projectId : null);
        if (!projectId || typeof body.zoneId !== "string") throw new HttpError(400, "capsule_payload_invalid", "Name a project and a zone.");
        if (method === "POST") {
          const made = await subscriptions.subscribe(user.id, projectId, body.zoneId);
          await audit(user, "capsule.zone.subscribe", { projectId, zoneId: body.zoneId });
          return reply(made, 201);
        }
        const removed = await subscriptions.unsubscribe(user.id, projectId, body.zoneId);
        await audit(user, "capsule.zone.unsubscribe", { projectId, zoneId: body.zoneId });
        return reply(removed);
      }
      throw new HttpError(404, "not_found", "Capsule route not found.");
    }
    // The recipient's side of a delivery: pending ones, one opened (its preview), taken in, turned down.
    if (parts[0] === "deliveries") {
      const { sharing: sharedWith } = shares();
      if (parts.length === 1 && method === "GET") return reply(await sharedWith.pending(user.id));
      if (parts.length === 2 && method === "GET") return reply(await sharedWith.open(user.id, parts[1], await shareContext()));
      if (parts.length === 3 && parts[2] === "import" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["expectedDigest", "title"]);
        const imported = await sharedWith.import(user.id, parts[1], body, await shareContext());
        await audit(user, imported.payload?.transfer?.upgradedAt ? "capsule.pack.upgrade" : "capsule.pack.import",
          { capsuleId: imported.id, snapshotId: imported.payload?.transfer?.snapshotId ?? null, issuerTrust: imported.payload?.transfer?.issuerTrust ?? null, channel: "delivery" });
        return reply(imported, 201);
      }
      if (parts.length === 3 && parts[2] === "decline" && method === "POST") {
        await bodyOf(req, maxJsonBytes, []);
        const declined = await sharedWith.decline(user.id, parts[1]);
        await audit(user, "capsule.share.decline", { deliveryId: parts[1] });
        return reply(declined);
      }
      throw new HttpError(404, "not_found", "Capsule route not found.");
    }
    // A share link, redeemed by a signed-in account: its preview, and the import. The token is in the path of this request and
    // in no log line; the audit names the action and the capsule that came out of it.
    if (parts[0] === "shared" && parts.length >= 2) {
      const { sharing: sharedWith } = shares();
      if (parts.length === 2 && method === "GET") return reply(await sharedWith.openLink(user.id, parts[1], await shareContext()));
      if (parts.length === 3 && parts[2] === "import" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["expectedDigest", "title"]);
        const imported = await sharedWith.importLink(user.id, parts[1], body, await shareContext());
        await audit(user, imported.payload?.transfer?.upgradedAt ? "capsule.pack.upgrade" : "capsule.pack.import",
          { capsuleId: imported.id, snapshotId: imported.payload?.transfer?.snapshotId ?? null, issuerTrust: imported.payload?.transfer?.issuerTrust ?? null, channel: "link" });
        return reply(imported, 201);
      }
      throw new HttpError(404, "not_found", "Capsule route not found.");
    }
    // The operator takes down everything one author shared: their snapshots, every recipient's copy, every link.
    if (parts[0] === "takedowns" && parts.length === 1 && method === "POST") {
      const { sharing: sharedWith } = shares();
      if (!isOperator(user)) throw new HttpError(403, "capsule_share_operator_required", "Only an operator may take down an author's shares.");
      const body = await bodyOf(req, maxJsonBytes, ["authorId", "reason"]);
      const result = await sharedWith.takeDown({ authorId: productId(body.authorId, "author"), by: "operator", reason: typeof body.reason === "string" ? body.reason : "" });
      await audit(user, "capsule.share.takedown", { by: "operator", authorId: body.authorId, ...result });
      return reply(result);
    }
    if (parts.length >= 2 && ["deliveries", "links"].includes(parts[1]) && parts.length <= 3) {
      const { sharing: sharedWith, links: ownLinks } = shares();
      if (parts[1] === "deliveries" && parts.length === 2) {
        if (method === "POST") {
          const body = await bodyOf(req, 16 * 1024, ["recipients", "scopes", "card"]);
          const result = await sharedWith.deliver(user.id, parts[0], body, await shareContext());
          await audit(user, "capsule.share.deliver", { capsuleId: parts[0], delivered: result.delivered, notDelivered: result.notDelivered, snapshotId: result.snapshot?.id ?? null });
          return reply(result, 201);
        }
        if (method === "GET") { await transferService.assertOwnCapsule(user.id, parts[0]); return reply(await sharedWith.sent(user.id, { capsuleId: parts[0] })); }
      }
      if (parts[1] === "links" && ownLinks) {
        if (parts.length === 2 && method === "POST") {
          const body = await bodyOf(req, 16 * 1024, ["scopes", "card", "ttlDays", "maxUses"]);
          const made = await sharedWith.createLink(user.id, parts[0], body, await shareContext());
          await audit(user, "capsule.share.link.create", { capsuleId: parts[0], linkId: made.link.id, snapshotId: made.snapshot?.id ?? null });
          return reply(made, 201);
        }
        if (parts.length === 2 && method === "GET") { await transferService.assertOwnCapsule(user.id, parts[0]); return reply(await ownLinks.list(user.id, { capsuleId: parts[0] })); }
        if (parts.length === 3 && method === "DELETE") {
          await transferService.assertOwnCapsule(user.id, parts[0]);
          const revoked = await ownLinks.revoke(user.id, parts[2]);
          await audit(user, "capsule.share.link.revoke", { capsuleId: parts[0], linkId: parts[2] });
          return reply(revoked);
        }
      }
      throw new HttpError(404, "not_found", "Capsule route not found.");
    }
    // The approved learned methods as an Agent Skills pack: a zip, text only.
    if (parts.length === 3 && parts[1] === "methods" && parts[2] === "export" && method === "GET") {
      if (!shareEnabled) throw new HttpError(404, "capsule_share_not_enabled", "Capsule sharing is not enabled.");
      if (!transferService) throw new HttpError(503, "product_state_unavailable", "Capsule transfer is temporarily unavailable.");
      if (url.searchParams.get("format") !== "agent-skills") throw new HttpError(400, "capsule_payload_invalid", "Unsupported method pack format.");
      const pack = await transferService.methodPack(user.id, parts[0]);
      await audit(user, "capsule.methods.export", { capsuleId: parts[0], methods: pack.count, scripts: pack.scripts, format: "agent-skills" });
      res.writeHead(200, { "content-type": "application/zip", "cache-control": "no-store", "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${pack.filename}"` });
      res.end(Buffer.from(pack.zip));
      return true;
    }
    // The author's take-down of one snapshot: revoked, every recipient's copy disabled, and each told why.
    if (parts.length === 4 && parts[1] === "exports" && parts[3] === "takedown" && method === "POST") {
      const { sharing: sharedWith, transferService: transfers } = shares();
      const body = await bodyOf(req, 4096, ["reason"]);
      await transfers.snapshot(user.id, parts[0], parts[2]);
      const result = await sharedWith.takeDown({ authorId: user.id, snapshotId: parts[2], by: "author", reason: typeof body.reason === "string" ? body.reason : "" });
      await audit(user, "capsule.share.takedown", { by: "author", capsuleId: parts[0], snapshotId: parts[2], ...result });
      return reply(result);
    }
    if ((parts[0] === "transfers" && parts.length === 2) || parts[1] === "exports") {
      if (!transferService) throw new HttpError(503, "product_state_unavailable", "Capsule transfer is temporarily unavailable.");
      const accountContext = { accountCreatedAt: user.accountCreatedAt, projectId: await current() };
      if (parts[0] === "transfers" && method === "POST") {
        if (parts[1] === "preview") return reply(await transferService.preview(user.id,
          await bodyOf(req, CAPSULE_TRANSFER_MAX_BYTES * 2 + 4096, ["archive", "password"]), accountContext));
        if (parts[1] === "import") {
          const imported = await transferService.import(user.id,
            await bodyOf(req, CAPSULE_TRANSFER_MAX_BYTES * 2 + 4096, ["archive", "password", "expectedDigest", "confirmed", "title"]), accountContext);
          await audit(user, imported.payload?.transfer?.upgradedAt ? "capsule.pack.upgrade" : "capsule.pack.import", {
            capsuleId: imported.id, snapshotId: imported.payload?.transfer?.snapshotId ?? null, issuerTrust: imported.payload?.transfer?.issuerTrust ?? null,
            dropped: imported.payload?.scan?.dropped?.length ?? 0,
          });
          return reply(imported, 201);
        }
      }
      if (parts[1] === "exports" && parts.length === 2) {
        if (method === "GET") return reply(await transferService.history(user.id, parts[0], { cursor: url.searchParams.get("cursor") }));
        if (method === "POST") {
          const result = await transferService.export(user.id, parts[0],
            await bodyOf(req, 16 * 1024, ["password", "scopes", "supersedes", "recipients", "card"]), accountContext);
          await audit(user, "capsule.pack.export", {
            capsuleId: parts[0], snapshotId: result.snapshot?.id ?? null, entries: result.snapshot?.entryCount ?? null, scopes: result.snapshot?.scopes ?? null,
            recipients: result.snapshot?.recipientCount ?? 0, supersedes: result.snapshot?.supersedes ?? null,
          });
          return reply(result, 201);
        }
      }
      // 「对方会看到什么」: the pack as its recipient would read it, before a
      // password is chosen — and, for an account with nothing to share yet,
      // that state rather than a refused export.
      if (parts[1] === "exports" && parts.length === 3 && parts[2] === "preview" && method === "POST") {
        return reply(await transferService.exportPreview(user.id, parts[0], await bodyOf(req, 16 * 1024, ["scopes", "supersedes", "card"])));
      }
      if (parts[1] === "exports" && parts.length === 3) {
        if (method === "DELETE") {
          const body = await bodyOf(req, 4096, ["expectedRevision"]);
          const revoked = await transferService.revoke(user.id, parts[0], parts[2], body.expectedRevision);
          // A delivery or a link of the snapshot ends with it, and the recipients who had not taken it in are told it was withdrawn.
          if (sharing) await sharing.afterRevoke(user.id, parts[2]).catch(() => null);
          await audit(user, "capsule.pack.revoke", { capsuleId: parts[0], snapshotId: parts[2] });
          return reply(revoked);
        }
        if (method === "GET") {
          const result = await transferService.download(user.id, parts[0], parts[2]);
          res.writeHead(200, { "content-type": "application/vnd.evimed.capsule+json", "cache-control": "no-store",
            "x-content-type-options": "nosniff", "content-disposition": `attachment; filename="${result.filename}"` });
          res.end(result.archive); return true;
        }
      }
      throw new HttpError(404, "not_found", "Capsule transfer route not found.");
    }
    const [capsuleId, action, entryId, entryAction] = parts;
    if (parts.length === 1) {
      if (method === "GET") return reply(await service.get(user.id, capsuleId));
      if (method === "PATCH") return reply(await service.update(user.id, capsuleId,
        await bodyOf(req, maxJsonBytes, ["title", "description", "expectedRevision"])));
      if (method === "DELETE") {
        const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
        return reply(await service.remove(user.id, capsuleId, body.expectedRevision));
      }
    }
    if (parts.length === 2 && action === "activate" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["mode", "projectId"]);
      body.projectId = await project(body.projectId);
      return reply(await service.activate(user.id, capsuleId, body));
    }
    // A received pack: one click in force, one click out, or tried once in a
    // conversation of its own that writes nothing into the researcher's memory.
    // Every project, or with `projectId` that one project only (build spec
    // §9.4 #6); a project the account cannot open is refused by name.
    if (parts.length === 2 && action === "enable" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["projectId"]);
      if (body.projectId !== undefined && (typeof body.projectId !== "string" || !body.projectId)) {
        throw new HttpError(400, "capsule_payload_invalid", "Invalid project.");
      }
      const onlyProject = body.projectId !== undefined ? await project(body.projectId) : null;
      const enabled = await service.enableReceived(user.id, capsuleId, onlyProject
        ? { projectId: onlyProject, onlyProject: true } : { projectId: await current() });
      await audit(user, "capsule.pack.enable", { capsuleId, ...(onlyProject ? { projectId: onlyProject } : {}) });
      return reply(enabled);
    }
    if (parts.length === 2 && action === "disable" && method === "POST") {
      await bodyOf(req, maxJsonBytes, []);
      const disabled = await service.disable(user.id, capsuleId);
      await audit(user, "capsule.pack.disable", { capsuleId });
      return reply(disabled);
    }
    if (parts.length === 2 && action === "trial" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["sessionId"]);
      const projectId = await current();
      if (!trials || !projectId) throw new HttpError(503, "capsule_trial_unavailable", "Trying a capsule needs the research memory store and a project.");
      if (typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(body.sessionId)) {
        throw new HttpError(400, "capsule_payload_invalid", "Invalid session id.");
      }
      const pack = await service.prepareTrial(user.id, capsuleId, { projectId });
      await trials.mark(user.id, projectId, body.sessionId, capsuleId);
      recordShareTrial(String(pack?.payload?.transfer?.channel ?? "file"));
      await audit(user, "capsule.pack.trial", { capsuleId, projectId, sessionId: body.sessionId });
      return reply({ capsuleId, sessionId: body.sessionId });
    }
    if (parts.length === 2 && action === "restore" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
      return reply(await service.restore(user.id, capsuleId, body.expectedRevision));
    }
    if (parts.length === 2 && action === "history" && method === "GET") {
      await service.get(user.id, capsuleId);
      return reply(await service.documents.history(user.id, "capsule", capsuleId, {
        limit: Number(url.searchParams.get("limit") ?? 50),
        beforeRevision: url.searchParams.has("beforeRevision") ? Number(url.searchParams.get("beforeRevision")) : null,
      }));
    }
    if (action === "entries" && parts.length === 2) {
      if (method === "GET") return reply(await service.entries(user.id, capsuleId, pageOptions(url)));
      if (method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["factKind", "layer", "content"]);
        // Only a document's publication writes the document layer: an entry in
        // it is recalled in its document's project alone and never listed.
        if (body.layer === DOCUMENT_MEMORY_LAYER) throw new HttpError(400, "capsule_payload_invalid", "Invalid layer.");
        return reply(await service.addEntry(user.id, capsuleId, { ...body, origin: "explicit", provenance: [{ type: "user", id: user.id }] }), 201);
      }
    }
    if (action === "entries" && parts.length === 3 && method === "PATCH") {
      return reply(await service.updateEntry(user.id, capsuleId, entryId,
        await bodyOf(req, maxJsonBytes, ["content", "status", "expectedRevision"])));
    }
    // One click takes back the last change to an entry (owner ruling
    // 2026-09-19): nothing asks first, so everything can be undone.
    if (action === "entries" && parts.length === 4 && entryAction === "undo" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
      return reply(await service.undoEntry(user.id, capsuleId, entryId, { expectedRevision: body.expectedRevision }));
    }
    if (action === "entries" && parts.length === 4 && entryAction === "history" && method === "GET") {
      await service.get(user.id, capsuleId);
      const entry = await service.documents.get(user.id, "fact", entryId);
      if (!entry || entry.payload.capsuleId !== capsuleId) throw new HttpError(404, "capsule_entry_not_found", "The capsule entry is unavailable.");
      return reply(await service.documents.history(user.id, "fact", entryId, {
        limit: Number(url.searchParams.get("limit") ?? 50),
        beforeRevision: url.searchParams.has("beforeRevision") ? Number(url.searchParams.get("beforeRevision")) : null,
      }));
    }
    throw new HttpError(404, "not_found", "Capsule route not found.");
  };
}
