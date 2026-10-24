import { randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { productId } from "./productPersistence.mjs";
import { migrateCapsuleShare } from "./capsuleShareLinks.mjs";
import { reachableAccounts } from "./capsuleRecipients.mjs";
import { senderDisplayName } from "./capsuleShareLabel.mjs";
import { recordShareDeclined, recordShareRefused, recordShared, recordTakedown } from "./capsuleShareMetrics.mjs";

/**
 * Handing a capsule to other accounts of this deployment, in the app (evidence-flywheel plan §7, F17a, 2026-10-05): a delivery to
 * named accounts, a share link, and taking either back.
 *
 * Hidden knowledge:
 *
 * - **The recipient never handles a file.** A delivery is sealed for the recipient's own key by the export that already existed
 *   (`capsuleTransferService.mjs`, named recipients), and the archive stays where the author's snapshot is; the recipient's page
 *   asks this class for the preview and the import and this class reads the archive on their behalf. A link's snapshot is sealed
 *   with a password the platform chose (`capsuleShareLinks.mjs`) and handed over the same way.
 * - **A name is not a directory.** A recipient is named by an exact account id or an exact display name, and the answer to a
 *   delivery is how many were delivered and how many were not, in the same words whatever the reason: an unknown name, a name
 *   two accounts share, an account that cannot sign in, the sender's own. Nothing here lists, completes or counts accounts.
 * - **The sender sees what happened to their own deliveries, per recipient**: delivered, opened, imported, declined, withdrawn.
 *   They already know the names they typed; no account id is shown to anyone.
 * - **The inbox says it once.** One `share` notice per delivery, idempotent by the delivery; a withdrawal and a take-down are
 *   their own notices, each saying in one sentence what happened and why. A notice that cannot be written never fails the
 *   delivery it announces: the page still has the delivery.
 * - **A take-down is a revocation that reaches the copies.** The author's revoke stops further imports and says so; a take-down
 *   (the author's of one snapshot, or the operator's of everything an author shared) also disables every recipient's copy.
 *
 * @module capsuleSharing
 */

const REF_LIMIT = 32;
const DAY_MS = 86_400_000;

/** @param {unknown} value @param {number} max */
const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
};

/** @param {any} row */
function deliveryView(row) {
  return {
    id: row.id, snapshotId: row.snapshot_id, capsuleId: row.capsule_id, state: row.state,
    createdAt: new Date(row.created_at).toISOString(),
    openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    importedAt: row.imported_at ? new Date(row.imported_at).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  };
}

/**
 * The sender as a recipient is told of them: the name the share was signed with (署名: its snapshot's card author, 2026-10-10
 * review C4c) or, for a share signed with none, the account's display name — in either case never the login id and never an
 * e-mail address (`senderDisplayName`). Read from the rows each time, so it holds for a delivery made before the rules as well as
 * after them (review M-9: the display name defaults to the login id, and an external identity's was its address).
 * @param {{ sender_name?: unknown, owner_id?: unknown, signed_as?: unknown, card?: { author?: unknown } | null }} row
 */
function senderOf(row) {
  const signed = typeof row.signed_as === "string" ? row.signed_as : row.card?.author;
  return { name: senderDisplayName(typeof signed === "string" && signed.trim() ? signed : row.sender_name, row.owner_id) };
}

/** What a delivery's snapshot was signed with: the author of its card. Spliced into the queries that name a delivery's sender. */
const SIGNED_AS = "(SELECT s.payload->'card'->>'author' FROM evimed_product.documents s WHERE s.user_id=d.owner_id AND s.kind='preferences' AND s.id=d.snapshot_id)";

export class CapsuleSharing {
  /**
   * @param {{ database: any, transfers: import('./capsuleTransferService.mjs').CapsuleTransferService, links: import('./capsuleShareLinks.mjs').CapsuleShareLinks,
   *   notifications?: import('./notificationService.mjs').NotificationService | null, perDay?: number, now?: () => number, report?: (code: string) => void }} options
   */
  constructor({ database, transfers, links, notifications = null, perDay = 50, now = Date.now, report = () => {} }) {
    this.database = database; this.transfers = transfers; this.links = links; this.notifications = notifications;
    this.perDay = perDay; this.now = now; this.report = report;
  }

