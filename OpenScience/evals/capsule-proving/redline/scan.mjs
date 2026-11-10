// Every place a marker can be held or shown, read through the product (and, for what the product never shows, directly):
// the engine's files of the account, its vector index, the database's text columns, the memory page, the model-facing tools,
// the plugin's own recall route, the resident block, the capsule export preview and the account export. The raw findings
// carry only where the marker was found (a path, a table and column, a block kind), never the text around it.
//
// What a finding means for a given delete path is decided apart, by the pure table in `classify.mjs`.
import { createRequire } from "node:module";

import { lineFingerprint } from "../../../apps/server/src/nativeMemoryOverlay.mjs";

const requireServer = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const { unzipSync } = requireServer("fflate");

/**
 * Whether a text holds the marker, in any letter case: the engine slugs a marker into a lowercase file name (`projects/r-47162 …md`)
 * and its directory summaries link to it that way.
 * @param {unknown} text @param {string} marker
 */
export function holds(text, marker) {
  return String(text ?? "").toLowerCase().includes(String(marker).toLowerCase());
}

/** Where a file of an engine user's tree belongs (path relative to the user's root, no leading slash). @param {string} rel */
export function enginePlace(rel) {
  const parts = rel.split("/");
  const name = parts.at(-1) ?? "";
  const hidden = name.startsWith(".");
  if (parts[0] === "memories") return hidden ? "engine-summaries" : "engine-files";
  if (parts[0] === "sessions") return "archive";
  if (parts[0] === "resources" && parts[1] === "history") return hidden ? "engine-summaries" : "raw-history";
  if (parts[0] === "privacy") return hidden ? "engine-summaries" : "privacy-tree";
  if (hidden) return "engine-summaries";
  return "engine-other";
}

/** The kind of one text block of the model-facing `search` answer (`memoryGateway.mjs` builds it in this order). @param {string} text @param {number} index */
export function searchBlockKind(text, index) {
  if (/^Original conversation excerpts/.test(String(text))) return "history";
  return index === 0 ? "memories" : "capsule";
}

/** The marker-bearing statements of a text, as the product fingerprints a line (`lineFingerprint` of the bullet-less statement). @param {string} text @param {string} marker */
export function markerLinePrints(text, marker) {
  return String(text ?? "").split("\n").filter((line) => holds(line, marker))
    .map((line) => lineFingerprint(line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "")));
}

/** Paths of a ZIP (nested ZIPs opened) whose bytes contain the marker. @param {Uint8Array} bytes @param {string} marker @param {string} [prefix] */
export function zipPathsWith(bytes, marker, prefix = "") {
  const found = [];
  let entries;
  try { entries = unzipSync(bytes); } catch { return holds(Buffer.from(bytes).toString("utf8"), marker) ? [`${prefix || "(archive)"}`] : []; }
  for (const [name, data] of Object.entries(entries)) {
    const path = `${prefix}${name}`;
    if (/\.zip$/i.test(name)) { found.push(...zipPathsWith(data, marker, `${path}!/`)); continue; }
    if (holds(name, marker) || holds(Buffer.from(data).toString("utf8"), marker)) found.push(path);
  }
  return found;
}

/** @type {WeakMap<any, Promise<{ schema: string, table: string, columns: string[] }[]>>} */
const columnCache = new WeakMap();
/** @param {any} database */
function textColumns(database) {
  if (!columnCache.has(database)) {
    columnCache.set(database, database.query(`SELECT c.table_schema, c.table_name, c.column_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
        WHERE c.table_schema NOT IN ('pg_catalog','information_schema') AND c.table_schema NOT LIKE 'pg_%'
          AND (c.data_type IN ('text','character varying','json','jsonb') OR (c.data_type='ARRAY' AND c.udt_name IN ('_text','_varchar')))
        ORDER BY 1, 2, 3`).then((/** @type {any} */ result) => {
      /** @type {Map<string, { schema: string, table: string, columns: string[] }>} */
      const tables = new Map();
      for (const row of result.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        if (!tables.has(key)) tables.set(key, { schema: row.table_schema, table: row.table_name, columns: [] });
        /** @type {any} */ (tables.get(key)).columns.push(row.column_name);
      }
      return [...tables.values()];
    }));
  }
  return /** @type {Promise<any>} */ (columnCache.get(database));
}
/** Forget the column list (a new table appeared after the first scan, e.g. a lazily migrated module). @param {any} database */
export function refreshColumns(database) { columnCache.delete(database); }

