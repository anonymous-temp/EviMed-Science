/**
 * What accounts asked the platform for and was not served, as closed codes and counts, for the offline RSI lab's tool leads (2026-11-04).
 * Read-only, run inside the serving web container against the release it serves, beside the frontier export (rsi-frontier-push.sh):
 *
 *   docker exec -i web-open-science-web-1 node --input-type=module - --from 2026-09-01 --to 2026-10-31 < rsi-signals-export.mjs > out.json
 *
 * Two readings of the product ledger over the window (Asia/Shanghai days, both ends included):
 *
 *   - `signals`: the platform's own signal records (`evolutionSignals.mjs`), counted by module, kind, capability, operation, data shape and
 *     reason. Every code is projected through the release's closed vocabularies in the statement itself — a value outside one is `unknown`,
 *     a record of another module or kind is not read — so nothing an account wrote can reach the output through a code.
 *   - `leads`: what the platform's modules and runs filed as a gap they could not fill (`evolutionLedger.addLead`: a failed run's gap
 *     today; the scheduler's autopilot leads, and the 虚拟临床研究 missing-method and 循证 GEO analysis-not-offered leads of the retired module adapters are history that stays
 *     readable), by source, track, gap code, closed lead code and endpoint, counted over the accounts that met it.
 *
 * What a row carries is a combination of codes and two counts: `accounts` (distinct) and `occurrences`. A combination fewer than five
 * accounts take part in is listed with `accounts: "<5"` and `occurrences: null`, so that neither a small number nor a heavy single user can be
 * read from it; no total is written, so a withheld count cannot be subtracted back. No user, project, run, event or conversation id, no
 * text of any kind, and no timestamp finer than the window leaves this script. One REPEATABLE READ, READ ONLY transaction; nothing is
 * written. The lab stores the file and no lab step reads it: the operator's tool-lead intake does (evals/rsi-campaigns/tool_leads.mjs).
 */
import { readFile } from "node:fs/promises";

const APP = process.env.RSI_EXPORT_APP_ROOT ?? "/app";
const args = process.argv.slice(process.argv.indexOf("-") + 1 || 2);
const arg = (/** @type {string} */ name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const from = arg("--from"), to = arg("--to");
if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? "") || from > to) {
  throw new Error("Usage: rsi-signals-export.mjs --from YYYY-MM-DD --to YYYY-MM-DD");
}
/** The fewest distinct accounts a combination of codes needs before its counts leave the platform. */
const FLOOR = 5;
const TIME_ZONE = "Asia/Shanghai";
const load = (/** @type {string} */ path) => import(`file://${APP}/${path}`);
const { loadConfig } = await load("apps/server/src/config.mjs");
const { ControlPlaneDatabase } = await load("apps/server/src/controlPlaneDatabase.mjs");
const signals = await load("apps/server/src/evolutionSignals.mjs");
const { EVOLUTION_MODULE_IDS } = await load("apps/server/src/evolutionUsage.mjs");
const domain = await load("packages/domain/index.mjs");
// The capabilities a signal may name are the ones the release has, the same set `evolutionSignals.mjs` is handed to record against.
const capabilities = JSON.parse(await readFile(`${APP}/packages/domain/src/capability-contracts.json`, "utf8")).capabilities.map((/** @type {{id: string}} */ row) => row.id);

const vocabulary = {
  modules: [...EVOLUTION_MODULE_IDS], kinds: [...signals.EVOLUTION_SIGNAL_KINDS], capabilities: ["open-domain-answer", "unknown", ...capabilities],
  operations: [...signals.EVOLUTION_OPERATIONS], dataShapes: [...signals.EVOLUTION_DATA_SHAPES], reasons: [...signals.EVOLUTION_DEMAND_REASONS],
  leadSources: [...domain.EVOLUTION_LEAD_SOURCES], tracks: [...domain.EVOLUTION_TRACKS], gapCodes: [...domain.EVOLUTION_GAP_CODES],
  // The codes a lead may carry: a gap code, and the two kinds the retired module adapters filed — GEO's "no capability offers this analysis" and a
  // 虚拟临床研究 method family the engine does not publish — with the endpoint types of that study. Rows of those kinds stay in the ledger.
  leadCodes: [...domain.EVOLUTION_GAP_CODES, "analysis-not-offered", ...new Set(domain.VCR_ENGINE_METHOD_IDS.map((/** @type {string} */ id) => `vcr-${id.split(".")[0]}`)), "vcr-other"],
  endpoints: ["continuous", "binary", "time_to_event"],
};

