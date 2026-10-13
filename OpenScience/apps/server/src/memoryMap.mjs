import { dayOf, timeZoneOrDefault } from "./memoryTimeline.mjs";
import { HttpError, apiBaseFromRequest, assertObject, readJson, sendJson } from "./security.mjs";
import { MAP_EDGE_TYPES, MAP_NODE_TYPES, excerpt, nodeId, parseNodeId, requestMemo } from "./memoryMapSources/common.mjs";
import { edgeIdOf, isDismissable } from "./memoryMapEdges.mjs";

/**
 * 「记忆地图」: the one read-only document every view of the map is drawn from — what the platform remembers and knows about a
 * researcher, as marks, the lines between them, how they changed and when.
 *
 * Hidden knowledge:
 *
 * - **Derived when read, and nothing is written** (like `memoryTimeline.mjs`): every mark and line comes from a store that already
 *   owns it, so the map cannot disagree with the memory page it opens onto. The one thing that ever writes near it is the topics'
 *   regrouping, which is a separate request (`POST /api/memory/topics/refresh`) with a daily bound of its own.
 * - **Sources, not queries.** The document is assembled from independent sources (`memoryMapSources/*`) that each return what
 *   they have: the memories in PostgreSQL, the knowledge-base documents, the learned methods, the ledgers, the topics. A source
 *   that fails costs its part of the map and is named in `missing`; the others are drawn as they would have been (principle 19).
 *   Two sources are seams for packages still being built — the native memory engine (`nativeMemory.mjs`) and the knowledge graph
 *   an OpenViking compile writes (`knowledgeGraph.mjs`) — and contribute nothing until a reader is wired into them.
 * - **A mark is `<type>:<id>`** and carries what a click opens (`open`), so any view's mark opens through one path: the memory
 *   drawer for `record`, the method drawer for `method`, an address of its own for a `page`. A document is not opened in a drawer.
 * - **Never drawn:** a run summary, a sensitive memory, a forgotten one. Who wrote a memory and how sure it is are the platform's
 *   own and appear in no field of this document (owner ruling of 2026-10-10); there is no word in it for 「推断」.
 * - **The caps are the server's.** An overview holds at most `MAP_OVERVIEW_NODES` marks: what does not fit is folded into clusters
 *   by project and kind, those that need a second look are never folded, and `truncated` says how many were. A focus holds at
 *   most `MAP_FOCUS_NODES` marks around one mark (to a depth of one or two lines) or around one cluster's members, which is how a
 *   cluster is opened. Lines are capped at `MAP_EDGES`.
 * - **Range is a server filter and so is focus; topic, kind, dimension and the search are the page's.** A range keeps the marks
 *   that began inside it and whatever they are tied to; the calendar (`buckets`) is always the last year, whatever the range.
 *
 * @module memoryMap
 */

/** The most marks an overview draws. */
export const MAP_OVERVIEW_NODES = 150;
/** The most marks a focus draws. */
export const MAP_FOCUS_NODES = 300;
/** The most lines either draws. */
export const MAP_EDGES = 600;
/** The most lanes and events a read returns. */
export const MAP_LANES = 40;
export const MAP_EVENTS = 500;
/** How long one source is waited for. */
export const MAP_SOURCE_TIMEOUT_MS = 8_000;
/** The blocks of the document a caller may ask for, and the ones it gets by default. */
export const MAP_BLOCKS = Object.freeze(["summary", "facets", "nodes", "edges", "buckets", "lanes", "events"]);
const DEFAULT_BLOCKS = MAP_BLOCKS.filter((block) => block !== "events");

/** What a range parameter may say. */
const RANGE_DAYS = Object.freeze({ "30d": 30, "90d": 90, "1y": 365 });
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** @param {string} day @param {number} count */
function addDays(day, count) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}

/**
 * The range a request names, as days in the researcher's zone: `30d`, `90d`, `1y`, `all` (the default), or `YYYY-MM-DD..YYYY-MM-DD`.
 * @param {unknown} value @param {Date} now @param {string} timeZone
 * @returns {{ from: string | null, to: string, unit: "day" | "week" | "month" }}
 */
