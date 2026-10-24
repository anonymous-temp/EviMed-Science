#!/usr/bin/env node
/**
 * Replay a week of 「前沿动态」 items through the genre mix of 精选 (`@evimed/domain` `frontierMixReplay`), day by day: what
 * production selected (before) and what the mix selects (after), by genre group, with the Chinese share. Reads a JSON-lines
 * export, writes nothing, calls nothing.
 *
 *   node scripts/ops/frontier-mix-replay.mjs --file scored-7d.jsonl                 # a table, days with 100+ items
 *   node scripts/ops/frontier-mix-replay.mjs --file scored-7d.jsonl --json          # one JSON object
 *   node scripts/ops/frontier-mix-replay.mjs --file scored-7d.jsonl --threshold 82 --min-items 1
 *
 * The export is one row per published item of the window, read on the serving host (read-only):
 *
 *   SELECT i.public_id, i.primary_source_id AS source_id, i.platform, i.channel, i.source_type, i.evidence_type, i.flags,
 *          i.safety_alert, i.lane, i.lang, i.genre, i.score_total, i.verification, i.selected, i.selected_rule,
 *          i.published_at, i.first_seen_at, i.timeline_at, i.event_id, i.same_event_item_id, s.authority AS src_authority
 *     FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
 *    WHERE i.state = 'published' AND i.timeline_at > now() - interval '7 days'
 *
 * (`\copy (SELECT row_to_json(r) FROM (…) r) TO 'scored-7d.jsonl'`). The replay selects each day at once, as if no item had
 * been selected before; production selects through the day and never takes a selection back, so its own numbers move
 * a little from these.
 */
import { readFileSync } from "node:fs";

import { FRONTIER_MIX_GROUP_ORDER, frontierMixReplay } from "@evimed/domain";

import { FRONTIER_SELECT_THRESHOLD_DEFAULT } from "../../apps/server/src/frontierPipeline.mjs";

/** @param {string} name */
function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const file = argument("file");
if (!file) {
  process.stderr.write("usage: frontier-mix-replay.mjs --file <export.jsonl> [--threshold 82] [--min-items 100] [--json]\n");
  process.exit(2);
}
const threshold = Number(argument("threshold") ?? FRONTIER_SELECT_THRESHOLD_DEFAULT);
const minItems = Number(argument("min-items") ?? 100);
const rows = readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
const days = frontierMixReplay(rows, { threshold }).filter((day) => day.candidates >= minItems);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ threshold, days }, null, 2)}\n`);
} else {
  const groups = [...FRONTIER_MIX_GROUP_ORDER, "roundup"];
  const cells = (/** @type {{ total: number, groups: Record<string, number>, zh: number, zhShare: number }} */ side) =>
    `${String(side.total).padStart(4)} | ${groups.map((group) => String(side.groups[group] ?? 0).padStart(5)).join("")} | ${String(Math.round(side.zhShare * 100)).padStart(3)}%`;
  process.stdout.write(`line ${threshold}\nday         items size        total | ${groups.map((group) => group.slice(0, 4).padStart(5)).join("")} |  zh\n`);
  for (const day of days) {
    process.stdout.write(`${day.day} ${String(day.candidates).padStart(6)} ${String(day.size).padStart(4)} before ${cells(day.before)}\n`);
    process.stdout.write(`${" ".repeat(23)}after  ${cells(day.after)}  ${JSON.stringify(day.rules)} out ${JSON.stringify(day.excluded)}\n`);
  }
}
