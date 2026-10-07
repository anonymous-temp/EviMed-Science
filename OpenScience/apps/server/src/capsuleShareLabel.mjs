// Where a received pack's entries came from, in the words a recall hands the model (plan §7, 2026-10-05). Pure, and a module
// of its own because `capsuleService.mjs` and `capsuleMethods.mjs` both need it and reach each other through `capsuleScan.mjs`.

/**
 * Where an entry of a received pack came from, in the words a recall hands the model: 「来自 李主任 的分享」. A recalled entry of a
 * pack somebody shared is always labelled with it (plan §7), whatever else it carries — the author is the pack's card's display
 * name or the one recorded beside the entry when it was imported, never the account. An entry of the researcher's own capsule has
 * none. A pack imported before authors were recorded says only that it is somebody's.
 * @param {any} capsule @param {any} [entryPayload]
 * @returns {{ label: string, authorName: string | null, snapshotHash: string | null, channel: string | null, sharedAt: string | null } | null}
 */
export function sharedFrom(capsule, entryPayload = null) {
  if (capsule?.payload?.imported !== true) return null;
  const share = entryPayload?.share ?? capsule.payload.share ?? null;
  const name = String(share?.authorName ?? capsule.payload.card?.author ?? "").trim() || null;
  return {
    label: name ? `来自 ${name} 的分享` : "来自他人的分享", authorName: name,
    snapshotHash: share?.snapshotHash ?? capsule.payload.transfer?.manifestSha256 ?? null, channel: share?.channel ?? capsule.payload.transfer?.channel ?? null,
    sharedAt: share?.sharedAt ?? null,
  };
}
