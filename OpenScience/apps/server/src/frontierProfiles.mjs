/**
 * 「与你相关」: the frontier feed's per-reader ranking (plan §4.6, §6.5, §10.5.3;
 * rebuilt 2026-09-24 on what the reader actually shows interest in).
 *
 * Content is written once for everyone; personalization only re-orders what
 * is already written. A reader's profile — specialties and at most ten
 * interest phrases, each naming what it came from — is extracted by one model
 * call and the phrases are embedded; the published items of the last 72 hours
 * (7 days when that holds fewer than 20) are ranked against it in SQL, and the
 * top eight are cached with the phrase that picked each: that phrase is the
 * heading the reader sees the item under.
 *
 * Hidden knowledge:
 *
 * - **Two more signals, entities and not words (flywheel F11, 2026-10-05).** The evidence zones the reader follows
 *   and the documents of their own knowledge base: each is tagged with the platform's one entity vocabulary
 *   (`entityVocabulary.mjs` — a zone by its title, description and the keys its published cards carry; a document
 *   by its title and the summary its understanding run stored), the keys that recur most are turned into the names
 *   a reader knows them by, and they join the profile as phrases beside the model's. No model reads them: a key is a
 *   glossary lookup, so a reader who follows a zone and has asked nothing yet is a profile at last. Only the
 *   reader's own rows are read, and a paused or internal project's documents stay out as its memories do. A phrase
 *   from a zone says 「因为你关注的专区涉及」 and one from the library 「因为你的知识库里有」; neither is ever a
 *   fact written anywhere, only the heading of a group of news items.
 * - **What the reader shows interest in, three ways.** Their memory of every
 *   provenance — stated, confirmed, edited, inferred, from a tool or from the
 *   assistant — that is active and not sensitive (at most 40, by importance);
 *   the questions of their own conversations of the last 30 days (at most 30,
 *   newest first, `frontierProfileQuestions`); and the feed items they starred
 *   or opened in the last 60 days (at most 30, stars first). Left out: run
 *   summaries; memories and questions of a project the reader paused and of
 *   the platform's internal projects; deleted conversations and work a
 *   machine started. Everything is left out when the reader paused recall —
 *   for them the block is off. An inferred memory feeds a ranking and nothing
 *   else: it is at most the heading of a group of news items, never written
 *   anywhere as a fact (principle 18).
 * - **Every phrase keeps where it came from** — `memory` with the memory's
 *   id, `question`, or `frontier-item`. A memory the reader deleted or archived
 *   since the ranking was cached takes its items with it at once, without a
 *   new ranking; the other two are read again at the next profile.
 * - **What the reader hid pushes back.** An item marked 「不感兴趣」 keeps out
 *   every candidate of its event and, where there are vectors, every candidate
 *   whose cosine to it is at least `FRONTIER_FOR_YOU_HIDDEN_COSINE`. Items the
 *   reader already starred or opened are not recommended to them again.
 * - **Ranking (ct-track, 2026-10-24).** Every published item of the window that passes the reader's hidden and muted
 *   filters is a candidate (the newest 300). Its reasons are the profile's phrases (a phrase vector's cosine, at or above
 *   the 0.4 floor; or a keyword hit), what the reader told onboarding (a tag or entity key of interest), what they follow
 *   (a positive follow's predicate), and their specialties (onboarding's, else the ones the model extracted — finally
 *   used — matching items of 精选 quality). An (item, reason) pair ranks by its match, plus an editorial share of the
 *   item's score out of 100 that shrinks with the reader's visit days (0.3 for a newcomer, 0.2 at five, toward 0.1: the
 *   editor beats the algorithm for a reader the platform barely knows, Claussen, Peukert & Sen), plus the reader's genre
 *   affinity (Beta-smoothed opens and satisfied reads over seen impressions, a hide an extra failure, priors by role —
 *   a pharmacist leans to safety, approval, policy and guideline). A reason picks at most two items (a specialty four),
 *   so one interest never fills the block. Vectors, not the rerank service (§10.5.3): that service returns an order
 *   without scores and cannot say which phrase matched. Every constant is in `FRONTIER_RANKING`.
 * - **Slots.** Up to two `must-see` entries first — a safety alert of the last 72 hours that names one of the reader's
 *   specialties or none, then a selected guideline or approval in their specialties; then the `personal` entries; then,
 *   while fewer than seven, the editor's (`editorial`, 精选 by score); and one `explore` entry, drawn uniformly at random from
 *   the best items the profile matched nothing of, at the first group boundary from the fourth place, with its
 *   propensity (1 / the pool's size) recorded so the ranking can be evaluated off-policy. A reader with nothing at all is
 *   served 精选 (and the exploration entry), never an empty block.
 * - **Served in display order.** The block groups entries under their reason's topic; the server orders entries so each
 *   topic's run is contiguous, so an entry's index in the answer is the position it is displayed at (contract C).
 * - **Without vectors it says so.** No embedder, no pgvector, or no phrase
 *   vector: the phrases are matched as keywords against the items' own search
 *   lexemes, and the answer's `basis` is `tags` — never a ranking that
 *   pretends to be semantic.
 * - **Fresh within a round, not a day.** A profile is due when it is missing
 *   or a day old, and as soon as what it was read from changes: a star or an
 *   unstar, a researcher's new or deleted question (`noteConversation`), a
 *   change to their memory (its count, versions and latest change, kept as
 *   `memory_mark`), and — for a reader who has nothing yet — an item opened or
 *   the block opened. A hide changes nothing the model reads and only drops
 *   the cached ranking. Readers who opened the block since their profile was
 *   computed go first. Each round computes at most five profiles, one model
 *   call each, and none while the day's budget is past its threshold.
 * - **States, honestly.** `off`: this deployment has no memory store or no
 *   model to read it with — the block is absent — or this reader paused recall
 *   (`paused: true`). `unavailable`: the memory store failed when it was last
 *   read — the page says 「暂时不可用」 and the rest goes on (§10.5.3). Nothing
 *   to show yet is `available` with no items. Never a guessed hit.
 * - **The read path makes no model call and no embedding call.** A reader
 *   whose profile is not computed yet is ranked from what SQL knows (onboarding,
 *   follows, specialties, 精选) until the composer's next round computes it; a
 *   cached ranking older than six hours, or dropped by a hide, a follow or a
 *   saved onboarding answer, is recomputed in SQL alone.
 * - **Onboarding (ct-track).** `prefs` / `savePrefs`: a role, one to three specialties, up to ten interests (tag slugs or
 *   entity keys), and when it was finished or skipped. The answer of `forYou` says `onboarding: true` while the reader has
 *   neither answered nor skipped and the platform knows too little of them (no phrase and fewer than five opened items);
 *   the page shows its skippable card then, and never again once it is answered or skipped.
 *
 * @module frontierProfiles
 */

import { FRONTIER_DWELL, FRONTIER_GENRE_LABELS_ZH, FRONTIER_GENRES, FRONTIER_ONBOARDING_LIMITS, FRONTIER_READER_ROLES, FRONTIER_SPECIALTIES, FRONTIER_SPECIALTY_LABELS_ZH,
  frontierSpecialtyKey, isFrontierGenre } from "@evimed/domain";
import { isEntityKey, splitKeys } from "@evimed/domain/entity-keys";
import { FrontierSubscriptions, frontierFollowPredicate } from "./frontierSubscriptions.mjs";
import { FRONTIER_PHRASE_LIMITS } from "./frontierEditor.mjs";
import { FRONTIER_GENRE_COLUMNS, frontierItemGenre } from "./frontierInteractions.mjs";
import { migrateFrontier } from "./frontierPersistence.mjs";
import { frontierSelectThreshold } from "./frontierPipeline.mjs";
import { HttpError } from "./security.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { tsqueryLiteral } from "./kbChunker.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A profile is extracted again after this long even when nothing changed (plan §10.5.3). */
export const FRONTIER_PROFILE_TTL_MS = DAY;
/** A cached ranking is recomputed after this long. */
export const FRONTIER_FOR_YOU_TTL_MS = 6 * HOUR;
/** Readers seen in this long get a profile. */
export const FRONTIER_PROFILE_ACTIVE_MS = 14 * DAY;
/** Items the block shows. */
export const FRONTIER_FOR_YOU_SIZE = 8;
/** Items one phrase may pick: one interest never fills the block. */
export const FRONTIER_FOR_YOU_PER_PHRASE = 2;
/** Candidates ranked, newest first: a few days of published items. */
export const FRONTIER_FOR_YOU_CANDIDATES = 300;
/** The window ranked, and the wider one used when it holds too few candidates. */
export const FRONTIER_FOR_YOU_WINDOW_MS = 72 * HOUR;
export const FRONTIER_FOR_YOU_WIDE_WINDOW_MS = 7 * DAY;
export const FRONTIER_FOR_YOU_MIN_CANDIDATES = 20;
/**
 * Below this cosine a phrase is not a reason: an item near nothing the reader
 * showed interest in is not 「与你相关」. A starting point to be read against the
 * measured distribution, as the selection threshold is.
 */
export const FRONTIER_FOR_YOU_MIN_COSINE = 0.4;
/** The share of the editorial score (out of 100) added to a cosine: 0.1 lifts a 90-point item 0.04 over a 50-point one. */
export const FRONTIER_FOR_YOU_EDITORIAL_SHARE = 0.1;
/**
 * A candidate at least this close to an item the reader hid is dropped: the
 * same story again, or its twin. Uncalibrated — item-to-item cosines of the
 * embedding pin were not measured when it was set; read it against the
 * `hiddenDropped` counter and the reader's hides before moving it.
 */
export const FRONTIER_FOR_YOU_HIDDEN_COSINE = 0.85;
/** The entity keys kept on one phrase: a phrase is about a few things, and the demand signal counts each. */
const FRONTIER_PROFILE_PHRASE_ENTITY_KEYS = 12;
/** Entity phrases a profile adds from followed zones and from the library, each at most (the model's own are ten). */
export const FRONTIER_PROFILE_ENTITY_PHRASES = Object.freeze({ zone: 3, library: 3 });
/** Followed zones, their cards and library documents read for those keys, at most. */
export const FRONTIER_PROFILE_ENTITY_LIMITS = Object.freeze({ zones: 50, zoneCards: 200, documents: 60 });
/** The kinds of key a phrase is made of: what a record is about, not who said it. */
const ENTITY_PHRASE_KINDS = new Set(["drug", "disease", "trial"]);
/** The windows the signals are read over. */
export const FRONTIER_PROFILE_QUESTION_WINDOW_MS = 30 * DAY;
export const FRONTIER_PROFILE_ITEM_WINDOW_MS = 60 * DAY;
/** The hides weighed against candidates, most recent first. */
const HIDDEN_LIMIT = 100;
/** Memory kinds that describe what a researcher works on. */
const WORK_KINDS = new Set(["project_fact", "analysis", "decision", "follow_up"]);
/** A failed refresh is not tried again for this long. */
const RETRY_MS = HOUR;
/** The memory store is reported unavailable this long after it last failed. */
const UNAVAILABLE_MS = 15 * MINUTE;
/** How often one reader's opening of the block is written, at most. */
const VISIT_INTERVAL_MS = 10 * MINUTE;
/** Conversation changes remembered as already noted, so a run's every state change is not a write. */
const NOTED_LIMIT = 5_000;
/**
 * What a reader's memory was when a profile read it: how many records, the sum
 * of their versions (every write moves one) and the latest change. Any
 * insert, update, archive or delete moves it; comparing it needs no clock.
 */
