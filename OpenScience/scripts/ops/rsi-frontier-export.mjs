/**
 * The frontier feed's monthly snapshot for the offline RSI lab (2026-10-26). Read-only, run inside the serving web container
 * against the release it serves, so the day windows, genre floors, congress calendar and settings are production's own code:
 *
 *   docker exec -i web-open-science-web-1 node --input-type=module - --from 2026-09-01 --to 2026-10-31 < rsi-frontier-export.mjs > out.json
 *
 * Every row is the projection `FrontierPipeline#mix` reads, for each day of the window in the feed's zone, with the selection the
 * mix made taken back: what a day's mix picked (`threshold`, `genre-floor`, `zh-target`, `preprint-lane`, `event-primary`, the
 * retired `lane-floor`) is replayed as unselected, and only an item-time `safety-bypass` stays selected, so an offline replay
 * of any threshold starts where production's mix started. Production's own picks travel beside it (`production_selected`,
 * `production_rule`) for the replay-fidelity check. Event members on other days keep the state they have. `beside_selected`
 * is read against that same counterfactual state.
 *
 * `incumbent` is the frontier module's incumbent policy identity as the serving layer itself names it (`rsiIncumbent`, the function
 * `currentTarget` uses, over the row the serving read returns: the module policy document of the evolution owner, the first configured
 * operator): `default:<digest of the code defaults>` or `evolution-module-policy-frontier:<revision>`. A campaign built from this export
 * binds exactly that as its baseline, which is what a bundle's target is compared with at import. A release that predates the function,
 * or a deployment with no operator to own the policy, cannot name it as the serving layer would: the export omits `incumbent` and keeps
 * the configured threshold, and the lab measures the month against an `unbound:` baseline no bundle can be imported against.
 *
 * `consumerDigest` is this release's dependency digest of the `frontier-selection` surface, by the serving layer's own `currentTarget`: what a bundle's target is compared with at import. The
 * lab compares it on the 1st, so a release that moved it is an early answer instead of a late refusal. A release that cannot say omits it and the month is measured as not importable.
 *
 * Public frontier content only: items, sources and events of the feed, no account, project, conversation or reader data.
 * The texts a labeller reads are the source's own (title, abstract or page excerpt, at most 1,200 characters), never the
 * platform's model-written fields. One REPEATABLE READ, READ ONLY transaction; nothing is written.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const APP = process.env.RSI_EXPORT_APP_ROOT ?? "/app";
const args = process.argv.slice(process.argv.indexOf("-") + 1 || 2);
const arg = (/** @type {string} */ name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const from = arg("--from"), to = arg("--to");
if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? "") || from > to) {
  throw new Error("Usage: rsi-frontier-export.mjs --from YYYY-MM-DD --to YYYY-MM-DD");
}
const load = (/** @type {string} */ path) => import(`file://${APP}/${path}`);
const { loadConfig } = await load("apps/server/src/config.mjs");
const { ControlPlaneDatabase } = await load("apps/server/src/controlPlaneDatabase.mjs");
const pipeline = await load("apps/server/src/frontierPipeline.mjs");
const { FRONTIER_SCORE_VERSION } = await load("apps/server/src/frontierEditor.mjs");
const domain = await load("packages/domain/index.mjs");
// A release from before the serving adapters has no such module: it names no incumbent either.
const serving = await load("apps/server/src/rsiServingAdapters.mjs").catch((/** @type {any} */ error) => { if (error?.code === "ERR_MODULE_NOT_FOUND") return {}; throw error; });
const namesIncumbent = typeof serving.rsiIncumbent === "function" && typeof serving.rsiPolicyDefaults === "function";

const MIX_RULES = new Set(["threshold", "genre-floor", "zh-target", "preprint-lane", "event-primary", "lane-floor"]);
const CONSUMER_PATHS = ["apps/server/src/frontierSelection.mjs", "packages/domain/src/frontierMix.mjs",
  "packages/domain/src/frontierSelection.mjs", "packages/domain/src/frontier-selection.json", "packages/domain/src/frontierGenres.mjs",
  "packages/domain/src/frontierVocabulary.mjs"];
const sha256 = (/** @type {string | Buffer} */ value) => createHash("sha256").update(value).digest("hex");