export function rangeOf(value, now, timeZone) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = dayOf(now.toISOString(), format);
  const text = typeof value === "string" && value.trim() ? value.trim() : "all";
  const unitOf = (/** @type {string | null} */ from, /** @type {string} */ to) => {
    if (!from) return "month";
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    return days <= 45 ? "day" : days <= 400 ? "week" : "month";
  };
  if (text === "all") return { from: null, to: today, unit: "month" };
  if (Object.hasOwn(RANGE_DAYS, text)) {
    const from = addDays(today, 1 - RANGE_DAYS[/** @type {keyof typeof RANGE_DAYS} */ (text)]);
    return { from, to: today, unit: unitOf(from, today) };
  }
  const [from, to] = text.split("..");
  if (DAY.test(from ?? "") && DAY.test(to ?? "") && !Number.isNaN(Date.parse(`${from}T00:00:00Z`)) && !Number.isNaN(Date.parse(`${to}T00:00:00Z`))) {
    const [first, last] = from <= to ? [from, to] : [to, from];
    return { from: first, to: last, unit: unitOf(first, last) };
  }
  throw new HttpError(400, "memory_map_invalid", "range must be 30d, 90d, 1y, all or YYYY-MM-DD..YYYY-MM-DD.");
}

/**
 * The part of a block list a request asks for. `include` is a comma-separated subset of `MAP_BLOCKS`.
 * @param {unknown} value @returns {Set<string>}
 */
export function blocksOf(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return new Set(DEFAULT_BLOCKS);
  const asked = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (asked.some((block) => !MAP_BLOCKS.includes(block))) throw new HttpError(400, "memory_map_invalid", `include must be a subset of ${MAP_BLOCKS.join(", ")}.`);
  return new Set(asked);
}

/** @template T @param {Promise<T>} work @param {number} ms */
function within(work, ms) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const clock = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("map source timed out")), ms); });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

/** @param {Record<string, any>} base @param {Record<string, any>} next the fields the later source has */
function layered(base, next) {
  const merged = { ...base };
  // A later source's fields win; its explicit nothing (`open: null`) is only a value when no earlier source said anything.
  for (const [key, value] of Object.entries(next)) if (value !== undefined && (value !== null || merged[key] === undefined)) merged[key] = value;
  return merged;
}

/** How much a mark is worth keeping in view when the map has to fold some. @param {any} node @param {number} degree */
function priority(node, degree) {
  const base = { memory: 1, entity: 0.9, document: 0.85, page: 0.7, method: 0.6, reference: 0.5 }[/** @type {"memory"} */ (node.type)] ?? 0.4;
  const worth = (Number(node.weight) || 0) * 0.5 + Math.min(1, degree / 5) * 0.3 + (node.state === "replaced" ? -0.5 : 0);
  return base + worth;
}

/** The cluster a mark folds into: by project and kind, or — when that leaves too many — by kind alone. @param {any} node @param {1 | 2} level */
function foldKey(node, level) {
  const where = level === 1 ? node.projectId || "account" : "all";
  return `cluster:${node.type}:${where}:${node.subtype || "other"}`;
}

/**
 * Fold what does not fit into clusters. The marks that need a second look, the account and its projects are never folded.
 * @param {any[]} nodes @param {any[]} edges @param {number} limit
 * @returns {{ nodes: any[], edges: any[], folded: number }}
 */
