// A typed follow as the feed's service made one until the owner's ruling of 2026-10-29 (typed follows became 我的专区 zones,
// `evidenceZoneWrites.mjs`). The matching, the counts and the daily notice that read such a follow still stand until the notices are
// replaced, and their tests need follows to read, so this helper writes one the way the service did: its words read by the watch,
// the row stored, the reader's lists moved on, the last seven days matched.
import { typedFollowKey, typedFollowLabel } from "../../src/frontierFollowQuery.mjs";

/**
 * @param {{ db: any, watch: any, service: any, now: () => Date }} parts
 * @param {{ id: string }} user @param {string} label
 * @returns {Promise<{ follow: any }>}
 */
export async function createTypedFollow({ db, watch, service, now }, user, label) {
  const words = typedFollowLabel(label);
  if (!words) throw Object.assign(new Error("The words to follow are empty or too long."), { code: "frontier_follow_invalid" });
  const parsed = await watch.parse(user.id, words);
  const row = (await db.query(`INSERT INTO evimed_frontier.user_follows AS f (user_id, kind, key, label, muted, query, created_at) VALUES ($1,'query',$2,$3,false,$4::jsonb,$5::timestamptz)
    ON CONFLICT (user_id, kind, key) DO UPDATE SET label = EXCLUDED.label RETURNING id`, [user.id, typedFollowKey(words), words, JSON.stringify(parsed.query), now().toISOString()])).rows[0];
  await db.query(`INSERT INTO evimed_frontier.user_prefs (user_id, state_version) VALUES ($1, 1)
    ON CONFLICT (user_id) DO UPDATE SET state_version = evimed_frontier.user_prefs.state_version + 1`, [user.id]);
  await db.query("UPDATE evimed_frontier.user_profiles SET for_you_at=NULL WHERE user_id=$1", [user.id]);
  await watch.backfill({ id: row.id, userId: user.id, query: parsed.query });
  const follows = (await service.listFollows(user)).follows;
  return { follow: follows.find((/** @type {any} */ follow) => String(follow.id) === String(row.id)) };
}