const config = loadConfig();
// The serving read's owner (rsiServingAdapters.mjs `incumbent`: the evolution service's owner, the first configured operator).
const policyOwner = config.operatorUsers?.[0] ?? null;
const timeZone = config.frontierTimeZone ?? "Asia/Shanghai";
const settings = {
  threshold: pipeline.frontierSelectThreshold(config), thresholdSource: "config",
  preprintPlaces: pipeline.frontierPreprintLanePerDay(config), preprintMinScore: pipeline.frontierPreprintLaneMinScore(config),
  scoreVersion: FRONTIER_SCORE_VERSION, timeZone,
};
// A release from before a file has no such file: nothing of it to compare, and the export goes on.
const consumer = (await Promise.all(CONSUMER_PATHS.map(async (path) => ({ path, sha256: sha256(await readFile(`${APP}/${path}`).catch(() => "")) })))).filter((row) => row.sha256 !== sha256(""));
const consumerTarget = await serving.createRsiServingAdapters?.({ config: { ...config, rootDir: APP }, service: { owner: async () => "" }, database: {}, documents: {} })?.currentTarget("frontier-selection", { query: async () => ({ rows: [] }) }).catch(() => null);
const database = new ControlPlaneDatabase({ ...config, databasePoolMax: 1 });
const client = await database.pool.connect();

/** The counterfactual selection state before a day's mix. @param {any} row @param {string} day */
const preMix = (row, day) => {
  const mixPick = row.selected === true && (row.selected_rule == null || MIX_RULES.has(row.selected_rule));
  const sameDay = row.visible_day === day;
  return sameDay && mixPick ? { selected: false, rule: null } : { selected: row.selected === true, rule: row.selected_rule ?? null };
};