const MEMORY_MARK = "count(*)::text || ':' || coalesce(sum(r.version), 0)::text || ':' || coalesce(extract(epoch FROM max(r.updated_at))::text, '')";

// ───────────────────────── pure decisions (unit-tested) ─────────────────────────

/**
 * The memories a profile may be built from, as the model is shown them, in
 * the order given (the store's: by importance). Every provenance counts; run
 * summaries, sensitive and inactive records, and records of a paused or
 * internal project do not.
 * @param {any[]} records `researchMemory.listAllRecords` rows
 * @param {{ pausedProjects?: string[] }} [settings]
 * @returns {Array<{ id: string, kind: string, text: string }>}
 */
export function frontierProfileMemories(records, { pausedProjects = [] } = {}) {
  const paused = new Set(pausedProjects.map(String));
  return (Array.isArray(records) ? records : [])
    .filter((record) => record?.status === "active" && record?.kind !== "run_summary" && record?.sensitive !== true
      && (record?.scope === "user" || (record?.scope === "project" && !paused.has(String(record.scopeId)) && !isInternalProject(record.scopeId))))
    .map((record) => ({ id: String(record.id), kind: String(record.kind), text: String(record.summary || record.value || "").replace(/\s+/g, " ").trim() }))
    .filter((memory) => memory.text);
}

/**
 * The questions a profile may be read from: the researcher's own
 * conversations since `since` — not deleted, not in a paused or internal
 * project — newest first, each question once, at most 30. A run is read by
 * what was asked; one without a question by its title when a person or the
 * titler gave it one, never by a placeholder.
 * @param {Array<{ projectId: string, run: Record<string, any> }>} entries a researcher's own runs (`isResearcherRun`), by project
 * @param {{ since?: Date, pausedProjects?: string[] }} [options]
 * @returns {Array<{ text: string, at: string }>}
 */
export function frontierProfileQuestions(entries, { since = new Date(0), pausedProjects = [] } = {}) {
  const paused = new Set(pausedProjects.map(String));
  const cutoff = since.getTime();
  const usable = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.run && entry.run.deleted !== true && !isInternalProject(entry.projectId) && !paused.has(String(entry.projectId))
      && Date.parse(String(entry.run.startedAt ?? "")) >= cutoff)
    .sort((left, right) => String(right.run.startedAt).localeCompare(String(left.run.startedAt)));
  const seen = new Set();
  /** @type {Array<{ text: string, at: string }>} */
  const questions = [];
  for (const { run } of usable) {
    const asked = typeof run.question === "string" && run.question.trim() ? run.question
      : (run.titleSource === "user" || run.titleSource === "auto") && typeof run.title === "string" ? run.title : "";
    const text = asked.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    questions.push({ text, at: String(run.startedAt) });
    if (questions.length >= FRONTIER_PHRASE_LIMITS.questions) break;
  }
  return questions;
}

/**
 * What the block says a phrase is to the reader: what they work on, what they
 * asked, or what they follow — by what the phrase came from.
 * @param {{ text: string, kind?: string | null }} phrase
 */
export function frontierReasonText(phrase) {
  const kind = String(phrase.kind ?? "");
  // An entry with no reason of the reader's — the editor's pick, a must-see, the exploration entry — is named by its topic alone.
  if (kind === "editorial" || kind === "must-see" || kind === "explore") return String(phrase.text);
  const lead = WORK_KINDS.has(kind) ? "因为你在做" : kind === "question" ? "因为你问过" : kind === "zone" ? "因为你关注的专区涉及"
    : kind === "library" ? "因为你的知识库里有" : "因为你关注";
  return `${lead}：${phrase.text}`;
}

/**
 * Where a stored phrase or cached entry came from. One written before the
 * other signals existed names only a memory.
 * @param {{ source?: unknown, memoryId?: unknown }} entry @returns {"memory" | "question" | "frontier-item" | "zone" | "library"}
 */
export function frontierPhraseSource(entry) {
  const source = entry?.source;
  return source === "question" || source === "frontier-item" || source === "zone" || source === "library" ? source : "memory";
}

/** Where a cached entry's reason came from: a profile phrase's source, or what the reader stated, or no reason of theirs. */
const STATED_SOURCES = new Set(["interest", "follow", "specialty", "editorial", "must-see", "explore"]);

/**
 * Where a cached entry of the block came from: a phrase's sources (`frontierPhraseSource`), what the reader stated (`interest`,
 * `follow`, `specialty`) or no reason of theirs (`editorial`, `must-see`, `explore`).
 * @param {{ source?: unknown, memoryId?: unknown }} entry
 * @returns {"memory" | "question" | "frontier-item" | "zone" | "library" | "interest" | "follow" | "specialty" | "editorial" | "must-see" | "explore"}
 */
export function frontierReasonSource(entry) {
  return typeof entry?.source === "string" && STATED_SOURCES.has(entry.source) ? /** @type {any} */ (entry.source) : frontierPhraseSource(entry);
}

/**
 * The keys that recur most, kept to the kinds a phrase is made of: a count of how many records carry each, most first,
 * ties by the key itself so the same inputs give the same phrases.
 * @param {Iterable<string[]>} keyLists one list of keys per record @param {number} limit
 * @returns {string[]}
 */
export function frontierRecurringEntityKeys(keyLists, limit) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const list of keyLists) {
    for (const key of new Set(splitKeys(list).entityKeys)) {
      if (ENTITY_PHRASE_KINDS.has(key.slice(0, key.indexOf(":")))) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).slice(0, limit).map(([key]) => key);
}

/** A vector as stored with a phrase: float32, little-endian, base64. @param {number[]} vector */
export function encodeVector(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

/** @param {unknown} value @param {number} dimension @returns {number[] | null} */
export function decodeVector(value, dimension) {
  if (typeof value !== "string" || !value) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== dimension * 4) return null;
  // Read float by float: a small decoded Buffer is a slice of Node's shared
  // pool, and its offset need not be the multiple of four a Float32Array view
  // over it requires.
  const vector = Array.from({ length: dimension }, (_, index) => bytes.readFloatLE(index * 4));
  return vector.every(Number.isFinite) ? vector : null;
}

// ───────────────────────── the ranking's constants and its pure parts (ct-track) ─────────────────────────

/**
 * Every constant of 与我相关's ranking, in one place. Each is a starting point to be read against the measured distribution
 * (`/api/ops/frontier-reading`), as the selection threshold is; none was fitted, because 1–4 readers a day fit nothing yet.
 *
 * - `match`: what a non-phrase reason scores, on the cosine scale a phrase vector's cosine is on (floor 0.4). A stated interest
 *   or a follow is stronger than a weak cosine (0.6); a keyword hit (no vectors) is moderate (0.5, plus its rank); a specialty is
 *   broad and only just above the floor (0.42), and matches items of 精选 quality only.
 * - `editorial`: the share of the editorial score (out of 100) added to a match — `ceiling` for a reader with no visit day,
 *   halfway to `floor` at `visitsHalf` visit days (in 60 days). The editor beats the algorithm for a reader the platform barely
 *   knows (Claussen, Peukert & Sen, NBER field experiment: the algorithm led from about five visits).
 * - `genre`: Beta smoothing of a reader's per-genre success rate: `strength` virtual impressions at the prior mean — `lean` for
 *   the genres the reader's role leans to, `base` for the rest (Liu, Dolan & Pedersen's 10 virtual clicks) — an open counts
 *   `openWeight`, a satisfied read (`FRONTIER_DWELL.satisfiedMs`, the end reached, a star, a save, a share, a research) 1, a hide
 *   one extra failure; the term added is `share` × log2(mean / base), clipped to ±1.
 * - `mustSee`: at most `max` entries; a safety alert counts within `safetyHours`.
 * - `explore`: `slots` entries drawn from at most `poolMax` of the best unmatched items, placed at the first group boundary at
 *   or after index `position`.
 * - `perReason`: how many items one reason may pick. `follows`: the positive follows read, most recent first.
 * - `onboardingOpens`: a reader with this many opened items is known enough not to be asked.
 */
export const FRONTIER_RANKING = Object.freeze({
  policy: "for-you-2026-10-24.1",
  match: Object.freeze({ interest: 0.6, follow: 0.6, keyword: 0.5, specialty: 0.42 }),
  editorial: Object.freeze({ ceiling: 0.3, floor: 0.1, visitsHalf: 5 }),
  genre: Object.freeze({ share: 0.05, base: 0.08, lean: 0.12, strength: 10, windowDays: 60, openWeight: 0.5 }),
  roleLeans: Object.freeze({
    clinician: Object.freeze(["guideline", "paper", "safety", "conference"]),
    pharmacist: Object.freeze(["safety", "approval", "policy", "guideline"]),
    researcher: Object.freeze(["paper", "preprint", "trial", "conference"]),
    industry: Object.freeze(["industry", "approval", "policy", "trial"]),
    student: Object.freeze(["paper", "guideline", "commentary", "news"]),
    other: Object.freeze([]),
  }),
  mustSee: Object.freeze({ max: 2, safetyHours: 72 }),
  explore: Object.freeze({ slots: 1, position: 3, poolMax: 30 }),
  perReason: Object.freeze({ phrase: FRONTIER_FOR_YOU_PER_PHRASE, interest: 2, follow: 2, specialty: 4 }),
  follows: 30,
  onboardingOpens: 5,
});

/** The topics of the entries that have no reason of the reader's: the editor's pick, and the exploration entry. */
export const FRONTIER_FOR_YOU_TOPICS = Object.freeze({ editorial: "精选", explore: "其他领域精选" });

/**
 * The editorial share for a reader with this many visit days: `ceiling` at none, halfway to `floor` at `visitsHalf`.
 * @param {number} visits @param {typeof FRONTIER_RANKING.editorial} [rule]
 */
export function frontierEditorialShare(visits, rule = FRONTIER_RANKING.editorial) {
  const days = Number.isFinite(visits) && visits > 0 ? visits : 0;
  return rule.floor + (rule.ceiling - rule.floor) * (rule.visitsHalf / (rule.visitsHalf + days));
}

