import { FRONTIER_HIDE_REASON_LABELS_ZH, FRONTIER_HIDE_REASONS } from "@evimed/domain";
import { addFrontierFollow, listFrontierFollows, removeFrontierFollow, type FrontierHideReason, type FrontierItem } from "@/lib/frontierClient";

/**
 * 「不感兴趣」 with its reason (c2-hide, 2026-10-25): the words and the one side effect a reason has.
 *
 * - The reasons are the domain's, in its order, with its labels; only the last one names the source — 「不想看“<来源名>”」 — because
 *   the reader is saying something about who published it, and the words say which.
 * - 「不想看这个来源」 also mutes the source, through the same muted follow 「屏蔽 <来源>」 makes, so the feed stops bringing it. The
 *   mute is undone with the hide, to what it was: nothing (the follow is removed), a follow (it is made a follow again), or a
 *   mute the reader already had (left alone — it was not this hide's).
 */

/** The reasons in the order the domain lists them. */
export const HIDE_REASONS: readonly FrontierHideReason[] = FRONTIER_HIDE_REASONS;

/** What a reason chip says for this item: the domain's label, and for the source's own the source's name. */
export function hideReasonLabel(reason: FrontierHideReason, item: Pick<FrontierItem, "source">): string {
  return reason === "source" ? `不想看“${item.source.name}”` : FRONTIER_HIDE_REASON_LABELS_ZH[reason] ?? reason;
}

/**
 * Mute the item's source and answer how to undo it. Reads the reader's follows first so the undo can give back what was there;
 * when they cannot be read nothing is muted (a guess here could delete a follow the reader made).
 */
export async function muteSourceOf(item: Pick<FrontierItem, "source">): Promise<() => Promise<void>> {
  const key = item.source.id;
  const before = (await listFrontierFollows()).find((follow) => follow.kind === "source" && follow.key === key) ?? null;
  if (before?.muted) return async () => undefined;
  const added = await addFrontierFollow({ kind: "source", key, label: item.source.name, muted: true });
  return async () => {
    if (before) await addFrontierFollow({ kind: "source", key: before.key, label: before.label, muted: false });
    else await removeFrontierFollow(added.id);
  };
}
