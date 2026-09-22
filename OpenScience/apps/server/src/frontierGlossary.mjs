/**
 * The frontier editor's glossary: the one Chinese name a drug, an agency or a
 * trial is given (plan §10.3.6).
 *
 * Hidden knowledge:
 *
 * - **Only what the text names reaches the prompt.** The glossary holds a few
 *   thousand pairs (NMPA generic names from the pharmacy base data, plus a short
 *   hand-kept list in `frontierGlossarySeed.json`); an item's prompt carries
 *   only the entries its own text contains, so the stable prompt prefix the
 *   provider caches never changes and a term the item never mentions never
 *   costs a token.
 * - **Latin terms match whole words, case-insensitively — except acronyms.**
 *   `semaglutide` matches Semaglutide but not semaglutides; an all-capitals term
 *   of up to eight characters (WHO, NICE, SELECT, KEYNOTE) matches only as written,
 *   because in lower case it is an English word ("patients who", "a nice
 *   result") and a hint for it would only teach the model noise.
 * - **Chinese terms match as substrings** — Chinese has no word boundary to
 *   honour — and only from two characters up.
 * - **Entity keys are language-independent where the glossary knows the
 *   term.** 司美格鲁肽 from a Chinese source and semaglutide from an English one
 *   both key as `drug:semaglutide`, which is what lets a follow, an event and a
 *   search find both; a name the glossary does not know keys as itself,
 *   normalised.
 * - The glossary is derived data with an owner: the table is filled by
 *   `scripts/ops/seed-frontier-glossary.mjs`, and a hand-kept row (`origin`
 *   `hand`) is never overwritten by a generated one.
 *
 * @module frontierGlossary
 */

/** @typedef {"drug" | "disease" | "org" | "trial" | "method" | "other"} GlossaryKind */
/** @typedef {{ kind: GlossaryKind, termEn: string, termZh: string, keepOriginal: boolean, origin?: string }} GlossaryEntry */

export const GLOSSARY_KINDS = Object.freeze(["drug", "disease", "org", "trial", "method", "other"]);

/** The most entries one prompt carries: a long abstract names a dozen drugs at most. */
export const GLOSSARY_MAX_HITS = 30;

/** Entity kinds as the editor writes them, and the glossary kind each keys against. */
export const ENTITY_KINDS = Object.freeze({ drugs: "drug", trials: "trial", orgs: "org", diseases: "disease" });

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;

/** @param {string} term */
function isAcronym(term) {
  return /^[A-Z][A-Z0-9-]{1,7}$/.test(term) && /[A-Z]{2}/.test(term);
}

/** Lower-case alphanumeric runs: the tokens a Latin term and a text are compared by.
 * @param {string} text */
function latinTokens(text) {
  return [...String(text ?? "").normalize("NFKC").matchAll(/[A-Za-z0-9]+/g)].map((match) => ({
    token: match[0], lower: match[0].toLowerCase(), at: match.index ?? 0,
  }));
}

/**
 * A name in the form keys are made from: NFKC, trimmed, one space, lower case.
 * @param {unknown} name
 */