export function foldToFit(nodes, edges, limit) {
  if (nodes.length <= limit) return { nodes, edges, folded: 0 };
  /** @type {Map<string, number>} */
  const degree = new Map();
  for (const edge of edges) for (const end of [edge.from, edge.to]) degree.set(end, (degree.get(end) ?? 0) + 1);
  const fixed = nodes.filter((node) => node.type === "you" || node.type === "project" || node.state === "check");
  const rest = nodes.filter((node) => !fixed.includes(node))
    .sort((left, right) => priority(right, degree.get(right.id) ?? 0) - priority(left, degree.get(left.id) ?? 0)
      || String(right.at ?? "").localeCompare(String(left.at ?? "")) || left.id.localeCompare(right.id));
  /** @param {any[]} folded @param {1 | 2} level */
  const clusters = (folded, level) => {
    /** @type {Map<string, any>} */
    const made = new Map();
    for (const node of folded) {
      const id = foldKey(node, level);
      const held = made.get(id) ?? {
        id, type: "cluster", subtype: node.subtype ?? null, memberType: node.type, group: node.group ?? node.subtype ?? node.type,
        label: node.group ?? node.subtype ?? node.type, count: 0, projectId: level === 1 ? node.projectId ?? null : null, state: "current", at: node.at ?? null, open: null,
      };
      held.count += 1;
      if (node.at && (!held.at || node.at < held.at)) held.at = node.at;
      made.set(id, held);
    }
    return [...made.values()];
  };
  /** @param {number} kept @param {1 | 2} level */
  const folding = (kept, level) => {
    const folded = rest.slice(kept);
    const made = clusters(folded, level);
    const keep = new Set([...fixed, ...rest.slice(0, kept)].map((node) => node.id));
    const into = new Map(folded.map((node) => [node.id, foldKey(node, level)]));
    const remap = (/** @type {string} */ id) => (keep.has(id) ? id : into.get(id) ?? null);
    const seen = new Set();
    const remapped = [];
    for (const edge of edges) {
      const from = remap(edge.from);
      const to = remap(edge.to);
      if (!from || !to || from === to) continue;
      const key = `${from}\u0000${to}\u0000${edge.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      remapped.push(from === edge.from && to === edge.to ? edge : { ...edge, from, to });
    }
    return { all: [...fixed, ...rest.slice(0, kept), ...made], edges: remapped, folded: folded.length };
  };
  // Keep as many marks as the cap allows after the clusters that stand for the rest, giving marks up five percent at a time; if even
  // that does not fit, fold by kind alone (the clusters then number the kinds there are) and keep none.
  const step = Math.max(1, Math.floor(rest.length * 0.05));
  for (const level of /** @type {const} */ ([1, 2])) {
    for (let kept = Math.min(Math.max(0, limit - fixed.length), rest.length); ; kept = Math.max(0, kept - step)) {
      const attempt = folding(kept, level);
      if (attempt.all.length <= limit || (level === 2 && kept === 0)) return { nodes: attempt.all, edges: attempt.edges, folded: attempt.folded };
      if (kept === 0) break;
    }
  }
  return { nodes: fixed.slice(0, limit), edges: [], folded: rest.length };
}

/**
 * The marks around one mark, or around one cluster's members: breadth first, a mark's best neighbours first, to the cap.
 * @param {any[]} nodes @param {any[]} edges @param {string} focus @param {number} depth @param {number} limit
 * @returns {{ nodes: any[], edges: any[] } | null} null when the focus names nothing
 */
export function egoOf(nodes, edges, focus, depth, limit) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  /** @type {Map<string, string[]>} */
  const around = new Map();
  for (const edge of edges) {
    around.set(edge.from, [...(around.get(edge.from) ?? []), edge.to]);
    around.set(edge.to, [...(around.get(edge.to) ?? []), edge.from]);
  }
  const degree = (/** @type {string} */ id) => around.get(id)?.length ?? 0;
  const rank = (/** @type {string[]} */ ids) => [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean)
    .sort((left, right) => priority(right, degree(right.id)) - priority(left, degree(left.id)) || left.id.localeCompare(right.id)).map((node) => node.id);
  /** @type {string[]} */
  let seeds;
  if (focus.startsWith("cluster:")) {
    seeds = rank(nodes.filter((node) => node.type !== "you" && node.type !== "project" && (foldKey(node, 1) === focus || foldKey(node, 2) === focus)).map((node) => node.id));
    if (seeds.length === 0) return null;
    seeds = seeds.slice(0, Math.floor(limit * 0.6));
  } else {
    if (!byId.has(focus)) return null;
    seeds = [focus];
  }
  const chosen = new Set(seeds);
  let frontier = seeds;
  const levels = focus.startsWith("cluster:") ? 1 : depth;
  for (let level = 0; level < levels && chosen.size < limit; level += 1) {
    const next = [];
    for (const id of frontier) {
      for (const neighbour of rank(around.get(id) ?? [])) {
        if (chosen.has(neighbour)) continue;
        if (chosen.size >= limit) break;
        chosen.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  const kept = nodes.filter((node) => chosen.has(node.id));
  return { nodes: kept, edges: edges.filter((edge) => chosen.has(edge.from) && chosen.has(edge.to)) };
}

/**
 * The map of one account.
 *
 * @param {{ sources: import("./memoryMapSources/common.mjs").MapSource[] }} dependencies
 * @param {{ user: { id: string }, projects: { id: string, name: string, kind?: string }[], projectId?: string | null,
 *   range?: unknown, timeZone?: unknown, now?: Date, engine?: "postgres" | "native", focus?: unknown, depth?: unknown, include?: unknown,
 *   dismissedEdges?: ReadonlySet<string> | null }} request
 *   `dismissedEdges`: the ids of the lines the account called wrong (`memoryMapEdges.mjs`), left out of the map. `projects` are the account's own, never the platform's internal ones; `projectId`, when given, has already been checked to be one of them
 */
export async function buildMemoryMap({ sources }, request) {
  const now = request.now ?? new Date();
  const timeZone = timeZoneOrDefault(request.timeZone);
  const range = rangeOf(request.range, now, timeZone);
  const blocks = blocksOf(request.include);
  const depth = Math.max(1, Math.min(2, Math.trunc(Number(request.depth) || 1)));
  const projectId = request.projectId ? String(request.projectId) : null;
  const focusText = typeof request.focus === "string" ? request.focus.trim() : "";
  if (focusText && (focusText.length > 400 || !parseNodeId(focusText))) throw new HttpError(400, "memory_map_invalid", "focus must be a mark id.");
  const projects = request.projects.map((project) => ({ id: project.id, name: project.name, kind: project.kind ?? "own" }));

  /** @type {import("./memoryMapSources/common.mjs").MapSourceRequest} */
  const asked = {
    user: request.user, projects, projectId, range, timeZone, now, engine: request.engine ?? "postgres", focus: focusText || null, memo: requestMemo(),
  };

  /** @type {string[]} */
  const missing = [];
  const answers = await Promise.all(sources.map(async (source) => {
    if (source.applies && !source.applies(asked)) return null;
    try {
      return await within(source.read(asked), MAP_SOURCE_TIMEOUT_MS);
    } catch {
      missing.push(source.name);
      return null;
    }
  }));

  // ---- merge ----
  /** @type {Map<string, any>} */
  const merged = new Map();
  /** @type {Map<string, any>} */
  const joined = new Map();
  /** @type {any[]} */
  const lanes = [];
  /** @type {any[]} */
  const events = [];
  /** @type {Map<string, any>} */
  const days = new Map();
  /** @type {any[]} */
  const kinds = [];
  /** @type {any[]} */
  const dimensions = [];
  /** @type {any[]} */
  let topics = [];
  let topicsStatus = "off";
  /** @type {string[]} */
  const since = [];
  for (const answer of answers) {
    if (!answer) continue;
    for (const node of answer.nodes ?? []) {
      if (node && typeof node.id === "string" && MAP_NODE_TYPES.includes(node.type)) merged.set(node.id, layered(merged.get(node.id) ?? {}, node));
    }
    for (const edge of answer.edges ?? []) {
      if (!edge || !MAP_EDGE_TYPES.includes(edge.type)) continue;
      // Every line carries a stable id, so the researcher can call one wrong; one they already did is not drawn.
      const id = edgeIdOf(edge);
      if (isDismissable(edge) && request.dismissedEdges?.has(id)) continue;
      joined.set(`${edge.from}\u0000${edge.to}\u0000${edge.type}`, joined.get(`${edge.from}\u0000${edge.to}\u0000${edge.type}`) ?? { ...edge, id });
    }
    lanes.push(...(answer.lanes ?? []));
    events.push(...(answer.events ?? []));
    for (const bucket of answer.buckets ?? []) {
      const held = days.get(bucket.t) ?? { t: bucket.t, memory: 0, run: 0, method: 0, feedback: 0 };
      for (const key of ["memory", "run", "method", "feedback"]) held[key] += Number(bucket[key]) || 0;
      days.set(bucket.t, held);
    }
    kinds.push(...(answer.facets?.kinds ?? []));
    dimensions.push(...(answer.facets?.dimensions ?? []));
    if (answer.facets?.topics) topics = answer.facets.topics;
    if (answer.facts?.topicsStatus) topicsStatus = answer.facts.topicsStatus;
    if (answer.facts?.since) since.push(answer.facts.since);
    missing.push(...(answer.missing ?? []));
  }

  // A memory of a project the account no longer has (or one of the platform's own) hangs from one mark, 「其他」, as it does under the
  // memory page's 项目 dropdown.
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const OTHER = "__other";
  const homeOf = (/** @type {string} */ id) => (projectName.has(id) ? id : OTHER);
  for (const node of merged.values()) if (node.projectId && !projectName.has(node.projectId)) node.projectId = OTHER;
  const edgesAll = [...joined.values()].map((edge) => {
    const from = edge.from.startsWith("project:") ? nodeId("project", homeOf(edge.from.slice(8))) : edge.from;
    const to = edge.to.startsWith("project:") ? nodeId("project", homeOf(edge.to.slice(8))) : edge.to;
    return from === edge.from && to === edge.to ? edge : { ...edge, from, to };
  });
  if (edgesAll.some((edge) => edge.from === nodeId("project", OTHER) || edge.to === nodeId("project", OTHER))) projectName.set(OTHER, "其他");
  const ends = new Set(edgesAll.flatMap((edge) => [edge.from, edge.to]));
  for (const [id, name] of projectName) {
    const mark = nodeId("project", id);
    if (ends.has(mark) || id === projectId) merged.set(mark, { id: mark, type: "project", label: excerpt(name, 40), state: "current", projectId: id, open: null });
  }
  if (ends.has(nodeId("you", "account"))) merged.set(nodeId("you", "account"), { id: nodeId("you", "account"), type: "you", label: "你", state: "current", open: null });

  // ---- range: what began inside it, and whatever that is tied to ----
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayOfNode = (/** @type {any} */ node) => (node.at ? dayOf(node.at, format) : null);
  const inRange = (/** @type {string | null} */ day) => day === null || ((range.from === null || day >= range.from) && day <= range.to);
  /** @type {Set<string>} */
  const kept = new Set();
  for (const node of merged.values()) {
    if (node.type === "you" || node.type === "project" || node.type === "entity" || node.type === "page" || node.type === "cluster") kept.add(node.id);
    else if (inRange(dayOfNode(node))) kept.add(node.id);
  }
  if (range.from !== null) {
    for (const edge of edgesAll) {
      if (edge.type === "belongs-to") continue;
      const memoryEnd = [edge.from, edge.to].find((id) => id.startsWith("memory:") && kept.has(id));
      if (memoryEnd) for (const id of [edge.from, edge.to]) if (merged.has(id)) kept.add(id);
    }
  }
  let nodes = [...merged.values()].filter((node) => kept.has(node.id));
  let edges = edgesAll.filter((edge) => kept.has(edge.from) && kept.has(edge.to) && merged.has(edge.from) && merged.has(edge.to));
  // A project or the account with nothing left hanging from it is not a mark, and neither is an outside source nothing rests on.
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  nodes = nodes.filter((node) => (node.type !== "you" && node.type !== "project" && node.type !== "reference") || linked.has(node.id) || node.projectId === projectId);

  // ---- topics onto marks ----
  const present = new Set(nodes.map((node) => node.id));
  const shownTopics = topics.map((topic) => ({ ...topic, members: topic.members.filter((/** @type {string} */ id) => present.has(id)) }))
    .filter((topic) => topic.members.length > 0);
  /** @type {Map<string, string[]>} */
  const topicsOf = new Map();
  for (const topic of shownTopics) for (const id of topic.members) topicsOf.set(id, [...(topicsOf.get(id) ?? []), topic.id]);
  nodes = nodes.map((node) => (topicsOf.has(node.id) ? { ...node, topics: topicsOf.get(node.id) } : node));

  // ---- the headline numbers, before anything is folded ----
  const memories = nodes.filter((node) => node.type === "memory" && node.state !== "replaced");
  const summary = {
    memories: memories.length,
    documents: nodes.filter((node) => node.type === "document").length,
    methods: nodes.filter((node) => node.type === "method").length,
    projects: nodes.filter((node) => node.type === "project").length,
    needsLook: memories.filter((node) => node.state === "check").length,
    since: since.sort()[0] ? dayOf(since[0], format) : null,
  };
  const counted = new Map();
  for (const node of memories) counted.set(node.subtype, { id: node.subtype, label: node.group ?? node.subtype, count: (counted.get(node.subtype)?.count ?? 0) + 1 });
  const facets = {
    projects: projects.filter((project) => !projectId || project.id === projectId).map((project) => ({
      id: project.id, name: project.name, kind: project.kind,
      memories: memories.filter((node) => node.projectId === project.id).length,
      documents: nodes.filter((node) => node.type === "document" && node.projectId === project.id).length,
    })),
    kinds: [...counted.values()].sort((left, right) => right.count - left.count || String(left.id).localeCompare(String(right.id))),
    topics: shownTopics,
    dimensions: ["work", "memory"].flatMap((id) => dimensions.filter((dimension) => dimension.id === id).slice(0, 1)),
  };

  // ---- caps: an overview folds what does not fit; a focus shows what is around one mark ----
  /** @type {{ nodes: number, edges: number }} */
  const truncated = { nodes: 0, edges: 0 };
  let focus = null;
  if (focusText) {
    const around = egoOf(nodes, edges, focusText, depth, MAP_FOCUS_NODES);
    if (around) {
      focus = focusText;
      truncated.nodes = Math.max(0, nodes.length - around.nodes.length);
      nodes = around.nodes;
      edges = around.edges;
    }
  }
  if (!focus) {
    const fitted = foldToFit(nodes, edges, MAP_OVERVIEW_NODES);
    nodes = fitted.nodes;
    edges = fitted.edges;
    truncated.nodes = fitted.folded;
  }
  if (edges.length > MAP_EDGES) {
    truncated.edges = edges.length - MAP_EDGES;
    edges = edges.slice(0, MAP_EDGES);
  }

  // ---- lanes, events, days ----
  const overlaps = (/** @type {string | null} */ from, /** @type {string | null} */ to) => {
    const first = from ? dayOf(from, format) : null;
    const last = to ? dayOf(to, format) : null;
    return (range.from === null || last === null || last >= range.from) && (first === null || first <= range.to);
  };
  const shownLanes = lanes.filter((lane) => (!projectId || lane.projectId === projectId) && lane.segments.some((/** @type {any} */ segment) => overlaps(segment.from, segment.to))).slice(0, MAP_LANES);
  const shownEvents = events.filter((event) => inRange(dayOf(event.at, format))).sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id)).slice(0, MAP_EVENTS);
  const series = [...days.values()].sort((left, right) => left.t.localeCompare(right.t));

  const unique = [...new Set(missing)];
  /** @type {Record<string, any>} */
  const document = {
    version: 1,
    scope: { projectId, range, timeZone, focus, depth: focus ? depth : null },
    status: { topics: topicsStatus },
    summary, facets, nodes, edges,
    buckets: { unit: "day", series },
    lanes: shownLanes, events: shownEvents,
    truncated, missing: unique,
  };
  for (const block of MAP_BLOCKS) if (!blocks.has(block)) delete document[block];
  return document;
}

/**
 * `GET /api/memory/map`, `GET /api/memory/records/:id/links`, `POST /api/memory/topics/refresh` and `PATCH /api/memory/topics/:id`.
 *
 * Off with the memory subsystem or with `OPEN_SCIENCE_MEMORY_MAP_ENABLED`: the routes then answer 503 by name, so a deployment that
 * turned the map off and one where the route moved are different facts. Registered before the memory routes in `createWebApiApp`:
 * `/api/memory/records/:id/links` would otherwise be read as a record id with a slash in it.
 *
 * @param {{
 *   config: any, researchMemory: any, sources: import("./memoryMapSources/common.mjs").MapSource[],
 *   topics?: import("./memoryTopics.mjs").MemoryTopics | null, store: any, context: (req: any, res: any) => Promise<any>,
 *   memoryEngine?: (userId: string) => Promise<"postgres" | "native"> | "postgres" | "native",
 *   projectOf?: (user: any, projectId: string) => Promise<any>,
 *   isInternalProject?: (userId: string, projectId: string) => boolean,
 *   recordLinks?: ((user: any, record: any) => Promise<any>) | null,
 *   edgeCorrections?: import("./memoryMapEdges.mjs").MapEdgeCorrections | null,
 *   accountRecords?: ((userId: string) => Promise<any[]>) | null,
 *   nativeLinks?: ((user: any, recordId: string) => Promise<any>) | null,
 *   decodeRouteComponent: (value: string, label: string) => string, audit?: ((ctx: any, action: string, status: string, details?: any) => Promise<void>) | null,
 * }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createMemoryMapRoutes({
  config, researchMemory, sources, topics = null, store, context, memoryEngine = () => "postgres", isInternalProject = () => false,
  recordLinks = null, nativeLinks = null, edgeCorrections = null, accountRecords = null, decodeRouteComponent, audit = null,
}) {
  /** The account's memories as the topics are made from them, from whichever engine holds them. */
  const topicRecords = (/** @type {string} */ userId) => (accountRecords ? accountRecords(userId) : researchMemory.mapRecords(userId, { projectId: null, limit: 2000 }));
  const enabled = config.memoryEnabled !== false && config.memoryMapEnabled !== false;
  const TOPICS = /^\/api\/memory\/topics(?:\/([^/]+))?$/u;
  const LINKS = /^\/api\/memory\/records\/([^/]+)\/links$/u;
  const EDGE = /^\/api\/memory\/map\/edges\/([^/]+)$/u;

  return async function memoryMapRoutes(req, res) {
    const pathname = new URL(req.url ?? "/", "http://evimed.local").pathname;
    const isMap = pathname === "/api/memory/map";
    const links = LINKS.exec(pathname);
    const topic = TOPICS.exec(pathname);
    const edge = EDGE.exec(pathname);
    if (!isMap && !links && !topic && !edge) return false;
    if (!enabled) throw new HttpError(503, "memory_map_disabled", "The memory map is disabled in this deployment.");
    if (!researchMemory?.configured) throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");

    if (isMap) {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "The memory map is read-only.");
      const ctx = await context(req, res);
      const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
      // The project first: one of another account is a 404, as for the project overview, and nothing is read before that is settled.
      const asked = url.searchParams.get("projectId");
      const project = asked ? await store.requireProject(ctx.user, decodeRouteComponent(asked, "project id")) : null;
      if (project && isInternalProject(ctx.user.id, project.id)) throw new HttpError(404, "project_not_found", "Project not found.");
      const listed = (await store.listProjects(ctx.user)).filter((/** @type {any} */ item) => !isInternalProject(ctx.user.id, item.id) && !item.archivedAt);
      // What the account called wrong; a failed read costs the corrections, never the map.
      const dismissedEdges = await edgeCorrections?.dismissed(ctx.user.id).catch(() => null) ?? null;
      const map = await buildMemoryMap({ sources }, {
        user: ctx.user, projects: listed, projectId: project?.id ?? null, dismissedEdges,
        range: url.searchParams.get("range"), timeZone: url.searchParams.get("timeZone"), engine: await memoryEngine(ctx.user.id),
        focus: url.searchParams.get("focus"), depth: url.searchParams.get("depth"), include: url.searchParams.get("include"),
      });
      sendJson(res, 200, { data: map });
      return true;
    }

    // 「这条关联不对」: a line of the relation view the researcher called wrong, or took back.
    if (edge) {
      if (req.method !== "PUT") throw new HttpError(405, "method_not_allowed", "A line is hidden or shown again with PUT.");
      const ctx = await context(req, res);
      if (!edgeCorrections?.configured) throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");
      const body = assertObject(await readJson(req, config.maxJsonBytes), "line correction");
      const unknown = Object.keys(body).filter((field) => field !== "hidden");
      if (unknown.length > 0 || typeof body.hidden !== "boolean") throw new HttpError(400, "memory_map_invalid", "A line correction says hidden: true or false.");
      const done = await edgeCorrections.set(ctx.user.id, decodeRouteComponent(edge[1], "line id"), body.hidden);
      await audit?.(ctx, "memory.map.edge", "completed", { hidden: done.hidden });
      sendJson(res, 200, { data: done });
      return true;
    }

    if (links) {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "A memory's links are read-only.");
      const ctx = await context(req, res);
      const recordId = decodeRouteComponent(links[1], "structured memory id");
      // An account on the native engine: the memory is a file of the engine's, and its links are what the overlay recorded.
      if (nativeLinks && await memoryEngine(ctx.user.id) === "native") {
        sendJson(res, 200, { data: await nativeLinks(ctx.user, recordId) });
        return true;
      }
      // The record first: one of another account is a 404.
      const record = await researchMemory.getRecord(ctx.user.id, recordId);
      if (record.sensitive || record.kind === "run_summary") throw new HttpError(404, "memory_not_found", "Memory not found.");
      sendJson(res, 200, { data: recordLinks ? await recordLinks(ctx.user, record) : { rests: [], replaced: [], replacedBy: null, conflicts: [], usedIn: [] } });
      return true;
    }

    // ---- topics ----
    const ctx = await context(req, res);
    if (!topics?.configured) throw new HttpError(503, "memory_topics_unavailable", "Memory topics are not available in this deployment.");
    if (!topic[1] && pathname === "/api/memory/topics" && req.method === "GET") {
      const records = await topicRecords(ctx.user.id);
      sendJson(res, 200, { data: await topics.read(ctx.user.id, records) });
      return true;
    }
    if (pathname === "/api/memory/topics/refresh" && req.method === "POST") {
      const result = await topics.refresh(ctx.user.id, { projectId: ctx.project.id });
      sendJson(res, 200, { data: result });
      return true;
    }
    if (topic[1] && req.method === "PATCH") {
      const id = decodeRouteComponent(topic[1], "topic id");
      const body = assertObject(await readJson(req, config.maxJsonBytes), "topic update");
      const verbs = ["label", "mergeInto", "dismiss", "removeMember"].filter((field) => Object.hasOwn(body, field));
      const unknown = Object.keys(body).filter((field) => !["label", "mergeInto", "dismiss", "removeMember"].includes(field));
      if (verbs.length !== 1 || unknown.length > 0) throw new HttpError(400, "memory_topic_invalid", "A topic update says exactly one of label, mergeInto, dismiss or removeMember.");
      let done = false;
      if (verbs[0] === "label") done = await topics.rename(ctx.user.id, id, String(body.label ?? ""));
      else if (verbs[0] === "mergeInto") done = await topics.merge(ctx.user.id, id, String(body.mergeInto ?? ""));
      else if (verbs[0] === "dismiss") done = body.dismiss === true && await topics.dismiss(ctx.user.id, id);
      else done = await topics.removeMember(ctx.user.id, id, String(body.removeMember ?? ""));
      if (!done) throw new HttpError(404, "memory_topic_not_found", "Topic not found.");
      await audit?.(ctx, "memory.topic.update", "completed", { verb: verbs[0] });
      const records = await topicRecords(ctx.user.id);
      sendJson(res, 200, { data: await topics.read(ctx.user.id, records) });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "That method is not allowed here.");
  };
}
