// The serving policy's frontier selector is advice to the day's mix (review of the serving cutover, 2026-10-26): when it fails,
// the mix is the pipeline's own selection at its configured threshold and the failure is counted, never a failed round.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { createModuleEvolutionPolicies } from "../src/moduleEvolutionPolicies.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const DIMENSION = 16;
const operator = `frontier_mix_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let capabilities;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 2_000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Frontier operator','development')", [operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
  await migrateUsageLedger(database);
  capabilities = await migrateFrontier(database, { dimension: DIMENSION });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [operator]);
  await database.close();
});

async function reset() {
  await database.query(`TRUNCATE ${capabilities.vector ? "evimed_frontier.item_vectors, " : ""}evimed_frontier.item_texts, evimed_frontier.item_keys, evimed_frontier.item_mentions,
    evimed_frontier.item_links, evimed_frontier.item_changes, evimed_frontier.user_state, evimed_frontier.event_items, evimed_frontier.items,
    evimed_frontier.entries, evimed_frontier.sources, evimed_frontier.glossary, evimed_frontier.dailies RESTART IDENTITY CASCADE`);
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key IN ('content_version','hot_version','daily_version')");
  await database.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, authority, safety_feed, owner_entity, launch_tier, region)
    VALUES ('j-small','Journal of Small Things','evidence','journal','crossref-issn','api',3,false,'Small','P0','US')`);
}
/** One delivered journal entry whose text the plugin cannot give. @param {number} seq */
async function deliver(seq) {
  const doi = `10.1000/mix.${seq}`, identity = `doi:${doi}`;
  const entryId = `j-small:${createHash("sha256").update(`${identity}:${seq}`).digest("hex").slice(0, 32)}`;
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url,
      doi, title_raw, summary_raw, facts, lang, date_precision, first_seen_at, content_sha256, backfill, defects, state)
    VALUES ($1,$2,1,'j-small',$3,$4,$4,$5,$6,$7,'{}'::jsonb,'en','instant','2026-09-22T10:00:00Z',$8,false,'{}','received')`,
  [entryId, seq, identity, `https://example.org/mix/${seq}`, doi, `A small journal paper ${seq}`, "P".repeat(200), createHash("sha256").update(`${seq}`).digest("hex")]);
  return entryId;
}
/** An editor that keeps every entry and scores it 60 of its share: with the source's authority, 74 against a line of 70. */
function editor() {
  return {
    owner: { userId: operator, projectId: "evimed-frontier" }, available: true, provider: { balanceSpent: false },
    /** @param {any[]} batch */
    async screen(batch) {
      return { verdicts: new Map(batch.map((input) => [input.key, { medical: true, news: true, lane: input.allowedLanes[0], specialties: ["cardiology"], language: "en", digest: false }])), errors: new Map(), calls: 1 };
    },
    /** @param {any} item */
    async edit(item) {
      const modelInput = buildModelInput(item);
      return { modelInput, modelInputSha256: sha256(modelInput), attempts: 1, issues: [], numbers: null, error: null, model: "deepseek-flash", editorVersion: FRONTIER_EDITOR_VERSION,
        fieldDiagnostics: { title_zh: ["passed"], summary_zh: ["passed"] }, verification: "passed", output: {
          genre: null, titleZh: `中文：${item.titleRaw.slice(0, 20)}`, summaryZh: "导读：有摘要。", reasonZh: "值得一看。", lane: item.allowedLanes[0], specialties: ["cardiology"],
          evidenceType: item.evidenceFixed?.type ?? "observational", entities: { drugs: [], trials: [], orgs: [], diseases: [] },
          scores: { impact: 30, novelty: 20, relevance: 10 }, practice: null, flags: [], scoresRaw: { impact: 30, novelty: 20, relevance: 10 } } };
    },
  };
}

test("a failing serving selector leaves the day's mix to the pipeline's own selection at its configured threshold, counted", options, async () => {
  await reset();
  const entries = [await deliver(1), await deliver(2)];
  const plugin = { text: async (/** @type {string} */ entryId) => ({ entry_id: entryId, revision: 1, status: "unavailable", abstract: null, body_excerpt: null, enrichment: {} }) };
  const policies = { ...createModuleEvolutionPolicies(), evaluateFrontierSelection: async () => { throw Object.assign(new Error("campaign store down"), { code: "rsi_store_unavailable" }); } };
  const pipeline = new FrontierPipeline({ database, editor: editor(), plugin, policies, now: () => new Date("2026-09-22T12:00:00Z"), workerId: `test-${randomUUID()}`,
    glossary: new FrontierGlossary([]),
    embedder: { configured: true, modelKey: `fake@${DIMENSION}`, dimension: DIMENSION, embedDocuments: async (/** @type {string[]} */ texts) => texts.map(() => Array.from({ length: DIMENSION }, (_, at) => at + 1)) },
    config: { kbEmbeddingDimension: DIMENSION, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 10, frontierSelectThreshold: 70 } });
  const summary = await pipeline.processBatch();
  assert.equal(summary.published, 2);
  const items = (await database.query(`SELECT i.score_total, i.selected, i.selected_rule FROM evimed_frontier.items i
    JOIN evimed_frontier.entries e ON e.item_id = i.id WHERE e.plugin_entry_id = ANY($1::text[]) ORDER BY i.id`, [entries])).rows;
  assert.deepEqual(items.map((row) => [row.score_total >= 70, row.selected, row.selected_rule]), [[true, true, "threshold"], [true, true, "threshold"]]);
  assert.equal(pipeline.counters.mixSelectionFallbacks, 1);
  assert.equal(pipeline.counters.mix.threshold, 2);
});