const ident = (/** @type {string} */ name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Every text column of the database holding the marker: `schema.table.column` → rows. A unique marker needs no owner filter.
 * @param {any} database @param {string} marker
 */
export async function databaseColumnsWith(database, marker) {
  const pattern = `%${marker.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;  // matched with ILIKE: any letter case
  /** @type {Record<string, number>} */
  const found = {};
  for (const { schema, table, columns } of await textColumns(database)) {
    const tests = columns.map((column) => `(${ident(column)}::text ILIKE $1)`);
    let result;
    try {
      result = await database.query(`SELECT ${tests.map((test, index) => `${test} AS m${index}`).join(", ")} FROM ${ident(schema)}.${ident(table)} WHERE ${tests.join(" OR ")} LIMIT 200`, [pattern]);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "42P01") continue; // dropped meanwhile
      throw error;
    }
    for (const row of result.rows) columns.forEach((column, index) => { if (row[`m${index}`]) found[`${schema}.${table}.${column}`] = (found[`${schema}.${table}.${column}`] ?? 0) + 1; });
  }
  return found;
}

/**
 * Every file of an engine user's tree whose text holds the marker, by place. Only for a user the engine still lists: a call
 * as a user that is gone could register it again.
 * @param {any} sessions @param {string} userId @param {string} marker
 */
export async function engineFilesWith(sessions, userId, marker, { userRoot = null } = {}) {
  const root = userRoot ?? sessions.userRoot(userId);
  const nodes = await sessions.tree(userId, root, { levelLimit: 14, showHidden: true });
  /** @type {Record<string, string[]>} */
  const byPlace = {};
  const files = nodes.filter((/** @type {any} */ node) => !node.isDir && String(node.uri).startsWith(`${root}/`));
  for (let index = 0; index < files.length; index += 8) {
    const batch = files.slice(index, index + 8);
    const texts = await Promise.all(batch.map((/** @type {any} */ node) => sessions.read(userId, node.uri).catch(() => null)));
    batch.forEach((/** @type {any} */ node, position) => {
      const rel = node.uri.slice(root.length + 1);
      if (!holds(texts[position], marker) && !holds(rel, marker)) return;
      (byPlace[enginePlace(rel)] ??= []).push(rel);
    });
  }
  return { files: files.length, byPlace };
}

/** Text of the memory files the model can be handed, by relative path. @param {any} sessions @param {string} userId */
export async function servedMemoryFiles(sessions, userId, { userRoot = null } = {}) {
  const root = userRoot ?? sessions.userRoot(userId);
  const memories = `${root}/memories`;
  const nodes = await sessions.tree(userId, memories, { levelLimit: 10 }).catch((/** @type {any} */ error) => {
    if (error?.code === "memory_index_not_found") return [];
    throw error;
  });
  /** @type {Record<string, string>} */
  const files = {};
  for (const node of nodes) {
    if (node.isDir || !String(node.uri).startsWith(`${memories}/`)) continue;
    const rel = node.uri.slice(root.length + 1);
    if (enginePlace(rel) !== "engine-files") continue;
    files[rel] = String(await sessions.read(userId, node.uri).catch(() => "") ?? "");
  }
  return files;
}

/** @param {string} text */
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

/** The URIs (from `viking://user/<id>/` on) of the search hits whose JSON holds the marker. @param {unknown} hits @param {string} marker */
export function hitsWith(hits, marker) {
  if (!Array.isArray(hits)) return [];
  return hits.filter((hit) => holds(JSON.stringify(hit ?? null), marker))
    .map((hit) => String(hit?.uri ?? "").replace(/^viking:\/\/user\/[^/]+\//, "") || "(no uri)");
}

/**
 * What the model and the plugin are handed in one workload: the `search` tool (by the marker and by the carrier's words), a
 * recursive `list` and a `read` of every listed file, the plugin's own recall route, and the resident block.
 * @param {any} stack @param {{ userId: string, projectId: string }} where @param {string} marker @param {string[]} queries
 */
export async function modelSurfaces(stack, { userId, projectId }, marker, queries) {
  const memory = stack.memory(userId, projectId);
  const token = stack.tokenFor(userId, projectId);
  /** @type {Record<string, any>} */
  const out = { search: [], listRead: [], pluginRecall: [], resident: false, refused: [] };
  for (const [queryIndex, query] of queries.entries()) {
    // Which query found it: the marker itself, or the carrier's words (what a person asking about it would type).
    const by = queryIndex === 0 ? "@marker" : "@words";
    const answer = await memory.callTool("search", { query, limit: 10 });
    if (answer.isError) out.refused.push(`search:${String(answer.blocks[0] ?? "").slice(0, 60)}`);
    answer.blocks.forEach((text, index) => {
      if (!holds(text, marker)) return;
      const kind = searchBlockKind(text, index);
      if (kind !== "memories") { out.search.push(`${kind}${by}`); return; }
      const rels = hitsWith(parseJson(text)?.memories, marker);
      out.search.push(...(rels.length ? rels.map((rel) => `memories:${rel}${by}`) : [`memories${by}`]));
    });
    const recalled = await stack.gateway(token, "POST", "/api/v1/search/search", { query, limit: 10 });
    if (!recalled.ok) out.refused.push(`recall:${recalled.code ?? recalled.status}`);
    else {
      const result = recalled.json?.result ?? {};
      for (const [key, value] of Object.entries(result)) {
        if (!holds(JSON.stringify(value ?? null), marker)) continue;
        const rels = Array.isArray(value) ? hitsWith(value, marker).filter((rel) => rel !== "(no uri)") : [];
        out.pluginRecall.push(...(rels.length ? rels.map((rel) => `${key}:${rel}${by}`) : [`${key}${by}`]));
      }
    }
  }
  const listed = await memory.callTool("list", { recursive: true });
  const uris = [];
  for (const text of listed.blocks) {
    if (holds(text, marker)) out.listRead.push("list");
    try {
      const value = JSON.parse(text);
      const rows = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.result) ? value.result : [];
      for (const row of rows) if (row && !row.isDir && typeof row.uri === "string" && /\.md$/.test(row.uri) && !/\/\.[^/]+$/.test(row.uri)) uris.push(row.uri);
    } catch { /* prose */ }
  }
  for (let index = 0; index < uris.length; index += 10) {
    const read = await memory.callTool("read", { uris: uris.slice(index, index + 10) });
    if (read.blocks.some((text) => holds(text, marker))) out.listRead.push("read");
  }
  const block = await stack.app.residentProfiles.forDispatch(userId, { projectId, sessionId: null, attended: true }).catch(() => null);
  out.resident = Boolean(block?.text && holds(block.text, marker));
  out.search = [...new Set(out.search)];
  out.listRead = [...new Set(out.listRead)];
  out.pluginRecall = [...new Set(out.pluginRecall)];
  out.listed = uris.length;
  return out;
}

/**
 * What the memory page shows a signed-in person: the active records' values and the page search (`page`), and the rest of what
 * it carries (forgotten records, replaced words, the profile document, recent changes: `pageHistory`).
 * @param {any} stack @param {any} user @param {string} marker
 */
export async function pageSurfaces(stack, user, marker) {
  const page = new Set();
  const history = new Set();
  const records = await stack.http(user, "GET", "/api/memory/records?pageSize=500");
  const rows = Array.isArray(records.json?.data) ? records.json.data : Array.isArray(records.json?.data?.records) ? records.json.data.records : [];
  for (const row of rows) {
    // What the page shows as the memory now: its words, its title and its file.
    if (holds(`${row?.value ?? ""}\n${row?.summary ?? ""}\n${row?.key ?? ""}`, marker)) page.add("records");
    const { value: _value, summary: _summary, key: _key, ...rest } = row ?? {};
    if (holds(JSON.stringify(rest), marker)) history.add("records-other-fields");
  }
  const archived = await stack.http(user, "GET", "/api/memory/records?status=archived&pageSize=500");
  if (holds(JSON.stringify(archived.json?.data ?? null), marker)) history.add("records-archived");
  // The route echoes the query back (`query`), and each item carries its earlier versions: only an item's own words are what the
  // page shows as the memory now; the rest is its history.
  const search = await stack.http(user, "GET", `/api/memory/search?q=${encodeURIComponent(marker)}`);
  for (const item of Array.isArray(search.json?.data?.items) ? search.json.data.items : []) {
    if (holds(`${item?.summary ?? ""}\n${item?.value ?? ""}\n${item?.key ?? ""}`, marker)) page.add("search");
    else if (holds(JSON.stringify(item ?? null), marker)) history.add("search-item-history");
  }
  const profile = await stack.http(user, "GET", "/api/memory/profile");
  if (holds(JSON.stringify(profile.json?.data ?? null), marker)) history.add("profile");
  const changes = await stack.http(user, "GET", "/api/memory/changes?limit=100");
  if (holds(JSON.stringify(changes.json?.data ?? null), marker)) history.add("changes");
  return { page: [...page], pageHistory: [...history], status: [records.status, search.status, profile.status] };
}

/** The account export's paths that hold the marker (`GET /api/account/export`). @param {any} stack @param {any} user @param {string} marker */
export async function exportPaths(stack, user, marker) {
  const answer = await stack.http(user, "GET", "/api/account/export", undefined, { raw: true, timeoutMs: 300_000 });
  if (answer.status !== 200) return { status: answer.status, paths: null };
  return { status: 200, paths: zipPathsWith(answer.bytes, marker) };
}

/** The capsule export preview's entries that hold the marker (`POST /api/capsules/:id/exports/preview`). @param {any} stack @param {any} user @param {string} marker */
export async function capsulePreview(stack, user, marker) {
  const capsule = await stack.app.capsuleService.ownCapsule(user.id, { create: true });
  const answer = await stack.http(user, "POST", `/api/capsules/${encodeURIComponent(capsule.id)}/exports/preview`, {});
  if (answer.status !== 200) return { status: answer.status, entries: null };
  const entries = Array.isArray(answer.json?.data?.entries) ? answer.json.data.entries : [];
  return { status: 200, entries: entries.filter((/** @type {any} */ entry) => holds(entry?.content, marker)).map((/** @type {any} */ entry) => String(entry.factKind ?? "entry")) };
}

/**
 * The engine's own vector search over the account's whole root, by the marker: hits whose returned text holds it.
 * @param {any} sessions @param {string} userId @param {string} marker
 */
export async function vectorHits(sessions, userId, marker, { userRoot = null } = {}) {
  const root = userRoot ?? sessions.userRoot(userId);
  const hits = await sessions.find(userId, marker, { target: root, limit: 20 });
  return (Array.isArray(hits) ? hits : []).filter((/** @type {any} */ hit) => holds(hit?.text, marker) || holds(hit?.abstract, marker) || holds(hit?.uri, marker))
    .map((/** @type {any} */ hit) => String(hit.uri ?? "").slice(root.length + 1));
}

/** Line-origin rows still naming a deleted marker line (fingerprints only). @param {any} database @param {string} userId @param {string[]} prints */
export async function staleOrigins(database, userId, prints) {
  if (!prints.length) return 0;
  const result = await database.query("SELECT count(*)::int AS n FROM evimed_memory.native_line_origins WHERE user_id=$1 AND fingerprint = ANY($2::text[])", [userId, prints]);
  return Number(result.rows[0]?.n ?? 0);
}
