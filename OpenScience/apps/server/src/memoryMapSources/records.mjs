/**
 * The map's first source: the account's memories in PostgreSQL (`evimed_memory`), the lines between them and what they rest on.
 *
 * Hidden knowledge:
 *
 * - **Derived, never written.** Every mark and line here is read from a table that already has an owner — the records, what
 *   each rests on (`record_sources`), the disagreements still open (`record_conflicts`), the use counters (`record_usage`) — so
 *   the map cannot disagree with the memory page it opens onto.
 * - **What is never drawn.** A run summary names a conversation and is not a memory; a sensitive memory is never recalled and
 *   is never drawn; a forgotten one is under 已忘记的内容. The store's `mapRecords` filters them in the query, and this module
 *   does not trust that alone: it drops them again, because the rule is the map's and not the query's.
 * - **Nothing here is a back-office label.** `origin` and `provenance` — who wrote a memory and how sure it is — are the
 *   platform's own and never reach a field of this document (owner ruling 2026-10-10).
 * - **A mark that needs a second look says why**, in one code (`MAP_REASONS`): a source it rests on was withdrawn, changed or
 *   expired, or it disagrees with another memory in force, or its own date has passed. The first that holds is the one told.
 * - **Lineages** are the supersede chains: the memory a later one replaced, which stays as 「曾经如此」. A lane is one chain, each
 *   segment a version over the interval it held.
 *
 * Stands aside when the account's memories live in the native engine (`request.engine === "native"`): that account's marks come
 * from `nativeMemory.mjs`.
 *
 * @module memoryMapSources/records
 */

import { MEMORY_KIND_LABELS_ZH } from "../researchMemoryPersistence.mjs";
import { bucketsOf, memoryEventsOf } from "./activity.mjs";
import { excerpt, instant, nodeId, unit } from "./common.mjs";

/** The memories one read draws at most (the store reads the most recently changed). */
export const MAP_RECORD_LIMIT = 2000;
/** The longest a mark's label is. */
export const MAP_LABEL_CHARS = 40;
/** The lanes one read returns at most. */
export const MAP_LANE_LIMIT = 40;
/** How many days back the ghost polygon of the second dimension looks. */
export const MAP_PREVIOUS_DAYS = 30;

/**
 * The aspects of a researcher the second radar counts, in the order they are told: fixed, named and the researcher's own words
 * (`SELF_SECTIONS` and a project's kinds on the memory page). Never a list of topics, which would change who is on an axis.
 */
export const MEMORY_ASPECTS = Object.freeze([
  { id: "aspect:background", label: "背景", kinds: Object.freeze(["profile"]) },
  { id: "aspect:preference", label: "偏好", kinds: Object.freeze(["preference"]) },
  { id: "aspect:habit", label: "工作与写作习惯", kinds: Object.freeze(["behavior"]) },
  { id: "aspect:correction", label: "纠正过的", kinds: Object.freeze(["correction"]) },
  { id: "aspect:project", label: "项目事实", kinds: Object.freeze(["project_fact", "analysis", "follow_up"]) },
  { id: "aspect:decision", label: "已定的决策", kinds: Object.freeze(["decision"]) },
]);

/** @param {any} record whether the map may draw it at all */
export function drawable(record) {
  return Boolean(record) && record.kind !== "run_summary" && record.sensitive !== true && record.status !== "archived"
    && (record.scope === "user" || record.scope === "project");
}

/** @param {any} record the sentence a mark is labelled by */
export function recordText(record) {
  return String(record?.summary || record?.value || "");
}

/**
 * What a memory's mark says it needs, in the order the page tells it.
 * @param {any} record @param {{ sources: any[], conflicted: boolean }} facts @param {number} now
 * @returns {string | null}
 */