export function normalizeEntityName(name) {
  return String(name ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export class FrontierGlossary {
  /** @param {Iterable<GlossaryEntry>} [entries] */
  constructor(entries = []) {
    /** @type {GlossaryEntry[]} */
    this.entries = [];
    /** Latin: first token → entries whose token sequence starts with it. @type {Map<string, Array<{ entry: GlossaryEntry, tokens: string[], exact: boolean }>>} */
    this.latin = new Map();
    /** Chinese: first two characters → entries. @type {Map<string, GlossaryEntry[]>} */
    this.chinese = new Map();
    /** Entity keys: `${kind}\u0000${normalised name}` → canonical English. @type {Map<string, string>} */
    this.canonical = new Map();
    for (const entry of entries) this.#add(entry);
    // Synonyms share one key: every English name of one Chinese name (aspirin,
    // acetylsalicylic acid → 阿司匹林) keys as the shortest of them, so a
    // Chinese source and an English one meet whichever synonym each used.
    /** @type {Map<string, string>} */
    const shortest = new Map();
    for (const entry of this.entries) {
      const group = `${entry.kind}\u0000${normalizeEntityName(entry.termZh)}`;
      const name = entry.termEn.toLowerCase();
      const current = shortest.get(group);
      if (current === undefined || name.length < current.length || (name.length === current.length && name < current)) shortest.set(group, name);
    }
    for (const entry of this.entries) {
      const canonical = /** @type {string} */ (shortest.get(`${entry.kind}\u0000${normalizeEntityName(entry.termZh)}`));
      for (const name of [entry.termEn, entry.termZh]) this.canonical.set(`${entry.kind}\u0000${normalizeEntityName(name)}`, canonical);
    }
  }

  /** @param {GlossaryEntry} entry */
  #add(entry) {
    const termEn = String(entry?.termEn ?? "").trim();
    const termZh = String(entry?.termZh ?? "").trim();
    if (!GLOSSARY_KINDS.includes(entry?.kind) || termEn.length < 2 || !termZh) return;
    const clean = { kind: entry.kind, termEn, termZh, keepOriginal: entry.keepOriginal === true, origin: entry.origin };
    this.entries.push(clean);
    const exact = isAcronym(termEn);
    const tokens = latinTokens(termEn).map((token) => (exact ? token.token : token.lower));
    if (tokens.length) {
      const first = exact ? tokens[0] : tokens[0].toLowerCase();
      const list = this.latin.get(first) ?? [];
      list.push({ entry: clean, tokens, exact });
      this.latin.set(first, list);
    }
    if (CJK.test(termZh) && [...termZh].length >= 2 && !clean.keepOriginal) {
      const head = [...termZh].slice(0, 2).join("");
      const list = this.chinese.get(head) ?? [];
      list.push(clean);
      this.chinese.set(head, list);
    }
  }

  get size() { return this.entries.length; }

  /**
   * The entries a text names, in the order it names them, at most
   * `GLOSSARY_MAX_HITS`.
   * @param {unknown} text
   * @returns {GlossaryEntry[]}
   */
  match(text) {
    const source = String(text ?? "").normalize("NFKC");
    /** @type {Array<{ at: number, entry: GlossaryEntry }>} */
    const hits = [];
    const seen = new Set();
    /** @param {number} at @param {GlossaryEntry} entry */
    const hit = (at, entry) => {
      const id = `${entry.kind}\u0000${entry.termEn}`;
      if (seen.has(id)) return;
      seen.add(id);
      hits.push({ at, entry });
    };
    const tokens = latinTokens(source);
    for (let index = 0; index < tokens.length; index += 1) {
      const candidates = [...(this.latin.get(tokens[index].lower) ?? []), ...(this.latin.get(tokens[index].token) ?? [])];
      for (const { entry, tokens: wanted, exact } of candidates) {
        if (index + wanted.length > tokens.length) continue;
        const matches = wanted.every((token, offset) => (exact ? tokens[index + offset].token : tokens[index + offset].lower) === token);
        if (matches) hit(tokens[index].at, entry);
      }
    }
    const chars = [...source];
    let offset = 0;
    for (let index = 0; index < chars.length - 1; index += 1) {
      const candidates = this.chinese.get(chars[index] + chars[index + 1]);
      if (candidates) for (const entry of candidates) if (source.startsWith(entry.termZh, offset)) hit(offset, entry);
      offset += chars[index].length;
    }
    return hits.sort((left, right) => left.at - right.at).slice(0, GLOSSARY_MAX_HITS).map((item) => item.entry);
  }

  /**
   * The key an entity is followed, clustered and searched by:
   * `<kind>:<canonical English, lower case>` when the glossary knows the name
   * in either language, else `<kind>:<the name, normalised>`. Null for an
   * empty name or an unknown kind.
   * @param {"drug" | "trial" | "org" | "disease"} kind @param {unknown} name
   * @returns {string | null}
   */
  entityKey(kind, name) {
    if (!["drug", "trial", "org", "disease"].includes(kind)) return null;
    const normalized = normalizeEntityName(name);
    if (!normalized) return null;
    const canonical = this.canonical.get(`${kind}\u0000${normalized}`) ?? normalized;
    return `${kind}:${canonical}`.slice(0, 160);
  }

  /**
   * Every key of an item's entities, deduplicated, in a stable order.
   * @param {{ drugs?: unknown, trials?: unknown, orgs?: unknown, diseases?: unknown } | null | undefined} entities
   * @returns {string[]}
   */
  entityKeys(entities) {
    const keys = new Set();
    for (const [field, kind] of Object.entries(ENTITY_KINDS)) {
      const names = Array.isArray(entities?.[/** @type {keyof typeof ENTITY_KINDS} */ (field)]) ? entities[field] : [];
      for (const name of names) {
        const key = this.entityKey(/** @type {any} */ (kind), name);
        if (key) keys.add(key);
      }
    }
    return [...keys];
  }
}

/**
 * The glossary as the pipeline reads it: loaded from `evimed_frontier.glossary`
 * once, reloaded after `ttlMs`, and kept when a reload fails — a stale
 * glossary costs a translation's consistency, an empty one costs all of it.
 */
export class FrontierGlossaryStore {
  /**
   * @param {{ database: any, ttlMs?: number, now?: () => number }} options
   */
  constructor({ database, ttlMs = 60 * 60_000, now = () => Date.now() }) {
    this.database = database;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {FrontierGlossary | null} */
    this.glossary = null;
    this.loadedAt = 0;
    /** @type {string | null} */
    this.lastError = null;
    /** @type {Promise<FrontierGlossary> | null} */
    this.loading = null;
  }

  /** @returns {Promise<FrontierGlossary>} */
  async current() {
    if (this.glossary && this.now() - this.loadedAt < this.ttlMs) return this.glossary;
    if (!this.loading) {
      this.loading = this.#load().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  /** @returns {Promise<FrontierGlossary>} */
  async #load() {
    try {
      const result = await this.database.query(
        "SELECT kind, term_en, term_zh, keep_original, origin FROM evimed_frontier.glossary ORDER BY kind, term_en");
      this.glossary = new FrontierGlossary(result.rows.map((/** @type {any} */ row) => ({
        kind: row.kind, termEn: row.term_en, termZh: row.term_zh, keepOriginal: row.keep_original, origin: row.origin,
      })));
      this.lastError = null;
    } catch (error) {
      this.lastError = typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "frontier_glossary_unreadable";
      this.glossary ??= new FrontierGlossary([]);
    }
    this.loadedAt = this.now();
    return this.glossary;
  }
}
