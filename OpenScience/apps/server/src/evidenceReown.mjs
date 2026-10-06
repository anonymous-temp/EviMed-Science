import assert from "node:assert/strict";
import { PLATFORM_ACCOUNT_AUTH_TYPE, PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { evidenceHash } from "./evidenceCardContent.mjs";
import { EvidenceZoneService } from "./evidenceZoneService.mjs";

/**
 * Official zones are the platform publisher's, never a person's (evidence-flywheel plan §3.3, B2).
 *
 * An earlier release imported the platform's own evidence zones under an operator's account, as ordinary user zones. Until such a zone
 * is moved to the publisher account and marked `kind = 'official'`, its AI upkeep is booked to that operator's wallet
 * (`isOfficialZone` reads the kind and the owner), it is refused by the writers that only reach official zones, and deleting the
 * operator deletes the platform's published evidence (the ownership columns cascade). Two callers move them, through the one function
 * here: the import script (`scripts/ops/import-evidence-content.mjs --reown-from`, which names the zones by the request identities of
 * its seed) and the control plane itself at start (`reownOperatorImportedZones`, which finds them by what they hold), so a database that
 * comes from release 6 needs no manual step.
 *
 * @module evidenceReown
 */

const check = (/** @type {unknown} */ condition, /** @type {string} */ message) => assert(condition, message);
const request = (/** @type {unknown} */ value) => { check(typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value), "Invalid stable request identity."); return /** @type {string} */ (value); };

/** The id a card or zone gets from its owner and request identity (`ez_…`, `ec_…`). @param {string} prefix @param {string} owner @param {string} requestId */
export const stableId = (prefix, owner, requestId) => `${prefix}_${evidenceHash(`${owner}:${requestId}`).slice(0, 32)}`;

/**
 * Where an earlier import put a seed row: the id its owner and request identity derive (`stableId`). The zone and
 * card ids derive from the owner that created them, so rows an operator account created keep that account's
 * derivation after they are moved to the publisher (their ids are in people's links and follows and are never
 * rewritten); a later import must still find them, which the operator that created them names in `fromOwners`.
 * @param {string} prefix @param {string} requestId @param {string[]} owners publisher first
 */
export const candidateIds = (prefix, requestId, owners) => [...new Set(owners.map((owner) => stableId(prefix, owner, requestId)))];