export function reasonOf(record, { sources, conflicted }, now) {
  if (record.status === "superseded") return null;
  if (sources.some((source) => source.state === "retracted")) return "source-retracted";
  if (conflicted) return "conflict";
  if (sources.some((source) => source.state === "changed")) return "source-changed";
  if (sources.some((source) => source.state === "expired")) return "source-expired";
  const ends = Date.parse(record.expiresAt ?? "");
  return Number.isFinite(ends) && ends <= now ? "expired" : null;
}

/** The type and id of an outside source's mark, from the store's source type. @param {string} type @param {string} id */
export function sourceNode(type, id) {
  if (type === "knowledge_source") return { id: nodeId("document", id), type: "document" };
  return { id: nodeId("reference", `${type === "doi" ? "doi" : type}:${id}`), type: "reference", subtype: type };
}

/** @param {string} type @param {string} id */
function referenceLabel(type, id) {
  if (type === "doi") return excerpt(id, MAP_LABEL_CHARS);
  return type === "evidence_card" ? "证据卡" : "前沿动态条目";
}

/**
 * The lineages of an account's memories: each chain of replacements, oldest version first, with the interval each held.
 * A chain of one is no change and is not a lane. At most `MAP_LANE_LIMIT`, the chains that moved most recently first.
 * @param {readonly any[]} records @param {ReadonlySet<string>} conflicted ids in an open disagreement
 * @returns {import("./common.mjs").MapLane[]}
 */
