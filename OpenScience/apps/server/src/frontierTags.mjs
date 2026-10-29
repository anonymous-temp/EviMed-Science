/**
 * The tag tree of 「前沿动态」 (owner, 2026-10-23): what an item is about — a disease, a drug or a class of drugs, a therapy, a
 * technology, a method, a concept, a population, a policy — as one controlled vocabulary under the thirty specialties, that grows
 * by itself.
 *
 * Hidden knowledge:
 *
 * - **Why a tree and not the editor's words.** Until 2026-10-23 the editor wrote free tags: 11,214 distinct tags in thirty days,
 *   68% used once, 5,216 of them needed to cover 80% of the uses, and only 21% matching the 92 topics. A tag a reader can filter
 *   by or follow has one spelling: here it is a row of `tags`, every other spelling an alias of it (`tag_aliases`, matched by
 *   `tagKey`), and the editor is shown the tree's spelling of what its text names (`candidatesFor`).
 * - **Seen only when promoted.** A name the tree does not know becomes a `candidate` row linked to its item and shown nowhere;
 *   the daily upkeep (`frontierTagUpkeep.mjs`) promotes it when enough items from enough sources name it and the model, shown
 *   its nearest neighbours, judges it a stable concept of its own — or folds it into the tag it is another name of, or rejects
 *   it. So nobody approves a tag and no bad tag reaches a reader (the owner's rule: AI-driven, bad data never shown).
 * - **A merge is a pointer, read at display time.** A merged tag keeps its rows and its item links; `merged_into` names the tag
 *   that stands for it (flattened, never a chain), so an undo is the pointer taken away again, and a follow of the old tag reads
 *   as the new one.
 * - **The seed** is `frontierTagSeed.json`: the thirty days of free tags, disease and drug names before the tree, grouped and
 *   named by `deepseek-flash` and matched to MeSH 2026 (English names and entry terms are aliases, so an English abstract names
 *   its tags; the MeSH unique id is kept), loaded once into an empty table (`frontierPersistence.mjs`).
 *
 * @module frontierTags
 */

import { FRONTIER_SPECIALTIES } from "@evimed/domain";

/** What a tag can be. */
export const FRONTIER_TAG_KINDS = Object.freeze(["disease", "drug", "drug-class", "therapy", "technology", "method", "concept", "population", "policy"]);
/** A tag's life: proposed, shown, asleep, folded into another, refused. */
export const FRONTIER_TAG_STATES = Object.freeze(["candidate", "active", "dormant", "merged", "rejected"]);
/** The tagging an item's `tag_version` records; an item below it is tagged again (`FrontierPipeline#retag`). */
export const FRONTIER_TAG_VERSION = 1;
/** Tags one item carries; the card shows the first three. */
export const FRONTIER_ITEM_TAG_LIMIT = 4;
/** Candidate tags one edit is shown. */
export const FRONTIER_TAG_CANDIDATES_MAX = 30;
/** A tag's length in characters. */
export const FRONTIER_TAG_CHARS = Object.freeze({ min: 2, max: 16 });

/**
 * The upkeep's thresholds (the plan the owner confirmed on 2026-10-23, after NLM's supplementary-concept-to-descriptor path and
 * TaxoAdapt's width/depth expansion): a candidate is judged once named by `promoteItems` items from `promoteSources` sources in
 * `windowDays` days; a specialty with `capPerSpecialty` active tags asks `cappedItems`; a tag named by no item in `dormantDays` days
 * sleeps; a specialty with `splitItems` items in `splitDays` days that carry none of its tags is clustered for new ones; two tags
 * whose items overlap by `mergeJaccard` are judged for a merge.
 */
export const FRONTIER_TAG_RULES = Object.freeze({
  promoteItems: 5, promoteSources: 2, windowDays: 30, capPerSpecialty: 60, cappedItems: 10, dormantDays: 180,
  splitItems: 40, splitDays: 90, splitSample: 80, splitMinItems: 8, mergeJaccard: 0.6, mergeMinItems: 5, rejudgeDays: 7,
});

/**
 * A name in the form aliases are matched by: NFKC, lower case, no spaces or middle dots, one kind of hyphen. 「GLP-1 受体激动剂」,
 * 「GLP‑1受体激动剂」 and 「glp-1 受体激动剂」 are one key.
 * @param {unknown} value @returns {string}
 */