// A column is its value when the release's list holds it and `fallback` otherwise, decided in the statement: no other value is ever selected.
const closed = (/** @type {string} */ path, /** @type {number} */ list, /** @type {string | null} */ fallback) =>
  `CASE WHEN ${path} = ANY($${list}::text[]) THEN ${path} ELSE ${fallback === null ? "NULL" : `'${fallback}'`} END`;
const windowStart = "($1::date)::timestamp AT TIME ZONE $2::text", windowEnd = "(($3::date) + 1)::timestamp AT TIME ZONE $2::text";

const SIGNALS = `SELECT payload->>'moduleId' AS module, payload->>'kind' AS kind,
    ${closed("payload#>>'{codes,capability}'", 4, "unknown")} AS capability, ${closed("payload#>>'{codes,operation}'", 5, "unknown")} AS operation,
    ${closed("payload#>>'{codes,dataShape}'", 6, "unknown")} AS data_shape, ${closed("payload#>>'{codes,reason}'", 7, "unsupported")} AS reason,
    count(*)::int AS occurrences, count(DISTINCT user_id)::int AS accounts
  FROM evimed_product.documents
  WHERE kind = 'knowledge' AND deleted_at IS NULL AND payload->>'recordType' = 'evolution-signal' AND coalesce(payload->>'state', 'active') = 'active'
    AND payload->>'moduleId' = ANY($8::text[]) AND payload->>'kind' = ANY($9::text[]) AND created_at >= ${windowStart} AND created_at < ${windowEnd}
  GROUP BY 1, 2, 3, 4, 5, 6`;
const LEADS = `SELECT ${closed("l.payload->>'source'", 4, "unknown")} AS source, ${closed("l.payload->>'track'", 5, "unknown")} AS track,
    ${closed("l.payload->>'gapCode'", 6, "unknown")} AS gap_code, ${closed("l.payload->>'code'", 7, "other")} AS code, ${closed("l.payload->>'endpoint'", 8, null)} AS endpoint,
    count(*)::int AS occurrences, count(DISTINCT o.user_id)::int AS accounts
  FROM evimed_product.documents o
  JOIN evimed_product.documents l ON l.id = o.payload->>'leadId' AND l.kind = 'knowledge' AND l.deleted_at IS NULL AND l.payload->>'recordType' = 'evolution-lead'
  WHERE o.kind = 'knowledge' AND o.deleted_at IS NULL AND o.payload->>'recordType' = 'evolution-lead-occurrence' AND o.payload->>'scope' = 'owner'
    AND o.created_at >= ${windowStart} AND o.created_at < ${windowEnd}
  GROUP BY 1, 2, 3, 4, 5`;

/** The counts of one combination of codes, or their withholding below the floor. @param {{accounts: number, occurrences: number}} row */
const counts = (row) => (row.accounts >= FLOOR ? { accounts: row.accounts, occurrences: row.occurrences } : { accounts: `<${FLOOR}`, occurrences: null });
/** Rows in the order of their codes by code point, whatever collation the database sorts by. @param {Record<string, any>[]} rows @param {string[]} keys */
const ordered = (rows, keys) => rows.sort((a, b) => { for (const key of keys) { const x = String(a[key] ?? ""), y = String(b[key] ?? ""); if (x !== y) return x < y ? -1 : 1; } return 0; });

const config = loadConfig();
const database = new ControlPlaneDatabase({ ...config, databasePoolMax: 1 });
const client = await database.pool.connect();
try {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  const window = [from, TIME_ZONE, to];
  const signalRows = (await client.query(SIGNALS, [...window, vocabulary.capabilities, vocabulary.operations, vocabulary.dataShapes, vocabulary.reasons, vocabulary.modules, vocabulary.kinds])).rows;
  const leadRows = (await client.query(LEADS, [...window, vocabulary.leadSources, vocabulary.tracks, vocabulary.gapCodes, vocabulary.leadCodes, vocabulary.endpoints])).rows;
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ schema: "rsi-signals-export-v1", exportedAt: new Date().toISOString().slice(0, 10), releaseId: process.env.OPEN_SCIENCE_RELEASE_ID ?? null,
    from, to, timeZone: TIME_ZONE, floor: FLOOR,
    signals: ordered(signalRows, ["module", "kind", "capability", "operation", "data_shape", "reason"]).map((row) => ({ module: row.module, kind: row.kind, capability: row.capability, operation: row.operation, dataShape: row.data_shape, reason: row.reason, ...counts(row) })),
    leads: ordered(leadRows, ["source", "track", "gap_code", "code", "endpoint"]).map((row) => ({ source: row.source, track: row.track, gapCode: row.gap_code, code: row.code, endpoint: row.endpoint, ...counts(row) })) }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await database.close();
}