  /**
   * The accounts a list of names reaches: each an exact id, or an exact display name that exactly one account that can sign in
   * has. Anything else is silently not reachable — the caller answers every such case alike.
   * @param {string} senderId @param {readonly string[]} refs
   * @returns {Promise<string[]>}
   */
  async #reach(senderId, refs) {
    return reachableAccounts(this.database, senderId, refs);
  }

  /**
   * Deliver a pack to named accounts of this deployment: it is exported sealed for their keys, each gets one inbox notice, and the
   * sender gets the count — never a reason, never a name back. With nobody reachable nothing is exported at all.
   * @param {string} userId @param {string} capsuleId
   * @param {{ recipients?: unknown, scopes?: unknown, card?: unknown, excludeEntryIds?: unknown }} input
   * @param {{ accountCreatedAt?: string | null, projectId?: string | null }} [context]
   * @returns {Promise<{ delivered: number, notDelivered: number, snapshot: any | null }>}
   */
  async deliver(userId, capsuleId, input, context = {}) {
    const allowed = ["recipients", "scopes", "card", "excludeEntryIds"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
      throw new HttpError(400, "capsule_payload_invalid", "The delivery has unsupported fields.");
    }
    const asked = input.recipients;
    if (!Array.isArray(asked) || asked.length === 0 || asked.length > REF_LIMIT || asked.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 200)) {
      throw new HttpError(400, "capsule_payload_invalid", "Name between one and thirty-two recipients.");
    }
    await migrateCapsuleShare(this.database);
    const refs = [...new Set(asked.map((ref) => String(ref).trim()))];
    // Own capsule first: a delivery of somebody else's pack is refused the same way an export of it is, whoever it is for.
    await this.transfers.assertOwnCapsule(userId, capsuleId);
    const recipients = await this.#reach(userId, refs);
    if (recipients.length === 0) return { delivered: 0, notDelivered: refs.length, snapshot: null };
    const since = new Date(this.now() - DAY_MS).toISOString();
    const sent = Number((await this.database.query("SELECT count(*)::integer AS n FROM evimed_share.deliveries WHERE owner_id=$1 AND created_at>$2::timestamptz", [userId, since])).rows[0].n);
    if (sent + recipients.length > this.perDay) {
      recordShareRefused("rate_limited");
      throw new HttpError(429, "capsule_share_rate_limited", "Too many deliveries today.");
    }
    // A newer snapshot of what some of them already took in is that pack's next version: they upgrade in place and read the
    // changelog, instead of holding a second capsule beside the first.
    const supersedes = await this.#previousSnapshot(userId, capsuleId, recipients);
    const result = await this.transfers.export(userId, capsuleId, { scopes: input.scopes, card: input.card, recipients, excludeEntryIds: input.excludeEntryIds,
      ...(supersedes ? { supersedes } : {}) }, { ...context, channel: "delivery" });
    const snapshot = result.snapshot;
    /** @type {string[]} */
    const delivered = [];
    for (const recipient of recipients) {
      const id = `dlv_${randomUUID().replaceAll("-", "")}`;
      const inserted = await this.database.query(`INSERT INTO evimed_share.deliveries(id,snapshot_id,owner_id,recipient_id,capsule_id,manifest_sha256,archive_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(snapshot_id,recipient_id) DO NOTHING RETURNING id`,
      [id, snapshot.id, userId, recipient, capsuleId, snapshot.manifestSha256, snapshot.archiveSha256]);
      if (!inserted.rowCount) continue;
      delivered.push(recipient);
      recordShared("delivery");
      await this.#announce(recipient, id, snapshot);
    }
    return { delivered: delivered.length, notDelivered: refs.length - delivered.length, snapshot };
  }

  /**
   * The snapshot a new one of this capsule continues: the newest the people it goes to have taken in — those named (`recipients`),
   * or anybody, for a link, whose redeemers are not known beforehand — whether it reached them in a delivery or through a link.
   * Only a snapshot somebody holds can be upgraded in place; one nobody took in is just an earlier export, and chaining to it would
   * leave the holder of an older version with a second capsule. Nor one that was taken down: its copies were disabled and marked, an
   * upgrade in place would keep them so and the new version would never be in force, so what replaces a taken-down version is a
   * pack of its own. Null when there is none, and the new snapshot starts a chain.
   * @param {string} userId @param {string} capsuleId @param {readonly string[] | null} recipients
   * @returns {Promise<string | null>}
   */
  async #previousSnapshot(userId, capsuleId, recipients) {
    const row = (await this.database.query(`SELECT taken.snapshot_id FROM (
        SELECT d.snapshot_id, d.created_at AS at FROM evimed_share.deliveries d
          WHERE d.owner_id=$1 AND d.capsule_id=$2 AND d.state='imported' AND ($3::text[] IS NULL OR d.recipient_id=ANY($3::text[]))
        UNION ALL
        SELECT l.snapshot_id, l.created_at AS at FROM evimed_share.links l JOIN evimed_share.link_uses u ON u.link_id=l.id
          WHERE l.owner_id=$1 AND l.capsule_id=$2 AND u.imported_at IS NOT NULL AND ($3::text[] IS NULL OR u.user_id=ANY($3::text[]))
      ) taken JOIN evimed_product.documents s ON s.user_id=$1 AND s.kind='preferences' AND s.id=taken.snapshot_id
        AND s.deleted_at IS NULL AND s.payload->'takenDown' IS NULL
      ORDER BY taken.at DESC LIMIT 1`, [userId, capsuleId, recipients ? [...recipients] : null])).rows[0];
    if (!row) return null;
    try { await this.transfers.snapshot(userId, capsuleId, row.snapshot_id); return String(row.snapshot_id); }
    catch (error) { if (/** @type {any} */ (error)?.code === "capsule_snapshot_not_found") return null; throw error; }
  }

  /** The `share` notice of one delivery. Never fails the delivery. @param {string} recipient @param {string} deliveryId @param {any} snapshot */
  async #announce(recipient, deliveryId, snapshot) {
    if (!this.notifications) return;
    const card = snapshot.card ?? {};
    const sender = clip(card.author, 60) || "有人";
    try {
      const notice = await this.notifications.create(recipient, {
        noticeType: "notify", severity: "info", idempotencyKey: `share-delivery:${deliveryId}`,
        title: clip(`${sender} 向你分享了一套工作方式`, 150),
        body: [clip(card.title, 150), clip(card.summary, 500), "点开可以先预览，再试用一次，满意再收下；不需要可以拒收。"].filter(Boolean).join("\n"),
        actions: [{ id: "open", label: "查看并试用", style: "primary" }],
        source: { type: "share", id: `delivery/${deliveryId}` },
      });
      await this.database.query("UPDATE evimed_share.deliveries SET notice_id=$2 WHERE id=$1", [deliveryId, notice.id]);
    } catch { this.report("share_notice_failed"); }
  }

  /**
   * The deliveries an account has not yet answered — delivered or opened — with who sent them and the pack's card, newest first:
   * the shelf's 「待收下的分享」, for a recipient who did not come through the inbox.
   * @param {string} userId
   */
  async pending(userId) {
    await migrateCapsuleShare(this.database);
    const rows = (await this.database.query(`SELECT d.*, u.name AS sender_name,
        (SELECT s.payload->'card' FROM evimed_product.documents s WHERE s.user_id=d.owner_id AND s.kind='preferences' AND s.id=d.snapshot_id) AS card
      FROM evimed_share.deliveries d JOIN evimed_control.users u ON u.id=d.owner_id
      WHERE d.recipient_id=$1 AND d.state IN ('delivered','opened') ORDER BY d.created_at DESC, d.id LIMIT 50`, [productId(userId, "user")])).rows;
    return rows.map((row) => ({ ...deliveryView(row), sender: senderOf(row), card: row.card ?? null }));
  }

  /**
   * One delivery as its recipient may read it — its sender's display name and the pack's card — and, the first time, the moment it
   * was opened. Another account's delivery is not found; so is one that does not exist.
   * @param {string} userId @param {string} deliveryId
   */
  async #mine(userId, deliveryId) {
    await migrateCapsuleShare(this.database);
    const row = (await this.database.query(`SELECT d.*, u.name AS sender_name, ${SIGNED_AS} AS signed_as FROM evimed_share.deliveries d JOIN evimed_control.users u ON u.id=d.owner_id
      WHERE d.id=$1 AND d.recipient_id=$2`, [productId(deliveryId, "delivery"), userId])).rows[0];
    if (!row) throw new HttpError(404, "capsule_share_not_found", "The share is unavailable.");
    return row;
  }

  /**
   * Open a delivery: the preview of its pack (card, entries, what the automatic scan would drop), read on the recipient's behalf.
   * A closed delivery — declined, withdrawn, taken down — still says so, and shows nothing of the pack.
   * @param {string} userId @param {string} deliveryId @param {{ accountCreatedAt?: string | null, projectId?: string | null }} [context]
   */
  async open(userId, deliveryId, context = {}) {
    let row = await this.#mine(userId, deliveryId);
    const view = () => ({ ...deliveryView(row), sender: senderOf(row) });
    if (["withdrawn", "taken_down", "declined"].includes(row.state)) return { delivery: view(), preview: null };
    if (row.state === "delivered") {
      const opened = (await this.database.query("UPDATE evimed_share.deliveries SET state='opened', opened_at=clock_timestamp() WHERE id=$1 AND state='delivered' RETURNING *", [row.id])).rows[0];
      if (opened) row = { ...opened, sender_name: row.sender_name, signed_as: row.signed_as };
    }
    let preview = null;
    try {
      const { archive } = await this.transfers.snapshotArchive(row.owner_id, row.snapshot_id);
      preview = await this.transfers.preview(userId, { archive }, context);
    } catch (error) {
      // The snapshot was revoked under it: the delivery is closed as withdrawn rather than left looking open.
      if (/** @type {any} */ (error)?.code !== "capsule_snapshot_revoked") throw error;
      await this.database.query("UPDATE evimed_share.deliveries SET state='withdrawn', closed_at=clock_timestamp() WHERE id=$1 AND state IN ('delivered','opened')", [row.id]);
      row = { ...row, state: "withdrawn" };
    }
    return { delivery: view(), preview };
  }

  /**
   * Take the pack in: the import that has always existed, with the archive resolved here. What the recipient previewed is what
   * they get (`expectedDigest`), the automatic scan runs before anything is written, and nothing is enabled by importing.
   * @param {string} userId @param {string} deliveryId @param {{ expectedDigest?: unknown, title?: unknown }} input
   * @param {{ accountCreatedAt?: string | null, projectId?: string | null }} [context]
   */
  async import(userId, deliveryId, input, context = {}) {
    const row = await this.#mine(userId, deliveryId);
    if (!["delivered", "opened", "imported"].includes(row.state)) throw new HttpError(409, "capsule_share_delivery_closed", "This delivery is closed.");
    const { archive } = await this.transfers.snapshotArchive(row.owner_id, row.snapshot_id);
    const imported = await this.transfers.import(userId, { archive, expectedDigest: input.expectedDigest, confirmed: true,
      ...(input.title !== undefined ? { title: input.title } : {}) }, { ...context, channel: "delivery" });
    await this.database.query("UPDATE evimed_share.deliveries SET state='imported', imported_at=COALESCE(imported_at,clock_timestamp()) WHERE id=$1 AND state IN ('delivered','opened','imported')", [row.id]);
    return imported;
  }

  /** A recipient turns a delivery down; the sender sees it. @param {string} userId @param {string} deliveryId */
  async decline(userId, deliveryId) {
    const row = await this.#mine(userId, deliveryId);
    if (row.state === "declined") return { ...deliveryView(row), sender: senderOf(row) };
    if (!["delivered", "opened"].includes(row.state)) throw new HttpError(409, "capsule_share_delivery_closed", "This delivery is closed.");
    const updated = (await this.database.query(
      "UPDATE evimed_share.deliveries SET state='declined', closed_at=clock_timestamp() WHERE id=$1 AND state IN ('delivered','opened') RETURNING *", [row.id])).rows[0];
    if (updated) recordShareDeclined();
    if (this.notifications && row.notice_id) {
      try { const notice = await this.notifications.get(userId, row.notice_id); await this.notifications.markRead(userId, notice.id, notice.revision); } catch { /* the notice is only a pointer */ }
    }
    return { ...deliveryView(updated ?? row), sender: senderOf(row) };
  }

  /**
   * What happened to the deliveries an account made, per recipient, newest first.
   * @param {string} userId @param {{ capsuleId?: string | null, snapshotId?: string | null }} [filter]
   */
  async sent(userId, { capsuleId = null, snapshotId = null } = {}) {
    await migrateCapsuleShare(this.database);
    const rows = (await this.database.query(`SELECT d.*, u.name AS recipient_name FROM evimed_share.deliveries d JOIN evimed_control.users u ON u.id=d.recipient_id
      WHERE d.owner_id=$1 AND ($2::text IS NULL OR d.capsule_id=$2) AND ($3::text IS NULL OR d.snapshot_id=$3) ORDER BY d.created_at DESC, d.id LIMIT 200`,
    [productId(userId, "user"), capsuleId, snapshotId])).rows;
    return rows.map((row) => ({ ...deliveryView(row), recipient: { name: row.recipient_name } }));
  }

  // ------------------------------------------------------------------ links

  /**
   * A share link for a new snapshot of the author's own capsule, sealed under a password only the platform holds. The token is in
   * this answer and nowhere else.
   * @param {string} userId @param {string} capsuleId @param {{ scopes?: unknown, card?: unknown, ttlDays?: number, maxUses?: number, excludeEntryIds?: unknown }} input
   * @param {{ accountCreatedAt?: string | null, projectId?: string | null }} [context]
   */
  async createLink(userId, capsuleId, input, context = {}) {
    const allowed = ["scopes", "card", "ttlDays", "maxUses", "excludeEntryIds"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
      throw new HttpError(400, "capsule_payload_invalid", "The link request has unsupported fields.");
    }
    await migrateCapsuleShare(this.database);
    const secret = randomBytes(24).toString("base64url");
    // Whoever opens a link is not known yet: it continues the newest snapshot anybody took in.
    const supersedes = await this.#previousSnapshot(userId, capsuleId, null);
    const result = await this.transfers.export(userId, capsuleId, { password: secret, scopes: input.scopes, card: input.card, excludeEntryIds: input.excludeEntryIds,
      ...(supersedes ? { supersedes } : {}) }, { ...context, channel: "link" });
    const made = await this.links.create(userId, {
      capsuleId, snapshotId: result.snapshot.id, manifestSha256: result.snapshot.manifestSha256, archiveSha256: result.snapshot.archiveSha256, secret,
    }, { ttlDays: input.ttlDays, maxUses: input.maxUses });
    return { ...made, snapshot: result.snapshot };
  }

  /**
   * Redeem a token: the preview of the pack behind it, for a signed-in account. A use is counted the first time an account looks.
   * Nothing here names the owner's account; the card carries the display name.
   * @param {string} userId @param {string} token @param {{ accountCreatedAt?: string | null, projectId?: string | null }} [context]
   */
  async openLink(userId, token, context = {}) {
    const redeemed = await this.links.redeem(userId, token);
    const preview = await this.#linkPreview(userId, redeemed, context);
    return { preview, link: { expiresAt: redeemed.link.expiresAt, usesLeft: Math.max(0, redeemed.link.maxUses - redeemed.link.uses) } };
  }

  /** @param {string} userId @param {Awaited<ReturnType<CapsuleShareLinks['redeem']>>} redeemed @param {any} context */
  async #linkPreview(userId, redeemed, context) {
    const { archive } = await this.#linkArchive(redeemed);
    return this.transfers.preview(userId, { archive, password: redeemed.secret }, context);
  }

  /** @param {Awaited<ReturnType<CapsuleShareLinks['redeem']>>} redeemed */
  async #linkArchive(redeemed) {
    try { return await this.transfers.snapshotArchive(redeemed.link.ownerId, redeemed.link.snapshotId); }
    catch (error) {
      if (/** @type {any} */ (error)?.code === "capsule_snapshot_revoked") {
        recordShareRefused("link_revoked");
        throw new HttpError(410, "capsule_share_link_revoked", "This share link can no longer be used.");
      }
      throw error;
    }
  }

  /**
   * @param {string} userId @param {string} token @param {{ expectedDigest?: unknown, title?: unknown }} input
   * @param {{ accountCreatedAt?: string | null, projectId?: string | null }} [context]
   */
  async importLink(userId, token, input, context = {}) {
    const redeemed = await this.links.redeem(userId, token);
    const { archive } = await this.#linkArchive(redeemed);
    const imported = await this.transfers.import(userId, { archive, password: redeemed.secret, expectedDigest: input.expectedDigest, confirmed: true,
      ...(input.title !== undefined ? { title: input.title } : {}) }, { ...context, channel: "link" });
    await this.links.markImported(userId, redeemed.link.id);
    return imported;
  }

  // ------------------------------------------------- withdrawing and taking down

  /**
   * The author revoked a snapshot: its links end with it, its open deliveries are withdrawn, and each recipient is told so — the
   * notice says withdrawn, the one thing the revoke does that a copy already taken in does not undo.
   * @param {string} userId @param {string} snapshotId
   */
  async afterRevoke(userId, snapshotId) {
    await migrateCapsuleShare(this.database);
    await this.links.revokeForSnapshots(userId, [snapshotId]);
    const rows = (await this.database.query(`UPDATE evimed_share.deliveries SET state='withdrawn', closed_at=clock_timestamp()
      WHERE owner_id=$1 AND snapshot_id=$2 AND state IN ('delivered','opened') RETURNING *`, [userId, snapshotId])).rows;
    for (const row of rows) await this.#tellWithdrawn(row);
    return { withdrawn: rows.length };
  }

  /**
   * A take-down: the author's of one snapshot, or the operator's of everything an author shared. The snapshots are revoked, each
   * recipient's copy is disabled with the reason on it, and every recipient of a pack that was never taken in is told it was
   * withdrawn. The reason is a sentence the actor wrote; without one the notice says who took it down.
   * @param {{ authorId: string, snapshotId?: string | null, by: "author" | "operator", reason?: string }} input
   */
  async takeDown({ authorId, snapshotId = null, by, reason = "" }) {
    await migrateCapsuleShare(this.database);
    const result = await this.transfers.takeDown({ authorId, snapshotId, by, reason });
    await this.links.revokeForSnapshots(authorId, result.snapshots);
    const why = clip(reason, 120) || (by === "operator" ? "平台发现其中的内容不适合继续分享" : "作者不再分享它");
    const who = by === "operator" ? "平台" : "作者";
    for (const copy of result.copies) {
      await this.#notify(copy.userId, `takedown/${copy.capsuleId}`, `share-takedown:${copy.capsuleId}`,
        clip(`「${copy.title}」已被${who}下架并停用`, 150), `${clip(`「${copy.title}」已被${who}下架并停用：${why}。`, 400)}你自己的记忆和对话没有受影响。`);
    }
    const open = result.snapshots.length
      ? (await this.database.query(`UPDATE evimed_share.deliveries SET state='taken_down', closed_at=clock_timestamp()
        WHERE owner_id=$1 AND snapshot_id=ANY($2::text[]) AND state IN ('delivered','opened') RETURNING *`, [authorId, result.snapshots])).rows
      : [];
    for (const row of open) {
      await this.#notify(row.recipient_id, `takedown/${row.id}`, `share-takedown:${row.id}`,
        clip(`一份分享已被${who}下架`, 150), `${clip(`发给你的一份分享已被${who}下架：${why}。`, 400)}它不能再收下。`);
    }
    recordTakedown(by, result.copies.length);
    return { snapshots: result.snapshots.length, copies: result.copies.length, withdrawn: open.length };
  }

  /** @param {string} recipient @param {string} sourceId @param {string} key @param {string} title @param {string} body */
  async #notify(recipient, sourceId, key, title, body) {
    if (!this.notifications) return;
    try {
      await this.notifications.create(recipient, { noticeType: "notify", severity: "info", idempotencyKey: key, title, body,
        actions: [{ id: "open", label: "查看", style: "neutral" }], source: { type: "share", id: sourceId } });
    } catch { this.report("share_notice_failed"); }
  }

  /** The withdrawal notice of one delivery: said once, as withdrawn, to a recipient who has not taken the pack in. @param {any} delivery */
  async #tellWithdrawn(delivery) {
    // The name the share was signed with, as the recipient has always known the sender by; else the account's display name.
    const found = (await this.database.query(`SELECT u.name, (SELECT s.payload->'card'->>'author' FROM evimed_product.documents s
      WHERE s.user_id=u.id AND s.kind='preferences' AND s.id=$2) AS signed_as FROM evimed_control.users u WHERE u.id=$1`, [delivery.owner_id, delivery.snapshot_id])).rows[0];
    const signed = String(found?.signed_as ?? "").trim();
    const named = signed || String(found?.name ?? "").trim();
    const sender = named ? senderDisplayName(named, delivery.owner_id) : "";
    await this.#notify(delivery.recipient_id, `withdrawn/${delivery.id}`, `share-withdrawn:${delivery.id}`,
      clip(`${sender || "分享的人"}撤回了发给你的一份分享`, 150), "这份分享已被撤回，不能再收下。已经收下的副本不受影响。");
  }
}

/** @typedef {import('./capsuleShareLinks.mjs').CapsuleShareLinks} CapsuleShareLinks */
