#!/usr/bin/env node
/**
 * The operators' hand on the topic zones of 「证据专区」 (owner 2026-10-29; plan §6.4): what the zones are doing, what happened to one, and
 * the few things an operator may do that the planner and the readers cannot — set a definition, take a zone offline, pin or exclude an
 * item, delete a zone, and take back one action of the planner.
 *
 *   node scripts/ops/evidence-zones.mjs list [--kind official|user|all] [--lifecycle active|quiet|archived|all]
 *   node scripts/ops/evidence-zones.mjs changes <zone> [--limit N]
 *   node scripts/ops/evidence-zones.mjs undo <change-id> --operator <name> [--apply]
 *   node scripts/ops/evidence-zones.mjs set-definition <zone> --file definition.json --operator <name> [--title T] [--apply]
 *   node scripts/ops/evidence-zones.mjs offline <zone> --operator <name> [--apply]
 *   node scripts/ops/evidence-zones.mjs pin|exclude <zone> <item-public-id> --operator <name> [--apply]
 *   node scripts/ops/evidence-zones.mjs delete <zone> --operator <name> [--apply]
 *
 * A zone is named by its id or its slug. Every write is a dry run until `--apply`, and every applied write is a `zone_changes` row with
 * the actor `operator:<name>` (the detail an undo needs), the content version moved once so readers' lists reload. Nothing here is
 * shown to a reader as back office.
 *
 * Hidden knowledge:
 *
 * - **Undo reads exactly what the planner wrote.** `created` is deleted; `quiet`, `active` and `archived` go back to the lifecycle the
 *   change found (`fromLifecycle`); a `split` goes back to that lifecycle and deletes the zones it made (`into`); a `merged` zone goes
 *   back to its lifecycle and its followers are followed again (`movedFollowers`; the follows that moved to the kept zone stay there,
 *   because what they followed before the merge is not recorded). A redefinition is not undoable — the previous definition is not
 *   kept — and the command says so; set the definition from a file instead.
 * - **A definition from a file is resolved against the tag tree only.** The names are matched to tags through the tree's own spellings
 *   (`tagIds`); entity keys come from the control plane's glossary, which a script does not load. A keyword without them still
 *   collects by its words and by meaning, and the membership module collects again when `definition_version` moves.
 * - It needs the configuration the server runs with — the database — and prints counts, ids and codes, never a key.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { evidenceZoneRole, normalizeEvidenceZoneDefinition } from "@evimed/domain";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { FrontierTagStore } from "../../apps/server/src/frontierTags.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMMANDS = Object.freeze(["list", "changes", "undo", "set-definition", "offline", "pin", "exclude", "delete"]);
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { command: "", positional: /** @type {string[]} */ ([]), apply: false, operator: "", kind: "all", lifecycle: "all", limit: 30, file: "", title: "" };
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command ${JSON.stringify(command ?? "")}; use ${COMMANDS.join(", ")}.`);
  options.command = command;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--operator") options.operator = String(rest[++index] ?? "");
    else if (argument === "--kind") options.kind = String(rest[++index] ?? "");
    else if (argument === "--lifecycle") options.lifecycle = String(rest[++index] ?? "");
    else if (argument === "--file") options.file = String(rest[++index] ?? "");
    else if (argument === "--title") options.title = String(rest[++index] ?? "");
    else if (argument === "--limit") {
      options.limit = Number(rest[++index]);
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) throw new Error("--limit must be an integer from 1 to 500");
    } else if (argument.startsWith("--")) throw new Error(`Unknown argument ${argument}.`);
    else options.positional.push(argument);
  }
  if (!["official", "user", "all"].includes(options.kind)) throw new Error("--kind must be official, user or all");
  if (!["active", "quiet", "archived", "all"].includes(options.lifecycle)) throw new Error("--lifecycle must be active, quiet, archived or all");
  if (options.apply && !/^[A-Za-z0-9._-]{1,40}$/.test(options.operator)) throw new Error("--apply needs --operator <name> (letters, digits, . _ -)");
  const needs = { list: 0, changes: 1, undo: 1, "set-definition": 1, offline: 1, pin: 2, exclude: 2, delete: 1 }[command];
  if (options.positional.length !== needs) throw new Error(`${command} takes ${needs} argument${needs === 1 ? "" : "s"}.`);
  if (command === "undo" && !/^\d{1,18}$/.test(options.positional[0])) throw new Error("undo takes a change id (the number `changes` prints)");
  if (command === "set-definition" && !options.file) throw new Error("set-definition needs --file <json>");
  for (const reference of command === "undo" ? [] : options.positional.slice(0, 1)) if (!ID.test(reference)) throw new Error("A zone is named by its id or slug.");
  return options;
}

/** The content version readers' lists are cached against. @param {any} client */
async function bumpVersion(client) {
  await client.query("UPDATE evimed_frontier.evidence_zone_meta SET version = version + 1 WHERE singleton");
}

/** @param {any} client @param {string} reference */
async function findZone(client, reference) {
  const row = (await client.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id = $1 OR slug = $1 ORDER BY (id = $1) DESC LIMIT 1 FOR UPDATE", [reference])).rows[0];
  if (!row) throw Object.assign(new Error(`No zone ${JSON.stringify(reference)}.`), { code: "zone_not_found" });
  return row;
}

/** @param {any} client @param {string} zoneId @param {string} kind @param {string} actor @param {Record<string, unknown>} detail */
async function record(client, zoneId, kind, actor, detail) {
  await client.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES ($1, $2, $3, $4::jsonb)", [zoneId, kind, actor, JSON.stringify(detail)]);
}

/** The zones with their activity: stats snapshot, item counts by state, followers. @param {any} database @param {{ kind: string, lifecycle: string }} filter */
export async function listZones(database, { kind, lifecycle }) {
  const rows = (await database.query(`SELECT z.id, z.slug, z.title, z.kind, z.state, z.lifecycle, z.zone_type, z.specialties, z.definition_version, z.revision, z.stats, z.stats_at, z.overview_at,
      (SELECT count(*) FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id)::integer AS follows,
      coalesce((SELECT jsonb_object_agg(s.state, s.n) FROM (SELECT zi.state, count(*)::integer AS n FROM evimed_frontier.zone_items zi WHERE zi.zone_id = z.id GROUP BY zi.state) s), '{}'::jsonb) AS items
    FROM evimed_frontier.evidence_zones z WHERE z.lifecycle <> 'none' AND ($1 = 'all' OR z.kind = $1) AND ($2 = 'all' OR z.lifecycle = $2)
    ORDER BY z.kind, z.lifecycle, z.title`, [kind, lifecycle])).rows;
  return rows.map((/** @type {any} */ row) => ({
    id: row.id, slug: row.slug, title: row.title, kind: row.kind, lifecycle: row.lifecycle, published: row.state === "published", type: row.zone_type, specialties: row.specialties,
    definitionVersion: row.definition_version, revision: row.revision, follows: row.follows, items: row.items, perWeek: typeof row.stats?.perWeek === "number" ? row.stats.perWeek : null,
    week: row.stats?.week ?? null, month: row.stats?.month ?? null, statsAt: row.stats_at, overviewAt: row.overview_at,
  }));
}

/** A zone's history, newest first. @param {any} database @param {string} reference @param {number} limit */
export async function zoneChanges(database, reference, limit) {
  const zone = (await database.query("SELECT id, title FROM evimed_frontier.evidence_zones WHERE id = $1 OR slug = $1 LIMIT 1", [reference])).rows[0];
  const id = zone?.id ?? reference;
  const rows = (await database.query("SELECT id::text AS id, kind, actor, detail, occurred_at FROM evimed_frontier.zone_changes WHERE zone_id = $1 ORDER BY zone_changes.id DESC LIMIT $2", [id, limit])).rows;
  return { zone: zone ? { id: zone.id, title: zone.title } : { id, title: null }, changes: rows };
}

/**
 * Take back one action of the planner (or of an operator): what it found is put back.
 * @param {any} database @param {string} changeId @param {{ apply: boolean, operator: string }} how
 */
export async function undoChange(database, changeId, { apply, operator }) {
  return database.transaction(async (/** @type {any} */ client) => {
    const change = (await client.query("SELECT id::text AS id, zone_id, kind, actor, detail FROM evimed_frontier.zone_changes WHERE id = $1", [changeId])).rows[0];
    if (!change) return { ok: false, reason: "no such change" };
    const actor = `operator:${operator}`;
    const detail = change.detail ?? {};
    /** @type {Array<() => Promise<void>>} */
    const steps = [];
    /** @type {string[]} */
    const plan = [];
    const restoreLifecycle = (/** @type {string} */ zoneId, /** @type {string} */ wanted) => {
      // A lifecycle is also the kind of change that puts a zone into it.
      const lifecycle = ["active", "quiet", "archived"].includes(wanted) ? wanted : "active";
      plan.push(`${zoneId}: lifecycle back to ${lifecycle}`);
      steps.push(async () => {
        await client.query("UPDATE evimed_frontier.evidence_zones SET lifecycle = $2, revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1", [zoneId, lifecycle]);
        await record(client, zoneId, lifecycle, actor, { undoes: change.id, lifecycle });
      });
    };
    const remove = (/** @type {string} */ zoneId, /** @type {string} */ why) => {
      plan.push(`${zoneId}: deleted (${why})`);
      steps.push(async () => {
        await client.query("DELETE FROM evimed_frontier.evidence_zones WHERE id = $1", [zoneId]);
        await record(client, zoneId, "deleted", actor, { undoes: change.id, reason: why });
      });
    };
    if (change.kind === "created") remove(change.zone_id, "its creation undone");
    else if (["quiet", "active", "archived"].includes(change.kind) && typeof detail.fromLifecycle === "string") restoreLifecycle(change.zone_id, detail.fromLifecycle);
    else if (change.kind === "split" && typeof detail.fromLifecycle === "string" && Array.isArray(detail.into)) {
      restoreLifecycle(change.zone_id, detail.fromLifecycle);
      for (const zoneId of detail.into) if (typeof zoneId === "string") remove(zoneId, "its split undone");
    } else if (change.kind === "merged" && typeof detail.fromLifecycle === "string") {
      restoreLifecycle(change.zone_id, detail.fromLifecycle);
      const followers = (Array.isArray(detail.movedFollowers) ? detail.movedFollowers : []).filter((/** @type {unknown} */ id) => typeof id === "string");
      if (followers.length) {
        plan.push(`${change.zone_id}: ${followers.length} follower(s) follow it again`);
        steps.push(async () => {
          await client.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id, zone_id) SELECT x, $2 FROM unnest($1::text[]) AS x ON CONFLICT DO NOTHING", [followers, change.zone_id]);
        });
      }
    } else return { ok: false, change: change.id, kind: change.kind, reason: "this change cannot be undone; set the definition from a file instead" };
    if (apply) {
      for (const step of steps) await step();
      await bumpVersion(client);
    }
    return { ok: true, applied: apply, change: change.id, kind: change.kind, plan };
  });
}

/**
 * Set a zone's definition from a file (the web's body shape): checked, resolved against the tag tree, versioned.
 * @param {any} database @param {string} reference @param {unknown} body @param {{ apply: boolean, operator: string, title?: string }} how
 */
export async function setDefinition(database, reference, body, { apply, operator, title = "" }) {
  const { definition, issues } = normalizeEvidenceZoneDefinition(body);
  if (!definition) return { ok: false, reason: `the definition is incomplete: ${issues.join(", ")}` };
  const vocabulary = await new FrontierTagStore({ database }).vocabulary();
  const resolved = {
    ...definition,
    keywords: definition.keywords.map((keyword) => ({ ...keyword,
      tagIds: [...new Set([keyword.label, ...keyword.terms].map((name) => vocabulary.byName(name)?.id).filter((id) => Number.isSafeInteger(id)))].slice(0, 50) })),
  };
  return database.transaction(async (/** @type {any} */ client) => {
    const zone = await findZone(client, reference);
    const kept = { ...resolved, seeds: zone.definition?.seeds ?? resolved.seeds };
    const result = { ok: true, applied: apply, zone: zone.id, from: zone.definition_version, to: zone.definition_version + 1, keywords: kept.keywords.map((keyword) => [keyword.label, keyword.tagIds.length]) };
    if (!apply) return result;
    await client.query(`UPDATE evimed_frontier.evidence_zones SET title = CASE WHEN $2 = '' THEN title ELSE $2 END, description = $3, scope_zh = $3, zone_type = $4, specialties = $5::text[], group_label = $6,
        definition = $7::jsonb, definition_version = definition_version + 1, revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1`,
    [zone.id, title.trim().slice(0, 30), kept.scope, kept.type, kept.specialties, kept.group, JSON.stringify(kept)]);
    await record(client, zone.id, "definition", `operator:${operator}`, { version: zone.definition_version + 1, keywords: kept.keywords.map((keyword) => keyword.label) });
    await bumpVersion(client);
    return result;
  });
}

/** Take a published zone offline: it is a draft again, still its owner's. @param {any} database @param {string} reference @param {{ apply: boolean, operator: string }} how */
export async function takeOffline(database, reference, { apply, operator }) {
  return database.transaction(async (/** @type {any} */ client) => {
    const zone = await findZone(client, reference);
    const result = { ok: true, applied: apply, zone: zone.id, title: zone.title, wasPublished: zone.state === "published" };
    if (!apply || zone.state !== "published") return result;
    await client.query("UPDATE evimed_frontier.evidence_zones SET state = 'draft', revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1", [zone.id]);
    await record(client, zone.id, "unpublished", `operator:${operator}`, { reason: "taken offline" });
    await bumpVersion(client);
    return result;
  });
}

/**
 * Pin an item into a zone, or exclude it, for good: no automatic pass rewrites either.
 * @param {any} database @param {string} reference @param {string} itemPublicId @param {"pinned" | "excluded"} state @param {{ apply: boolean, operator: string }} how
 */
export async function overrideItem(database, reference, itemPublicId, state, { apply, operator }) {
  return database.transaction(async (/** @type {any} */ client) => {
    const zone = await findZone(client, reference);
    const item = (await client.query("SELECT id, genre, safety_alert FROM evimed_frontier.items WHERE public_id = $1", [itemPublicId])).rows[0];
    if (!item) return { ok: false, reason: `no item ${itemPublicId}` };
    const result = { ok: true, applied: apply, zone: zone.id, item: itemPublicId, state };
    if (!apply) return result;
    await client.query(`INSERT INTO evimed_frontier.zone_items(zone_id, item_id, state, relevance, via, role, decided_by, definition_version, judged_at)
      VALUES ($1, $2, $3, CASE WHEN $3 = 'pinned' THEN 'core' END, 'editor', $4, $5, $6, clock_timestamp())
      ON CONFLICT (zone_id, item_id) DO UPDATE SET state = EXCLUDED.state, relevance = EXCLUDED.relevance, via = 'editor', decided_by = EXCLUDED.decided_by, judged_at = clock_timestamp()`,
    [zone.id, item.id, state, evidenceZoneRole({ genre: item.genre, safetyAlert: item.safety_alert }), `operator:${operator}`, zone.definition_version]);
    await record(client, zone.id, state === "pinned" ? "pinned" : "excluded", `operator:${operator}`, { item: itemPublicId });
    await bumpVersion(client);
    return result;
  });
}

/** Delete a zone (any kind, a reader's public one included); its history stays. @param {any} database @param {string} reference @param {{ apply: boolean, operator: string }} how */
export async function deleteZone(database, reference, { apply, operator }) {
  return database.transaction(async (/** @type {any} */ client) => {
    const zone = await findZone(client, reference);
    const result = { ok: true, applied: apply, zone: zone.id, title: zone.title, kind: zone.kind };
    if (!apply) return result;
    await client.query("DELETE FROM evimed_frontier.evidence_zones WHERE id = $1", [zone.id]);
    await record(client, zone.id, "deleted", `operator:${operator}`, { title: zone.title, kind: zone.kind });
    await bumpVersion(client);
    return result;
  });
}

/**
 * Run a parsed command.
 * @param {any} database @param {ReturnType<typeof parseArguments>} options
 */
export async function runCommand(database, options) {
  const how = { apply: options.apply, operator: options.operator };
  const [first, second] = options.positional;
  switch (options.command) {
    case "list": return { zones: await listZones(database, options) };
    case "changes": return zoneChanges(database, first, options.limit);
    case "undo": return undoChange(database, first, how);
    case "set-definition": return setDefinition(database, first, JSON.parse(fs.readFileSync(options.file, "utf8")), { ...how, title: options.title });
    case "offline": return takeOffline(database, first, how);
    case "pin": return overrideItem(database, first, second, "pinned", how);
    case "exclude": return overrideItem(database, first, second, "excluded", how);
    case "delete": return deleteZone(database, first, how);
    default: throw new Error(`Unknown command ${options.command}`);
  }
}

/** The control-plane database, from the same sources the server reads it from. */
function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    const result = await runCommand(database, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result && typeof result === "object" && "ok" in result && !result.ok) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