export function lanesOf(records, conflicted = new Set()) {
  const byId = new Map(records.map((record) => [record.id, record]));
  /** @type {Map<string, string>} */
  const parent = new Map();
  const find = (/** @type {string} */ id) => {
    let root = id;
    while (parent.get(root) && parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
    return root;
  };
  for (const record of records) parent.set(record.id, record.id);
  for (const record of records) {
    if (record.supersededBy && byId.has(record.supersededBy)) parent.set(find(record.id), find(record.supersededBy));
  }
  /** @type {Map<string, any[]>} */
  const chains = new Map();
  for (const record of records) chains.set(find(record.id), [...(chains.get(find(record.id)) ?? []), record]);
  const lanes = [];
  for (const [root, members] of chains) {
    if (members.length < 2) continue;
    // Oldest version first: by how many replacements precede it, then by when it began — two versions written in one second are still in order.
    const depth = (/** @type {any} */ record, /** @type {number} */ guard = 0) => {
      const before = members.filter((other) => other.supersededBy === record.id);
      return before.length === 0 || guard > members.length ? 0 : 1 + Math.max(...before.map((other) => depth(other, guard + 1)));
    };
    const ordered = members.map((record) => ({ record, depth: depth(record) }))
      .sort((left, right) => left.depth - right.depth
        || String(left.record.validFrom ?? left.record.createdAt ?? "").localeCompare(String(right.record.validFrom ?? right.record.createdAt ?? ""))
        || left.record.id.localeCompare(right.record.id))
      .map((entry) => entry.record);
    const current = ordered.findLast((record) => record.status !== "superseded") ?? ordered.at(-1);
    lanes.push({
      moved: ordered.map((record) => instant(record.invalidSince) ?? instant(record.updatedAt) ?? "").sort().at(-1) ?? "",
      lane: {
        id: `lineage:${root}`,
        label: excerpt(recordText(current), 24),
        projectId: current.scope === "project" ? current.scopeId : null,
        segments: ordered.map((record) => ({
          recordId: record.id,
          text: excerpt(recordText(record), 60),
          from: instant(record.validFrom) ?? instant(record.createdAt),
          to: record.status === "superseded" ? instant(record.invalidSince) ?? instant(record.updatedAt) : null,
          state: /** @type {"current" | "replaced"} */ (record.status === "superseded" ? "replaced" : "current"),
          conflict: conflicted.has(record.id),
        })),
      },
    });
  }
  return lanes.sort((left, right) => right.moved.localeCompare(left.moved) || left.lane.id.localeCompare(right.lane.id))
    .slice(0, MAP_LANE_LIMIT).map((entry) => entry.lane);
}

/**
 * The second radar: how many memories the account holds under each aspect now, and held 30 days ago. One scale, so the shape
 * that changes between the two polygons is a real change, and the count is the number at the vertex.
 * @param {readonly any[]} records @param {Date} now
 * @returns {import("./common.mjs").MapDimension}
 */
export function aspectDimension(records, now) {
  const then = now.getTime() - MAP_PREVIOUS_DAYS * 86_400_000;
  const heldNow = records.filter((record) => record.status === "active" || record.status === "pending");
  const heldThen = records.filter((record) => {
    const began = Date.parse(record.validFrom ?? record.createdAt ?? "");
    if (!Number.isFinite(began) || began > then) return false;
    if (record.status === "superseded") {
      const ended = Date.parse(record.invalidSince ?? record.updatedAt ?? "");
      return Number.isFinite(ended) && ended > then;
    }
    return true;
  });
  const axes = MEMORY_ASPECTS.map((aspect) => {
    const count = heldNow.filter((record) => aspect.kinds.includes(record.kind)).length;
    const previous = heldThen.filter((record) => aspect.kinds.includes(record.kind)).length;
    return { id: aspect.id, label: aspect.label, value: count, previousValue: previous, count, kinds: [...aspect.kinds] };
  });
  return {
    id: "memory", title: "各方面记了多少", previous: `${MAP_PREVIOUS_DAYS} 天前`, scale: "count",
    total: axes.reduce((sum, axis) => sum + axis.count, 0), previousTotal: axes.reduce((sum, axis) => sum + axis.previousValue, 0), axes,
  };
}

/**
 * The memories the map draws, as the sources that need them share them (one read per request).
 * @param {import("./common.mjs").MapSourceRequest} request @param {any} researchMemory
 */
export async function drawnRecords(request, researchMemory) {
  const found = await request.memo("records", () => researchMemory.mapRecords(request.user.id, { projectId: request.projectId, limit: MAP_RECORD_LIMIT }));
  return found.filter(drawable);
}

/**
 * What those memories rest on, disagree with and are used by (one read per request).
 * @param {import("./common.mjs").MapSourceRequest} request @param {any} researchMemory
 */
export async function drawnLinks(request, researchMemory) {
  const records = await drawnRecords(request, researchMemory);
  return request.memo("links", () => researchMemory.mapLinks(request.user.id, records.map((record) => record.id)));
}

/**
 * Everything the map draws of a set of memories, from the memories and the relations read for them. Pure: the source below reads
 * PostgreSQL and the native engine's source reads files, and both hand their memories to this.
 *
 * @param {readonly any[]} found the memories, in the store's light shape (`publicRecord`)
 * @param {{ sources?: any[], conflicts?: any[], usage?: Record<string, { count: number }> }} links what they rest on, the open
 *   disagreements (`recordStatus` / `otherStatus` when known) and how often each was handed to a run
 * @param {{ now: Date, timeZone: string }} context
 * @returns {import("./common.mjs").MapContribution}
 */
export function recordsContribution(found, links, { now, timeZone }) {
  const records = found.filter(drawable);
  const inSet = new Set(records.map((record) => record.id));
  const live = (/** @type {string} */ id) => ["active", "pending"].includes(records.find((record) => record.id === id)?.status ?? "");
  const at = now.getTime();

  /** @type {Map<string, any[]>} */
  const sourcesOf = new Map();
  for (const source of links.sources ?? []) sourcesOf.set(source.recordId, [...(sourcesOf.get(source.recordId) ?? []), source]);
  // A disagreement is a reason to look at the side that is in force, whether or not the other side can be drawn.
  const conflicted = new Set();
  /** @type {import("./common.mjs").MapEdge[]} */
  const edges = [];
  for (const conflict of links.conflicts ?? []) {
    const bothLive = (conflict.recordStatus ? ["active", "pending"].includes(conflict.recordStatus) : live(conflict.recordId))
      && (conflict.otherStatus ? ["active", "pending"].includes(conflict.otherStatus) : live(conflict.otherId));
    if (!bothLive) continue;
    for (const side of [conflict.recordId, conflict.otherId]) if (inSet.has(side)) conflicted.add(side);
    if (inSet.has(conflict.recordId) && inSet.has(conflict.otherId)) {
      edges.push({ from: nodeId("memory", conflict.recordId), to: nodeId("memory", conflict.otherId), type: "conflicts" });
    }
  }

  /** @type {import("./common.mjs").MapNode[]} */
  const nodes = [];
  /** @type {Map<string, import("./common.mjs").MapNode>} */
  const outside = new Map();
  for (const record of records) {
    const sources = sourcesOf.get(record.id) ?? [];
    const reason = reasonOf(record, { sources, conflicted: conflicted.has(record.id) }, at);
    const used = links.usage?.[record.id]?.count ?? 0;
    const projectId = record.scope === "project" ? record.scopeId : null;
    const id = nodeId("memory", record.id);
    nodes.push({
      id, type: "memory", subtype: record.kind, group: /** @type {Record<string, string>} */ (MEMORY_KIND_LABELS_ZH)[record.kind] ?? record.kind,
      label: excerpt(recordText(record), MAP_LABEL_CHARS),
      weight: unit(0.5 * (Number(record.importance) || 0) + 0.5 * Math.min(1, Math.log1p(used) / Math.log1p(10))),
      at: instant(record.createdAt),
      state: record.status === "superseded" ? "replaced" : reason ? "check" : "current",
      reason, projectId, open: { kind: "record", id: record.id },
    });
    edges.push({ from: id, to: projectId ? nodeId("project", projectId) : nodeId("you", "account"), type: "belongs-to" });
    if (record.supersededBy && inSet.has(record.supersededBy)) {
      edges.push({ from: nodeId("memory", record.supersededBy), to: id, type: "replaces", at: instant(record.invalidSince) });
    }
    for (const source of sources) {
      const target = sourceNode(source.type, source.id);
      edges.push({ from: id, to: target.id, type: "rests-on", state: source.state, at: source.linkedAt ?? null });
      if (!outside.has(target.id)) {
        outside.set(target.id, target.type === "document"
          ? { id: target.id, type: "document", label: "一份资料", state: "current", open: { kind: "page", href: `/app/files/${encodeURIComponent(source.id)}` } }
          : { id: target.id, type: "reference", subtype: source.type, label: referenceLabel(source.type, source.id), state: "current" });
      }
    }
  }

  const kinds = new Map();
  for (const record of records) {
    if (record.status === "superseded") continue;
    kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
  }
  const dated = records.map((record) => instant(record.createdAt)).filter(Boolean).sort();
  const events = memoryEventsOf(records);
  return {
    nodes: [...nodes, ...outside.values()],
    edges,
    lanes: lanesOf(records, conflicted),
    events,
    buckets: bucketsOf(events, timeZone, now),
    facets: {
      kinds: [...kinds.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([id, count]) => ({ id, label: /** @type {Record<string, string>} */ (MEMORY_KIND_LABELS_ZH)[id] ?? id, count })),
      dimensions: [aspectDimension(records, now)],
    },
    facts: { since: dated[0] ?? null },
  };
}

/**
 * @param {{ researchMemory: any }} dependencies `mapRecords` and `mapLinks`, as `ResearchMemoryStore` has them
 * @returns {import("./common.mjs").MapSource}
 */
export function createRecordsSource({ researchMemory }) {
  return {
    name: "records",
    applies: (request) => request.engine !== "native" && typeof researchMemory?.mapRecords === "function",
    async read(request) {
      const records = await drawnRecords(request, researchMemory);
      const links = await drawnLinks(request, researchMemory);
      return recordsContribution(records, links, { now: request.now, timeZone: request.timeZone });
    },
  };
}
