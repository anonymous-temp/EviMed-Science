// Fixtures for the frontier feed's second wave (events, dailies, 与你相关): a
// published item with what clustering and the daily read — entity and
// cluster keys, a language, a total score, a vector — on top of the shared
// `insertItem`, and vectors whose cosine to each other is chosen.
import { insertItem } from "./frontierFixtures.mjs";

export const TEST_MODEL_KEY = "test-embedding@1024";
export const TEST_DIMENSION = 1024;

/**
 * A unit vector at a chosen cosine to the first axis (and to every other
 * vector made here along the same plane): cos θ on axis 0, sin θ on `axis`.
 * @param {number} cosine @param {number} [axis]
 */
export function vectorAt(cosine, axis = 1) {
  const vector = new Array(TEST_DIMENSION).fill(0);
  vector[0] = cosine;
  vector[axis] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return vector;
}

/** An embedder that says it is configured and never embeds (the vectors are written by the test). */
export const testEmbedder = Object.freeze({ configured: true, modelKey: TEST_MODEL_KEY, dimension: TEST_DIMENSION });

/**
 * A published item as the pipeline leaves one, with the second wave's fields.
 * @param {any} database
 * @param {Record<string, any> & { entityKeys?: string[], registryIds?: string[], lang?: string, identityKey?: string,
 *   scoreTotal?: number | null, vector?: number[] | null, clusterKeys?: string[] }} [overrides]
 */
export async function insertComposedItem(database, overrides = {}) {
  const { entityKeys = [], registryIds = [], lang = "en", identityKey = null, scoreTotal = null, vector = null, clusterKeys = null, ...rest } = overrides;
  const row = await insertItem(database, rest);
  await database.query(`UPDATE evimed_frontier.items SET entity_keys = $2, registry_ids = $3, lang = $4,
      identity_key = coalesce($5, identity_key), score_total = $6 WHERE id = $1`,
  [row.id, entityKeys, registryIds, lang, identityKey, scoreTotal]);
  // What the pipeline writes for clustering: a bare registry id per registry
  // id, owned by the first item that had it.
  const keys = clusterKeys ?? registryIds.map((id) => `reg:${String(id).toUpperCase()}`);
  for (const key of keys) {
    await database.query("INSERT INTO evimed_frontier.item_keys (key, item_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, row.id]);
  }
  if (vector) {
    await database.query("INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding) VALUES ($1, $2, $3)",
      [row.id, TEST_MODEL_KEY, `[${vector.join(",")}]`]);
  }
  return row;
}

/** The event an item is in: its row, or null. @param {any} database @param {string} itemId */
export async function eventOf(database, itemId) {
  return (await database.query(`SELECT e.* FROM evimed_frontier.items i JOIN evimed_frontier.events e ON e.id = i.event_id WHERE i.id = $1`,
    [itemId])).rows[0] ?? null;
}

/** A meta counter as a number. @param {any} database @param {string} key */
export async function metaValue(database, key) {
  return Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key = $1", [key])).rows[0]?.value ?? 0);
}

/** Empty everything the second wave writes and reads, between tests. @param {any} database */
export async function resetFrontier(database) {
  for (const table of ["event_links", "event_aliases", "event_revisions", "event_items", "hot_snapshots", "dailies", "user_profiles"]) {
    await database.query(`DELETE FROM evimed_frontier.${table}`);
  }
  await database.query("UPDATE evimed_frontier.items SET event_id = NULL");
  await database.query("DELETE FROM evimed_frontier.events");
  await database.query("DELETE FROM evimed_frontier.item_links");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("DELETE FROM evimed_frontier.user_follows");
  await database.query("DELETE FROM evimed_frontier.user_prefs");
  await database.query("UPDATE evimed_frontier.meta SET value = '0'::jsonb WHERE key IN ('content_version', 'hot_version', 'daily_version')");
}
