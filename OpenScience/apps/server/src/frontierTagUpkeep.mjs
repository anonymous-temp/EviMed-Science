/**
 * The tag tree's upkeep (「前沿动态」 标签, owner 2026-10-23): how the tree grows, folds and sleeps by itself.
 *
 * Daily — `promote`: a candidate named by enough items from enough sources is judged by the model beside the tags nearest to it:
 * a stable concept of its own is promoted (named, put under its specialties and a broader tag), another spelling of a tag folds
 * into it, anything else is refused; `wake`: a sleeping tag named again is shown again. Weekly — `merge`: two tags carried by the
 * same items, or spelled nearly alike, are judged for one concept; `split`: a specialty whose items carry none of its tags is read
 * for the concepts they share, which become candidates; `sleep`: a tag no item named for half a year leaves the filters.
 *
 * Hidden knowledge:
 *
 * - **Code decides everything that can be counted** — thresholds, caps, which neighbours are shown, that an answer names a row it
 *   was shown — and the model decides only what is language: whether two names are one concept, whether a name is a concept at
 *   all, what it is called. An answer that names a row it was not shown is dropped for that candidate, not trusted.
 * - **Every change is a row of `tag_changes`** with what it replaced, so an operator can take it back (`undo`); nobody is asked
 *   first (the owner's rule: no approval step), and nothing unpromoted is ever shown to a reader.
 * - **One run at a time, across processes:** a run claims its period by moving its `meta` stamp in one statement.
 *
 * @module frontierTagUpkeep
 */

import { FRONTIER_SPECIALTIES, FRONTIER_SPECIALTY_LABELS_ZH } from "@evimed/domain";
import { bumpFrontierVersion, FRONTIER_META_KEYS } from "./frontierPersistence.mjs";
import { FRONTIER_TAG_KINDS, FRONTIER_TAG_RULES, tagKey, tagName, tagSlug } from "./frontierTags.mjs";

const DAY_MS = 86_400_000;
const SPECIALTY_LINE = FRONTIER_SPECIALTIES.map((key) => `${key} ${FRONTIER_SPECIALTY_LABELS_ZH[key]}`).join("；");
const JUDGE_BATCH = 20;
const JUDGE_MAX_TOKENS = 3_000;
const JUDGE_TIMEOUT_MS = 90_000;
const MERGE_PAIRS_MAX = 60;
const NEIGHBOURS = 8;

/** The promotion judge's instructions. */
export const FRONTIER_TAG_JUDGE_INSTRUCTIONS = [
  "你在维护一个面向国内临床医生、药师和医学研究者的医学资讯平台的标签树。标签表示一条资讯具体讲什么：疾病、药物或药物类别、疗法、技术、研究方法、生物学或临床概念、人群、卫生政策。",
  "下面每个候选标签附：最近用到它的几条消息标题，以及标签树里和它最接近的已有标签（带编号）。逐个判断，只输出 JSON。",
  "",
  "- verdict \"new\"：它是一个稳定的医学概念，不是已有标签的另一种说法。给出 zh（规范中文名，国内临床和指南常用写法，2 到 16 个字）、en（英文名，优先用 MeSH 主题词的写法）、kind（disease、drug、drug-class、therapy、technology、method、concept、population、policy 之一）、specialties（0 到 2 个专科键）、broader（它是某个已有标签的下位概念时填那个编号，否则 null）。",
  "- verdict \"same\"：它和某个已有标签是同一个概念（同义词、缩写、写法不同），same_as 填那个编号。",
  "- verdict \"reject\"：不适合做标签：专科或栏目名、证据类型或研究设计、机构、公司、期刊、国家或地区、人名、几乎任何资讯都能用的泛词、一次性的事件或句子。why 用 10 个字以内说明。",
  "",
  `专科词表：${SPECIALTY_LINE}。`,
  "",
  "输出格式：{\"items\":[{\"i\":1,\"verdict\":\"new\",\"zh\":\"\",\"en\":\"\",\"kind\":\"\",\"specialties\":[],\"broader\":null,\"same_as\":null,\"why\":\"\"}]}",
  "每个候选恰好一行，i 原样照抄；编号只能用该候选自己列出的已有标签编号；不要输出任何解释。",
].join("\n");

/** The merge judge's instructions. */
export const FRONTIER_TAG_MERGE_INSTRUCTIONS = [
  "你在维护一个医学资讯平台的标签树。下面每一对标签附各自最近的几条消息标题。逐对判断两者是不是同一个医学概念（同义词、缩写、写法不同算同一个；上下位关系、相关但不同的概念不算）。只输出 JSON。",
  "输出格式：{\"pairs\":[{\"i\":1,\"same\":true}]}，每对恰好一行，i 原样照抄；不要输出任何解释。",
].join("\n");

