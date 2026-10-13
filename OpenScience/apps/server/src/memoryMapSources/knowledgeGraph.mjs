/**
 * THE SEAM FOR THE KNOWLEDGE GRAPH an OpenViking compile writes — the parsers are built, the fetching is not.
 *
 * What OpenViking's two compile skills leave in a project's resource tree is plain files, and the files are the contract:
 *
 *   knowledge-graph   entities/<id>.md   YAML frontmatter `type: entity`, `id`, `title`, `entity_type` (open, snake_case),
 *                                        `description` (one sentence), `sources` (the files it was read from), optional `aliases`
 *                     relations.jsonl    one directed edge per line: {"from","relation","label","to","evidence":[uri, …]};
 *                                        `relation` is a stable snake_case predicate, `label` its display name
 *   llm-wiki          <page>.md          frontmatter `type`, `title`; the pages link to each other with ordinary Markdown links
 *                                        `[label](relative/path.md)`, not wikilinks
 *
 * Only the format is consumed here (the upstream display scripts are AGPL and are not copied; the picture is the map's own).
 * `parseEntity`, `parseRelations`, `parseWikiPage` and `graphFromCompile` are pure: files in, marks and lines out, with every
 * line that does not stand reported by line number and left out (a graph is drawn from what stands, never from a guess).
 *
 * What the package that reads the compile products supplies is `fetchProducts` — and nothing else:
 *
 *   fetchProducts(request: MapSourceRequest) => Promise<KnowledgeGraphProducts | null>
 *
 *   KnowledgeGraphProducts = {
 *     entities: { path: string, text: string }[],   // each entities/<id>.md of the account's graph, whole
 *     relations: string,                            // relations.jsonl, whole ("" when the graph has no edges)
 *     pages: { uri: string, text: string }[],       // each wiki page, with the address it is linked by
 *   }
 *
 * Until it is wired the source stands aside and contributes nothing. Once wired, null is "no graph yet" (also nothing), and a throw
 * is `missing: ["knowledge-graph"]`. A source file named in `evidence` or `sources` is mapped back to a knowledge-base document by
 * `documentIdOfUri` (the `src_<sha256>` id an uploaded file is stored under, found in its address); one that maps to nothing is
 * simply not drawn as a line.
 *
 * @module memoryMapSources/knowledgeGraph
 */

import { parse as parseYaml } from "yaml";

import { excerpt, nodeId } from "./common.mjs";

/** The entities one read draws at most (OpenViking itself stops a compile at 128 pages). */
export const GRAPH_ENTITY_LIMIT = 300;
/** The lines (relations and page links) one read draws at most. */
export const GRAPH_EDGE_LIMIT = 600;

const PREDICATE = /^[a-z][a-z0-9_]*$/u;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/**
 * A file's frontmatter and body. Null when there is none or it is not a YAML mapping.
 * @param {unknown} text @returns {{ data: Record<string, unknown>, body: string } | null}
 */
export function parseFrontmatter(text) {
  const match = FRONTMATTER.exec(String(text ?? ""));
  if (!match) return null;
  try {
    const data = parseYaml(match[1]);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return { data: /** @type {Record<string, unknown>} */ (data), body: String(text).slice(match[0].length) };
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map((item) => String(item ?? "").trim()).filter(Boolean);
}

/** An entity type as a stable snake_case word; anything else is `other`. @param {unknown} value */
export function entityTypeOf(value) {
  const type = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/gu, "_");
  return PREDICATE.test(type) ? type : "other";
}

/**
 * One `entities/<id>.md`. Null when it does not stand: no frontmatter, not `type: entity`, no stable id or no title. The id is
 * the file's own (its name without `.md`), which the frontmatter's `id` must agree with when it gives one.
 * @param {string} text @param {{ path?: string }} [options]
 * @returns {{ id: string, title: string, entityType: string, description: string, aliases: string[], sources: string[] } | null}
 */
export function parseEntity(text, { path = "" } = {}) {
  const file = parseFrontmatter(text);
  if (!file || String(file.data.type ?? "") !== "entity") return null;
  const named = String(path).split("/").at(-1)?.replace(/\.md$/iu, "") ?? "";
  const id = String(file.data.id ?? named).trim();
  const title = String(file.data.title ?? "").trim();
  if (!ENTITY_ID.test(id) || !title || (named && named !== id)) return null;
  return {
    id, title, entityType: entityTypeOf(file.data.entity_type), description: String(file.data.description ?? "").replace(/\s+/gu, " ").trim(),
    aliases: strings(file.data.aliases), sources: strings(file.data.sources),
  };
}

