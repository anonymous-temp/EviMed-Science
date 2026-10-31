/**
 * What the map draws of an account's memories: marks, the lines between them and what they rest on, and events.
 *
 * Hidden knowledge:
 *
 * - **Derived, never written.** Every mark and line here is read from a store that already has an owner — the engine's memory files
 *   and the overlay's record of what each rests on — so the map cannot disagree with the memory page it opens onto. The one source
 *   is `nativeMemory.mjs`, which reads them and hands them to `recordsContribution`; this module is the pure half. (It also had
 *   a PostgreSQL source over the legacy engine's `records` until that engine was deleted, 2026-10-25; the open
 *   disagreements and the use counters below are what those records had and a file of the engine does not.)
 * - **What is never drawn.** A run summary names a conversation and is not a memory; a sensitive memory is never recalled and
 *   is never drawn; a forgotten one is under 已忘记的内容. The store filters them, and this module does not trust that alone: it
 *   drops them again, because the rule is the map's and not the query's.
 * - **Nothing here is a back-office label.** `origin` and `provenance` — who wrote a memory and how sure it is — are the
 *   platform's own and never reach a field of this document (owner ruling 2026-10-10).
 * - **A mark that needs a second look says why**, in one code (`MAP_REASONS`): a source it rests on was withdrawn, changed or
 *   expired, or its own date has passed. The first that holds is the one told.
 *
 * @module memoryMapSources/records
 */

import { MEMORY_KIND_LABELS_ZH } from "../memoryKinds.mjs";
import { memoryEventsOf } from "./activity.mjs";
import { excerpt, freshnessOf, instant, nodeId, unit } from "./common.mjs";

/** The memories one read draws at most (the store reads the most recently changed). */
export const MAP_RECORD_LIMIT = 2000;
/** The longest a mark's label is. */
export const MAP_LABEL_CHARS = 40;

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
 * Everything the map draws of a set of memories, from the memories and the relations read for them. Pure: the source reads the
 * engine's files and hands its memories to this.
 *
 * @param {readonly any[]} found the memories, in the store's light shape (`publicRecord`)
 * @param {{ sources?: any[], conflicts?: any[], usage?: Record<string, { count: number }>, replaced?: readonly import("./replacedStatements.mjs").ReplacedStatement[] }} links
 *   what they rest on, the open disagreements (`recordStatus` / `otherStatus` when known), how often each was handed to a run and what they used to say
 * @param {{ now: Date, weigh?: (record: any) => number }} context `weigh`: what a mark's size says when the store has no
 *   importance of its own to say it (the native engine's files all have the same): given, it replaces the importance-and-use weight
 * @returns {import("./common.mjs").MapContribution}
 */
export function recordsContribution(found, links, { now, weigh = undefined }) {
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
      weight: weigh ? unit(weigh(record)) : unit(0.5 * (Number(record.importance) || 0) + 0.5 * Math.min(1, Math.log1p(used) / Math.log1p(10))),
      at: instant(record.createdAt),
      freshness: record.status === "superseded" ? 0 : freshnessOf({ kind: record.kind, projectId, writtenAt: record.updatedAt ?? record.createdAt, recalledAt: record.lastRecalledAt, recalls: record.recallCount }, now),
      recalledAt: instant(record.lastRecalledAt),
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

  // What they used to say: a mark of its own, in grey, with a line from what replaced it. It opens the drawer of the memory in force, which lists the versions.
  const byId = new Map(records.map((record) => [record.id, record]));
  const replacedIds = new Set((links.replaced ?? []).map((statement) => statement.id));
  for (const statement of links.replaced ?? []) {
    const head = byId.get(statement.head);
    if (!head || !(byId.has(statement.successor) || replacedIds.has(statement.successor))) continue;
    const projectId = head.scope === "project" ? head.scopeId : null;
    const id = nodeId("memory", statement.id);
    nodes.push({
      id, type: "memory", subtype: head.kind, group: /** @type {Record<string, string>} */ (MEMORY_KIND_LABELS_ZH)[head.kind] ?? head.kind,
      label: excerpt(statement.text, MAP_LABEL_CHARS), weight: 0.1, at: instant(statement.at), until: instant(statement.until), freshness: 0, recalledAt: null,
      state: "replaced", reason: null, projectId, open: { kind: "record", id: head.id },
    });
    edges.push({ from: id, to: projectId ? nodeId("project", projectId) : nodeId("you", "account"), type: "belongs-to" });
    edges.push({ from: nodeId("memory", statement.successor), to: id, type: "replaces", at: instant(statement.until) });
  }

  const dated = records.map((record) => instant(record.createdAt)).filter(Boolean).sort();
  return { nodes: [...nodes, ...outside.values()], edges, events: memoryEventsOf(records), facts: { since: dated[0] ?? null } };
}
