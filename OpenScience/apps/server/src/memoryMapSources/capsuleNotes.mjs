/**
 * The map's capsule notes: the notes in force of the account's own capsule — what a conversation noted, each labelled with the project
 * it was written in (`capsuleEntryProject.mjs`), and whatever the researcher noted on the capsule page, which belongs to no project —
 * as marks and as the events the change chart counts.
 *
 * Hidden knowledge:
 *
 * - **A note is a memory to the person.** It is listed on the memory page beside the memories (`mine`: the account capsule, and any
 *   capsule made by hand before there was only one, the notes in force), so the map draws it as a memory — a `memory:entry:<id>` mark of the memory's
 *   own kinds (`profile`, `preference`, `project_fact`… and the capsule's `writing_style`, `expertise`, `method_preference`) — and counts it
 *   in the headline and the growth. It was left out while a native account's conversation could not read the notes: a page
 *   that counted what the conversation could not use said more than the platform held (H report §4.4). The package that reaches them
 *   from a native conversation shipped in the same release, so this one is honest for both engines.
 * - **What a mark opens** is the memory page's own drawer, `entry:<id>` (`MapOpen.kind === "entry"`), which edits, forgets and undoes a
 *   note through the capsule's own routes. A note nothing remembers by a record's id has no links, sources or topics: it is not a node the
 *   records' relation read knows, and the map does not pretend it is.
 * - **Never drawn:** a note the researcher retired (it is under 已忘记的内容), and what a document yielded (`mine` never lists it).
 * - **Derived and read-only**, like every source; a note's day is the day it was written (`createdAt`), and its mark's weight is its
 *   recency, as a native memory's is.
 *
 * @module memoryMapSources/capsuleNotes
 */

import { MEMORY_KIND_LABELS_ZH } from "../memoryKinds.mjs";
import { entryProject } from "../capsuleEntryProject.mjs";
import { excerpt, instant, nodeId, freshnessOf, recencyWeight } from "./common.mjs";
import { MAP_LABEL_CHARS } from "./records.mjs";

/** The notes one read draws at most (the newest). */
export const MAP_CAPSULE_NOTE_LIMIT = 300;

/** What a kind of note is called where the memory's own kinds have no word for it (the capsule's vocabulary is wider than the memory's). */
const NOTE_KIND_WORDS = Object.freeze({ writing_style: "写作习惯", expertise: "背景知识", stance: "立场", method_preference: "研究方法", tooling: "工具", tension: "两难之处", analysis: "分析要素" });

/**
 * The map's contribution of a set of notes in force. Pure: the source below reads the capsules and this draws what it was given.
 *
 * @param {readonly any[]} entries the notes in force, as `CapsuleService.mine` lists them (the project label on the document as `projectId`, the fact in `payload`)
 * @param {{ now: Date, projectId: string | null }} context `projectId`: the project the map is narrowed to, whose notes alone are drawn
 * @returns {import("./common.mjs").MapContribution}
 */
export function capsuleNotesContribution(entries, { now, projectId }) {
  const notes = entries.filter((entry) => entry && entry.deletedAt == null && entry.payload?.status === "approved" && String(entry.payload.content ?? "").trim()
    && (!projectId || entryProject(entry) === projectId));
  /** @type {import("./common.mjs").MapNode[]} */
  const nodes = [];
  /** @type {import("./common.mjs").MapEdge[]} */
  const edges = [];
  /** @type {import("./common.mjs").MapEvent[]} */
  const events = [];
  for (const entry of notes) {
    const kind = String(entry.payload.factKind ?? "profile");
    const label = entryProject(entry);
    const home = label ? nodeId("project", label) : nodeId("you", "account");
    const id = nodeId("memory", `entry:${entry.id}`);
    const at = instant(entry.createdAt);
    nodes.push({
      id, type: "memory", subtype: kind, group: /** @type {Record<string, string>} */ (MEMORY_KIND_LABELS_ZH)[kind] ?? /** @type {Record<string, string>} */ (NOTE_KIND_WORDS)[kind] ?? kind, label: excerpt(entry.payload.content, MAP_LABEL_CHARS), weight: recencyWeight(at, now),
      at, freshness: freshnessOf({ kind, projectId: label, writtenAt: at }, now), recalledAt: null, state: "current", reason: null, projectId: label, open: { kind: "entry", id: String(entry.id) },
    });
    edges.push({ from: id, to: home, type: "belongs-to" });
    if (at) {
      events.push({
        id: `${id}:created`, at, type: "memory", change: "created", ref: id, text: excerpt(entry.payload.content, 80),
      });
    }
  }
  return { nodes, edges, events, facts: { since: events.map((event) => event.at).sort()[0] ?? null } };
}

/**
 * @param {{ capsules: { mine: (userId: string, options?: { limit?: number }) => Promise<{ entries?: any[] }> } | null }} dependencies
 * @returns {import("./common.mjs").MapSource}
 */
export function createCapsuleNotesSource({ capsules }) {
  return {
    name: "capsule-notes",
    applies: () => Boolean(capsules) && typeof capsules?.mine === "function",
    async read(request) {
      const mine = await request.memo("capsule-notes", () => /** @type {NonNullable<typeof capsules>} */ (capsules).mine(request.user.id, { limit: MAP_CAPSULE_NOTE_LIMIT }));
      return capsuleNotesContribution(mine?.entries ?? [], { now: request.now, projectId: request.projectId });
    },
  };
}