try {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  // An active module policy overrides the configured line (FrontierPipeline#processBatch reads `evolution-module-policy-frontier`): the serving
  // layer's own read (rsiServingAdapters.mjs `read`, the same statement over the same owner) and its own rule say which, and name the identity
  // a campaign's bundle will be compared with.
  let incumbent = null;
  if (namesIncumbent && policyOwner) {
    const policy = (await client.query("SELECT payload, revision FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2 AND deleted_at IS NULL",
      [policyOwner, "evolution-module-policy-frontier"])).rows[0] ?? null;
    incumbent = serving.rsiIncumbent("frontier", policy, serving.rsiPolicyDefaults("frontier", config));
    if (!incumbent.revisionId.startsWith("default:")) { settings.threshold = incumbent.policy.selectionThreshold; settings.thresholdSource = "module-policy"; }
  }
  const days = [];
  /** @type {Record<string, any>} */
  const texts = {};
  /** @type {Record<string, any>} */
  const signals = {};
  for (let at = new Date(`${from}T12:00:00Z`); ; at = new Date(at.getTime() + 24 * 3600 * 1000)) {
    const { start, end, day } = pipeline.frontierDayWindow(at, timeZone);
    if (day > to) break;
    if (day < from) continue;
    const rows = (await client.query(`SELECT i.id::text AS id, i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.flags,
        i.safety_alert, i.lane, i.lang, i.title_raw, i.score_total, i.verification, i.selected, i.selected_rule,
        i.primary_source_id, i.event_id::text AS event_id, i.practice_changing, i.practice_zh, length(btrim(coalesce(i.summary_zh, ''))) > 0 AS summarized,
        i.editor_diagnostics->>'scoreVersion' AS score_version,
        (to_jsonb(i)->'event_selection'->>'addsValue')::boolean AS adds_value,
        s.authority AS source_authority, s.source_type AS source_source_type, t.publication_types,
        i.visible_at, i.same_event_item_id::text AS same_event_item_id,
        to_char(i.visible_at AT TIME ZONE $3, 'YYYY-MM-DD') AS visible_day,
        b.selected AS beside_selected_now, b.selected_rule AS beside_rule, to_char(b.visible_at AT TIME ZONE $3, 'YYYY-MM-DD') AS beside_day
      FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
      LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      LEFT JOIN evimed_frontier.items b ON b.id = i.same_event_item_id AND b.state = 'published'
      WHERE i.state = 'published' AND i.visible_at >= $1 AND i.visible_at < $2 ORDER BY i.id`, [start, end, timeZone])).rows;
    const eventIds = [...new Set(rows.map((row) => row.event_id).filter((id) => id != null))];
    /** @type {Record<string, any[]>} */
    const events = {};
    if (eventIds.length) {
      const members = (await client.query(`SELECT ei.event_id::text AS event_id, i.id::text AS id, i.genre, i.platform, i.channel, i.source_type,
          i.evidence_type, i.flags, i.safety_alert, i.lane, i.selected, i.selected_rule, to_char(i.visible_at AT TIME ZONE $2, 'YYYY-MM-DD') AS visible_day
        FROM evimed_frontier.event_items ei
        JOIN evimed_frontier.items i ON i.id = ei.item_id AND i.state = 'published'
        JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
        WHERE ei.event_id = ANY($1::bigint[]) ORDER BY ei.event_id, i.id`, [eventIds, timeZone])).rows;
      for (const member of members) {
        const state = preMix(member, day);
        (events[member.event_id] ??= []).push({ id: member.id, genre: domain.frontierMixGenre(member), evidenceType: member.evidence_type ?? null,
          selected: state.selected, rule: state.rule, safety: member.safety_alert === true });
      }
    }
    const floorRows = (await client.query(`SELECT i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.flags,
        i.safety_alert, i.lane, i.score_total, count(*)::int AS n
      FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
      WHERE i.state = 'published' AND i.score_total IS NOT NULL AND i.timeline_at >= $1 AND i.timeline_at < $2
      GROUP BY i.genre, i.platform, i.channel, i.source_type, i.evidence_type, i.flags, i.safety_alert, i.lane, i.score_total`,
    [new Date(end.getTime() - domain.FRONTIER_MIX_GENRE_FLOOR.days * 24 * 3600 * 1000), end])).rows;
    days.push({
      day, window: { start: start.toISOString(), end: end.toISOString() }, complete: true,
      congressActive: domain.frontierActiveCongresses(day).length > 0, genreFloors: domain.frontierMixGenreFloors(floorRows),
      preprintPlaces: settings.preprintPlaces, preprintMinScore: settings.preprintMinScore, scoreVersion: settings.scoreVersion,
      events,
      rows: rows.map((row) => {
        const state = preMix(row, day);
        const beside = row.same_event_item_id == null || row.beside_selected_now == null ? false
          : preMix({ selected: row.beside_selected_now, selected_rule: row.beside_rule, visible_day: row.beside_day }, day).selected;
        return {
          id: row.id, genre: row.genre, platform: row.platform, channel: row.channel, source_type: row.source_type, evidence_type: row.evidence_type,
          flags: row.flags ?? [], safety_alert: row.safety_alert === true, lane: row.lane, lang: row.lang, title_raw: row.title_raw,
          score_total: row.score_total, verification: row.verification, selected: state.selected, selected_rule: state.rule,
          primary_source_id: row.primary_source_id, event_id: row.event_id, practice_changing: row.practice_changing, practice_zh: row.practice_zh,
          summarized: row.summarized === true, score_version: row.score_version, adds_value: row.adds_value,
          source_authority: row.source_authority, source_source_type: row.source_source_type, publication_types: row.publication_types,
          beside_selected: beside, visible_at: new Date(row.visible_at).toISOString(), same_event_item_id: row.same_event_item_id,
          production_selected: row.selected === true, production_rule: row.selected_rule ?? null,
        };
      }),
    });
    const ids = rows.map((row) => row.id);
    if (ids.length) {
      const textRows = (await client.query(`SELECT i.id::text AS id, i.title_raw, s.name AS source_name, s.source_type, t.journal,
          t.publication_types, i.published_at, i.date_precision, i.lang,
          left(coalesce(nullif(btrim(t.abstract_raw), ''), nullif(btrim(t.body_excerpt), ''), ''), 1200) AS excerpt
        FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id WHERE i.id = ANY($1::bigint[])`, [ids])).rows;
      for (const text of textRows) {
        texts[text.id] = { title_raw: text.title_raw, source_name: text.source_name, source_type: text.source_type, journal: text.journal ?? null,
          publication_types: text.publication_types ?? [], published_at: text.published_at ? new Date(text.published_at).toISOString() : null,
          date_precision: text.date_precision, lang: text.lang, excerpt: text.excerpt };
      }
      // Delayed, screener-independent signals: how many distinct sources and reports the item's event drew by export time.
      const signalRows = (await client.query(`SELECT i.id::text AS id, count(DISTINCT m.primary_source_id)::int AS event_sources, count(m.id)::int AS event_reports
        FROM evimed_frontier.items i LEFT JOIN evimed_frontier.event_items ei ON ei.event_id = i.event_id
        LEFT JOIN evimed_frontier.items m ON m.id = ei.item_id AND m.state = 'published'
        WHERE i.id = ANY($1::bigint[]) GROUP BY i.id`, [ids])).rows;
      for (const signal of signalRows) signals[signal.id] = { event_sources: signal.event_sources, event_reports: signal.event_reports };
    }
  }
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ schema: "rsi-frontier-export-v1", exportedAt: new Date().toISOString(),
    releaseId: process.env.OPEN_SCIENCE_RELEASE_ID ?? null, from, to, settings, ...(incumbent ? { incumbent: { revisionId: incumbent.revisionId, threshold: settings.threshold } } : {}),
    ...(consumerTarget?.qualified ? { consumerDigest: consumerTarget.dependencyDigest } : {}), consumer, days, texts, signals }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await database.close();
}
