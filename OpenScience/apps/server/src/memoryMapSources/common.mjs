/**
 * What every source of the memory map speaks: the id grammar, the vocabularies of a mark and of a line between two marks, and
 * the small helpers the adapters share (`memoryMap.mjs` is the aggregator that merges what they return).
 *
 * Hidden knowledge: a mark's id is `<type>:<id>` and the id after the first colon may hold colons of its own (a DOI,
 * `reference:doi:10.1056/nejmoa2034577`), so an id is split at its first colon and nowhere else. Nothing here names a
 * kind of memory, a specialty or a drug: the map is general, and what an account's own records are about reaches it as
 * their words and as the kinds the store already has.
 *
 * @module memoryMapSources/common
 */

/** The kinds of mark. `you` is the account itself; a `cluster` stands for marks the map folded to stay readable. */
export const MAP_NODE_TYPES = Object.freeze(["you", "project", "memory", "document", "reference", "method", "entity", "page", "cluster"]);

/**
 * The kinds of line. `belongs-to`, `rests-on`, `replaces` and `conflicts` come from the memory store; `links` (a page's link to
 * another page) and `relates` (a typed relation between two entities, carrying its `label`) come from the knowledge graph an
 * OpenViking compile writes (`knowledgeGraph.mjs`).
 */
export const MAP_EDGE_TYPES = Object.freeze(["belongs-to", "rests-on", "replaces", "conflicts", "links", "quotes", "relates"]);

/** What a mark that needs a second look is held for, in the order a memory is told: a withdrawn source first. */
export const MAP_REASONS = Object.freeze(["source-retracted", "conflict", "source-changed", "source-expired", "expired"]);

/** A mark's state: in force, worth a look, or replaced by a later one. A forgotten memory is not drawn at all. */
export const MAP_STATES = Object.freeze(["current", "check", "replaced"]);

/** @param {string} type @param {string} id */
export function nodeId(type, id) {
  return `${type}:${id}`;
}

/** @param {unknown} value @returns {{ type: string, id: string } | null} */
export function parseNodeId(value) {
  const text = String(value ?? "");
  const cut = text.indexOf(":");
  if (cut <= 0 || cut === text.length - 1) return null;
  return { type: text.slice(0, cut), id: text.slice(cut + 1) };
}

/** @param {unknown} value @param {number} max */
export function excerpt(value, max) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