export function tagKey(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\s·・]+/gu, "").replace(/[‐‑‒–—―−]/gu, "-");
}

/**
 * A tag name as an editor or the upkeep may write it: one line, 2–16 characters, no sentence punctuation, no link, no leading 「#」.
 * @param {unknown} value @returns {string | null}
 */
export function tagName(value) {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim().replace(/^#+\s*/u, "");
  const length = [...name].length;
  if (length < FRONTIER_TAG_CHARS.min || length > FRONTIER_TAG_CHARS.max) return null;
  if (/[，。；：！？,;:!?、"“”《》<>]|https?:|www\./iu.test(name)) return null;
  return name;
}

/**
 * The address of a tag: its English name in kebab case (`hepatocellular-carcinoma`), or `t-<id>` when it has none; a taken one
 * gets the id appended.
 * @param {string | null | undefined} nameEn @param {number | string} id @param {(slug: string) => boolean} [taken]
 */
export function tagSlug(nameEn, id, taken = () => false) {
  const base = String(nameEn ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  const slug = base.length >= 2 ? base : `t-${id}`;
  return taken(slug) ? `${slug}-${id}`.slice(0, 80) : slug;
}

/** A specialty key of the thirty, or null. @param {unknown} key */
function specialtyOf(key) {
  return typeof key === "string" && FRONTIER_SPECIALTIES.includes(/** @type {any} */ (key)) ? key : null;
}

const HAN = /\p{Script=Han}/u;
/** Upper-case letters and digits, 2–6 long, with at least two letters: an acronym, matched only as written (「ALL」 is not 「all」). */
const ACRONYM = /^(?=(?:.*[A-Z]){2})[A-Z0-9]{2,6}$/;

/**
 * @typedef {{ id: number, slug: string, name: string, nameEn: string | null, kind: string | null, specialties: string[],
 *   broaderId: number | null, meshUi: string | null, state: string, mergedInto: number | null }} FrontierTag
 * @typedef {{ key: string, tagId: number, alias: string }} FrontierTagAlias
 */

/**
 * The tree in memory: every tag and alias, as the tables hold them at one moment (`version`). Pure; built by
 * `FrontierTagStore.vocabulary()` and by tests from rows.
 */
export class FrontierTagVocabulary {
  /**
   * @param {FrontierTag[]} tags @param {FrontierTagAlias[]} aliases @param {number} [version]
   */
  constructor(tags, aliases, version = 0) {
    this.version = version;
    /** @type {Map<number, FrontierTag>} */
    this.byId = new Map(tags.map((tag) => [tag.id, tag]));
    /** @type {Map<string, FrontierTag>} */
    this.bySlugMap = new Map(tags.map((tag) => [tag.slug, tag]));
    /** @type {Map<string, number>} every spelling of every tag, to its row */
    this.keys = new Map();
    for (const tag of tags) {
      for (const name of [tag.name, tag.nameEn]) if (name && !this.keys.has(tagKey(name))) this.keys.set(tagKey(name), tag.id);
    }
    for (const alias of aliases) if (!this.keys.has(alias.key)) this.keys.set(alias.key, alias.tagId);
    // The words an active tag is found by in a text: the Han spellings by substring, the Latin ones by whole words.
    /** @type {Array<{ text: string, tagId: number }>} */
    this.han = [];
    /** @type {Map<string, Array<{ words: string[], acronym: boolean, tagId: number, length: number }>>} */
    this.latin = new Map();
    const spellings = new Map();
    for (const tag of tags) {
      if (tag.state !== "active") continue;
      for (const name of [tag.name, tag.nameEn]) if (name) spellings.set(`${tag.id}\u0000${name}`, { tagId: tag.id, text: name });
    }
    for (const alias of aliases) {
      const tag = this.resolveId(alias.tagId);
      if (tag?.state === "active") spellings.set(`${tag.id}\u0000${alias.alias}`, { tagId: tag.id, text: alias.alias });
    }
    for (const { tagId, text } of spellings.values()) {
      const value = String(text).normalize("NFKC").trim();
      if (HAN.test(value)) {
        if ([...value].length >= 2) this.han.push({ text: tagKey(value), tagId });
        continue;
      }
      const acronym = ACRONYM.test(value);
      const words = (acronym ? [value] : value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      if (!words.length || (!acronym && words.join("").length < 4)) continue;
      const list = this.latin.get(words[0]) ?? [];
      list.push({ words, acronym, tagId, length: value.length });
      this.latin.set(words[0], list);
    }
  }

  /** The tag that stands for a row: itself, or the tag it was merged into. @param {number | null | undefined} id */
  resolveId(id) {
    let tag = id == null ? undefined : this.byId.get(Number(id));
    for (let hops = 0; tag && tag.state === "merged" && tag.mergedInto != null && hops < 8; hops += 1) tag = this.byId.get(tag.mergedInto);
    return tag ?? null;
  }

  /** The tag a name is a spelling of (resolved), or null. @param {unknown} name */
  byName(name) {
    const id = this.keys.get(tagKey(name));
    return id == null ? null : this.resolveId(id);
  }

  /** A tag by its address, resolved through a merge: `{ tag, mergedFrom }`, or null. @param {string} slug */
  bySlug(slug) {
    const found = this.bySlugMap.get(String(slug));
    if (!found) return null;
    const tag = this.resolveId(found.id);
    return tag ? { tag, mergedFrom: tag.id === found.id ? null : found.slug } : null;
  }

  /** Active tags only: the ones a reader sees. @param {number} id */
  shown(id) {
    const tag = this.resolveId(id);
    return tag?.state === "active" ? tag : null;
  }

  /**
   * The rows an item may carry to be listed under a tag: the tag, every tag merged into it, and its active narrower tags with
   * theirs.
   * @param {number} id @returns {number[]}
   */
  filterIds(id) {
    const root = this.resolveId(id);
    if (!root) return [];
    const heads = new Set([root.id]);
    for (const tag of this.byId.values()) if (tag.broaderId === root.id && tag.state === "active") heads.add(tag.id);
    const ids = new Set(heads);
    for (const tag of this.byId.values()) {
      const target = this.resolveId(tag.id);
      if (target && heads.has(target.id)) ids.add(tag.id);
    }
    return [...ids];
  }

  /**
   * The active tags a text names, best first: a name in the title counts three times; a longer spelling before a shorter one.
   * What an edit is shown as 「候选标签」 — offered, never imposed: the model writes what the item is about.
   * @param {{ title?: string | null, text?: string | null }} input @param {number} [limit]
   * @returns {FrontierTag[]}
   */
  candidatesFor({ title = "", text = "" }, limit = FRONTIER_TAG_CANDIDATES_MAX) {
    /** @type {Map<number, number>} */
    const score = new Map();
    /** @type {Map<number, number>} */
    const longest = new Map();
    const add = (/** @type {number} */ tagId, /** @type {number} */ weight, /** @type {number} */ length) => {
      score.set(tagId, (score.get(tagId) ?? 0) + weight);
      longest.set(tagId, Math.max(longest.get(tagId) ?? 0, length));
    };
    for (const [part, weight] of /** @type {Array<[string, number]>} */ ([[String(title ?? ""), 3], [String(text ?? ""), 1]])) {
      if (!part) continue;
      const key = tagKey(part);
      for (const { text: spelling, tagId } of this.han) if (key.includes(spelling)) add(tagId, weight, spelling.length);
      const raw = part.normalize("NFKC").split(/[^A-Za-z0-9]+/).filter(Boolean);
      const lower = raw.map((word) => word.toLowerCase());
      for (let index = 0; index < lower.length; index += 1) {
        const entries = [...(this.latin.get(lower[index]) ?? []), ...(raw[index] !== lower[index] ? this.latin.get(raw[index]) ?? [] : [])];
        for (const entry of entries) {
          if (entry.acronym) {
            if (raw[index] === entry.words[0]) add(entry.tagId, weight, entry.length);
            continue;
          }
          if (entry.words.every((word, offset) => lower[index + offset] === word)) add(entry.tagId, weight, entry.length);
        }
      }
    }
    return [...score.keys()]
      .map((id) => this.resolveId(id)).filter((tag) => tag?.state === "active")
      .filter((tag, index, list) => list.findIndex((other) => other?.id === tag?.id) === index)
      .sort((left, right) => (score.get(/** @type {any} */ (right).id) ?? 0) - (score.get(/** @type {any} */ (left).id) ?? 0)
        || (longest.get(/** @type {any} */ (right).id) ?? 0) - (longest.get(/** @type {any} */ (left).id) ?? 0))
      .slice(0, limit)
      .map((tag) => /** @type {FrontierTag} */ (tag));
  }
}

/**
 * What one item's tag answer comes to against the tree: the tags it names (resolved, in order, at most `FRONTIER_ITEM_TAG_LIMIT`),
 * and the names the tree does not know, which become candidates. A name of a rejected tag is dropped; a name that is a specialty,
 * a lane or an evidence type is not a tag and the caller leaves it out before (`frontierTagNameRefused`).
 * @param {FrontierTagVocabulary} vocabulary @param {readonly unknown[]} names
 * @returns {{ known: FrontierTag[], unknown: string[] }}
 */
export function frontierTagsOf(vocabulary, names) {
  /** @type {FrontierTag[]} */
  const known = [];
  /** @type {string[]} */
  const unknown = [];
  const seen = new Set();
  for (const value of names) {
    if (known.length + unknown.length >= FRONTIER_ITEM_TAG_LIMIT) break;
    const name = tagName(value);
    if (!name) continue;
    const tag = vocabulary.byName(name);
    if (tag) {
      if (tag.state === "rejected" || seen.has(`id:${tag.id}`)) continue;
      seen.add(`id:${tag.id}`);
      known.push(tag);
      continue;
    }
    const key = tagKey(name);
    if (seen.has(`key:${key}`)) continue;
    seen.add(`key:${key}`);
    unknown.push(name);
  }
  return { known, unknown };
}

/**
 * Names that are another dimension, never a tag: the thirty specialties, the eight lanes, the evidence types — by equality of
 * the key, a closed list (principle 5), so 「肿瘤」 is refused and 「肿瘤微环境」 is not.
 * @param {Iterable<string>} labels the closed vocabularies' Chinese labels
 */
export function frontierTagNameRefusal(labels) {
  const refused = new Set([...labels].map(tagKey));
  return (/** @type {string} */ name) => refused.has(tagKey(name));
}

/**
 * The seed file's rows, checked: a bad row stops the start by its slug rather than seeding a tree with a hole in it.
 * @param {any} seed
 * @returns {Array<{ slug: string, name: string, nameEn: string | null, kind: string | null, specialties: string[], broader: string | null,
 *   meshUi: string | null, aliases: string[], state: "active" | "candidate" | "rejected" }>}
 */
export function frontierTagSeedRows(seed) {
  const rows = Array.isArray(seed?.tags) ? seed.tags : null;
  if (!rows) throw new TypeError("frontierTagSeed.json: no tags.");
  const slugs = new Set();
  const keys = new Map();
  const out = rows.map((/** @type {any} */ row) => {
    const slug = typeof row?.slug === "string" ? row.slug : "";
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug) || slugs.has(slug)) throw new TypeError(`frontierTagSeed.json: the slug ${JSON.stringify(slug)} is invalid or repeated.`);
    slugs.add(slug);
    const name = tagName(row.name);
    if (!name) throw new TypeError(`frontierTagSeed.json: ${slug} has no usable name.`);
    // A refused name (the seed's first pass judged it no tag: a specialty, a study design, a generic word) is a row too, so an edit
    // that writes it again drops it at once instead of growing a candidate the upkeep refuses again.
    const state = row.state === "candidate" ? "candidate" : row.state === "rejected" ? "rejected" : "active";
    if (state !== "rejected" && !FRONTIER_TAG_KINDS.includes(row.kind)) throw new TypeError(`frontierTagSeed.json: ${slug} has no known kind.`);
    const specialties = (Array.isArray(row.specialties) ? row.specialties : []).map(specialtyOf).filter(Boolean).slice(0, 2);
    const aliases = [...new Set((Array.isArray(row.aliases) ? row.aliases : []).filter((alias) => typeof alias === "string" && alias.trim()).map((alias) => alias.trim()))];
    const key = tagKey(name);
    if (keys.has(key)) throw new TypeError(`frontierTagSeed.json: ${slug} and ${keys.get(key)} share the name ${name}.`);
    keys.set(key, slug);
    return { slug, name, nameEn: typeof row.nameEn === "string" && row.nameEn.trim() ? row.nameEn.trim().slice(0, 200) : null, kind: state === "rejected" ? null : row.kind,
      specialties: /** @type {string[]} */ (specialties), broader: typeof row.broader === "string" ? row.broader : null,
      meshUi: typeof row.meshUi === "string" && /^D\d{6,9}$/.test(row.meshUi) ? row.meshUi : null, aliases, state };
  });
  for (const row of out) if (row.broader && !slugs.has(row.broader)) throw new TypeError(`frontierTagSeed.json: ${row.slug} names an unknown broader tag.`);
  return out;
}

/** How often the cached vocabulary asks whether the tree moved. */
const VOCABULARY_CHECK_MS = 30_000;
/** How long a specialty's hot tags are kept. */
const HOT_CACHE_MS = 5 * 60_000;

/**
 * The tree in PostgreSQL (`evimed_frontier.tags`, `tag_aliases`, `item_tags`): the vocabulary an edit is matched against, the
 * links an edit writes, and what the reader and the filters read.
 */
export class FrontierTagStore {
  /** @param {{ database: any, now?: () => Date }} options */
  constructor({ database, now = () => new Date() }) {
    this.database = database;
    this.now = now;
    /** @type {{ vocabulary: FrontierTagVocabulary, checkedAt: number } | null} */
    this.cached = null;
    /** @type {Promise<FrontierTagVocabulary> | null} */
    this.loading = null;
    /** @type {Map<string, { at: number, rows: any[] }>} */
    this.hotCache = new Map();
  }

  /** Forget the cached tree (after a change this process made). */
  invalidate() {
    this.cached = null;
    this.hotCache.clear();
  }

  /** The tree as the tables hold it, reloaded when `tags_version` moved. @returns {Promise<FrontierTagVocabulary>} */
  async vocabulary() {
    const at = this.now().getTime();
    if (this.cached && at - this.cached.checkedAt < VOCABULARY_CHECK_MS) return this.cached.vocabulary;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const version = await this.database.query("SELECT (value #>> '{}')::bigint AS version FROM evimed_frontier.meta WHERE key = 'tags_version'");
        const current = Number(version.rows[0]?.version ?? 0);
        if (this.cached && this.cached.vocabulary.version === current) {
          this.cached.checkedAt = at;
          return this.cached.vocabulary;
        }
        const [tags, aliases] = await Promise.all([
          this.database.query(`SELECT id, slug, name, name_en, kind, specialties, broader_id, mesh_ui, state, merged_into
            FROM evimed_frontier.tags WHERE state <> 'rejected' OR id IN (SELECT tag_id FROM evimed_frontier.tag_aliases)`),
          this.database.query("SELECT key, tag_id, alias FROM evimed_frontier.tag_aliases"),
        ]);
        const vocabulary = new FrontierTagVocabulary(tags.rows.map(tagRow), aliases.rows.map((/** @type {any} */ row) => ({ key: row.key, tagId: Number(row.tag_id), alias: row.alias })), current);
        this.cached = { vocabulary, checkedAt: at };
        return vocabulary;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /**
   * Write an item's tags, in the caller's transaction: the names the tree knows link to their tags; a name it does not know becomes
   * a candidate (shown nowhere until promoted) and links to it; the item is marked tagged at `FRONTIER_TAG_VERSION`. Replaces
   * whatever the item carried.
   * @param {any} client @param {number | string} itemId @param {readonly unknown[]} names
   * @param {{ origin: "edit" | "retag", specialties?: readonly string[], refuse?: (name: string) => boolean }} options
   * @returns {Promise<{ linked: number, created: number }>}
   */
  async link(client, itemId, names, { origin, specialties = [], refuse = () => false }) {
    const vocabulary = await this.vocabulary();
    const { known, unknown } = frontierTagsOf(vocabulary, names.filter((name) => typeof name === "string" && !refuse(name)));
    /** @type {Array<{ id: number, rank: number }>} */
    const links = known.map((tag, index) => ({ id: tag.id, rank: index }));
    let created = 0;
    for (const name of unknown) {
      const key = tagKey(name);
      const found = await client.query("SELECT tag_id FROM evimed_frontier.tag_aliases WHERE key = $1", [key]);
      let id = found.rows[0] ? Number(found.rows[0].tag_id) : null;
      if (id === null) {
        const inserted = await client.query(`INSERT INTO evimed_frontier.tags (slug, name, specialties, state, origin)
          VALUES ('c-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12), $1, $2, 'candidate', 'model') RETURNING id`,
        [name, specialties.map(specialtyOf).filter(Boolean).slice(0, 2)]);
        id = Number(inserted.rows[0].id);
        const aliased = await client.query(`INSERT INTO evimed_frontier.tag_aliases (key, tag_id, alias, origin) VALUES ($1, $2, $3, 'model')
          ON CONFLICT (key) DO NOTHING RETURNING tag_id`, [key, id, name]);
        if (!aliased.rowCount) {
          // Another edit created it meanwhile: use that one.
          await client.query("DELETE FROM evimed_frontier.tags WHERE id = $1", [id]);
          const again = await client.query("SELECT tag_id FROM evimed_frontier.tag_aliases WHERE key = $1", [key]);
          id = Number(again.rows[0].tag_id);
        } else created += 1;
      }
      const tag = vocabulary.resolveId(id);
      if (tag?.state === "rejected") continue;
      const target = tag?.id ?? id;
      if (!links.some((link) => link.id === target)) links.push({ id: target, rank: links.length });
    }
    await client.query("DELETE FROM evimed_frontier.item_tags WHERE item_id = $1", [itemId]);
    if (links.length) {
      await client.query(`INSERT INTO evimed_frontier.item_tags (item_id, tag_id, rank, origin)
        SELECT $1, r.id, r.rank, $3 FROM jsonb_to_recordset($2::jsonb) AS r(id bigint, rank smallint) ON CONFLICT DO NOTHING`,
      [itemId, JSON.stringify(links.slice(0, FRONTIER_ITEM_TAG_LIMIT)), origin]);
    }
    await client.query("UPDATE evimed_frontier.items SET tag_version = $2, tag_claim_until = NULL WHERE id = $1", [itemId, FRONTIER_TAG_VERSION]);
    return { linked: Math.min(links.length, FRONTIER_ITEM_TAG_LIMIT), created };
  }

  /**
   * The tags a reader sees on each item: active, resolved through merges, each once, in the item's order, at most
   * `FRONTIER_ITEM_TAG_LIMIT`.
   * @param {Array<number | string>} itemIds @returns {Promise<Map<string, Array<{ slug: string, name: string }>>>}
   */
  async itemTags(itemIds) {
    /** @type {Map<string, Array<{ slug: string, name: string }>>} */
    const out = new Map();
    if (!itemIds.length) return out;
    const vocabulary = await this.vocabulary();
    const rows = await this.database.query(`SELECT item_id, tag_id FROM evimed_frontier.item_tags WHERE item_id = ANY($1::bigint[]) ORDER BY item_id, rank`,
      [itemIds.map(String)]);
    for (const row of rows.rows) {
      const tag = vocabulary.shown(Number(row.tag_id));
      if (!tag) continue;
      const list = out.get(String(row.item_id)) ?? [];
      if (list.length < FRONTIER_ITEM_TAG_LIMIT && !list.some((entry) => entry.slug === tag.slug)) list.push({ slug: tag.slug, name: tag.name });
      out.set(String(row.item_id), list);
    }
    return out;
  }

  /**
   * The rows an item may carry to be listed under a tag (`FrontierTagVocabulary#filterIds`), or null for an address the tree does
   * not have.
   * @param {string} slug @returns {Promise<{ ids: number[], tag: FrontierTag } | null>}
   */
  async filter(slug) {
    const vocabulary = await this.vocabulary();
    const found = vocabulary.bySlug(slug);
    if (!found || found.tag.state === "rejected" || found.tag.state === "candidate") return null;
    return { ids: vocabulary.filterIds(found.tag.id), tag: found.tag };
  }

  /**
   * The active tags of some specialties, by published items of the last thirty days, most first (the 「专科」 panel's 热门标签).
   * @param {readonly string[]} specialties @param {number} limit
   * @returns {Promise<Array<{ slug: string, name: string, count: number }>>}
   */
  async hot(specialties, limit) {
    const keys = [...new Set(specialties.map(specialtyOf).filter(Boolean))].sort();
    const cacheKey = `${keys.join(",")}|${limit}`;
    const at = this.now().getTime();
    const cached = this.hotCache.get(cacheKey);
    if (cached && at - cached.at < HOT_CACHE_MS) return cached.rows;
    const vocabulary = await this.vocabulary();
    const result = await this.database.query(`SELECT it.tag_id, count(DISTINCT it.item_id)::integer AS n
      FROM evimed_frontier.item_tags it JOIN evimed_frontier.items i ON i.id = it.item_id
      WHERE i.state = 'published' AND i.timeline_at > $1::timestamptz
      GROUP BY it.tag_id`, [new Date(at - FRONTIER_TAG_RULES.windowDays * 86_400_000).toISOString()]);
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (const row of result.rows) {
      const tag = vocabulary.shown(Number(row.tag_id));
      if (!tag || (keys.length && !tag.specialties.some((key) => keys.includes(key)))) continue;
      counts.set(tag.id, (counts.get(tag.id) ?? 0) + Number(row.n));
    }
    const rows = [...counts].sort((left, right) => right[1] - left[1]).slice(0, limit)
      .map(([id, count]) => { const tag = /** @type {FrontierTag} */ (vocabulary.byId.get(id)); return { slug: tag.slug, name: tag.name, count }; });
    this.hotCache.set(cacheKey, { at, rows });
    return rows;
  }

  /**
   * Active tags whose name or a spelling contains the text, the most used first (the search box's suggestions).
   * @param {string} text @param {number} limit
   * @returns {Promise<Array<{ slug: string, name: string, count: number, specialties: string[] }>>}
   */
  async suggest(text, limit) {
    const key = tagKey(text);
    if (!key) return [];
    const vocabulary = await this.vocabulary();
    /** @type {Set<number>} */
    const ids = new Set();
    for (const [spelling, id] of vocabulary.keys) {
      if (!spelling.includes(key)) continue;
      const tag = vocabulary.shown(id);
      if (tag) ids.add(tag.id);
    }
    if (!ids.size) return [];
    const counts = await this.hot([], 5_000);
    const count = new Map(counts.map((row) => [row.slug, row.count]));
    return [...ids].map((id) => /** @type {FrontierTag} */ (vocabulary.byId.get(id)))
      .map((tag) => ({ slug: tag.slug, name: tag.name, count: count.get(tag.slug) ?? 0, specialties: tag.specialties, exact: tagKey(tag.name).startsWith(key) }))
      .sort((left, right) => Number(right.exact) - Number(left.exact) || right.count - left.count || left.name.length - right.name.length)
      .slice(0, limit)
      .map(({ exact: _exact, ...row }) => row);
  }

  /**
   * One tag as its address names it: its names, specialties, the broader tag and the narrower ones, how many items carried it in
   * thirty days; a merged one answers as the tag it was merged into. Null for an address the tree does not show.
   * @param {string} slug
   */
  async detail(slug) {
    const vocabulary = await this.vocabulary();
    const found = vocabulary.bySlug(slug);
    if (!found || found.tag.state !== "active") return null;
    const { tag } = found;
    const counts = await this.hot([], 5_000);
    const broader = tag.broaderId != null ? vocabulary.shown(tag.broaderId) : null;
    const narrower = [...vocabulary.byId.values()].filter((other) => other.broaderId === tag.id && other.state === "active")
      .map((other) => ({ slug: other.slug, name: other.name }));
    return {
      tag: { slug: tag.slug, name: tag.name, nameEn: tag.nameEn, specialties: tag.specialties, broader: broader ? { slug: broader.slug, name: broader.name } : null,
        narrower, count30d: counts.find((row) => row.slug === tag.slug)?.count ?? 0 },
      mergedFrom: found.mergedFrom,
    };
  }
}

/** A `tags` row as the vocabulary holds it. @param {any} row @returns {FrontierTag} */
export function tagRow(row) {
  return { id: Number(row.id), slug: row.slug, name: row.name, nameEn: row.name_en ?? null, kind: row.kind ?? null,
    specialties: Array.isArray(row.specialties) ? row.specialties : [], broaderId: row.broader_id == null ? null : Number(row.broader_id),
    meshUi: row.mesh_ui ?? null, state: row.state, mergedInto: row.merged_into == null ? null : Number(row.merged_into) };
}