/**
 * A reader's affinity for each genre, from what they were shown and did (per item: seen, opened, satisfied, hidden), smoothed
 * toward their role's priors. Pure.
 * @param {Array<{ genre: string, seen?: boolean, opened?: boolean, satisfied?: boolean, hidden?: boolean }>} outcomes one per item
 * @param {string | null} role @param {typeof FRONTIER_RANKING.genre} [rule]
 * @returns {Record<string, { trials: number, successes: number, mean: number, term: number }>}
 */
export function frontierGenreAffinity(outcomes, role, rule = FRONTIER_RANKING.genre) {
  const leans = new Set(role && Object.hasOwn(FRONTIER_RANKING.roleLeans, role) ? /** @type {Record<string, readonly string[]>} */ (FRONTIER_RANKING.roleLeans)[role] : []);
  /** @type {Record<string, { trials: number, successes: number }>} */
  const counts = Object.fromEntries(FRONTIER_GENRES.map((genre) => [genre, { trials: 0, successes: 0 }]));
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    const count = counts[outcome?.genre];
    if (!count) continue;
    const opened = outcome.opened === true;
    if (outcome.seen === true || opened || outcome.hidden === true) count.trials += 1;
    if (opened) count.successes += outcome.satisfied === true ? 1 : rule.openWeight;
    // A hide is a stronger "no" than a card scrolled past: one more failure.
    if (outcome.hidden === true) count.trials += 1;
  }
  return Object.fromEntries(FRONTIER_GENRES.map((genre) => {
    const { trials, successes } = counts[genre];
    const prior = leans.has(genre) ? rule.lean : rule.base;
    const mean = (successes + rule.strength * prior) / (trials + rule.strength);
    const term = rule.share * Math.max(-1, Math.min(1, Math.log2(mean / rule.base)));
    return [genre, { trials, successes: Math.round(successes * 100) / 100, mean: Math.round(mean * 10_000) / 10_000, term: Math.round(term * 10_000) / 10_000 }];
  }));
}

/**
 * @typedef {{ id: string, publicId: string, weight: number, selected: boolean, safetyAlert: boolean, genre: string, specialties: string[],
 *   visibleAt: number }} RankCandidate
 * @typedef {{ topic: string, kind: string, cap: number }} RankReason
 * @typedef {{ itemId: string, reason: number, score: number }} RankPair
 * @typedef {{ itemId: string, slot: "must-see" | "personal" | "editorial" | "explore", reason: number | null, topic: string, kind: string, score: number,
 *   propensity: number }} RankEntry
 */

/**
 * The block from its parts, in display order (pure; the integration test drives it through SQL). `pairs` are the (item, reason)
 * matches already above their floor; `terms` the genre terms; `random` returns [0, 1).
 * @param {{ candidates: RankCandidate[], reasons: RankReason[], pairs: RankPair[], readerSpecialties: string[], editorialShare: number,
 *   terms: Record<string, { term: number }>, now: number, selectThreshold: number, random?: () => number, size?: number,
 *   ranking?: typeof FRONTIER_RANKING }} input
 * @returns {RankEntry[]}
 */
export function frontierForYouBlock({ candidates, reasons, pairs, readerSpecialties, editorialShare, terms, now, selectThreshold,
  random = Math.random, size = FRONTIER_FOR_YOU_SIZE, ranking = FRONTIER_RANKING }) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const own = new Set(readerSpecialties);
  const overlaps = (/** @type {RankCandidate} */ candidate) => candidate.specialties.some((key) => own.has(key));
  const boost = (/** @type {RankCandidate} */ candidate) => editorialShare * candidate.weight / 100 + (terms[candidate.genre]?.term ?? 0);
  const label = (/** @type {string} */ genre) => /** @type {Record<string, string>} */ (FRONTIER_GENRE_LABELS_ZH)[genre] ?? genre;
  /** @type {RankEntry[]} */
  const mustSee = [];
  const safety = candidates.filter((candidate) => candidate.safetyAlert && now - candidate.visibleAt <= ranking.mustSee.safetyHours * 3_600_000
    && (!own.size || !candidate.specialties.length || overlaps(candidate)))
    .sort((left, right) => right.visibleAt - left.visibleAt || left.id.localeCompare(right.id));
  const major = own.size ? candidates.filter((candidate) => !candidate.safetyAlert && candidate.selected && (candidate.genre === "guideline" || candidate.genre === "approval")
    && overlaps(candidate)).sort((left, right) => right.weight - left.weight || right.visibleAt - left.visibleAt || left.id.localeCompare(right.id)) : [];
  for (const candidate of [...safety, ...major].slice(0, ranking.mustSee.max)) {
    mustSee.push({ itemId: candidate.id, slot: "must-see", reason: null, topic: label(candidate.genre), kind: "must-see", score: candidate.weight / 100, propensity: 1 });
  }
  const taken = new Set(mustSee.map((entry) => entry.itemId));
  const exploreSlots = ranking.explore.slots;
  const room = Math.max(0, size - mustSee.length - exploreSlots);
  /** @type {RankEntry[]} */
  const chosen = [];
  const matched = new Set(pairs.map((pair) => pair.itemId));
  const ranked = pairs.filter((pair) => byId.has(pair.itemId)).map((pair) => {
    const candidate = /** @type {RankCandidate} */ (byId.get(pair.itemId));
    return { ...pair, rank: pair.score + boost(candidate), weight: candidate.weight };
  }).sort((left, right) => right.rank - left.rank || right.weight - left.weight || left.reason - right.reason || left.itemId.localeCompare(right.itemId));
  /** @type {Map<number, number>} */
  const perReason = new Map();
  for (const pair of ranked) {
    if (chosen.length >= room) break;
    const reason = reasons[pair.reason];
    if (!reason || taken.has(pair.itemId) || (perReason.get(pair.reason) ?? 0) >= reason.cap) continue;
    taken.add(pair.itemId);
    perReason.set(pair.reason, (perReason.get(pair.reason) ?? 0) + 1);
    chosen.push({ itemId: pair.itemId, slot: "personal", reason: pair.reason, topic: reason.topic, kind: reason.kind, score: Math.round(pair.rank * 10_000) / 10_000, propensity: 1 });
  }
  // While the reader's own reasons leave room, the editor's: 精选 by score.
  const editorial = candidates.filter((candidate) => candidate.selected && !taken.has(candidate.id))
    .sort((left, right) => right.weight - left.weight || right.visibleAt - left.visibleAt || left.id.localeCompare(right.id));
  for (const candidate of editorial) {
    if (chosen.length >= room) break;
    taken.add(candidate.id);
    chosen.push({ itemId: candidate.id, slot: "editorial", reason: null, topic: FRONTIER_FOR_YOU_TOPICS.editorial, kind: "editorial",
      score: Math.round(boost(candidate) * 10_000) / 10_000, propensity: 1 });
  }
  // Groups in the order of their best entry; each topic's entries together.
  /** @type {string[]} */
  const order = [];
  for (const entry of chosen) if (!order.includes(entry.topic)) order.push(entry.topic);
  const grouped = order.flatMap((topic) => chosen.filter((entry) => entry.topic === topic));
  const block = [...mustSee, ...grouped];
  // The exploration entry: one of the best items the reader's reasons matched nothing of, drawn uniformly, its probability kept.
  const pool = candidates.filter((candidate) => !taken.has(candidate.id) && !matched.has(candidate.id) && (candidate.selected || candidate.weight >= selectThreshold))
    .sort((left, right) => right.weight - left.weight || right.visibleAt - left.visibleAt || left.id.localeCompare(right.id)).slice(0, ranking.explore.poolMax);
  for (let slot = 0; slot < exploreSlots && pool.length; slot += 1) {
    const draw = Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length));
    const propensity = 1 / pool.length;
    const [candidate] = pool.splice(draw, 1);
    // With no reason of the reader's at all, every entry is the editor's, and the drawn one joins their group.
    const topic = chosen.some((entry) => entry.slot === "personal") ? FRONTIER_FOR_YOU_TOPICS.explore : FRONTIER_FOR_YOU_TOPICS.editorial;
    const entry = /** @type {RankEntry} */ ({ itemId: candidate.id, slot: "explore", reason: null, topic, kind: "explore",
      score: Math.round(boost(candidate) * 10_000) / 10_000, propensity: Math.round(propensity * 1_000_000) / 1_000_000 });
    let at = block.length;
    for (let index = Math.min(ranking.explore.position, block.length); index <= block.length; index += 1) {
      // A boundary: the start, the end, or between two topics — or inside the run of its own topic.
      const before = block[index - 1];
      const after = block[index];
      if (!before || !after || before.topic !== after.topic || before.topic === topic) { at = index; break; }
    }
    block.splice(at, 0, entry);
  }
  return block.slice(0, size);
}

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_profile_failed";
}

// ───────────────────────── profiles ─────────────────────────

export class FrontierProfiles {
  /**
   * @param {{ database: any, researchMemory?: any, editor?: any, embedder?: any, config?: Record<string, any>,
   *           budget?: (() => Promise<{ state: string }>) | null, now?: () => Date, dimension?: number,
   *           conversations?: ((userId: string) => Promise<Array<{ projectId: string, run: Record<string, any> }>>) | null,
   *           entityVocabulary?: { enabled?: boolean, keysForText: (input: { texts: string[] }) => Promise<string[]>,
   *             tag?: (input: { texts: string[] }) => Promise<string[] | null>,
   *             describe: (keys: string[]) => Promise<Array<{ key: string, label: string }>> } | null,
   *           tags?: { filter: (slug: string) => Promise<{ ids: Iterable<number | string>, tag: { slug: string, name: string } } | null> } | null,
   *           random?: () => number, ranking?: typeof FRONTIER_RANKING }} options
   *   `researchMemory` the account memory store (`listAllRecords`, `settings`),
   *   `editor` a `FrontierEditor` (`extractProfile`), `embedder` the feed's,
   *   `conversations` a reader's own runs across their projects (the run ledger's
   *   `researcherRuns`, composed in `server.mjs`); without it no question is read,
   *   `entityVocabulary` the platform's one vocabulary (`entityVocabulary.mjs`); without it the followed zones and
   *   the library are not read, `tags` the tag tree (`FrontierTagStore`; without it an interest tag is not matched),
   *   `random` the exploration draw's source of [0, 1), `ranking` the constants (`FRONTIER_RANKING`; a test narrows them).
   */
  constructor({ database, researchMemory = null, editor = null, embedder = null, config = {}, budget = null,
    now = () => new Date(), dimension = 1024, conversations = null, entityVocabulary = null, tags = null, random = Math.random, ranking = FRONTIER_RANKING }) {
    if (!database) throw new TypeError("The frontier profiles need the product database.");
    this.database = database;
    this.subscriptions = new FrontierSubscriptions({ database });
    this.researchMemory = researchMemory;
    this.editor = editor;
    this.embedder = embedder;
    this.config = config ?? {};
    this.budgetReader = budget;
    this.now = now;
    this.conversations = typeof conversations === "function" ? conversations : null;
    this.entityVocabulary = entityVocabulary?.enabled === false ? null : entityVocabulary;
    this.tags = tags;
    this.random = random;
    this.ranking = ranking;
    /** The feed's own day, for a reader's visit days. */
    this.timeZone = String(this.config.frontierTimeZone || "Asia/Shanghai");
    this.dimension = Number(this.config.kbEmbeddingDimension) || Number(embedder?.dimension) || dimension;
    /** @type {Map<string, number>} reader → when their last refresh failed */
    this.failures = new Map();
    /** @type {Map<string, number>} reader → when their opening of the block was last written */
    this.visits = new Map();
    /** @type {Set<string>} conversation changes already marked (`noteConversation`) */
    this.noted = new Set();
    /** @type {number | null} when the memory store last failed */
    this.memoryFailedAt = null;
    /** Observable counters (principle 15). */
    this.counters = { refreshed: 0, empty: 0, paused: 0, failures: 0, ranked: 0, embedded: 0, embedFailures: 0, reasonsDropped: 0, reads: 0,
      staleMarks: 0, staleMarkFailures: 0, visitFailures: 0, questionFailures: 0, hiddenDropped: 0, entityPhrases: 0, entityFailures: 0,
      signalFailures: 0, statedFailures: 0, prefsSaved: 0 };
    /** @type {string | null} */
    this.lastError = null;
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /** Whether this deployment can personalize at all: a memory store to read and a model to read it with. */
  get composed() {
    return Boolean(this.researchMemory?.configured) && this.config.deepseekProviderEnabled === true && Boolean(this.config.deepseekApiKey);
  }

  /** `available`, `unavailable` (the memory store failed lately) or `off` — what `/status` says. */
  state() {
    if (!this.composed) return "off";
    if (this.memoryFailedAt != null && this.now().getTime() - this.memoryFailedAt < UNAVAILABLE_MS) return "unavailable";
    return "available";
  }

  /** @returns {Promise<{ state: string }>} */
  async #budget() {
    if (!this.budgetReader) return { state: "ok" };
    try { return await this.budgetReader(); } catch { return { state: "exhausted" }; }
  }