/** The split judge's instructions. */
export const FRONTIER_TAG_SPLIT_INSTRUCTIONS = [
  "你在维护一个医学资讯平台的标签树。下面是同一个专科里还没有合适标签的若干条消息标题（带编号）。找出其中被多条消息共同讲到的医学概念（疾病、药物或药物类别、疗法、技术、研究方法、生物学或临床概念、人群、卫生政策），最多 5 个，每个至少要覆盖 8 条消息。只输出 JSON。",
  "每个概念给出 zh（规范中文名，2 到 16 个字）、en（英文名，优先 MeSH 写法）、kind（disease、drug、drug-class、therapy、technology、method、concept、population、policy 之一）和 items（讲到它的消息编号）。不要写专科名、证据类型、研究设计、机构、国家地区和泛词；找不到就给空数组。",
  "输出格式：{\"tags\":[{\"zh\":\"\",\"en\":\"\",\"kind\":\"\",\"items\":[1,2]}]}；不要输出任何解释。",
].join("\n");

/** A name's character pairs, for nearness (Han and Latin alike). @param {string} value */
function pairs(value) {
  const chars = [...tagKey(value)];
  const out = new Set();
  for (let index = 0; index + 1 < chars.length; index += 1) out.add(chars[index] + chars[index + 1]);
  if (chars.length === 1) out.add(chars[0]);
  return out;
}

/** @param {Set<string>} left @param {Set<string>} right */
function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** A specialty key of the thirty, or null. @param {unknown} key */
const specialtyOf = (key) => (typeof key === "string" && FRONTIER_SPECIALTIES.includes(/** @type {any} */ (key)) ? key : null);

export class FrontierTagUpkeep {
  /**
   * @param {{ database: any, editor: any, tags: import("./frontierTags.mjs").FrontierTagStore, budget?: () => Promise<{ state: string }>,
   *   now?: () => Date, rules?: typeof FRONTIER_TAG_RULES }} options
   */
  constructor({ database, editor, tags, budget = async () => ({ state: "ok" }), now = () => new Date(), rules = FRONTIER_TAG_RULES }) {
    this.database = database;
    this.editor = editor;
    this.tags = tags;
    this.budget = budget;
    this.now = now;
    this.rules = rules;
    this.counters = { runs: 0, promoted: 0, folded: 0, rejected: 0, deferred: 0, woken: 0, merged: 0, split: 0, slept: 0, judgeFailures: 0, undone: 0 };
    /** @type {string | null} */
    this.lastError = null;
    /** @type {string | null} */
    this.lastRunAt = null;
  }

  /**
   * Run what is due: the daily part once in 20 hours, the weekly part once in six and a half days. Nothing runs while the model
   * cannot be asked (no editor, the day's budget spent).
   * @returns {Promise<{ daily: boolean, weekly: boolean }>}
   */
  async tick() {
    const ran = { daily: false, weekly: false };
    if (!this.editor?.available) return ran;
    if ((await this.budget()).state === "exhausted") return ran;
    this.counters.runs += 1;
    this.lastRunAt = this.now().toISOString();
    try {
      if (await this.#claim("tags_daily_at", 20 * 3_600_000)) {
        ran.daily = true;
        await this.promote();
        await this.wake();
      }
      if (await this.#claim("tags_weekly_at", 6.5 * DAY_MS)) {
        ran.weekly = true;
        await this.merge();
        await this.split();
        await this.sleep();
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = /** @type {any} */ (error)?.code ?? "frontier_tag_upkeep_failed";
      throw error;
    }
    return ran;
  }

  /** Move a period's stamp when it is older than the period; true when this call moved it. @param {string} key @param {number} period */
  async #claim(key, period) {
    const at = this.now();
    const result = await this.database.query(`INSERT INTO evimed_frontier.meta (key, value, updated_at) VALUES ($1, to_jsonb($2::text), clock_timestamp())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = clock_timestamp()
        WHERE (evimed_frontier.meta.value #>> '{}')::timestamptz < $3::timestamptz
      RETURNING key`, [key, at.toISOString(), new Date(at.getTime() - period).toISOString()]);
    return result.rowCount > 0;
  }