/**
 * `relations.jsonl`: every line that stands, and every line that does not with its number and the reason.
 * A line stands when it is a JSON object with a `from`, a `to`, a snake_case `relation` and a non-empty `evidence` list; a
 * predicate keeps one label across the graph (the first seen), and a repeated (from, relation, to) is one line with its evidence merged.
 * @param {string} text
 * @returns {{ relations: { from: string, relation: string, label: string, to: string, evidence: string[] }[], rejected: { line: number, reason: string }[] }}
 */
export function parseRelations(text) {
  /** @type {Map<string, { from: string, relation: string, label: string, to: string, evidence: string[] }>} */
  const merged = new Map();
  /** @type {Map<string, string>} */
  const labels = new Map();
  /** @type {{ line: number, reason: string }[]} */
  const rejected = [];
  String(text ?? "").split(/\r?\n/u).forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    let row;
    try { row = JSON.parse(raw); } catch { rejected.push({ line, reason: "not_json" }); return; }
    if (!row || typeof row !== "object" || Array.isArray(row)) { rejected.push({ line, reason: "not_an_object" }); return; }
    const from = String(row.from ?? "").trim();
    const to = String(row.to ?? "").trim();
    const relation = String(row.relation ?? "").trim();
    const evidence = strings(row.evidence);
    if (!from || !to) { rejected.push({ line, reason: "endpoint_missing" }); return; }
    if (!PREDICATE.test(relation)) { rejected.push({ line, reason: "relation_not_a_predicate" }); return; }
    if (evidence.length === 0) { rejected.push({ line, reason: "evidence_missing" }); return; }
    if (!labels.has(relation)) labels.set(relation, String(row.label ?? "").trim() || relation);
    const key = `${from}\u0000${relation}\u0000${to}`;
    const held = merged.get(key);
    if (held) held.evidence = [...new Set([...held.evidence, ...evidence])];
    else merged.set(key, { from, relation, label: /** @type {string} */ (labels.get(relation)), to, evidence });
  });
  return { relations: [...merged.values()], rejected };
}

/** Where a link in a page points, as a path relative to the wiki's root; null for an outside address or an anchor in the page itself. @param {string} from @param {string} href */
export function resolveLink(from, href) {
  const target = String(href ?? "").trim().replace(/[#?].*$/u, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) return null;
  const parts = (target.startsWith("/") ? [] : String(from).split("/").slice(0, -1)).concat(target.split("/"));
  /** @type {string[]} */
  const stack = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (stack.length === 0) return null; stack.pop(); } else stack.push(part);
  }
  return stack.length > 0 ? stack.join("/") : null;
}

const LINK = /(?<!!)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;

/**
 * One wiki page: its type and title from the frontmatter (the first heading, then the file's name, when there is no title) and
 * the pages it links to, in the order it links them, each once.
 * @param {string} text @param {{ path: string }} options the page's path under the wiki's root
 * @returns {{ path: string, type: string, title: string, links: string[] }}
 */
export function parseWikiPage(text, { path }) {
  const file = parseFrontmatter(text);
  const body = file?.body ?? String(text ?? "");
  const heading = /^#\s+(.+)$/mu.exec(body)?.[1]?.trim();
  const title = String(file?.data.title ?? "").trim() || heading || path.split("/").at(-1)?.replace(/\.md$/iu, "") || path;
  const links = [];
  for (const match of body.matchAll(LINK)) {
    const target = resolveLink(path, match[2]);
    if (target && /\.md$/iu.test(target) && target !== path && !links.includes(target)) links.push(target);
  }
  return { path, type: String(file?.data.type ?? "").trim() || "page", title, links };
}

/** The knowledge-base document an address names, by the `src_` id an uploaded file is stored under. @param {string} uri @returns {string | null} */
export function documentIdOfUri(uri) {
  return /(?<![A-Za-z0-9_])(src_[a-f0-9]{16,64})(?![A-Za-z0-9_])/u.exec(String(uri ?? ""))?.[1] ?? null;
}

/**
 * Where a mark of the compiled graph opens: the knowledge base's picture of that graph (`wiki` the pages and their links, `kg` the
 * entities and their relations) centred on the mark, in the project it was compiled for. The knowledge base's own address
 * (`knowledgeNav.ts`: `scope`, `kind=wiki`, `view=graph`, `graph`, `focus`, `depth`) is the contract; a mark's id in it is the page's
 * path or the entity's id, which is what these marks are made of.
 * @param {string | null} projectId @param {"wiki" | "kg"} graph @param {string} mark
 */