/** The columns the platform's official marking adds (`evidence_zones.kind`) exist in this build's database. @param {any} db */
export const hasKindColumn = async (db) => (await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema='evimed_frontier' AND table_name='evidence_zones' AND column_name='kind'")).rowCount > 0;

/**
 * Move the official zones an earlier import created under an operator account to the platform publisher account, and mark them
 * `kind = 'official'`. The zones and cards reference their owner with ON DELETE CASCADE, so until this ran, deleting that operator
 * deleted the platform's published evidence.
 *
 * Moves the owner column of each zone's row — found by the id its earlier owner derived from a seed request identity, or named
 * directly in `zoneIds` — and of all its cards, and nothing else: cards, revisions, automation, follows, comments, reviews and feedback
 * are keyed by the rows' own ids and stay exactly as they were. Ids are not rewritten, so every link and follow keeps working. One
 * transaction; idempotent (a zone already owned by the publisher is left, and only its marking is made good).
 *
 * @param {any} database a `ControlPlaneDatabase`
 * @param {{ zoneRequestIds?: string[], zoneIds?: string[], fromOwners: string[], publisherId?: string }} input
 * @returns {Promise<{ zonesMoved: number, cardsMoved: number, zonesMarked: number, zonesFound: number }>}
 */
export async function reownImportedZones(database, { zoneRequestIds = [], zoneIds = [], fromOwners, publisherId = PLATFORM_PUBLISHER_USER_ID }) {
  check(Array.isArray(zoneRequestIds) && Array.isArray(zoneIds) && (zoneRequestIds.length || zoneIds.length) && Array.isArray(fromOwners) && fromOwners.length,
    "Re-owning needs the seed zones and the account that imported them.");
  await database.migrate();
  const publisher = (await database.query("SELECT id,auth_type FROM evimed_control.users WHERE id=$1", [publisherId])).rows[0];
  check(publisher?.auth_type === PLATFORM_ACCOUNT_AUTH_TYPE, "The platform publisher account does not exist; start the control plane once so its migration runs.");
  const service = new EvidenceZoneService({ database }); await service.ready();
  const ids = [...new Set([...zoneRequestIds.flatMap((requestId) => candidateIds("ez", request(requestId), fromOwners)), ...zoneIds])];
  const kind = await hasKindColumn(database);
  return database.transaction(async (/** @type {any} */ client) => {
    const found = (await client.query("SELECT id,user_id FROM evimed_frontier.evidence_zones WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [ids])).rows;
    const toMove = found.filter((/** @type {any} */ zone) => zone.user_id !== publisherId).map((/** @type {any} */ zone) => zone.id);
    const zones = toMove.length ? (await client.query("UPDATE evimed_frontier.evidence_zones SET user_id=$2 WHERE id=ANY($1::text[])", [toMove, publisherId])).rowCount : 0;
    const cards = toMove.length ? (await client.query("UPDATE evimed_frontier.evidence_cards SET user_id=$2 WHERE zone_id=ANY($1::text[]) AND user_id<>$2", [toMove, publisherId])).rowCount : 0;
    const marked = kind && found.length ? (await client.query("UPDATE evimed_frontier.evidence_zones SET kind='official' WHERE id=ANY($1::text[]) AND kind IS DISTINCT FROM 'official'", [found.map((/** @type {any} */ zone) => zone.id)])).rowCount : 0;
    // Readers' lists are cached against this version.
    if (toMove.length || marked) await service.bump(client);
    return { zonesFound: found.length, zonesMoved: zones, cardsMoved: cards, zonesMarked: marked };
  });
}

/**
 * At start: the zones an operator's account still holds that hold at least one card written with origin `import` (the receipt an import
 * leaves on a card it reviewed, `editorial.reviewOrigin`) are the platform's official zones in the operator's name — moved to the
 * publisher once, by `reownImportedZones`. Idempotent: a second start finds none. Needs only the operators the deployment configures
 * (`config.operatorUsers`), so a zone an ordinary account made is never touched; a database with no publisher account yet is left for the next start.
 * The count is said on stderr.
 * @param {any} database @param {{ operatorUsers?: string[], publisherId?: string, report?: (line: string) => void }} options
 * @returns {Promise<{ zonesFound: number, zonesMoved: number, cardsMoved: number, zonesMarked: number } | null>} null when there was nothing to look for
 */
export async function reownOperatorImportedZones(database, { operatorUsers = [], publisherId = PLATFORM_PUBLISHER_USER_ID, report = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const operators = [...new Set(operatorUsers.map(String).filter((id) => id && id !== publisherId))];
  if (!operators.length) return null;
  await database.migrate();
  const publisher = (await database.query("SELECT auth_type FROM evimed_control.users WHERE id=$1", [publisherId])).rows[0];
  if (publisher?.auth_type !== PLATFORM_ACCOUNT_AUTH_TYPE) { report("evidence re-own: the platform publisher account does not exist yet; nothing moved"); return null; }
  await new EvidenceZoneService({ database }).ready();
  const zoneIds = (await database.query(
    `SELECT z.id FROM evimed_frontier.evidence_zones z
      WHERE z.user_id=ANY($1::text[])
        AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_cards c WHERE c.zone_id=z.id AND c.editorial->>'reviewOrigin'='import')
      ORDER BY z.id`, [operators])).rows.map((/** @type {any} */ row) => String(row.id));
  if (!zoneIds.length) return { zonesFound: 0, zonesMoved: 0, cardsMoved: 0, zonesMarked: 0 };
  const result = await reownImportedZones(database, { zoneIds, fromOwners: operators, publisherId });
  report(`evidence re-own: ${result.zonesMoved} official zone(s) and ${result.cardsMoved} card(s) moved from an operator account to the platform publisher; ${result.zonesMarked} marked official`);
  return result;
}