/** @param {unknown} value */
export function instant(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * How large a mark of this age is drawn when nothing else says how much it matters: 1 today, a fifth after five months. A native memory
 * file has no importance and no use counter of its own, and a capsule note none either, so what their marks say is how recent they are.
 * @param {string | null | undefined} at @param {Date} now
 */
export function recencyWeight(at, now) {
  const ms = Date.parse(at ?? "");
  if (!Number.isFinite(ms)) return 0.2;
  const days = Math.max(0, (now.getTime() - ms) / 86_400_000);
  return Math.max(0.2, Math.min(1, 1 - days / 150));
}

/** @param {number} value */
export function unit(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/**
 * Remembers the first answer to a question for the length of one request, so two adapters that need the same read (the records
 * for the nodes and for the events) cost one. A failed read is remembered too: asked again, it fails the same way at once.
 * @returns {<T>(key: string, read: () => Promise<T>) => Promise<T>}
 */
export function requestMemo() {
  /** @type {Map<string, Promise<any>>} */
  const held = new Map();
  return (key, read) => {
    let answer = held.get(key);
    if (!answer) {
      answer = Promise.resolve().then(read);
      held.set(key, answer);
    }
    return answer;
  };
}

/**
 * What one source hands the aggregator. Every field is optional: a source contributes what it has.
 *
 * @typedef {object} MapNode
 * @property {string} id `<type>:<id>`
 * @property {string} type one of `MAP_NODE_TYPES`
 * @property {string} [subtype] the memory kind, the document type, the kind of outside source, the entity type
 * @property {string} label at most 40 characters
 * @property {string} [group] what a folded cluster of marks like this one is called (a kind of memory, a type of document)
 * @property {number} [weight] 0..1: how much the mark is used and how much it matters; what a mark's size says
 * @property {string | null} [at] when it began (ISO)
 * @property {"current" | "check" | "replaced"} [state]
 * @property {string | null} [reason] one of `MAP_REASONS`, when `state` is `check`
 * @property {string | null} [projectId]
 * @property {string[]} [topics] topic ids; set by the aggregator from the topics source
 * @property {{ kind: string, id?: string, href?: string } | null} [open] what a click opens: `record` (the memory drawer), `method`,
 *   or `page` (an address of its own)
 * @property {number} [count] a cluster's size @property {string} [description] an entity's one sentence
 *
 * @typedef {object} MapEdge
 * @property {string} from @property {string} to
 * @property {string} type one of `MAP_EDGE_TYPES`
 * @property {string} [state] `current | changed | retracted | expired | unknown` for `rests-on`
 * @property {string | null} [at] @property {string} [label] a typed relation's display name @property {string} [relation] its stable predicate
 *
 * @typedef {object} MapLaneSegment
 * @property {string} recordId @property {string} text @property {string | null} from @property {string | null} to
 * @property {"current" | "replaced"} state @property {boolean} conflict
 * @typedef {object} MapLane
 * @property {string} id @property {string} label @property {string | null} projectId @property {MapLaneSegment[]} segments
 *
 * @typedef {object} MapEvent
 * @property {string} id @property {string} at @property {"memory" | "method" | "feedback" | "run"} type @property {string} change
 * @property {string} ref the mark it is about, `<type>:<id>` @property {string} lane `project:<id>` or `account`
 * @property {string} [kind] the memory kind, or `method` @property {string} [text] the words it left behind, at most 80 characters
 *
 * @typedef {object} MapAxis
 * @property {string} id @property {string} label @property {number} value on the dimension's own scale
 * @property {number} previousValue @property {number} count
 * @typedef {object} MapDimension
 * @property {string} id `work` or `memory` @property {string} title @property {string} previous what the ghost polygon is
 * @property {"share" | "count"} scale @property {number} total @property {number} previousTotal @property {MapAxis[]} axes
 *
 * @typedef {object} MapTopic
 * @property {string} id @property {string} label @property {number} weight @property {number} trend
 * @property {string[]} members `memory:<id>` and `document:<id>` ids
 *
 * @typedef {object} MapContribution
 * @property {MapNode[]} [nodes] @property {MapEdge[]} [edges] @property {MapLane[]} [lanes] @property {MapEvent[]} [events]
 * @property {{ t: string, memory?: number, run?: number, method?: number, feedback?: number, document?: number }[]} [buckets] days, in the researcher's zone
 * @property {{ kinds?: { id: string, label: string, count: number }[], dimensions?: MapDimension[], topics?: MapTopic[],
 *   documentTypes?: { id: string, label: string, count: number }[], projectDocuments?: { id: string, count: number }[] }} [facets]
 * @property {{ since?: string | null, topicsStatus?: "ready" | "stale" | "empty" | "off" }} [facts]
 * @property {string[]} [missing] the parts of this source that could not be read while the rest could
 *
 * One source of the map. `name` is what `missing` says when the source could not be read; `applies` lets a source stand aside
 * (an account on the native engine has no PostgreSQL records; one that has no database has no documents), and a source that stands
 * aside is not missing — it was never asked. `read` returns its contribution or throws; a throw costs that source's part of the
 * map and nothing else (principle 19).
 *
 * @typedef {object} MapSourceRequest
 * @property {{ id: string }} user
 * @property {{ id: string, name: string, kind: string }[]} projects the account's own projects, never the platform's internal ones
 * @property {string | null} projectId the project the map is narrowed to, already checked to be the account's
 * @property {{ from: string | null, to: string, unit: "day" | "week" | "month" }} range
 * @property {string} timeZone
 * @property {Date} now
 * @property {"postgres" | "native"} engine which store holds this account's memories
 * @property {string | null} focus
 * @property {<T>(key: string, read: () => Promise<T>) => Promise<T>} memo
 *
 * @typedef {object} MapSource
 * @property {string} name
 * @property {(request: MapSourceRequest) => boolean} [applies]
 * @property {(request: MapSourceRequest) => Promise<MapContribution | null>} read
 */