  /** One judged call; null when it failed (counted). @param {string} instructions @param {string} input */
  async #ask(instructions, input) {
    try {
      return await this.editor.callJson([{ role: "system", content: instructions }, { role: "user", content: input }], { maxTokens: JUDGE_MAX_TOKENS, timeoutMs: JUDGE_TIMEOUT_MS });
    } catch (error) {
      this.counters.judgeFailures += 1;
      this.lastError = /** @type {any} */ (error)?.code ?? "frontier_tag_judge_failed";
      return null;
    }
  }

  /** The tree moved: the vocabulary reloads and the lists' versions move. @param {any} client */
  async #moved(client) {
    await bumpFrontierVersion(client, FRONTIER_META_KEYS.tagsVersion);
    await bumpFrontierVersion(client);
  }

  /** Up to three recent titles of each tag's items. @param {number[]} ids @returns {Promise<Map<number, string[]>>} */
  async #titles(ids) {
    const result = await this.database.query(`SELECT tag_id, title FROM (
        SELECT it.tag_id, coalesce(i.title_zh, i.title_raw) AS title, row_number() OVER (PARTITION BY it.tag_id ORDER BY i.timeline_at DESC) AS n
        FROM evimed_frontier.item_tags it JOIN evimed_frontier.items i ON i.id = it.item_id
        WHERE it.tag_id = ANY($1::bigint[]) AND i.state = 'published') ranked WHERE n <= 3`, [ids.map(String)]);
    /** @type {Map<number, string[]>} */
    const out = new Map();
    for (const row of result.rows) out.set(Number(row.tag_id), [...(out.get(Number(row.tag_id)) ?? []), String(row.title).slice(0, 120)]);
    return out;
  }

  /**
   * The active tags nearest a name: same specialty first, by shared character pairs of any spelling.
   * @param {import("./frontierTags.mjs").FrontierTagVocabulary} vocabulary @param {string} name @param {string[]} specialties
   */
  #neighbours(vocabulary, name, specialties) {
    const mine = pairs(name);
    /** @type {Map<number, number>} */
    const best = new Map();
    for (const [key, id] of vocabulary.keys) {
      const tag = vocabulary.shown(id);
      if (!tag) continue;
      const score = jaccard(mine, pairs(key)) + (specialties.some((specialty) => tag.specialties.includes(specialty)) ? 0.15 : 0);
      if (score > (best.get(tag.id) ?? 0)) best.set(tag.id, score);
    }
    return [...best].sort((left, right) => right[1] - left[1]).slice(0, NEIGHBOURS)
      .map(([id]) => /** @type {import("./frontierTags.mjs").FrontierTag} */ (vocabulary.byId.get(id)));
  }

  /** Active tags per primary specialty. @param {import("./frontierTags.mjs").FrontierTagVocabulary} vocabulary */
  #activeBySpecialty(vocabulary) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const tag of vocabulary.byId.values()) {
      if (tag.state !== "active" || !tag.specialties[0]) continue;
      counts.set(tag.specialties[0], (counts.get(tag.specialties[0]) ?? 0) + 1);
    }
    return counts;
  }

  /** Judge the candidates that crossed the line (daily). */
  async promote() {
    const rules = this.rules;
    const at = this.now();
    const due = await this.database.query(`SELECT t.id, t.name, t.specialties, count(DISTINCT it.item_id)::integer AS items,
        count(DISTINCT i.primary_source_id)::integer AS sources
      FROM evimed_frontier.tags t JOIN evimed_frontier.item_tags it ON it.tag_id = t.id JOIN evimed_frontier.items i ON i.id = it.item_id
      WHERE t.state = 'candidate' AND i.state = 'published' AND i.timeline_at > $1::timestamptz
        AND (t.judged_at IS NULL OR t.judged_at < $2::timestamptz)
      GROUP BY t.id HAVING count(DISTINCT it.item_id) >= $3 AND count(DISTINCT i.primary_source_id) >= $4
      ORDER BY count(DISTINCT it.item_id) DESC LIMIT 200`,
    [new Date(at.getTime() - rules.windowDays * DAY_MS).toISOString(), new Date(at.getTime() - rules.rejudgeDays * DAY_MS).toISOString(),
      rules.promoteItems, rules.promoteSources]);
    if (!due.rowCount) return 0;
    const titles = await this.#titles(due.rows.map((row) => Number(row.id)));
    let changed = 0;
    for (let start = 0; start < due.rows.length; start += JUDGE_BATCH) {
      const vocabulary = await this.tags.vocabulary();
      const batch = due.rows.slice(start, start + JUDGE_BATCH).map((row) => ({
        id: Number(row.id), name: row.name, items: row.items, specialties: (row.specialties ?? []).map(specialtyOf).filter(Boolean),
        neighbours: this.#neighbours(vocabulary, row.name, row.specialties ?? []),
      }));
      const input = batch.map((candidate, index) => [
        `[${index + 1}] 候选标签：${candidate.name}（${candidate.items} 条消息）`,
        ...(titles.get(candidate.id) ?? []).map((title) => `  消息：${title}`),
        ...(candidate.neighbours.length ? [`  已有标签：${candidate.neighbours.map((tag, n) => `${n + 1}=${tag.name}${tag.nameEn ? `（${tag.nameEn}）` : ""}`).join("；")}`] : ["  已有标签：无"]),
      ].join("\n")).join("\n\n");
      const answer = await this.#ask(FRONTIER_TAG_JUDGE_INSTRUCTIONS, input);
      if (!answer) break;
      const rows = Array.isArray(answer.items) ? answer.items : [];
      const capped = this.#activeBySpecialty(vocabulary);
      await this.database.transaction(async (/** @type {any} */ client) => {
        let moved = false;
        for (const [index, candidate] of batch.entries()) {
          const row = rows.find((/** @type {any} */ entry) => Number(entry?.i) === index + 1);
          const neighbour = (/** @type {unknown} */ n) => (Number.isInteger(n) && Number(n) >= 1 && Number(n) <= candidate.neighbours.length ? candidate.neighbours[Number(n) - 1] : null);
          if (!row) continue;
          if (row.verdict === "same") {
            const target = neighbour(row.same_as);
            if (!target) continue;
            await this.#fold(client, candidate.id, target.id, "candidate", "judge");
            this.counters.folded += 1;
            moved = true;
            continue;
          }
          if (row.verdict === "reject") {
            await client.query("UPDATE evimed_frontier.tags SET state = 'rejected', state_at = clock_timestamp(), judged_at = clock_timestamp() WHERE id = $1 AND state = 'candidate'", [candidate.id]);
            await client.query(`INSERT INTO evimed_frontier.tag_changes (action, tag_id, before, after, reason) VALUES ('reject', $1, '{"state":"candidate"}', '{"state":"rejected"}', $2)`,
              [candidate.id, String(row.why ?? "").slice(0, 60) || null]);
            this.counters.rejected += 1;
            moved = true;
            continue;
          }
          if (row.verdict !== "new") continue;
          const name = tagName(row.zh) ?? tagName(candidate.name);
          const kind = FRONTIER_TAG_KINDS.includes(row.kind) ? row.kind : null;
          const specialties = [...new Set((Array.isArray(row.specialties) ? row.specialties : []).map(specialtyOf).filter(Boolean))].slice(0, 2);
          if (!name || !kind) continue;
          // A name another tag already answers to is that tag.
          const owner = vocabulary.byName(name);
          if (owner && owner.id !== candidate.id && owner.state === "active") {
            await this.#fold(client, candidate.id, owner.id, "candidate", "judge");
            this.counters.folded += 1;
            moved = true;
            continue;
          }
          const primary = /** @type {string | undefined} */ (specialties[0]);
          if (primary && (capped.get(primary) ?? 0) >= rules.capPerSpecialty && candidate.items < rules.cappedItems) {
            await client.query("UPDATE evimed_frontier.tags SET judged_at = clock_timestamp() WHERE id = $1", [candidate.id]);
            this.counters.deferred += 1;
            continue;
          }
          const en = typeof row.en === "string" && row.en.trim() ? row.en.trim().slice(0, 200) : null;
          const broader = neighbour(row.broader);
          const slug = tagSlug(en, candidate.id, (value) => vocabulary.bySlugMap.has(value));
          const before = await client.query("SELECT slug, name, name_en, kind, specialties, broader_id FROM evimed_frontier.tags WHERE id = $1 AND state = 'candidate'", [candidate.id]);
          if (!before.rowCount) continue;
          await client.query(`UPDATE evimed_frontier.tags SET state = 'active', name = $2, name_en = $3, kind = $4, specialties = $5, broader_id = $6,
              slug = $7, state_at = clock_timestamp(), judged_at = clock_timestamp() WHERE id = $1`,
          [candidate.id, name, en, kind, specialties, broader?.id ?? null, slug]);
          for (const [alias, origin] of /** @type {Array<[string | null, string]>} */ ([[name, "judge"], [en, "judge"]])) {
            if (alias) await client.query("INSERT INTO evimed_frontier.tag_aliases (key, tag_id, alias, origin) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING", [tagKey(alias), candidate.id, alias, origin]);
          }
          await client.query(`INSERT INTO evimed_frontier.tag_changes (action, tag_id, before, after) VALUES ('promote', $1, $2::jsonb, $3::jsonb)`,
            [candidate.id, JSON.stringify({ state: "candidate", ...before.rows[0] }), JSON.stringify({ state: "active", slug, name, name_en: en, kind, specialties, broader_id: broader?.id ?? null })]);
          if (primary) capped.set(primary, (capped.get(primary) ?? 0) + 1);
          this.counters.promoted += 1;
          moved = true;
        }
        if (moved) await this.#moved(client);
      });
      this.tags.invalidate();
      changed += batch.length;
    }
    return changed;
  }

  /**
   * Fold one tag into another: a pointer, and every tag that pointed at the folded one now points at its new owner (no chain).
   * @param {any} client @param {number} id @param {number} into @param {string} from the state it leaves @param {string} reason
   */
  async #fold(client, id, into, from, reason) {
    const flattened = await client.query("UPDATE evimed_frontier.tags SET merged_into = $2 WHERE merged_into = $1 RETURNING id", [id, into]);
    await client.query(`UPDATE evimed_frontier.tags SET state = 'merged', merged_into = $2, state_at = clock_timestamp(), judged_at = clock_timestamp() WHERE id = $1`, [id, into]);
    await client.query(`INSERT INTO evimed_frontier.tag_changes (action, tag_id, other_id, before, after, reason) VALUES ('merge', $1, $2, $3::jsonb, '{"state":"merged"}', $4)`,
      [id, into, JSON.stringify({ state: from, flattened: flattened.rows.map((row) => Number(row.id)) }), reason]);
  }

  /** Show again a sleeping tag an item named in the last thirty days (daily). */
  async wake() {
    const at = this.now();
    const woken = await this.database.transaction(async (/** @type {any} */ client) => {
      const rows = await client.query(`UPDATE evimed_frontier.tags t SET state = 'active', state_at = clock_timestamp()
        WHERE t.state = 'dormant' AND EXISTS (SELECT 1 FROM evimed_frontier.item_tags it JOIN evimed_frontier.items i ON i.id = it.item_id
          WHERE it.tag_id = t.id AND i.state = 'published' AND i.timeline_at > $1::timestamptz) RETURNING t.id`,
      [new Date(at.getTime() - this.rules.windowDays * DAY_MS).toISOString()]);
      for (const row of rows.rows) {
        await client.query(`INSERT INTO evimed_frontier.tag_changes (action, tag_id, before, after) VALUES ('wake', $1, '{"state":"dormant"}', '{"state":"active"}')`, [row.id]);
      }
      if (rows.rowCount) await this.#moved(client);
      return rows.rowCount;
    });
    if (woken) this.tags.invalidate();
    this.counters.woken += woken;
    return woken;
  }

  /** Put to sleep an active tag no item named in `dormantDays` (weekly). */
  async sleep() {
    const at = this.now();
    const slept = await this.database.transaction(async (/** @type {any} */ client) => {
      const rows = await client.query(`UPDATE evimed_frontier.tags t SET state = 'dormant', state_at = clock_timestamp()
        WHERE t.state = 'active' AND t.created_at < $1::timestamptz AND NOT EXISTS (
          SELECT 1 FROM evimed_frontier.item_tags it JOIN evimed_frontier.items i ON i.id = it.item_id
          JOIN evimed_frontier.tags m ON m.id = it.tag_id
          WHERE (m.id = t.id OR m.merged_into = t.id) AND i.state = 'published' AND i.timeline_at > $1::timestamptz) RETURNING t.id`,
      [new Date(at.getTime() - this.rules.dormantDays * DAY_MS).toISOString()]);
      for (const row of rows.rows) {
        await client.query(`INSERT INTO evimed_frontier.tag_changes (action, tag_id, before, after) VALUES ('dormant', $1, '{"state":"active"}', '{"state":"dormant"}')`, [row.id]);
      }
      if (rows.rowCount) await this.#moved(client);
      return rows.rowCount;
    });
    if (slept) this.tags.invalidate();
    this.counters.slept += slept;
    return slept;
  }

  /** Judge pairs of active tags carried by the same items or spelled nearly alike, and fold each pair judged one concept (weekly). */
  async merge() {
    const rules = this.rules;
    const at = this.now();
    const vocabulary = await this.tags.vocabulary();
    const links = await this.database.query(`SELECT it.tag_id, it.item_id FROM evimed_frontier.item_tags it JOIN evimed_frontier.items i ON i.id = it.item_id
      WHERE i.state = 'published' AND i.timeline_at > $1::timestamptz`, [new Date(at.getTime() - 90 * DAY_MS).toISOString()]);
    /** @type {Map<number, Set<string>>} */
    const items = new Map();
    for (const row of links.rows) {
      const tag = vocabulary.shown(Number(row.tag_id));
      if (!tag) continue;
      const set = items.get(tag.id) ?? new Set();
      set.add(String(row.item_id));
      items.set(tag.id, set);
    }
    const big = new Set([...items].filter(([, set]) => set.size >= rules.mergeMinItems).map(([id]) => id));
    // Tags carried by the same items: counted through the items, so only pairs that share one are ever compared.
    /** @type {Map<string, number[]>} */
    const byItem = new Map();
    for (const [id, set] of items) if (big.has(id)) for (const item of set) byItem.set(item, [...(byItem.get(item) ?? []), id]);
    /** @type {Map<string, number>} */
    const shared = new Map();
    for (const ids of byItem.values()) {
      for (let a = 0; a < ids.length; a += 1) for (let b = a + 1; b < ids.length; b += 1) {
        const key = ids[a] < ids[b] ? `${ids[a]}:${ids[b]}` : `${ids[b]}:${ids[a]}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
    /** @type {Map<string, { left: number, right: number, score: number }>} */
    const found = new Map();
    for (const [key, count] of shared) {
      const [left, right] = key.split(":").map(Number);
      const overlap = count / ((items.get(left)?.size ?? 0) + (items.get(right)?.size ?? 0) - count);
      if (overlap >= rules.mergeJaccard) found.set(key, { left, right, score: overlap });
    }
    // Tags spelled nearly alike within one specialty.
    for (const specialty of FRONTIER_SPECIALTIES) {
      const own = [...big].map((id) => /** @type {any} */ (vocabulary.byId.get(id))).filter((tag) => tag.specialties.includes(specialty));
      for (let a = 0; a < own.length; a += 1) for (let b = a + 1; b < own.length; b += 1) {
        const spelling = jaccard(pairs(own[a].name), pairs(own[b].name));
        const key = own[a].id < own[b].id ? `${own[a].id}:${own[b].id}` : `${own[b].id}:${own[a].id}`;
        if (spelling >= 0.6 && (found.get(key)?.score ?? 0) < spelling) found.set(key, { left: own[a].id, right: own[b].id, score: spelling });
      }
    }
    const candidates = [...found.values()].filter((pair) => {
      const left = /** @type {any} */ (vocabulary.byId.get(pair.left));
      const right = /** @type {any} */ (vocabulary.byId.get(pair.right));
      return left.broaderId !== right.id && right.broaderId !== left.id;
    });
    const chosen = candidates.sort((x, y) => y.score - x.score).slice(0, MERGE_PAIRS_MAX);
    if (!chosen.length) return 0;
    const titles = await this.#titles([...new Set(chosen.flatMap((pair) => [pair.left, pair.right]))]);
    let merged = 0;
    for (let start = 0; start < chosen.length; start += JUDGE_BATCH) {
      const batch = chosen.slice(start, start + JUDGE_BATCH);
      const input = batch.map((pair, index) => {
        const left = /** @type {any} */ (vocabulary.byId.get(pair.left));
        const right = /** @type {any} */ (vocabulary.byId.get(pair.right));
        return [`[${index + 1}] A：${left.name}${left.nameEn ? `（${left.nameEn}）` : ""}｜B：${right.name}${right.nameEn ? `（${right.nameEn}）` : ""}`,
          ...(titles.get(left.id) ?? []).slice(0, 2).map((title) => `  A 的消息：${title}`),
          ...(titles.get(right.id) ?? []).slice(0, 2).map((title) => `  B 的消息：${title}`)].join("\n");
      }).join("\n\n");
      const answer = await this.#ask(FRONTIER_TAG_MERGE_INSTRUCTIONS, input);
      if (!answer) break;
      const rows = Array.isArray(answer.pairs) ? answer.pairs : [];
      await this.database.transaction(async (/** @type {any} */ client) => {
        let moved = false;
        for (const [index, pair] of batch.entries()) {
          const row = rows.find((/** @type {any} */ entry) => Number(entry?.i) === index + 1);
          if (row?.same !== true) continue;
          // The tag carried by more items stands for both.
          const [keep, drop] = (items.get(pair.left)?.size ?? 0) >= (items.get(pair.right)?.size ?? 0) ? [pair.left, pair.right] : [pair.right, pair.left];
          const state = await client.query("SELECT state FROM evimed_frontier.tags WHERE id = ANY($1::bigint[])", [[String(keep), String(drop)]]);
          if (state.rows.some((/** @type {any} */ entry) => entry.state !== "active")) continue;
          await this.#fold(client, drop, keep, "active", "same-items");
          merged += 1;
          moved = true;
        }
        if (moved) await this.#moved(client);
      });
      this.tags.invalidate();
    }
    this.counters.merged += merged;
    return merged;
  }

  /** Read each specialty's untagged items for the concepts they share; each becomes a candidate linked to its items (weekly). */
  async split() {
    const rules = this.rules;
    const at = this.now();
    const vocabulary = await this.tags.vocabulary();
    let made = 0;
    for (const specialty of FRONTIER_SPECIALTIES) {
      const ownIds = [...vocabulary.byId.values()].filter((tag) => vocabulary.resolveId(tag.id)?.state === "active"
        && vocabulary.resolveId(tag.id)?.specialties.includes(specialty)).map((tag) => String(tag.id));
      const bare = await this.database.query(`SELECT i.id, coalesce(i.title_zh, i.title_raw) AS title FROM evimed_frontier.items i
        WHERE i.state = 'published' AND i.timeline_at > $1::timestamptz AND $2 = ANY(i.specialties) AND i.tag_version IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM evimed_frontier.item_tags it WHERE it.item_id = i.id AND it.tag_id = ANY($3::bigint[]))
        ORDER BY i.timeline_at DESC LIMIT $4`,
      [new Date(at.getTime() - rules.splitDays * DAY_MS).toISOString(), specialty, ownIds, Math.max(rules.splitItems, rules.splitSample)]);
      if (bare.rowCount < rules.splitItems) continue;
      const sample = bare.rows.slice(0, rules.splitSample);
      const answer = await this.#ask(FRONTIER_TAG_SPLIT_INSTRUCTIONS,
        [`专科：${FRONTIER_SPECIALTY_LABELS_ZH[specialty]}`, ...sample.map((row, index) => `[${index + 1}] ${String(row.title).slice(0, 120)}`)].join("\n"));
      if (!answer) break;
      const proposals = Array.isArray(answer.tags) ? answer.tags.slice(0, 5) : [];
      await this.database.transaction(async (/** @type {any} */ client) => {
        for (const proposal of proposals) {
          const name = tagName(proposal?.zh);
          const kind = FRONTIER_TAG_KINDS.includes(proposal?.kind) ? proposal.kind : null;
          const covered = [...new Set((Array.isArray(proposal?.items) ? proposal.items : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= sample.length))];
          if (!name || !kind || covered.length < rules.splitMinItems || vocabulary.byName(name)) continue;
          const en = typeof proposal.en === "string" && proposal.en.trim() ? proposal.en.trim().slice(0, 200) : null;
          const inserted = await client.query(`INSERT INTO evimed_frontier.tags (slug, name, name_en, kind, specialties, state, origin)
            VALUES ('c-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12), $1, $2, $3, $4, 'candidate', 'split') RETURNING id`,
          [name, en, kind, [specialty]]);
          const id = Number(inserted.rows[0].id);
          const aliased = await client.query("INSERT INTO evimed_frontier.tag_aliases (key, tag_id, alias, origin) VALUES ($1, $2, $3, 'judge') ON CONFLICT (key) DO NOTHING RETURNING key",
            [tagKey(name), id, name]);
          if (!aliased.rowCount) { await client.query("DELETE FROM evimed_frontier.tags WHERE id = $1", [id]); continue; }
          for (const n of covered) {
            await client.query(`INSERT INTO evimed_frontier.item_tags (item_id, tag_id, rank, origin) VALUES ($1, $2, 10, 'split') ON CONFLICT DO NOTHING`, [sample[n - 1].id, id]);
          }
          await client.query(`INSERT INTO evimed_frontier.tag_changes (action, tag_id, after, reason) VALUES ('split', $1, $2::jsonb, $3)`,
            [id, JSON.stringify({ state: "candidate", items: covered.length }), specialty]);
          made += 1;
        }
      });
    }
    this.counters.split += made;
    return made;
  }

  /**
   * Take a change back: a promotion returns the tag to the candidates, a fold or a refusal to the state it left, a sleep or a wake
   * the other way, a split's candidate is refused. Only the last state a change made can be taken back.
   * @param {number | string} changeId @returns {Promise<boolean>}
   */
  async undo(changeId) {
    const done = await this.database.transaction(async (/** @type {any} */ client) => {
      const found = await client.query("SELECT * FROM evimed_frontier.tag_changes WHERE id = $1 AND undone_at IS NULL AND action <> 'undo' FOR UPDATE", [changeId]);
      const change = found.rows[0];
      if (!change) return false;
      const tag = (await client.query("SELECT * FROM evimed_frontier.tags WHERE id = $1 FOR UPDATE", [change.tag_id])).rows[0];
      const after = change.after ?? {};
      const before = change.before ?? {};
      if (!tag || (after.state && tag.state !== after.state)) return false;
      if (change.action === "promote") {
        await client.query(`UPDATE evimed_frontier.tags SET state = 'candidate', slug = $2, name = $3, name_en = $4, kind = $5, specialties = $6, broader_id = $7,
            state_at = clock_timestamp(), judged_at = clock_timestamp() WHERE id = $1`,
        [tag.id, before.slug ?? tag.slug, before.name ?? tag.name, before.name_en ?? null, before.kind ?? null, before.specialties ?? [], before.broader_id ?? null]);
      } else if (change.action === "merge") {
        await client.query("UPDATE evimed_frontier.tags SET state = $2, merged_into = NULL, state_at = clock_timestamp(), judged_at = clock_timestamp() WHERE id = $1",
          [tag.id, before.state === "active" ? "active" : "candidate"]);
        const flattened = Array.isArray(before.flattened) ? before.flattened.map(String) : [];
        if (flattened.length) await client.query("UPDATE evimed_frontier.tags SET merged_into = $1 WHERE id = ANY($2::bigint[]) AND state = 'merged'", [tag.id, flattened]);
      } else if (change.action === "reject") {
        await client.query("UPDATE evimed_frontier.tags SET state = 'candidate', state_at = clock_timestamp(), judged_at = clock_timestamp() WHERE id = $1", [tag.id]);
      } else if (change.action === "dormant") {
        await client.query("UPDATE evimed_frontier.tags SET state = 'active', state_at = clock_timestamp() WHERE id = $1", [tag.id]);
      } else if (change.action === "wake") {
        await client.query("UPDATE evimed_frontier.tags SET state = 'dormant', state_at = clock_timestamp() WHERE id = $1", [tag.id]);
      } else if (change.action === "split") {
        await client.query("UPDATE evimed_frontier.tags SET state = 'rejected', state_at = clock_timestamp() WHERE id = $1 AND state = 'candidate'", [tag.id]);
      } else return false;
      await client.query("UPDATE evimed_frontier.tag_changes SET undone_at = clock_timestamp() WHERE id = $1", [change.id]);
      await client.query("INSERT INTO evimed_frontier.tag_changes (action, tag_id, other_id, before, reason) VALUES ('undo', $1, NULL, $2::jsonb, $3)",
        [tag.id, JSON.stringify({ change: Number(change.id), action: change.action }), "operator"]);
      await this.#moved(client);
      return true;
    });
    if (done) {
      this.tags.invalidate();
      this.counters.undone += 1;
    }
    return done;
  }

  /**
   * The operators' view: every specialty's active tags with their thirty-day counts, the candidates nearest the line, and the
   * latest changes with whether each can still be taken back.
   */
  async overview() {
    const at = this.now();
    const since = new Date(at.getTime() - this.rules.windowDays * DAY_MS).toISOString();
    const vocabulary = await this.tags.vocabulary();
    const counts = new Map((await this.tags.hot([], 10_000)).map((row) => [row.slug, row.count]));
    const specialties = FRONTIER_SPECIALTIES.map((key) => ({
      key, label: FRONTIER_SPECIALTY_LABELS_ZH[key],
      tags: [...vocabulary.byId.values()].filter((tag) => tag.state === "active" && tag.specialties[0] === key)
        .map((tag) => ({ slug: tag.slug, name: tag.name, state: tag.state, count30d: counts.get(tag.slug) ?? 0, origin: null }))
        .sort((left, right) => right.count30d - left.count30d),
    }));
    const general = [...vocabulary.byId.values()].filter((tag) => tag.state === "active" && !tag.specialties.length)
      .map((tag) => ({ slug: tag.slug, name: tag.name, state: tag.state, count30d: counts.get(tag.slug) ?? 0, origin: null }))
      .sort((left, right) => right.count30d - left.count30d);
    const candidates = await this.database.query(`SELECT t.slug, t.name, count(DISTINCT it.item_id)::integer AS items, count(DISTINCT i.primary_source_id)::integer AS sources,
        min(i.timeline_at) AS first_seen
      FROM evimed_frontier.tags t JOIN evimed_frontier.item_tags it ON it.tag_id = t.id JOIN evimed_frontier.items i ON i.id = it.item_id
      WHERE t.state = 'candidate' AND i.state = 'published' AND i.timeline_at > $1::timestamptz
      GROUP BY t.id ORDER BY count(DISTINCT it.item_id) DESC LIMIT 60`, [since]);
    const changes = await this.database.query(`SELECT c.id, c.at, c.action, c.reason, c.undone_at, c.after, t.slug, t.name, t.state, o.slug AS other_slug, o.name AS other_name
      FROM evimed_frontier.tag_changes c JOIN evimed_frontier.tags t ON t.id = c.tag_id LEFT JOIN evimed_frontier.tags o ON o.id = c.other_id
      ORDER BY c.at DESC, c.id DESC LIMIT 100`);
    return {
      specialties: [...specialties, { key: "general", label: "通用", tags: general }],
      candidates: candidates.rows.map((row) => ({ slug: row.slug, name: row.name, count30d: row.items, sources30d: row.sources, firstSeen: new Date(row.first_seen).toISOString() })),
      changes: changes.rows.map((row) => ({
        id: Number(row.id), at: new Date(row.at).toISOString(), action: row.action, reason: row.reason ?? null,
        tag: { slug: row.slug, name: row.name }, other: row.other_slug ? { slug: row.other_slug, name: row.other_name } : null,
        undoable: row.action !== "undo" && !row.undone_at && (!row.after?.state || row.after.state === row.state),
      })),
      counters: { ...this.counters },
      lastError: this.lastError,
      lastRunAt: this.lastRunAt,
    };
  }
}