export function knowledgeHref(projectId, graph, mark) {
  const params = new URLSearchParams();
  if (projectId) params.set("scope", projectId);
  params.set("kind", "wiki");
  params.set("view", "graph");
  if (graph === "kg") params.set("graph", "kg");
  params.set("focus", mark);
  params.set("depth", "1");
  return `/app/files?${params.toString()}`;
}

/**
 * The marks and lines of one compile's products.
 *
 * Entities become `entity` marks, a relation between two of them a `relates` line carrying its label and predicate, a page a
 * `page` mark and a link between two pages a `links` line. A relation with an endpoint that is no entity, a link to a page that
 * is not there and an entity that is not a file are left out. The documents an entity was read from, and a relation's evidence,
 * become `quotes` lines to the knowledge-base documents they map to.
 *
 * An entity and a page open in the knowledge base, on the picture of its graph centred on the mark (`knowledgeHref`): the route the
 * knowledge base's own address defines, whose marks open the page they are.
 *
 * @param {{ entities?: { path: string, text: string }[], relations?: string, pages?: { uri: string, text: string }[] }} products
 * @param {{ documentIdOfUri?: (uri: string) => string | null, projectId?: string | null }} [options]
 * @returns {{ nodes: import("./common.mjs").MapNode[], edges: import("./common.mjs").MapEdge[], rejected: { line: number, reason: string }[] }}
 */
export function graphFromCompile(products, { documentIdOfUri: documentOf = documentIdOfUri, projectId = null } = {}) {
  /** @type {import("./common.mjs").MapNode[]} */
  const nodes = [];
  /** @type {import("./common.mjs").MapEdge[]} */
  const edges = [];
  const entities = (products.entities ?? []).map((file) => parseEntity(file.text, { path: file.path })).filter((entity) => entity !== null)
    .slice(0, GRAPH_ENTITY_LIMIT);
  const known = new Set(entities.map((entity) => entity.id));
  for (const entity of entities) {
    nodes.push({
      id: nodeId("entity", entity.id), type: "entity", subtype: entity.entityType, group: entity.entityType,
      label: excerpt(entity.title, 40), state: "current", open: { kind: "page", href: knowledgeHref(projectId, "kg", entity.id) },
      ...(entity.description ? { description: excerpt(entity.description, 120) } : {}),
    });
    for (const source of entity.sources) {
      const document = documentOf(source);
      if (document) edges.push({ from: nodeId("entity", entity.id), to: nodeId("document", document), type: "quotes" });
    }
  }
  const { relations, rejected } = parseRelations(products.relations ?? "");
  for (const relation of relations) {
    if (!known.has(relation.from) || !known.has(relation.to)) continue;
    edges.push({ from: nodeId("entity", relation.from), to: nodeId("entity", relation.to), type: "relates", label: relation.label, relation: relation.relation });
  }
  const pages = (products.pages ?? []).map((page) => parseWikiPage(page.text, { path: page.uri }));
  const paths = new Set(pages.map((page) => page.path));
  for (const page of pages) {
    nodes.push({ id: nodeId("page", page.path), type: "page", subtype: page.type, group: page.type, label: excerpt(page.title, 40), state: "current", open: { kind: "page", href: knowledgeHref(projectId, "wiki", page.path) } });
    for (const target of page.links) {
      if (paths.has(target)) edges.push({ from: nodeId("page", page.path), to: nodeId("page", target), type: "links" });
    }
  }
  return { nodes, edges: edges.slice(0, GRAPH_EDGE_LIMIT), rejected };
}

/**
 * @typedef {object} KnowledgeGraphProducts
 * @property {{ path: string, text: string }[]} entities @property {string} relations @property {{ uri: string, text: string }[]} pages
 */

/**
 * @param {{ fetchProducts?: ((request: import("./common.mjs").MapSourceRequest) => Promise<KnowledgeGraphProducts | null>) | null,
 *   documentIdOfUri?: (uri: string) => string | null }} [dependencies]
 * @returns {import("./common.mjs").MapSource}
 */
export function createKnowledgeGraphSource({ fetchProducts = null, documentIdOfUri: documentOf = documentIdOfUri } = {}) {
  return {
    name: "knowledge-graph",
    applies: () => typeof fetchProducts === "function",
    async read(request) {
      const products = await /** @type {NonNullable<typeof fetchProducts>} */ (fetchProducts)(request);
      if (!products) return null;
      const { nodes, edges } = graphFromCompile(products, { documentIdOfUri: documentOf, projectId: request.projectId });
      return { nodes, edges };
    },
  };
}