  /** @param {string} userId @returns {Promise<{ recallPaused: boolean, pausedProjects: string[] }>} */
  async #settings(userId) {
    const settings = typeof this.researchMemory?.settings === "function" ? await this.researchMemory.settings(userId) : null;
    return { recallPaused: settings?.recallPaused === true, pausedProjects: (settings?.pausedProjects ?? []).map(String) };
  }

  /**
   * One round of refreshes (the composer's, every five minutes): profiles
   * whose memory changed are marked, then readers seen in the last 14 days
   * whose profile is missing, a day old or marked — those who opened the block
   * since first — at most `limit`, while a model may be called; then cached
   * rankings older than six hours, or dropped, recomputed in SQL.
   * @param {{ limit?: number, rerankLimit?: number }} [options]
   */
  async refreshDue({ limit = 5, rerankLimit = 20 } = {}) {
    const summary = { refreshed: 0, ranked: 0, skipped: 0 };
    if (!this.composed) return summary;
    await this.ready();
    const now = this.now();
    const active = new Date(now.getTime() - FRONTIER_PROFILE_ACTIVE_MS);
    const audience = this.#audience();
    await this.#markMemoryChanges(active);
    const due = (await this.database.query(`SELECT up.user_id FROM evimed_frontier.user_prefs up
      JOIN evimed_control.users u ON u.id = up.user_id
      LEFT JOIN evimed_frontier.user_profiles pr ON pr.user_id = up.user_id
      WHERE up.last_seen_at >= $1::timestamptz AND ($3::text[] IS NULL OR up.user_id = ANY($3::text[]))
        AND (pr.user_id IS NULL OR pr.computed_at < $2::timestamptz OR pr.inputs_version > pr.computed_inputs_version
          OR (jsonb_array_length(pr.phrases) = 0 AND up.for_you_seen_at > pr.computed_at))
      ORDER BY (up.for_you_seen_at IS NOT NULL AND (pr.user_id IS NULL OR up.for_you_seen_at > pr.computed_at)) DESC,
        (pr.inputs_version > pr.computed_inputs_version) DESC NULLS LAST,
        pr.computed_at NULLS FIRST, up.last_seen_at DESC LIMIT 100`,
    [active, new Date(now.getTime() - FRONTIER_PROFILE_TTL_MS), audience])).rows ?? [];
    const budget = due.length ? await this.#budget() : { state: "ok" };
    for (const row of due) {
      if (summary.refreshed >= limit) break;
      const failedAt = this.failures.get(row.user_id);
      if (failedAt && now.getTime() - failedAt < RETRY_MS) { summary.skipped += 1; continue; }
      // Not urgent: like clustering's adjudication and the digests, a profile
      // waits while the day's budget is past 80% (plan §10.3.10).
      if (budget.state !== "ok" || !this.editor?.available) break;
      try {
        await this.refreshUser(row.user_id);
        summary.refreshed += 1;
      } catch (error) {
        this.failures.set(row.user_id, now.getTime());
        this.counters.failures += 1;
        this.lastError = codeOf(error);
      }
    }
    const stale = (await this.database.query(`SELECT pr.user_id FROM evimed_frontier.user_profiles pr
      JOIN evimed_frontier.user_prefs up ON up.user_id = pr.user_id
      WHERE up.last_seen_at >= $1::timestamptz AND jsonb_array_length(pr.phrases) > 0
        AND (pr.for_you_at IS NULL OR pr.for_you_at < $2::timestamptz)
      ORDER BY pr.for_you_at NULLS FIRST LIMIT $3`, [active, new Date(now.getTime() - FRONTIER_FOR_YOU_TTL_MS), rerankLimit])).rows ?? [];
    for (const row of stale) {
      try {
        await this.rank(row.user_id);
        summary.ranked += 1;
      } catch (error) {
        this.counters.failures += 1;
        this.lastError = codeOf(error);
      }
    }
    return summary;
  }

  /** @returns {string[] | null} null = every account */
  #audience() {
    if (this.config.frontierAudience === "all") return null;
    return [...new Set([...(this.config.operatorUsers ?? []), ...(this.config.frontierPreviewUsers ?? [])].map(String))];
  }

  /**
   * Mark the profiles of active readers whose memory changed since it was
   * read: any writer — the extractor after a conversation, the memory page, an
   * import, a delete — moves the mark, so none of them has to call here. A
   * memory store that cannot be read marks nothing and the round goes on.
   * @param {Date} active
   */
  async #markMemoryChanges(active) {
    try {
      const result = await this.database.query(`UPDATE evimed_frontier.user_profiles pr SET inputs_version = pr.inputs_version + 1
        FROM evimed_frontier.user_prefs up
        WHERE up.user_id = pr.user_id AND up.last_seen_at >= $1::timestamptz AND pr.inputs_version <= pr.computed_inputs_version
          AND pr.memory_mark IS DISTINCT FROM (SELECT ${MEMORY_MARK} FROM evimed_memory.records r WHERE r.user_id = pr.user_id)`, [active]);
      this.counters.staleMarks += Number(result?.rowCount ?? 0);
    } catch (error) {
      this.counters.staleMarkFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * Something a profile is read from changed: it is due at the next round.
   * Never fails its caller — a mark lost is a profile a day old, not an error.
   * @param {string} userId @param {{ onlyEmpty?: boolean }} [options] `onlyEmpty`: only a profile with no phrase yet
   */
  async #markInputsChanged(userId, { onlyEmpty = false } = {}) {
    try {
      const result = await this.database.query(`UPDATE evimed_frontier.user_profiles SET inputs_version = inputs_version + 1
        WHERE user_id = $1 AND (NOT $2::boolean OR jsonb_array_length(phrases) = 0)`, [userId, onlyEmpty]);
      this.counters.staleMarks += Number(result?.rowCount ?? 0);
    } catch (error) {
      this.counters.staleMarkFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * What a reader's action on an item changes for 与我相关, after it
   * committed: a star or an unstar changes what the profile is read from; an
   * item opened does too, but is only worth a new profile while there is none
   * to show — otherwise it waits for the day's; a hide or an unhide changes
   * only which items are left out, so the cached ranking is dropped and the
   * next read or round ranks again in SQL.
   * @param {string} userId @param {string} action `star` | `unstar` | `hide` | `unhide` | `read`
   */
  async noteItemAction(userId, action) {
    if (action === "star" || action === "unstar") return this.#markInputsChanged(userId);
    if (action === "read") return this.#markInputsChanged(userId, { onlyEmpty: true });
    if (action !== "hide" && action !== "unhide") return;
    try {
      await this.database.query("UPDATE evimed_frontier.user_profiles SET for_you_at = NULL WHERE user_id = $1", [userId]);
    } catch (error) {
      this.counters.staleMarkFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * A researcher's run changed (the run ledger's state signal, composed in
   * `server.mjs` for their own runs of their own projects): a question seen for
   * the first time, or a conversation deleted, marks their profile. Returns at
   * once; the write happens behind it and never fails the ledger's.
   * @param {string} userId @param {{ id?: unknown, question?: unknown, deleted?: unknown }} run
   */
  noteConversation(userId, run) {
    const key = run?.deleted === true ? `${String(run.id)}:deleted` : typeof run?.question === "string" && run.question.trim() ? `${String(run.id)}:asked` : null;
    if (!key || !userId || this.noted.has(key)) return;
    if (this.noted.size >= NOTED_LIMIT) this.noted.clear();
    this.noted.add(key);
    void this.#markInputsChanged(String(userId));
  }

  /**
   * Record that this reader opened the block (`user_prefs.for_you_seen_at`),
   * at most every ten minutes per reader by this process: readers waiting on
   * it are computed first, and one with nothing yet is computed again.
   * @param {string} userId
   */
  async #noteVisit(userId) {
    const at = this.now().getTime();
    const last = this.visits.get(userId);
    if (last != null && at - last < VISIT_INTERVAL_MS) return;
    this.visits.set(userId, at);
    if (this.visits.size > 10_000) this.visits.clear();
    try {
      await this.database.query(`INSERT INTO evimed_frontier.user_prefs (user_id, for_you_seen_at) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET for_you_seen_at = GREATEST(coalesce(evimed_frontier.user_prefs.for_you_seen_at, EXCLUDED.for_you_seen_at),
          EXCLUDED.for_you_seen_at)`, [userId, new Date(at)]);
    } catch (error) {
      this.visits.delete(userId);
      this.counters.visitFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * The reader's recent questions. The run ledger is one input among three:
   * a ledger that cannot be read leaves the questions out and the profile is
   * built from the rest (counted, never faked).
   * @param {string} userId @param {string[]} pausedProjects @param {Date} now
   */
  async #questions(userId, pausedProjects, now) {
    if (!this.conversations) return [];
    try {
      return frontierProfileQuestions(await this.conversations(userId),
        { since: new Date(now.getTime() - FRONTIER_PROFILE_QUESTION_WINDOW_MS), pausedProjects });
    } catch (error) {
      this.counters.questionFailures += 1;
      this.lastError = codeOf(error);
      return [];
    }
  }

  /**
   * The items the reader starred or opened in the last 60 days and did not
   * hide since, stars first, newest first, as the titles a reader saw.
   * @param {string} userId @param {Date} now
   * @returns {Promise<Array<{ text: string, starred: boolean }>>}
   */
  async #itemSignals(userId, now) {
    const since = new Date(now.getTime() - FRONTIER_PROFILE_ITEM_WINDOW_MS);
    const rows = (await this.database.query(`SELECT coalesce(nullif(i.title_zh, ''), i.title_raw) AS title, us.starred_at IS NOT NULL AS starred
      FROM evimed_frontier.user_state us JOIN evimed_frontier.items i ON i.id = us.item_id
      WHERE us.user_id = $1 AND us.hidden_at IS NULL AND i.state = 'published'
        AND (us.starred_at >= $2::timestamptz OR us.read_at >= $2::timestamptz)
      ORDER BY (us.starred_at IS NOT NULL) DESC, greatest(us.starred_at, us.read_at) DESC, i.id DESC LIMIT $3`,
    [userId, since, FRONTIER_PHRASE_LIMITS.items])).rows ?? [];
    return rows.map((row) => ({ text: String(row.title ?? "").trim(), starred: row.starred === true })).filter((item) => item.text);
  }

  /**
   * What the reader's followed zones and their own library are about (flywheel F11), as phrases: the keys that recur
   * most, named as a reader knows them. Their own rows only; a paused or internal project's documents are left out,
   * and a vocabulary that cannot tag leaves the signal out (counted, never faked). The two signals fail apart: a
   * library that cannot be read costs the zones nothing.
   * @param {string} userId @param {string[]} pausedProjects
   * @returns {Promise<Array<{ text: string, source: "zone" | "library", memoryId: string, kind: "zone" | "library", entityKeys: string[] }>>}
   */
  async #entityPhrases(userId, pausedProjects) {
    const vocabulary = this.entityVocabulary;
    if (!vocabulary) return [];
    /** @param {() => Promise<string[][]>} read */
    const guarded = async (read) => {
      try { return await read(); } catch (error) {
        this.counters.entityFailures += 1;
        this.lastError = codeOf(error);
        return /** @type {string[][]} */ ([]);
      }
    };
    const zoneRecords = await guarded(async () => {
      /** @type {string[][]} */
      const records = [];
      const zones = (await this.database.query(`SELECT z.id, z.title, z.description FROM evimed_frontier.evidence_zone_follows f
        JOIN evimed_frontier.evidence_zones z ON z.id = f.zone_id AND z.state = 'published'
        WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT ${FRONTIER_PROFILE_ENTITY_LIMITS.zones}`, [userId])).rows ?? [];
      for (const zone of zones) records.push(await vocabulary.keysForText({ texts: [String(zone.title ?? ""), String(zone.description ?? "")] }));
      if (zones.length) {
        const cards = (await this.database.query(`SELECT c.entity_keys FROM evimed_frontier.evidence_cards c
          WHERE c.zone_id = ANY($1::text[]) AND c.state = 'published' AND c.withdrawn IS NULL ORDER BY c.updated_at DESC LIMIT ${FRONTIER_PROFILE_ENTITY_LIMITS.zoneCards}`,
        [zones.map((zone) => String(zone.id))])).rows ?? [];
        for (const card of cards) records.push(Array.isArray(card.entity_keys) ? card.entity_keys.map(String) : []);
      }
      return records;
    });
    const libraryRecords = await guarded(async () => {
      /** @type {string[][]} */
      const records = [];
      const documents = (await this.database.query(`SELECT d.project_id,
          coalesce(nullif(btrim(d.payload->'metadata'->>'title'), ''), d.payload->'paths'->>0) AS title,
          (SELECT k.payload->'output'->>'summary' FROM evimed_product.documents k
            WHERE k.user_id = d.user_id AND k.kind = 'knowledge' AND k.deleted_at IS NULL AND k.payload->>'recordType' = 'source-understanding'
              AND k.payload->>'sourceId' = d.id ORDER BY (k.payload->>'generation')::integer DESC NULLS LAST LIMIT 1) AS summary
        FROM evimed_product.documents d
        WHERE d.user_id = $1 AND d.kind = 'source' AND d.deleted_at IS NULL AND d.payload->>'status' IN ('complete', 'needs_attention')
        ORDER BY d.updated_at DESC LIMIT ${FRONTIER_PROFILE_ENTITY_LIMITS.documents}`, [userId])).rows ?? [];
      const paused = new Set(pausedProjects.map(String));
      for (const document of documents) {
        if (document.project_id && (paused.has(String(document.project_id)) || isInternalProject(document.project_id))) continue;
        records.push(await vocabulary.keysForText({ texts: [String(document.title ?? ""), String(document.summary ?? "")] }));
      }
      return records;
    });
    const zoneKeys = frontierRecurringEntityKeys(zoneRecords, FRONTIER_PROFILE_ENTITY_PHRASES.zone);
    const libraryKeys = frontierRecurringEntityKeys(libraryRecords, FRONTIER_PROFILE_ENTITY_PHRASES.library).filter((key) => !zoneKeys.includes(key));
    if (!zoneKeys.length && !libraryKeys.length) return [];
    let named;
    try { named = await vocabulary.describe([...zoneKeys, ...libraryKeys]); } catch (error) {
      this.counters.entityFailures += 1;
      this.lastError = codeOf(error);
      return [];
    }
    const label = new Map(named.map((entry) => [entry.key, String(entry.label ?? "").trim()]));
    /** @type {Array<{ text: string, source: "zone" | "library", memoryId: string, kind: "zone" | "library", entityKeys: string[] }>} */
    const phrases = [];
    for (const [source, keys] of /** @type {const} */ ([["zone", zoneKeys], ["library", libraryKeys]])) {
      for (const key of keys) if (label.get(key)) phrases.push({ text: /** @type {string} */ (label.get(key)), source, memoryId: "", kind: source, entityKeys: [key] });
    }
    return phrases;
  }

  /**
   * Every phrase of a profile tagged with the entity keys the shared vocabulary finds in it, kept on the phrase (2026-10-06 review).
   * The evidence programme's demand signal counts readers by these keys and reads no phrase text, so a phrase the vocabulary could
   * not tag at all (no glossary loaded) carries no `entityKeys` property — which is not the same as `[]`, a phrase tagged and found to
   * be about no known entity — and its profile is counted as one without keys. Profiles built before this carry none on their model
   * phrases until their next refresh. A vocabulary that fails leaves the phrases as they were: tagging is a label, never a gate.
   * @param {Array<{ text: string, entityKeys?: string[] }>} phrases
   */
  async #tagPhrases(phrases) {
    const vocabulary = this.entityVocabulary;
    if (!vocabulary) return;
    for (const phrase of phrases) {
      if (Array.isArray(phrase.entityKeys)) continue;
      try {
        const keys = await (typeof vocabulary.tag === "function" ? vocabulary.tag({ texts: [phrase.text] }) : vocabulary.keysForText({ texts: [phrase.text] }));
        if (Array.isArray(keys)) phrase.entityKeys = keys.map(String).slice(0, FRONTIER_PROFILE_PHRASE_ENTITY_KEYS);
      } catch (error) {
        this.counters.entityFailures += 1;
        this.lastError = codeOf(error);
      }
    }
  }

  /** @param {string} userId @returns {Promise<string>} */
  async #memoryMark(userId) {
    const row = (await this.database.query(`SELECT ${MEMORY_MARK} AS mark FROM evimed_memory.records r WHERE r.user_id = $1`, [userId])).rows?.[0];
    return String(row?.mark ?? "");
  }

  /**
   * Read, extract, embed and store one reader's profile, then rank for them.
   * A reader who paused recall, or who has shown nothing the block could use
   * yet, gets an empty profile — the block has nothing for them until that
   * changes, which marks the profile due again.
   * @param {string} userId
   */
  async refreshUser(userId) {
    const now = this.now();
    await this.ready();
    // Read first: a change while this runs moves the version past it, and the
    // profile is due again at the next round.
    const version = Number((await this.database.query(`SELECT inputs_version FROM evimed_frontier.user_profiles WHERE user_id = $1`,
      [userId])).rows?.[0]?.inputs_version ?? 0);
    let settings;
    let records;
    let mark;
    try {
      settings = await this.#settings(userId);
      mark = await this.#memoryMark(userId);
      records = settings.recallPaused ? [] : await this.researchMemory.listAllRecords(userId);
      this.memoryFailedAt = null;
    } catch (error) {
      this.memoryFailedAt = now.getTime();
      throw error;
    }
    const stamp = { now, version, mark };
    if (settings.recallPaused) {
      await this.#store(userId, { specialties: [], phrases: [], forYou: { state: "off", reason: "recall-paused" }, ...stamp });
      this.counters.paused += 1;
      return { state: "off", reason: "recall-paused" };
    }
    const memories = frontierProfileMemories(records, { pausedProjects: settings.pausedProjects });
    const questions = await this.#questions(userId, settings.pausedProjects, now);
    const items = await this.#itemSignals(userId, now);
    const entities = await this.#entityPhrases(userId, settings.pausedProjects);
    if (!memories.length && !questions.length && !items.length && !entities.length) {
      await this.#store(userId, { specialties: [], phrases: [], forYou: { state: "off", reason: "no-signal" }, ...stamp });
      this.counters.empty += 1;
      return { state: "off", reason: "no-signal" };
    }
    // The model reads what is language (memories, questions, titles of items); the entities are glossary lookups already, so
    // a reader who has only followed a zone or filled a library needs no model call to be a profile.
    const readsLanguage = memories.length > 0 || questions.length > 0 || items.length > 0;
    const extracted = readsLanguage ? await this.editor.extractProfile({ memories, questions, items }) : { error: null, phrases: [], specialties: [] };
    if (extracted.error) throw Object.assign(new Error("The profile could not be extracted."), { code: extracted.error });
    /** @type {Array<{ text: string, source: string, memoryId: string, kind: string, vector?: string, entityKeys?: string[] }>} */
    const phrases = [...extracted.phrases.map((/** @type {any} */ phrase) => ({ text: String(phrase.text), source: frontierPhraseSource(phrase),
      memoryId: frontierPhraseSource(phrase) === "memory" ? String(phrase.memoryId ?? "") : "", kind: String(phrase.kind ?? "profile") }))
      .filter((/** @type {any} */ phrase) => phrase.text && (phrase.source !== "memory" || phrase.memoryId)), ...entities];
    this.counters.entityPhrases += entities.length;
    await this.#tagPhrases(phrases);
    const capabilities = await this.ready();
    if (phrases.length && capabilities.vector && this.embedder?.configured) {
      try {
        // A phrase is what the reader is looking for: embedded as a query.
        const vectors = [];
        for (const phrase of phrases) vectors.push(await this.embedder.embedQuery(phrase.text));
        vectors.forEach((vector, index) => {
          if (Array.isArray(vector) && vector.length === this.dimension && vector.every(Number.isFinite)) phrases[index].vector = encodeVector(vector);
        });
        this.counters.embedded += phrases.length;
      } catch {
        // Kept without vectors, ranked by keywords, and said so (`basis: tags`).
        this.counters.embedFailures += 1;
      }
    }
    await this.#store(userId, { specialties: extracted.specialties, phrases, forYou: null, ...stamp });
    this.counters.refreshed += 1;
    if (!phrases.length) return { state: "available", phrases: 0 };
    await this.rank(userId);
    return { state: "available", phrases: phrases.length };
  }

  /**
   * @param {string} userId
   * @param {{ specialties: string[], phrases: any[], forYou: any, now: Date, version: number, mark: string }} profile
   */
  async #store(userId, { specialties, phrases, forYou, now, version, mark }) {
    await this.database.query(`INSERT INTO evimed_frontier.user_profiles
        (user_id, specialties, phrases, for_you, computed_at, for_you_at, computed_inputs_version, memory_mark)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, CASE WHEN $4::jsonb IS NULL THEN NULL ELSE $5::timestamptz END, $6, $7)
      ON CONFLICT (user_id) DO UPDATE SET specialties = EXCLUDED.specialties, phrases = EXCLUDED.phrases, for_you = EXCLUDED.for_you,
        computed_at = EXCLUDED.computed_at, for_you_at = EXCLUDED.for_you_at, computed_inputs_version = EXCLUDED.computed_inputs_version,
        memory_mark = EXCLUDED.memory_mark`,
    [userId, specialties.filter((key) => FRONTIER_SPECIALTIES.includes(/** @type {any} */ (key))), JSON.stringify(phrases),
      forYou == null ? null : JSON.stringify(forYou), now, version, mark]);
  }

  /**
   * The candidates for one reader since `since`: published items of enabled
   * sources, newest first, at most 300 — none the reader hid, starred or
   * opened, none of an event they hid an item of, none from a source or
   * specialty they muted — with what the block reads of each: the editorial
   * score, 精选, the safety flag, the specialties and the genre's columns.
   * @param {string} userId @param {Date} since
   * @returns {Promise<any[]>}
   */
  async #candidates(userId, since) {
    const { muted } = await this.subscriptions.read(userId);
    const values = /** @type {any[]} */ ([since, userId]);
    const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length}`; };
    const muteFilter = muted.map((follow) => `NOT coalesce((${frontierFollowPredicate(follow, param)}),false)`).join(" AND ") || "TRUE";
    return (await this.database.query(`SELECT i.id, i.public_id, coalesce(i.score_total, 0) AS weight, i.selected, i.specialties, i.visible_at,
        ${FRONTIER_GENRE_COLUMNS}
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND s.enabled AND i.visible_at >= $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = $2 AND us.item_id = i.id
          AND (us.hidden_at IS NOT NULL OR us.starred_at IS NOT NULL OR us.read_at IS NOT NULL))
        AND (i.event_id IS NULL OR NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state hs
          JOIN evimed_frontier.items hi ON hi.id = hs.item_id
          WHERE hs.user_id = $2 AND hs.hidden_at IS NOT NULL AND hi.event_id = i.event_id))
        AND ${muteFilter}
      ORDER BY i.visible_at DESC, i.id DESC LIMIT ${FRONTIER_FOR_YOU_CANDIDATES}`, values)).rows ?? [];
  }

  /**
   * The candidates that are the same story as something the reader hid, by
   * meaning: cosine to one of their last hundred hides at least
   * `FRONTIER_FOR_YOU_HIDDEN_COSINE`.
   * @param {string} userId @param {string[]} candidateIds
   * @returns {Promise<Set<string>>}
   */
  async #nearHidden(userId, candidateIds) {
    const hidden = ((await this.database.query(`SELECT item_id FROM evimed_frontier.user_state
      WHERE user_id = $1 AND hidden_at IS NOT NULL ORDER BY hidden_at DESC LIMIT ${HIDDEN_LIMIT}`, [userId])).rows ?? [])
      .map((row) => String(row.item_id));
    if (!hidden.length || !candidateIds.length) return new Set();
    const rows = (await this.database.query(`SELECT DISTINCT v.item_id FROM evimed_frontier.item_vectors v
      JOIN evimed_frontier.item_vectors h ON h.model_key = v.model_key AND h.item_id = ANY($2::bigint[])
      WHERE v.item_id = ANY($1::bigint[]) AND v.model_key = $3 AND 1 - (v.embedding <=> h.embedding) >= $4`,
    [candidateIds, hidden, String(this.embedder.modelKey), FRONTIER_FOR_YOU_HIDDEN_COSINE])).rows ?? [];
    return new Set(rows.map((row) => String(row.item_id)));
  }

  /**
   * What the reader was shown and did in the genre window, one outcome per item — impressions, opens, dwell, the end reached,
   * the keeping actions and hides from `interactions`; reads, stars and hides from `user_state`, which came before it — and
   * their visit days. A signal that cannot be read is empty (counted): the ranking falls back to the role's priors.
   * @param {string} userId @param {Date} now
   * @returns {Promise<{ outcomes: Array<{ genre: string, seen: boolean, opened: boolean, satisfied: boolean, hidden: boolean }>, opens: number, visits: number }>}
   */
  async #readingSignal(userId, now) {
    const since = new Date(now.getTime() - this.ranking.genre.windowDays * DAY);
    try {
      const rows = (await this.database.query(`WITH acts AS (
          SELECT x.item_id, min(x.genre) AS logged_genre, bool_or(x.type = 'impression') AS seen, bool_or(x.type = 'open') AS opened,
            coalesce(sum(x.value) FILTER (WHERE x.type = 'dwell'), 0) AS dwell, bool_or(x.type = 'reach-end') AS reached,
            bool_or(x.type IN ('star', 'save', 'share', 'research')) AS kept, bool_or(x.type = 'hide') AS hid
          FROM evimed_frontier.interactions x WHERE x.user_id = $1 AND x.item_id IS NOT NULL AND x.client_at >= $2 GROUP BY x.item_id
        ), marks AS (
          SELECT us.item_id, coalesce(us.read_at >= $2, false) AS read, coalesce(us.starred_at >= $2, false) AS starred,
            coalesce(us.hidden_at >= $2, false) AS hidden
          FROM evimed_frontier.user_state us WHERE us.user_id = $1 AND (us.read_at >= $2 OR us.starred_at >= $2 OR us.hidden_at >= $2)
        )
        SELECT a.logged_genre, ${FRONTIER_GENRE_COLUMNS}, coalesce(a.seen, false) AS seen, coalesce(a.opened, false) AS opened,
          coalesce(a.dwell, 0) AS dwell, coalesce(a.reached, false) AS reached, coalesce(a.kept, false) AS kept, coalesce(a.hid, false) AS hid,
          coalesce(m.read, false) AS read, coalesce(m.starred, false) AS starred, coalesce(m.hidden, false) AS hidden
        FROM acts a FULL JOIN marks m ON m.item_id = a.item_id
        JOIN evimed_frontier.items i ON i.id = coalesce(a.item_id, m.item_id) LIMIT 5000`, [userId, since])).rows ?? [];
      const outcomes = rows.map((/** @type {any} */ row) => ({
        genre: isFrontierGenre(row.logged_genre) ? row.logged_genre : frontierItemGenre(row),
        seen: row.seen === true, opened: row.opened === true || row.read === true,
        satisfied: Number(row.dwell) >= FRONTIER_DWELL.satisfiedMs || row.reached === true || row.kept === true || row.starred === true,
        hidden: row.hid === true || row.hidden === true,
      }));
      const visits = Number((await this.database.query(`SELECT count(*)::integer AS days FROM (
          SELECT (client_at AT TIME ZONE $3)::date AS day FROM evimed_frontier.interactions WHERE user_id = $1 AND client_at >= $2
          UNION SELECT (read_at AT TIME ZONE $3)::date FROM evimed_frontier.user_state WHERE user_id = $1 AND read_at >= $2) AS days`,
      [userId, since, this.timeZone])).rows?.[0]?.days ?? 0);
      return { outcomes, opens: outcomes.filter((outcome) => outcome.opened).length, visits };
    } catch (error) {
      this.counters.signalFailures += 1;
      this.lastError = codeOf(error);
      return { outcomes: [], opens: 0, visits: 0 };
    }
  }

  /**
   * The reader's onboarding answer as stored, with closed words re-checked (a specialty retired since reads as its successor).
   * @param {string} userId
   * @returns {Promise<{ role: string | null, specialties: string[], interests: string[], onboardedAt: string | null, skippedAt: string | null }>}
   */
  async #prefsRow(userId) {
    const row = (await this.database.query(`SELECT role, specialties, interests, onboarded_at, onboarding_skipped_at FROM evimed_frontier.user_prefs
      WHERE user_id = $1`, [userId])).rows?.[0];
    const iso = (/** @type {unknown} */ value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
    return {
      role: typeof row?.role === "string" && FRONTIER_READER_ROLES.includes(row.role) ? row.role : null,
      specialties: [...new Set((row?.specialties ?? []).map((/** @type {string} */ key) => frontierSpecialtyKey(key)).filter(Boolean))].map(String),
      interests: (row?.interests ?? []).map(String),
      onboardedAt: iso(row?.onboarded_at), skippedAt: iso(row?.onboarding_skipped_at),
    };
  }

  /**
   * The reasons a reader stated, beside the profile's phrases, and their matches among the candidates: onboarding's interests
   * (a tag through the tree — itself, what was folded into it, its narrower tags — or an entity key), the positive follows (the
   * most recent, a tag follow an interest already names left out) and the specialties, which match items of 精选 quality only.
   * A piece that cannot be read is left out (counted), never faked.
   * @param {string} userId @param {{ interests: string[] }} prefs @param {string[]} specialties @param {any[]} candidates @param {number} threshold
   * @returns {Promise<{ reasons: Array<{ text: string, source: string, memoryId: string, kind: string, cap: number }>, pairs: Array<{ itemId: string, reason: number, score: number }> }>}
   */
  async #statedReasons(userId, prefs, specialties, candidates, threshold) {
    /** @type {Array<{ text: string, source: string, memoryId: string, kind: string, cap: number }>} */
    const reasons = [];
    /** @type {Array<{ itemId: string, reason: number, score: number }>} */
    const pairs = [];
    const ids = candidates.map((row) => String(row.id));
    if (!ids.length) return { reasons, pairs };
    const { match, perReason } = this.ranking;
    try {
      /** @type {Array<{ tagId: string, reason: number }>} */
      const tagIds = [];
      /** @type {Array<{ key: string, reason: number }>} */
      const entityKeys = [];
      const interestSlugs = new Set();
      const entityNames = new Map();
      const keyed = prefs.interests.filter((key) => isEntityKey(key));
      if (keyed.length && this.entityVocabulary) {
        for (const entry of await this.entityVocabulary.describe(keyed).catch(() => [])) entityNames.set(entry.key, String(entry.label ?? "").trim());
      }
      for (const key of prefs.interests) {
        if (isEntityKey(key)) {
          const text = entityNames.get(key) || key.slice(key.indexOf(":") + 1);
          entityKeys.push({ key, reason: reasons.push({ text, source: "interest", memoryId: "", kind: "interest", cap: perReason.interest }) - 1 });
          continue;
        }
        const found = this.tags ? await this.tags.filter(key) : null;
        if (!found) continue;
        interestSlugs.add(found.tag.slug);
        const reason = reasons.push({ text: String(found.tag.name), source: "interest", memoryId: "", kind: "interest", cap: perReason.interest }) - 1;
        for (const id of found.ids) tagIds.push({ tagId: String(id), reason });
      }
      if (tagIds.length) {
        const rows = (await this.database.query(`SELECT it.item_id, x.idx FROM evimed_frontier.item_tags it
          JOIN unnest($1::bigint[], $2::integer[]) AS x(tag_id, idx) ON x.tag_id = it.tag_id WHERE it.item_id = ANY($3::bigint[])`,
        [tagIds.map((entry) => entry.tagId), tagIds.map((entry) => entry.reason), ids])).rows ?? [];
        for (const row of rows) pairs.push({ itemId: String(row.item_id), reason: Number(row.idx), score: match.interest });
      }
      if (entityKeys.length) {
        const rows = (await this.database.query(`SELECT i.id, x.idx FROM evimed_frontier.items i
          JOIN unnest($1::text[], $2::integer[]) AS x(key, idx) ON x.key = ANY(i.entity_keys) WHERE i.id = ANY($3::bigint[])`,
        [entityKeys.map((entry) => entry.key), entityKeys.map((entry) => entry.reason), ids])).rows ?? [];
        for (const row of rows) pairs.push({ itemId: String(row.id), reason: Number(row.idx), score: match.interest });
      }
      const { follows } = await this.subscriptions.read(userId);
      const positive = follows.filter((follow) => !follow.muted && !(follow.kind === "tag" && interestSlugs.has(follow.key)))
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, this.ranking.follows);
      if (positive.length) {
        const values = /** @type {any[]} */ ([ids]);
        const param = (/** @type {unknown} */ value) => { values.push(value); return `$${values.length}`; };
        const first = reasons.length;
        for (const follow of positive) reasons.push({ text: String(follow.label), source: "follow", memoryId: "", kind: "follow", cap: perReason.follow });
        const hits = positive.map((follow, index) => `CASE WHEN coalesce((${frontierFollowPredicate(follow, param)}), false) THEN ${first + index} END`);
        const rows = (await this.database.query(`SELECT i.id, array_remove(ARRAY[${hits.join(", ")}]::integer[], NULL) AS hits
          FROM evimed_frontier.items i WHERE i.id = ANY($1::bigint[])`, values)).rows ?? [];
        for (const row of rows) for (const hit of row.hits ?? []) pairs.push({ itemId: String(row.id), reason: Number(hit), score: match.follow });
      }
    } catch (error) {
      this.counters.statedFailures += 1;
      this.lastError = codeOf(error);
    }
    for (const key of specialties) {
      const reason = reasons.push({ text: FRONTIER_SPECIALTY_LABELS_ZH[key] ?? key, source: "specialty", memoryId: "", kind: "specialty", cap: perReason.specialty }) - 1;
      for (const row of candidates) {
        if ((row.specialties ?? []).includes(key) && (row.selected === true || Number(row.weight) >= threshold)) {
          pairs.push({ itemId: String(row.id), reason, score: match.specialty });
        }
      }
    }
    return { reasons, pairs };
  }

  /**
   * Rank the window for one reader and cache it (`user_profiles.for_you`): their phrases, what they stated (onboarding, follows,
   * specialties), their genre affinity and visit days, the must-see and the exploration entry (`frontierForYouBlock`). Never a
   * model call and never an embedding call: the phrase vectors are stored with the profile. A reader with nothing is ranked too
   * — 精选 and the exploration entry.
   * @param {string} userId
   */
  async rank(userId) {
    const capabilities = await this.ready();
    const now = this.now();
    const profile = (await this.database.query(`SELECT phrases, specialties FROM evimed_frontier.user_profiles WHERE user_id = $1`, [userId])).rows?.[0];
    const phrases = Array.isArray(profile?.phrases) ? profile.phrases : [];
    const prefs = await this.#prefsRow(userId);
    const vectors = phrases.map((phrase) => decodeVector(phrase.vector, this.dimension));
    const vectorsHere = Boolean(capabilities.vector && this.embedder?.configured);
    const useVectors = vectorsHere && vectors.some(Boolean);
    let candidates = await this.#candidates(userId, new Date(now.getTime() - FRONTIER_FOR_YOU_WINDOW_MS));
    if (candidates.length < FRONTIER_FOR_YOU_MIN_CANDIDATES) {
      candidates = await this.#candidates(userId, new Date(now.getTime() - FRONTIER_FOR_YOU_WIDE_WINDOW_MS));
    }
    // The same story as something the reader hid, by meaning, is no candidate at all — for a phrase, a follow or the editor.
    if (vectorsHere && candidates.length) {
      const near = await this.#nearHidden(userId, candidates.map((row) => String(row.id)));
      this.counters.hiddenDropped += near.size;
      if (near.size) candidates = candidates.filter((row) => !near.has(String(row.id)));
    }
    const ids = candidates.map((row) => String(row.id));
    const publicIds = new Map(candidates.map((row) => [String(row.id), row.public_id]));
    /** @type {Array<{ itemId: string, reason: number, score: number }>} */
    let phrasePairs = [];
    let basis = /** @type {"vector" | "tags" | null} */ (phrases.length ? "tags" : null);
    if (useVectors && ids.length) {
      const type = capabilities.halfvec ? "halfvec" : "vector";
      const literals = vectors.map((vector) => (vector ? `[${vector.join(",")}]` : null));
      const indexes = literals.map((literal, index) => (literal ? index : -1)).filter((index) => index >= 0);
      const rows = (await this.database.query(`SELECT v.item_id, p.idx, 1 - (v.embedding <=> p.vec::${type}) AS cosine
        FROM evimed_frontier.item_vectors v
        CROSS JOIN unnest($1::text[], $2::integer[]) AS p(vec, idx)
        WHERE v.item_id = ANY($3::bigint[]) AND v.model_key = $4`,
      [indexes.map((index) => literals[index]), indexes, ids, String(this.embedder.modelKey)])).rows ?? [];
      if (rows.length) {
        basis = "vector";
        phrasePairs = rows.map((row) => ({ itemId: String(row.item_id), reason: Number(row.idx), score: Number(row.cosine) }))
          .filter((pair) => Number.isFinite(pair.score) && pair.score >= FRONTIER_FOR_YOU_MIN_COSINE);
      }
    }
    if (basis === "tags" && ids.length) {
      const queries = phrases.map((phrase, index) => ({ index, query: tsqueryLiteral(String(phrase.text ?? "")) })).filter((entry) => entry.query);
      if (queries.length) {
        const rows = (await this.database.query(`SELECT i.id, p.idx, ts_rank(i.lexemes, p.q::tsquery, 1) AS rank
          FROM evimed_frontier.items i CROSS JOIN unnest($1::text[], $2::integer[]) AS p(q, idx)
          WHERE i.id = ANY($3::bigint[]) AND i.lexemes @@ p.q::tsquery`,
        [queries.map((entry) => entry.query), queries.map((entry) => entry.index), ids])).rows ?? [];
        // A keyword hit is no cosine: a moderate match, ordered among hits by its rank.
        phrasePairs = rows.map((row) => ({ itemId: String(row.id), reason: Number(row.idx), score: this.ranking.match.keyword + Math.min(0.1, Number(row.rank) || 0) }));
      }
    }
    // The reader's own specialties win over the ones the model read off their memory (principle 18: a statement over an inference).
    const readerSpecialties = prefs.specialties.length ? prefs.specialties
      : (Array.isArray(profile?.specialties) ? profile.specialties : []).filter((key) => FRONTIER_SPECIALTIES.includes(/** @type {any} */ (key)));
    const threshold = frontierSelectThreshold(this.config);
    const stated = await this.#statedReasons(userId, prefs, readerSpecialties, candidates, threshold);
    const reasons = [
      ...phrases.map((phrase) => {
        const source = frontierPhraseSource(phrase);
        return { text: String(phrase.text ?? ""), source, memoryId: source === "memory" ? String(phrase.memoryId ?? "") : "", kind: String(phrase.kind ?? "profile"),
          cap: this.ranking.perReason.phrase };
      }),
      ...stated.reasons,
    ];
    const pairs = [...phrasePairs, ...stated.pairs.map((pair) => ({ ...pair, reason: pair.reason + phrases.length }))]
      .filter((pair) => reasons[pair.reason]?.text && (reasons[pair.reason].source !== "memory" || reasons[pair.reason].memoryId));
    const signal = await this.#readingSignal(userId, now);
    const block = frontierForYouBlock({
      candidates: candidates.map((row) => ({ id: String(row.id), publicId: String(row.public_id), weight: Number(row.weight) || 0, selected: row.selected === true,
        safetyAlert: row.safety_alert === true, genre: frontierItemGenre(row), specialties: (row.specialties ?? []).map(String),
        visibleAt: row.visible_at ? new Date(row.visible_at).getTime() : 0 })),
      reasons: reasons.map((reason) => ({ topic: reason.text, kind: reason.kind, cap: reason.cap })),
      pairs, readerSpecialties, editorialShare: frontierEditorialShare(signal.visits, this.ranking.editorial),
      terms: frontierGenreAffinity(signal.outcomes, prefs.role, this.ranking.genre), now: now.getTime(), selectThreshold: threshold,
      random: this.random, ranking: this.ranking,
    });
    const items = block.map((entry) => {
      const reason = entry.reason === null ? null : reasons[entry.reason];
      const source = reason ? reason.source : entry.kind;
      return { itemId: publicIds.get(entry.itemId), text: reason ? reason.text : entry.topic, source, memoryId: source === "memory" ? reason?.memoryId ?? "" : "",
        kind: reason ? reason.kind : entry.kind, slot: entry.slot, score: entry.score, propensity: entry.propensity };
    }).filter((entry) => entry.itemId && entry.text && (entry.source !== "memory" || entry.memoryId));
    this.counters.ranked += 1;
    return this.#cache(userId, { state: "available", basis, policy: this.ranking.policy, signal: { opens: signal.opens, visits: signal.visits }, items }, now);
  }

  /**
   * Cache a ranking. A reader with no profile row yet gets one whose profile is due at once (`computed_at` at the epoch):
   * caching a ranking is not computing a profile.
   * @param {string} userId @param {Record<string, any>} forYou @param {Date} now
   */
  async #cache(userId, forYou, now) {
    const value = { ...forYou, computedAt: now.toISOString() };
    await this.database.query(`INSERT INTO evimed_frontier.user_profiles (user_id, for_you, for_you_at, computed_at) VALUES ($1, $2::jsonb, $3, 'epoch')
      ON CONFLICT (user_id) DO UPDATE SET for_you = EXCLUDED.for_you, for_you_at = EXCLUDED.for_you_at`, [userId, JSON.stringify(value), now]);
    return value;
  }

  /**
   * The block for one reader (the read path): the cached ranking, recomputed
   * in SQL when older than six hours, dropped, or made under another policy;
   * each memory reason checked against the memory it names; items hydrated by
   * `hydrate` (the service's, with the reader's own state), hidden ones left
   * out. Each entry says its `slot`, `score` and `propensity`; the answer says
   * the ranking's `policy` and whether to show onboarding (`onboarding`).
   * @param {{ id: string }} user
   * @param {(user: { id: string }, publicIds: string[]) => Promise<Map<string, any>>} hydrate
   * @returns {Promise<{ state: "available" | "unavailable" | "off", basis: "vector" | "tags" | null, paused?: true, policy?: string, onboarding?: boolean,
   *   items: Array<{ item: any, reason: { text: string, topic: string, memoryId: string | null, source: string }, slot: string, score: number | null, propensity: number | null }> }>}
   */
  async forYou(user, hydrate) {
    this.counters.reads += 1;
    const deployment = this.state();
    if (deployment === "off") return { state: "off", basis: null, items: [] };
    await this.ready();
    await this.#noteVisit(user.id);
    let settings;
    try {
      settings = await this.#settings(user.id);
    } catch {
      this.memoryFailedAt = this.now().getTime();
      return { state: "unavailable", basis: null, items: [] };
    }
    // The reader's own switch holds now, not at the next refresh.
    if (settings.recallPaused) return { state: "off", basis: null, paused: true, items: [] };
    const profile = (await this.database.query(`SELECT phrases, for_you, for_you_at FROM evimed_frontier.user_profiles WHERE user_id = $1`,
      [user.id])).rows?.[0];
    const phrases = Array.isArray(profile?.phrases) ? profile.phrases : [];
    let forYou = profile?.for_you ?? null;
    const stale = !profile?.for_you_at || this.now().getTime() - new Date(profile.for_you_at).getTime() > FRONTIER_FOR_YOU_TTL_MS;
    if (stale || forYou?.state !== "available" || forYou?.policy !== this.ranking.policy) forYou = await this.rank(user.id);
    const prefs = await this.#prefsRow(user.id);
    // Asked while the reader has neither answered nor skipped and the platform knows too little of them.
    const onboarding = !prefs.onboardedAt && !prefs.skippedAt && !phrases.length && !prefs.specialties.length && !prefs.interests.length
      && Number(forYou?.signal?.opens ?? 0) < this.ranking.onboardingOpens;
    const policy = String(forYou?.policy ?? this.ranking.policy);
    const entries = forYou?.state === "available" && Array.isArray(forYou.items) ? forYou.items : [];
    if (!entries.length) return { state: deployment, basis: forYou?.basis ?? null, policy, onboarding, items: [] };
    const remembered = [...new Set(entries.filter((/** @type {any} */ entry) => frontierReasonSource(entry) === "memory")
      .map((/** @type {any} */ entry) => String(entry.memoryId)))];
    /** @type {Set<string>} */
    let alive = new Set();
    if (remembered.length) {
      try {
        // A memory of a project paused since is no reason any more.
        const rows = (await this.database.query(`SELECT id FROM evimed_memory.records WHERE user_id = $1 AND id = ANY($2::text[]) AND status = 'active'
            AND (scope <> 'project' OR NOT (scope_id = ANY($3::text[])))`, [user.id, remembered, settings.pausedProjects])).rows ?? [];
        alive = new Set(rows.map((row) => String(row.id)));
      } catch {
        // The memory store cannot say whether a reason still stands: no reason
        // is shown rather than one that may no longer be true.
        this.memoryFailedAt = this.now().getTime();
        return { state: "unavailable", basis: null, items: [] };
      }
    }
    const kept = entries.filter((/** @type {any} */ entry) => frontierReasonSource(entry) !== "memory" || alive.has(String(entry.memoryId)));
    this.counters.reasonsDropped += entries.length - kept.length;
    const ids = kept.map((/** @type {any} */ entry) => String(entry.itemId));
    const muted = await this.subscriptions.mutedPublicIds(user.id, ids);
    const items = await hydrate(user, ids);
    return {
      state: "available",
      basis: forYou?.basis === "vector" ? "vector" : forYou?.basis === "tags" ? "tags" : null,
      policy,
      onboarding,
      items: kept.flatMap((/** @type {any} */ entry) => {
        const item = items.get(String(entry.itemId));
        if (!item || item.state?.hidden || muted.has(String(entry.itemId))) return [];
        const source = frontierReasonSource(entry);
        // `topic` is the phrase alone — what 「与我相关」 groups by and heads a
        // group with (plan 2026-09-23 §6.2), without the 「因为你在做」 before it.
        return [{ item, reason: { text: frontierReasonText({ text: String(entry.text), kind: entry.kind }), topic: String(entry.text),
          memoryId: source === "memory" ? String(entry.memoryId) : null, source },
        slot: typeof entry.slot === "string" ? entry.slot : "personal", score: Number.isFinite(entry.score) ? entry.score : null,
        propensity: Number.isFinite(entry.propensity) ? entry.propensity : null }];
      }).slice(0, FRONTIER_FOR_YOU_SIZE),
    };
  }

  /**
   * 与我相关's onboarding answer (`GET /api/frontier/prefs`): the role, the specialties, the interests — with the tags among them
   * named as the tree names them now — and when it was finished or skipped.
   * @param {string} userId
   */
  async prefs(userId) {
    await this.ready();
    const prefs = await this.#prefsRow(userId);
    /** @type {Array<{ slug: string, name: string }>} */
    const interestTags = [];
    for (const key of prefs.interests) {
      if (isEntityKey(key) || !this.tags) continue;
      const found = await this.tags.filter(key).catch(() => null);
      if (found) interestTags.push({ slug: String(found.tag.slug), name: String(found.tag.name) });
    }
    return { ...prefs, interestTags };
  }

  /**
   * Save the onboarding answer (`PUT /api/frontier/prefs`): `role` (a `FRONTIER_READER_ROLES` word or null), `specialties`
   * (at most three; finishing needs one), `interests` (at most ten tag slugs of the tree or entity keys; a tag is kept by the
   * address that stands for it now), `done` (finished) or `skipped` (skipped) — each time kept as the first, so an answer
   * changed later is not a second onboarding. A field not sent is left as it is. The cached ranking is dropped, so the next
   * read ranks with the answer.
   * @param {string} userId @param {Record<string, unknown>} body
   */
  async savePrefs(userId, body) {
    const invalid = (/** @type {string} */ message) => new HttpError(400, "frontier_prefs_invalid", message);
    await this.ready();
    const current = await this.#prefsRow(userId);
    /** @type {Record<string, unknown>} */
    const set = {};
    if (body.role !== undefined) {
      if (body.role !== null && (typeof body.role !== "string" || !FRONTIER_READER_ROLES.includes(body.role))) throw invalid("The role is not one of the roles.");
      set.role = body.role;
    }
    if (body.specialties !== undefined) {
      if (!Array.isArray(body.specialties) || body.specialties.some((key) => typeof key !== "string")) throw invalid("The specialties must be a list of keys.");
      const keys = [...new Set(body.specialties.map((key) => frontierSpecialtyKey(String(key))))];
      if (keys.some((key) => !key) || keys.length > FRONTIER_ONBOARDING_LIMITS.specialtiesMax) throw invalid(`At most ${FRONTIER_ONBOARDING_LIMITS.specialtiesMax} known specialties.`);
      set.specialties = keys;
    }
    if (body.interests !== undefined) {
      if (!Array.isArray(body.interests) || body.interests.length > FRONTIER_ONBOARDING_LIMITS.interestsMax || body.interests.some((key) => typeof key !== "string" || key.length > 200)) {
        throw invalid(`At most ${FRONTIER_ONBOARDING_LIMITS.interestsMax} interests.`);
      }
      /** @type {string[]} */
      const keys = [];
      for (const key of body.interests) {
        if (isEntityKey(key)) { keys.push(key); continue; }
        const found = this.tags && /^[a-z0-9][a-z0-9-]{1,79}$/.test(key) ? await this.tags.filter(key) : null;
        if (!found) throw invalid("An interest is neither a tag nor an entity key.");
        keys.push(String(found.tag.slug));
      }
      set.interests = [...new Set(keys)];
    }
    for (const flag of ["done", "skipped"]) if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw invalid(`${flag} must be a boolean.`);
    if (body.done === true && body.skipped === true) throw invalid("An answer is finished or skipped, not both.");
    const specialties = /** @type {string[]} */ (set.specialties ?? current.specialties);
    if (body.done === true && specialties.length < FRONTIER_ONBOARDING_LIMITS.specialtiesMin) throw invalid("Finishing needs at least one specialty.");
    const at = this.now();
    await this.database.query(`INSERT INTO evimed_frontier.user_prefs (user_id, role, specialties, interests, onboarded_at, onboarding_skipped_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) DO UPDATE SET
        role = CASE WHEN $7 THEN EXCLUDED.role ELSE evimed_frontier.user_prefs.role END,
        specialties = CASE WHEN $8 THEN EXCLUDED.specialties ELSE evimed_frontier.user_prefs.specialties END,
        interests = CASE WHEN $9 THEN EXCLUDED.interests ELSE evimed_frontier.user_prefs.interests END,
        onboarded_at = coalesce(evimed_frontier.user_prefs.onboarded_at, EXCLUDED.onboarded_at),
        onboarding_skipped_at = coalesce(evimed_frontier.user_prefs.onboarding_skipped_at, EXCLUDED.onboarding_skipped_at)`,
    [userId, set.role ?? current.role, specialties, set.interests ?? current.interests, body.done === true ? at : null, body.skipped === true ? at : null,
      "role" in set, "specialties" in set, "interests" in set]);
    await this.database.query("UPDATE evimed_frontier.user_profiles SET for_you_at = NULL WHERE user_id = $1", [userId]);
    this.counters.prefsSaved += 1;
    return this.prefs(userId);
  }

  status() {
    return { state: this.state(), lastError: this.lastError, counters: { ...this.counters } };
  }
}
